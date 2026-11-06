import { app, BrowserWindow, Menu, ipcMain, dialog, shell, protocol, screen } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import * as library from './library.js';
import { MAX_RULER_POINTS, normalizeDiscs } from '../src/lib/grid';
import type {
  EffectSnapshot,
  FogSnapshot,
  ImportResult,
  LibrarySettings,
  MapGrid,
  MapState,
  MapView,
  ProjectImportSummary,
  Point,
  ProjectResult,
  RulerState,
} from '../src/types/map';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Must run before `ready`: lets the windows load library media by id
protocol.registerSchemesAsPrivileged([
  { scheme: 'map-media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

// Build output:
//
//   dist/index.html            both windows' page (the player adds ?mode=view)
//   dist-electron/main.js      this file
//   dist-electron/preload.cjs  the window.electronAPI bridge
process.env.APP_ROOT = path.join(__dirname, '..');

const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL'];
const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist');

// Windows takes the icon from the executable, except in unpacked runs (npm run
// dev). Linux has no executable icon, and an AppImage that isn't integrated
// into the desktop has no .desktop file either, so the window always sets it.
const iconFile = path.join(
  process.env.APP_ROOT,
  'build',
  process.platform === 'linux' ? 'icon.png' : 'icon.ico',
);
const windowIcon =
  (process.platform === 'linux' || !app.isPackaged) && existsSync(iconFile) ? iconFile : undefined;

/** The DM window's preferred size, shrunk to fit small screens such as the Steam Deck's 1280×800. */
const DM_WINDOW = { width: 1280, height: 860 };

// Matches the UI's background colour, so windows don't flash white on open
const WINDOW_BACKGROUND = '#171412';

const MAP_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'webm'];
const HANDOUT_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'];

let dmWindow: BrowserWindow | null = null;
let playerWindow: BrowserWindow | null = null;

// The latest state and fog mask, so a player window opened later starts in sync
let latestMapState: MapState | null = null;
let latestFogDataUrl: string | null = null;
let latestEffects: EffectSnapshot | null = null;

const webPreferences = (): Electron.WebPreferences => ({
  preload: path.join(__dirname, 'preload.cjs'),
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
});

/**
 * The app only ever shows its own bundled page. Block navigation and pop-ups so
 * a file dropped in the wrong place (or any stray link) can't replace the UI.
 */
function lockDownNavigation(target: BrowserWindow) {
  target.webContents.on('will-navigate', (event) => event.preventDefault());
  target.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

function loadPage(target: BrowserWindow, mode?: 'view') {
  if (VITE_DEV_SERVER_URL) {
    target.loadURL(mode ? `${VITE_DEV_SERVER_URL}?mode=${mode}` : VITE_DEV_SERVER_URL);
  } else {
    target.loadFile(path.join(RENDERER_DIST, 'index.html'), mode ? { query: { mode } } : undefined);
  }
}

/**
 * Hide a window's menu bar for good. Its shortcuts still work, but Alt (snap,
 * zoom the DM view) must not pop it up: over the DM window's layout, or on the
 * table screen. On Windows a hidden menu still takes focus when Alt is
 * released, so the bare Alt key is swallowed; mouse and wheel events still
 * report Alt as held.
 */
function hideMenuBar(target: BrowserWindow) {
  target.setMenuBarVisibility(false);
  target.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'Alt' && !input.control && !input.shift && !input.meta) event.preventDefault();
  });
}

const isOpen = (target: BrowserWindow | null): target is BrowserWindow => !!target && !target.isDestroyed();
const sendToDm = (channel: string, ...args: unknown[]) => {
  if (isOpen(dmWindow)) dmWindow.webContents.send(channel, ...args);
};
const sendToPlayer = (channel: string, ...args: unknown[]) => {
  if (isOpen(playerWindow)) playerWindow.webContents.send(channel, ...args);
};

function createDmWindow() {
  const area = screen.getPrimaryDisplay().workAreaSize;
  const tooSmall = area.width < DM_WINDOW.width || area.height < DM_WINDOW.height;
  dmWindow = new BrowserWindow({
    title: 'Mini VTT',
    width: Math.min(DM_WINDOW.width, area.width),
    height: Math.min(DM_WINDOW.height, area.height),
    minWidth: 960,
    minHeight: 620,
    icon: windowIcon,
    backgroundColor: WINDOW_BACKGROUND,
    webPreferences: webPreferences(),
  });
  hideMenuBar(dmWindow);
  // On a screen smaller than the preferred size, use all of it
  if (tooSmall) dmWindow.maximize();
  lockDownNavigation(dmWindow);
  dmWindow.on('closed', () => {
    dmWindow = null;
    // A player screen without its controlling window is a dead end
    if (isOpen(playerWindow)) playerWindow.close();
  });
  loadPage(dmWindow);
}

function openPlayerWindow() {
  if (isOpen(playerWindow)) {
    if (playerWindow.isMinimized()) playerWindow.restore();
    playerWindow.focus();
    return;
  }

  const created = new BrowserWindow({
    title: 'Mini VTT — Player Screen',
    width: 1024,
    height: 768,
    minWidth: 480,
    minHeight: 360,
    icon: windowIcon,
    backgroundColor: '#000000',
    webPreferences: webPreferences(),
  });
  playerWindow = created;
  hideMenuBar(created);
  lockDownNavigation(created);
  created.on('closed', () => {
    if (playerWindow === created) playerWindow = null;
    sendToDm('player:closed');
  });
  const pushFullScreen = () => {
    if (!created.isDestroyed()) created.webContents.send('window:fullScreenChanged', created.isFullScreen());
  };
  created.on('enter-full-screen', pushFullScreen);
  created.on('leave-full-screen', pushFullScreen);
  loadPage(created, 'view');
}

// ─── Fog and effect persistence ───────────────────────────────────────────────
//
// The DM window encodes the fog mask (or effect layer) once per change and
// sends it here. The snapshot is relayed to the player window immediately and
// saved to disk after a short pause, so a burst of strokes costs one write. A
// pending save is flushed (never dropped) when a different map's snapshot
// arrives, before that map's layer is read back or the map is removed, and
// when the app quits.

const SNAPSHOT_SAVE_DELAY_MS = 500;

function delayedMapSave<T>(label: string, save: (mapId: string, value: T) => Promise<boolean>) {
  let pending: { mapId: string; value: T; timer: NodeJS.Timeout } | null = null;

  const flush = async (): Promise<void> => {
    const current = pending;
    if (!current) return;
    clearTimeout(current.timer);
    pending = null;
    try {
      await save(current.mapId, current.value);
    } catch (err) {
      console.error(`Failed to save ${label} for ${current.mapId}:`, err);
    }
  };

  return {
    flush,
    isPending: () => pending !== null,
    /** Flush first if a save for this map is waiting, so a read sees it. */
    flushFor: async (mapId: string) => {
      if (pending?.mapId === mapId) await flush();
    },
    schedule: (mapId: string, value: T) => {
      if (pending && pending.mapId !== mapId) void flush();
      if (pending) clearTimeout(pending.timer);
      pending = { mapId, value, timer: setTimeout(() => void flush(), SNAPSHOT_SAVE_DELAY_MS) };
    },
  };
}

const fogSaves = delayedMapSave<string>('fog', library.saveMapFog);
const effectSaves = delayedMapSave<string | null>('effects', library.saveMapEffects);
const flushAllSaves = () => Promise.all([fogSaves.flush(), effectSaves.flush()]);

// ─── Player window and relayed messages ───────────────────────────────────────
//
// What the DM window sends for the player screen is checked before it is kept
// or passed on, like everything else that arrives over IPC.

const MEDIA_URL = /^map-media:\/\/[A-Za-z0-9_-]{1,64}$/;
const PNG_DATA_URL = 'data:image/png;base64,';
const QUARTER_TURNS = [0, 90, 180, 270];

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
const isMediaUrl = (value: unknown): value is string | null =>
  value === null || (typeof value === 'string' && MEDIA_URL.test(value));
const isPngDataUrl = (value: unknown): value is string =>
  typeof value === 'string' && value.startsWith(PNG_DATA_URL);

/** A valid player state, or null. */
function normalizeMapState(value: unknown): MapState | null {
  if (!value || typeof value !== 'object') return null;
  const state = value as Record<string, unknown>;
  const { mediaUrl, handoutUrl, mediaType, zoom, rotation, handoutRotation } = state;
  if (!isMediaUrl(mediaUrl) || !isMediaUrl(handoutUrl)) return null;
  if (mediaType !== 'image' && mediaType !== 'video') return null;
  if (!isFiniteNumber(zoom) || zoom <= 0) return null;
  if (!isFiniteNumber(rotation) || !QUARTER_TURNS.includes(rotation)) return null;
  if (!isFiniteNumber(handoutRotation) || !QUARTER_TURNS.includes(handoutRotation)) return null;
  return {
    mediaUrl,
    mediaType,
    zoom,
    rotation,
    mirrorHorizontal: state.mirrorHorizontal === true,
    mirrorVertical: state.mirrorVertical === true,
    handoutUrl,
    handoutRotation,
    blackout: state.blackout === true,
    circles: normalizeDiscs(state.circles),
  };
}

ipcMain.handle('player:open', async () => {
  openPlayerWindow();
  return true;
});

ipcMain.handle('player:resize', async (_event, requestedWidth: number, requestedHeight: number) => {
  if (!isOpen(playerWindow) || !Number.isFinite(requestedWidth) || !Number.isFinite(requestedHeight))
    return null;
  playerWindow.setContentSize(
    Math.max(480, Math.round(requestedWidth)),
    Math.max(360, Math.round(requestedHeight)),
  );
  const [width, height] = playerWindow.getContentSize();
  return { width, height };
});

ipcMain.on('player:state', (_event, value: unknown) => {
  const state = normalizeMapState(value);
  if (!state) return;
  latestMapState = state;
  sendToPlayer('player:state', state);
});
ipcMain.handle('player:requestState', async () => latestMapState);

/** A valid ruler: 2 to MAX_RULER_POINTS points on the map and a distance in feet. */
function normalizeRuler(value: unknown): RulerState | null {
  if (!value || typeof value !== 'object') return null;
  const { points, feet } = value as Record<string, unknown>;
  if (!Array.isArray(points) || points.length < 2 || points.length > MAX_RULER_POINTS) return null;
  if (!isFiniteNumber(feet) || feet < 0 || feet > 1_000_000) return null;
  const clean: Point[] = [];
  for (const raw of points) {
    if (!raw || typeof raw !== 'object') return null;
    const { x, y } = raw as Record<string, unknown>;
    if (!isFiniteNumber(x) || !isFiniteNumber(y)) return null;
    clean.push({ x, y });
  }
  return { points: clean, feet };
}

// The ruler is only relayed, never kept: a player screen opened later shows
// it from the next change
ipcMain.on('ruler:update', (_event, value: unknown) => {
  if (value === null) sendToPlayer('ruler:update', null);
  else {
    const ruler = normalizeRuler(value);
    if (ruler) sendToPlayer('ruler:update', ruler);
  }
});
ipcMain.handle('player:requestFog', async () => latestFogDataUrl);
ipcMain.handle('player:requestEffects', async () => latestEffects?.dataUrl ?? null);

ipcMain.on('handout:close', () => sendToDm('handout:close'));

ipcMain.on('fog:reset', () => {
  latestFogDataUrl = null;
  sendToPlayer('fog:reset');
});

ipcMain.on('fog:snapshot', (_event, value: FogSnapshot) => {
  if (!value || typeof value.mapId !== 'string' || !isPngDataUrl(value.dataUrl)) return;
  const snapshot: FogSnapshot = {
    mapId: value.mapId,
    dataUrl: value.dataUrl,
    persist: value.persist === true,
  };
  // Snapshots are encoded in the background, so one can arrive after the DM
  // has moved on to another map: it is still saved, but never shown on the
  // player screen, where it would uncover the wrong parts of the new map
  if (latestMapState?.mediaUrl === `map-media://${snapshot.mapId}`) {
    latestFogDataUrl = snapshot.dataUrl;
    sendToPlayer('fog:snapshot', snapshot);
  }
  if (snapshot.persist) fogSaves.schedule(snapshot.mapId, snapshot.dataUrl);
});

ipcMain.on('effects:snapshot', (_event, value: EffectSnapshot) => {
  if (!value || typeof value.mapId !== 'string') return;
  if (value.dataUrl !== null && !isPngDataUrl(value.dataUrl)) return;
  const snapshot: EffectSnapshot = {
    mapId: value.mapId,
    dataUrl: value.dataUrl,
    persist: value.persist === true,
  };
  latestEffects = snapshot;
  sendToPlayer('effects:snapshot', snapshot);
  if (snapshot.persist) effectSaves.schedule(snapshot.mapId, snapshot.dataUrl);
});

ipcMain.on('viewport:size', (_event, width: unknown, height: unknown) => {
  if (isFiniteNumber(width) && isFiniteNumber(height) && width > 0 && height > 0) {
    sendToDm('viewport:size', width, height);
  }
});
ipcMain.on('viewport:pan', (_event, x: unknown, y: unknown) => {
  if (isFiniteNumber(x) && isFiniteNumber(y)) sendToPlayer('viewport:pan', x, y);
});

// ─── Full screen (applies to whichever window asks) ───────────────────────────

ipcMain.handle('window:toggleFullScreen', async (event) => {
  const target = BrowserWindow.fromWebContents(event.sender);
  if (!target || target.isDestroyed()) return false;
  target.setFullScreen(!target.isFullScreen());
  return target.isFullScreen();
});

ipcMain.handle('window:isFullScreen', async (event) => {
  const target = BrowserWindow.fromWebContents(event.sender);
  return target ? target.isFullScreen() : false;
});

// The DM window's menu bar is hidden, so its useful commands live in the
// settings menu. They act on the window that asks.
ipcMain.on('window:reload', (event) => event.sender.reload());
ipcMain.on('window:toggleDevTools', (event) => event.sender.toggleDevTools());
ipcMain.on('app:quit', () => app.quit());

// ─── Library ──────────────────────────────────────────────────────────────────

/** Import files one by one; unsupported or failing files are reported, not fatal. */
async function importFiles(paths: unknown, kind: 'map' | 'handout'): Promise<ImportResult> {
  const result: ImportResult = { added: 0, skipped: [], firstMap: null };
  if (!Array.isArray(paths)) return result;
  for (const sourcePath of paths) {
    if (typeof sourcePath !== 'string') continue;
    try {
      if (kind === 'map') {
        const added = await library.addMap(sourcePath);
        if (added) {
          result.added += 1;
          result.firstMap ??= added;
        } else result.skipped.push(path.basename(sourcePath));
      } else if (await library.addHandout(sourcePath)) {
        result.added += 1;
      } else {
        result.skipped.push(path.basename(sourcePath));
      }
    } catch (err) {
      console.error(`Failed to import ${kind} "${sourcePath}":`, err);
      result.skipped.push(path.basename(sourcePath));
    }
  }
  return result;
}

async function importFromDialog(kind: 'map' | 'handout'): Promise<ImportResult | null> {
  if (!isOpen(dmWindow)) return null;
  const chosen = await dialog.showOpenDialog(dmWindow, {
    title: kind === 'map' ? 'Add maps' : 'Add handouts',
    properties: ['openFile', 'multiSelections'],
    filters:
      kind === 'map'
        ? [{ name: 'Images and WebM videos', extensions: MAP_EXTENSIONS }]
        : [{ name: 'Images', extensions: HANDOUT_EXTENSIONS }],
  });
  if (chosen.canceled || chosen.filePaths.length === 0) return null;
  return importFiles(chosen.filePaths, kind);
}

ipcMain.handle('library:load', async () => library.loadSnapshot());
ipcMain.handle('library:importMapsFromDialog', async () => importFromDialog('map'));
ipcMain.handle('library:importMaps', async (_e, paths: unknown) => importFiles(paths, 'map'));
ipcMain.handle('library:loadMapMedia', async (_e, id: string) => library.loadMapMediaUrl(id));
ipcMain.handle('library:loadMapThumb', async (_e, id: string) => library.loadMapThumb(id));
ipcMain.handle('library:loadVideoCodec', async (_e, id: string) => library.loadVideoCodec(id));
ipcMain.handle('library:saveThumb', async (_e, id: unknown, png: unknown) => library.saveThumb(id, png));
ipcMain.handle('library:loadMapFog', async (_e, id: string) => {
  // A save may still be pending for this map: write it first so the read is current
  await fogSaves.flushFor(id);
  return library.loadMapFog(id);
});
ipcMain.handle('library:loadMapEffects', async (_e, id: string) => {
  await effectSaves.flushFor(id);
  return library.loadMapEffects(id);
});
ipcMain.handle('library:saveMapView', async (_e, id: string, view: MapView) => library.saveMapView(id, view));
ipcMain.handle('library:saveMapGrid', async (_e, id: string, grid: MapGrid | null) =>
  library.saveMapGrid(id, grid),
);
ipcMain.handle('library:renameMap', async (_e, id: string, name: string) => library.renameMap(id, name));
ipcMain.handle('library:removeMap', async (_e, id: string) => {
  // Write a waiting fog or effects save first: before the folder goes, so no
  // late save recreates it, and so nothing painted is lost if the map can't be
  // removed after all (its video still in use)
  await fogSaves.flushFor(id);
  await effectSaves.flushFor(id);
  return library.removeMap(id);
});
ipcMain.handle('library:reorderMaps', async (_e, ids: string[]) => library.reorderMaps(ids));
ipcMain.handle('library:saveSettings', async (_e, patch: Partial<LibrarySettings>) =>
  library.saveSettings(patch),
);
ipcMain.handle('library:revealFolder', async () => {
  try {
    const folder = path.join(app.getPath('userData'), 'library');
    await fs.mkdir(folder, { recursive: true });
    await shell.openPath(folder);
    return true;
  } catch (err) {
    console.error('Failed to open the library folder:', err);
    return false;
  }
});

// ─── Project files (the whole library in one file) ────────────────────────────

const PROJECT_FILTERS = [{ name: 'Mini VTT project', extensions: ['minivtt'] }];

const projectErrorMessage = (err: unknown, fallback: string) => {
  if (err instanceof library.ProjectError) return err.message;
  console.error(fallback, err);
  return fallback;
};

ipcMain.handle(
  'library:exportProject',
  async (): Promise<ProjectResult<{ maps: number; handouts: number }> | null> => {
    if (!isOpen(dmWindow)) return null;
    const date = new Date().toISOString().slice(0, 10);
    const chosen = await dialog.showSaveDialog(dmWindow, {
      title: 'Export project',
      buttonLabel: 'Export',
      defaultPath: path.join(app.getPath('documents'), `Mini VTT project ${date}.minivtt`),
      filters: PROJECT_FILTERS,
    });
    if (chosen.canceled || !chosen.filePath) return null;
    // Include fog and effects painted in the last moment before exporting
    await flushAllSaves();
    try {
      const counts = await library.exportProject(chosen.filePath);
      return { ok: true, fileName: path.basename(chosen.filePath), ...counts };
    } catch (err) {
      return { ok: false, error: projectErrorMessage(err, 'Couldn’t save the project file.') };
    }
  },
);

ipcMain.handle('library:importProject', async (): Promise<ProjectResult<ProjectImportSummary> | null> => {
  if (!isOpen(dmWindow)) return null;
  const chosen = await dialog.showOpenDialog(dmWindow, {
    title: 'Import project',
    buttonLabel: 'Import',
    properties: ['openFile'],
    filters: PROJECT_FILTERS,
  });
  const sourcePath = chosen.filePaths[0];
  if (chosen.canceled || !sourcePath) return null;
  try {
    const summary = await library.importProject(sourcePath);
    return { ok: true, fileName: path.basename(sourcePath), ...summary };
  } catch (err) {
    return { ok: false, error: projectErrorMessage(err, 'Couldn’t import the project file.') };
  }
});

ipcMain.handle('library:importHandoutsFromDialog', async () => importFromDialog('handout'));
ipcMain.handle('library:importHandouts', async (_e, paths: unknown) => importFiles(paths, 'handout'));
ipcMain.handle('library:loadHandoutMedia', async (_e, id: string) =>
  (await library.resolveHandoutPath(id)) ? `map-media://${id}` : null,
);
ipcMain.handle('library:loadHandoutThumb', async (_e, id: string) => library.loadHandoutThumb(id));
ipcMain.handle('library:rotateHandout', async (_e, id: string, rotation: number) =>
  library.rotateHandout(id, rotation),
);
ipcMain.handle('library:removeHandout', async (_e, id: string) => library.removeHandout(id));

// ─── App lifecycle ────────────────────────────────────────────────────────────

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createDmWindow();
});

// Write any pending fog save before the process exits
let quitAfterFlush = false;
app.on('before-quit', (event) => {
  if (quitAfterFlush || (!fogSaves.isPending() && !effectSaves.isPending())) return;
  event.preventDefault();
  quitAfterFlush = true;
  void flushAllSaves().finally(() => app.quit());
});

app.whenReady().then(() => {
  // The menu bar is never shown; the menu only provides these shortcuts. It
  // leaves out Electron's page zoom (Ctrl+= / Ctrl+- / Ctrl+0): that zooms
  // every window, the player screen too, and the DM window uses those keys to
  // zoom its own view of the map.
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'Mini VTT',
        submenu: [
          { role: 'reload' },
          { role: 'toggleDevTools' },
          { role: 'togglefullscreen' },
          { role: 'quit' },
        ],
      },
      { role: 'editMenu' },
    ]),
  );
  protocol.handle('map-media', async (request) => {
    const id = new URL(request.url).hostname;
    const mediaPath = library.isHandoutId(id)
      ? await library.resolveHandoutPath(id)
      : await library.resolveMapMediaPath(id);
    if (!mediaPath) return new Response('Not found', { status: 404 });
    // Streamed straight from the file rather than with net.fetch: when a
    // window drops the media (map switched or removed), this stream closes at
    // once and lets go of the file. A net.fetch of the file kept it open for
    // as long as it took to read it all, so a video map couldn't be deleted.
    const { size } = await fs.stat(mediaPath);
    const headers = { 'Content-Type': library.mediaMimeType(mediaPath), 'Accept-Ranges': 'bytes' };
    // Exactly the bytes asked for: a video asks for the rest of the file from
    // where it left off (see byteRange)
    const range = library.byteRange(request.headers.get('range'), size);
    if (range === 'unsatisfiable') {
      return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${size}` } });
    }
    if (size === 0) return new Response(null, { headers: { ...headers, 'Content-Length': '0' } });
    const { start, end } = range ?? { start: 0, end: size - 1 };
    const stream = createReadStream(mediaPath, { start, end });
    const body = Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>;
    return new Response(body, {
      status: range ? 206 : 200,
      headers: {
        ...headers,
        'Content-Length': String(end - start + 1),
        ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
      },
    });
  });
  // In the background: folders of removed maps that couldn't be deleted yet
  void library.removeLeftovers();
  createDmWindow();
});

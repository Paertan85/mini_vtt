import { app, BrowserWindow, ipcMain, dialog, shell, protocol, net } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as library from './library.js';
import type {
  FogSnapshot,
  FogStroke,
  ImportResult,
  LibrarySettings,
  MapState,
  MapView,
  ProjectImportSummary,
  ProjectResult,
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

export const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL'];
export const MAIN_DIST = path.join(process.env.APP_ROOT, 'dist-electron');
export const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist');

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL ? path.join(process.env.APP_ROOT, 'public') : RENDERER_DIST;

// Unpacked runs (npm run dev) have no executable icon, so set it on the window
const unpackedIcon = path.join(process.env.APP_ROOT, 'build', 'icon.ico');
const windowIcon = !app.isPackaged && existsSync(unpackedIcon) ? unpackedIcon : undefined;

// Matches the UI's background colour, so windows don't flash white on open
const WINDOW_BACKGROUND = '#171412';

const MAP_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'webm'];
const HANDOUT_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'];

let dmWindow: BrowserWindow | null = null;
let playerWindow: BrowserWindow | null = null;

// The latest state and fog mask, so a player window opened later starts in sync
let latestMapState: MapState | null = null;
let latestFogDataUrl: string | null = null;

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

const isOpen = (target: BrowserWindow | null): target is BrowserWindow => !!target && !target.isDestroyed();
const sendToDm = (channel: string, ...args: unknown[]) => {
  if (isOpen(dmWindow)) dmWindow.webContents.send(channel, ...args);
};
const sendToPlayer = (channel: string, ...args: unknown[]) => {
  if (isOpen(playerWindow)) playerWindow.webContents.send(channel, ...args);
};

function createDmWindow() {
  dmWindow = new BrowserWindow({
    title: 'Mini VTT',
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 620,
    icon: windowIcon,
    backgroundColor: WINDOW_BACKGROUND,
    webPreferences: webPreferences(),
    autoHideMenuBar: true,
  });
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
    autoHideMenuBar: true,
  });
  playerWindow = created;
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

// ─── Fog persistence ──────────────────────────────────────────────────────────
//
// The DM window encodes the fog mask once per stroke and sends it here. The
// snapshot is relayed to the player window immediately and saved to disk after
// a short pause, so a burst of strokes costs one write. A pending save is
// flushed (never dropped) when a different map's fog arrives or the app quits.

const FOG_SAVE_DELAY_MS = 500;
let pendingFogSave: { mapId: string; dataUrl: string; timer: NodeJS.Timeout } | null = null;

async function flushFogSave(): Promise<void> {
  const pending = pendingFogSave;
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingFogSave = null;
  try {
    await library.saveMapFog(pending.mapId, pending.dataUrl);
  } catch (err) {
    console.error(`Failed to save fog for ${pending.mapId}:`, err);
  }
}

function scheduleFogSave(mapId: string, dataUrl: string) {
  if (pendingFogSave && pendingFogSave.mapId !== mapId) void flushFogSave();
  if (pendingFogSave) clearTimeout(pendingFogSave.timer);
  pendingFogSave = { mapId, dataUrl, timer: setTimeout(() => void flushFogSave(), FOG_SAVE_DELAY_MS) };
}

function cancelFogSave(mapId: string) {
  if (pendingFogSave?.mapId !== mapId) return;
  clearTimeout(pendingFogSave.timer);
  pendingFogSave = null;
}

// ─── Player window and relayed messages ───────────────────────────────────────

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

ipcMain.on('player:state', (_event, state: MapState) => {
  latestMapState = state;
  sendToPlayer('player:state', state);
});
ipcMain.handle('player:requestState', async () => latestMapState);
ipcMain.handle('player:requestFog', async () => latestFogDataUrl);

ipcMain.on('handout:close', () => sendToDm('handout:close'));

ipcMain.on('fog:stroke', (_event, stroke: FogStroke) => sendToPlayer('fog:stroke', stroke));

ipcMain.on('fog:reset', () => {
  latestFogDataUrl = null;
  sendToPlayer('fog:reset');
});

ipcMain.on('fog:snapshot', (_event, snapshot: FogSnapshot) => {
  if (!snapshot || typeof snapshot.dataUrl !== 'string' || typeof snapshot.mapId !== 'string') return;
  latestFogDataUrl = snapshot.dataUrl;
  sendToPlayer('fog:snapshot', snapshot);
  if (snapshot.persist) scheduleFogSave(snapshot.mapId, snapshot.dataUrl);
});

ipcMain.on('viewport:size', (_event, width: number, height: number) =>
  sendToDm('viewport:size', width, height),
);
ipcMain.on('viewport:pan', (_event, x: number, y: number) => sendToPlayer('viewport:pan', x, y));

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
          result.firstMap ??= added.entry;
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
ipcMain.handle('library:loadMapFog', async (_e, id: string) => {
  // A save may still be pending for this map: write it first so the read is current
  if (pendingFogSave?.mapId === id) await flushFogSave();
  return library.loadMapFog(id);
});
ipcMain.handle('library:saveMapView', async (_e, id: string, view: MapView) => library.saveMapView(id, view));
ipcMain.handle('library:renameMap', async (_e, id: string, name: string) => library.renameMap(id, name));
ipcMain.handle('library:removeMap', async (_e, id: string) => {
  // Don't let a late fog save recreate the deleted map's folder
  cancelFogSave(id);
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
    // Include fog painted in the last moment before exporting
    await flushFogSave();
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
  if (quitAfterFlush || !pendingFogSave) return;
  event.preventDefault();
  quitAfterFlush = true;
  void flushFogSave().finally(() => app.quit());
});

app.whenReady().then(() => {
  protocol.handle('map-media', async (request) => {
    const id = new URL(request.url).hostname;
    const mediaPath = library.isHandoutId(id)
      ? await library.resolveHandoutPath(id)
      : await library.resolveMapMediaPath(id);
    if (!mediaPath) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(mediaPath).href);
  });
  createDmWindow();
});

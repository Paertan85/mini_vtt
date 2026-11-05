import { app, nativeImage } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import type {
  HandoutMeta,
  LibrarySettings,
  LibrarySnapshot,
  MapEntryMeta,
  MapGrid,
  MapView,
  ProjectImportSummary,
  VideoCodec,
} from '../src/types/map';
import { normalizeCircles, normalizeGrid } from '../src/lib/grid';

// ─── On-disk map library ──────────────────────────────────────────────────────
//
// Everything lives under the Electron userData directory:
//
//   <userData>/library/index.json            settings + per-map metadata (small JSON)
//   <userData>/library/<id>/image.<ext>      the map's media file (image or WebM;
//                                            the name predates video support and is
//                                            kept so existing libraries still load)
//   <userData>/library/<id>/thumb.png        small panel preview
//   <userData>/library/<id>/fog.png          saved fog mask (optional)
//   <userData>/library/<id>/effects.png      painted effect layer (only once used)
//   <userData>/library/handouts/<id>/...     handouts, same layout
//
// Only the small JSON crosses the IPC boundary. Media is served to the windows
// through the map-media:// protocol; thumbnails and fog masks are returned as
// data URLs because they are small.

const LIBRARY_DIR = () => path.join(app.getPath('userData'), 'library');
const INDEX_FILE = () => path.join(LIBRARY_DIR(), 'index.json');
const mapDir = (id: string) => path.join(LIBRARY_DIR(), id);

// Ids are prefixed by kind, so the media protocol can tell maps from handouts
const MAP_ID_PREFIX = 'm_';
const HANDOUT_ID_PREFIX = 'h_';
const newId = (prefix: string) =>
  `${prefix}${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
export const isHandoutId = (id: string) => id.startsWith(HANDOUT_ID_PREFIX);

// Only allow ids we generated, so a corrupt index can't escape the library dir
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

// A removed map's or handout's folder is first renamed with this prefix, then
// deleted. The dot keeps it from ever matching an id.
const REMOVED_PREFIX = '.removed-';
// Folders no index entry points to are deleted at startup once they are this
// old, so an import that is still copying its file is never touched
const LEFTOVER_AGE_MS = 10 * 60 * 1000;

// Image extensions we accept, probed from magic bytes rather than trusting the
// filename
const EXTENSIONS = ['png', 'jpg', 'gif', 'webp', 'bmp', 'webm'] as const;

/** Derive the extension from the file's magic bytes. */
function detectExt(bytes: Buffer): 'png' | 'jpg' | 'gif' | 'webp' | 'bmp' | 'webm' | null {
  if (
    bytes.length > 4 &&
    bytes[0] === 0x1a &&
    bytes[1] === 0x45 &&
    bytes[2] === 0xdf &&
    bytes[3] === 0xa3 &&
    bytes.includes(Buffer.from('webm'))
  ) {
    return 'webm';
  }
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'png';
  }
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'jpg';
  }
  if (bytes.length > 6 && bytes.subarray(0, 3).toString('ascii') === 'GIF') {
    return 'gif';
  }
  if (
    bytes.length > 12 &&
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'webp';
  }
  if (bytes.length > 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
    return 'bmp';
  }
  return null;
}

const mimeFor = (ext: string) => {
  if (ext === 'jpg') return 'image/jpeg';
  if (ext === 'webm') return 'video/webm';
  return `image/${ext}`;
};
const toDataUrl = (bytes: Buffer, ext: string) => `data:${mimeFor(ext)};base64,${bytes.toString('base64')}`;

/** The content type of a library media file (named image.<ext> by its sniffed type). */
export const mediaMimeType = (filePath: string) => mimeFor(path.extname(filePath).slice(1));

// ─── Index read/write ─────────────────────────────────────────────────────────

interface IndexShape {
  settings: LibrarySettings;
  maps: MapEntryMeta[];
  handouts: HandoutMeta[];
}

async function readIndex(): Promise<IndexShape> {
  let raw: string;
  try {
    raw = await fs.readFile(INDEX_FILE(), 'utf8');
  } catch {
    // No index yet (first run) - start with an empty library
    return { settings: { ...DEFAULT_SETTINGS }, maps: [], handouts: [] };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<IndexShape>;
    return {
      settings: normalizeSettings(parsed.settings),
      handouts: (parsed.handouts ?? [])
        .filter((entry) => entry && typeof entry.id === 'string' && SAFE_ID.test(entry.id))
        .map((entry) => ({
          ...entry,
          rotation: Number.isInteger(entry.rotation) ? ((entry.rotation % 360) + 360) % 360 : 0,
        })),
      // Drop entries with a malformed id so a bad file can't escape the dir
      maps: (parsed.maps ?? [])
        .filter((m) => m && typeof m.id === 'string' && SAFE_ID.test(m.id))
        .map((m) => {
          const normalizedRotation = Number.isInteger(m.rotation) ? ((m.rotation % 360) + 360) % 360 : 0;
          return {
            ...m,
            mediaType: m.mediaType === 'video' ? 'video' : 'image',
            rotation: normalizedRotation % 90 === 0 ? normalizedRotation : 0,
            mirrorHorizontal: m.mirrorHorizontal === true,
            mirrorVertical: m.mirrorVertical === true,
            grid: normalizeGrid(m.grid),
            circles: normalizeCircles(m.circles),
          };
        }),
    };
  } catch (err) {
    // Unparseable index: keep a copy before the next save replaces it, so the
    // library can be recovered by hand instead of being silently lost
    const backup = `${INDEX_FILE()}.corrupt-${Date.now()}`;
    await fs.copyFile(INDEX_FILE(), backup).catch(() => undefined);
    console.error(`Library index is unreadable; backed up to ${backup}:`, err);
    return { settings: { ...DEFAULT_SETTINGS }, maps: [], handouts: [] };
  }
}

async function writeIndex(index: IndexShape): Promise<void> {
  await fs.mkdir(LIBRARY_DIR(), { recursive: true });
  // Write to a temp file then rename, so an interrupted write can't truncate it
  const tmp = `${INDEX_FILE()}.${process.pid}.${++tmpCounter}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(index, null, 2), 'utf8');
  await fs.rename(tmp, INDEX_FILE());
}

let tmpCounter = 0;

// ─── Serialized index access ──────────────────────────────────────────────────
//
// The renderer fires several saves at once (view state, fog flag, settings).
// Each one is a read-modify-write of index.json, so without serialization the
// last reader silently overwrites the others' changes. Every index access goes
// through this queue so they run strictly one after another.

let indexQueue: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = indexQueue.then(task);
  // Keep the queue alive after a failed task; the caller still sees the error
  indexQueue = run.catch(() => undefined);
  return run;
}

/** Read the index without modifying it (ordered after pending writes). */
function withIndex<T>(fn: (index: IndexShape) => T | Promise<T>): Promise<T> {
  return enqueue(async () => fn(await readIndex()));
}

/**
 * Read, modify and write the index as one atomic step. Return `false` from
 * `fn` to skip the write (nothing changed); any other value is passed through.
 */
function mutateIndex<T>(fn: (index: IndexShape) => T | Promise<T>): Promise<T> {
  return enqueue(async () => {
    const index = await readIndex();
    const result = await fn(index);
    if (result !== false) await writeIndex(index);
    return result;
  });
}

/** A positive finite number, or null. Accepts numeric strings from older libraries. */
const toPositiveNumber = (value: unknown): number | null => {
  const parsed = typeof value === 'string' ? parseFloat(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

/**
 * Validate stored settings. Libraries written before 1.1 stored the player
 * screen size as `playerViewDiagonal` and both numbers as strings.
 */
function normalizeSettings(stored: unknown): LibrarySettings {
  const raw = (stored && typeof stored === 'object' ? stored : {}) as Record<string, unknown>;
  const currentMapId =
    typeof raw.currentMapId === 'string' && SAFE_ID.test(raw.currentMapId) ? raw.currentMapId : null;
  const mapOrder = Array.isArray(raw.mapOrder)
    ? raw.mapOrder.filter((id): id is string => typeof id === 'string' && SAFE_ID.test(id))
    : undefined;
  return {
    currentMapId,
    playerScreenDiagonal: toPositiveNumber(raw.playerScreenDiagonal ?? raw.playerViewDiagonal),
    gridSize: toPositiveNumber(raw.gridSize) ?? DEFAULT_SETTINGS.gridSize,
    showEffectTools: raw.showEffectTools !== false,
    showLibrary: raw.showLibrary !== false,
    ...(mapOrder ? { mapOrder } : {}),
  };
}

const DEFAULT_SETTINGS: LibrarySettings = {
  currentMapId: null,
  playerScreenDiagonal: null,
  gridSize: 1,
  showEffectTools: true,
  showLibrary: true,
};

// ─── Public API ───────────────────────────────────────────────────────────────

/** Sort maps in place into display order: unordered maps newest first, then mapOrder. */
function sortMaps(maps: MapEntryMeta[], settings: LibrarySettings): MapEntryMeta[] {
  const rank = new Map((settings.mapOrder ?? []).map((id, index) => [id, index]));
  return maps.sort((a, b) => {
    const rankA = rank.get(a.id);
    const rankB = rank.get(b.id);
    if (rankA === undefined && rankB === undefined) return b.addedAt - a.addedAt;
    if (rankA === undefined) return -1;
    if (rankB === undefined) return 1;
    return rankA - rankB;
  });
}

export async function loadSnapshot(): Promise<LibrarySnapshot> {
  const { settings, maps, handouts } = await withIndex((index) => index);
  sortMaps(maps, settings);
  handouts.sort((a, b) => b.addedAt - a.addedAt);
  return { maps, handouts, settings };
}

const handoutsDir = () => path.join(LIBRARY_DIR(), 'handouts');
const handoutDir = (id: string) => path.join(handoutsDir(), id);

export async function addHandout(sourcePath: string): Promise<HandoutMeta | null> {
  const ext = detectExt(await readHeader(sourcePath));
  if (!ext || ext === 'webm') return null;

  const probe = nativeImage.createFromPath(sourcePath);
  if (probe.isEmpty()) return null;
  const size = probe.getSize();
  const id = newId(HANDOUT_ID_PREFIX);
  const dir = handoutDir(id);
  await fs.mkdir(dir, { recursive: true });
  await fs.copyFile(sourcePath, path.join(dir, `image.${ext}`));
  const thumb = makeThumb(probe);
  if (thumb) await fs.writeFile(path.join(dir, 'thumb.png'), thumb);

  const handout: HandoutMeta = {
    id,
    name: path.basename(sourcePath).replace(/\.[^.]+$/, ''),
    width: size.width,
    height: size.height,
    rotation: 0,
    addedAt: Date.now(),
  };
  await mutateIndex((index) => {
    index.handouts.push(handout);
  });
  return handout;
}

export async function resolveHandoutPath(id: string): Promise<string | null> {
  if (!SAFE_ID.test(id) || !isHandoutId(id)) return null;
  const dir = handoutDir(id);
  for (const ext of EXTENSIONS) {
    if (ext === 'webm') continue;
    const assetPath = path.join(dir, `image.${ext}`);
    try {
      await fs.access(assetPath);
      return assetPath;
    } catch {
      // Try the next supported image extension.
    }
  }
  return null;
}

export async function rotateHandout(id: string, rotation: number): Promise<boolean> {
  if (!SAFE_ID.test(id) || !isHandoutId(id)) return false;
  if (!Number.isFinite(rotation)) return false;
  return mutateIndex((index) => {
    const handout = index.handouts.find((entry) => entry.id === id);
    if (!handout) return false;
    handout.rotation = normalizeRotation(rotation);
    return true;
  });
}

export async function removeHandout(id: string): Promise<boolean> {
  if (!SAFE_ID.test(id) || !isHandoutId(id)) return false;
  return removeEntry(
    handoutDir(id),
    (index) => index.handouts.some((entry) => entry.id === id),
    (index) => {
      index.handouts = index.handouts.filter((entry) => entry.id !== id);
    },
  );
}

/**
 * Remove a map or handout: its folder first, then its index entry. The folder
 * is renamed aside before anything else changes. Windows refuses that while a
 * window still has a file in it open (a playing video); the DM window unloads
 * the map first, so a few short retries cover the moment until the windows
 * let go. If the folder stays in use, nothing has changed and this returns
 * false. Never throws.
 */
async function removeEntry(
  dir: string,
  listed: (index: IndexShape) => boolean,
  unlist: (index: IndexShape) => void,
): Promise<boolean> {
  try {
    if (!(await withIndex(listed))) return false;
    const aside = await setAside(dir);
    if (!aside) return false;
    try {
      await mutateIndex((index) => {
        unlist(index);
      });
    } catch (err) {
      // Put the folder back, so the entry that is still listed keeps its files
      if (aside.moved) await fs.rename(aside.moved, dir).catch(() => undefined);
      throw err;
    }
    // A failure here only leaves a set-aside folder, deleted at next startup
    if (aside.moved) await fs.rm(aside.moved, { recursive: true, force: true }).catch(() => undefined);
    return true;
  } catch (err) {
    console.error(`Failed to remove ${path.basename(dir)}:`, err);
    return false;
  }
}

const IN_USE_CODES = ['EBUSY', 'EPERM', 'EACCES'];
const SET_ASIDE_ATTEMPTS = 8;

/** Rename `dir` aside for deletion; null while a file in it stays in use. */
async function setAside(dir: string): Promise<{ moved: string | null } | null> {
  const target = path.join(path.dirname(dir), `${REMOVED_PREFIX}${path.basename(dir)}`);
  for (let attempt = 1; ; attempt++) {
    try {
      await fs.rename(dir, target);
      return { moved: target };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (code === 'ENOENT') return { moved: null }; // no files on disk: just unlist it
      if (!IN_USE_CODES.includes(code) || attempt === SET_ASIDE_ATTEMPTS) {
        console.error(`Couldn’t set ${dir} aside for deletion:`, err);
        return null;
      }
      // About 3 s in all
      await new Promise((resolve) => setTimeout(resolve, attempt * 100));
    }
  }
}

/**
 * Delete what earlier sessions left behind: folders set aside for deletion
 * that couldn't be deleted yet, and folders no index entry points to (from
 * versions before 1.2, which unlisted a map before deleting its folder, or an
 * import cut short by a crash). Unlisted folders are only deleted when the
 * index was read successfully and they haven't changed for a while, so a
 * damaged index or an import still copying never loses anything.
 */
export async function removeLeftovers(): Promise<void> {
  let listed: Set<string> | null = null;
  try {
    const parsed = JSON.parse(await fs.readFile(INDEX_FILE(), 'utf8')) as Partial<IndexShape>;
    if (Array.isArray(parsed.maps) && Array.isArray(parsed.handouts)) {
      listed = new Set([...parsed.maps, ...parsed.handouts].map((entry) => entry?.id));
    }
  } catch {
    // No index, or a damaged one: only delete folders that were set aside
  }
  const cutoff = Date.now() - LEFTOVER_AGE_MS;
  const places: [string, string][] = [
    [LIBRARY_DIR(), MAP_ID_PREFIX],
    [handoutsDir(), HANDOUT_ID_PREFIX],
  ];
  for (const [parent, prefix] of places) {
    let names: string[];
    try {
      names = await fs.readdir(parent);
    } catch {
      continue;
    }
    for (const name of names) {
      const dir = path.join(parent, name);
      try {
        const setAsideBefore = name.startsWith(REMOVED_PREFIX);
        const unlisted =
          listed !== null && name.startsWith(prefix) && SAFE_ID.test(name) && !listed.has(name);
        if (!setAsideBefore && !unlisted) continue;
        const stats = await fs.stat(dir);
        if (!stats.isDirectory() || (unlisted && stats.mtimeMs > cutoff)) continue;
        await fs.rm(dir, { recursive: true, force: true });
      } catch (err) {
        console.error(`Couldn’t delete the leftover folder ${dir}:`, err);
      }
    }
  }
}

export async function loadHandoutThumb(id: string): Promise<string | null> {
  if (!SAFE_ID.test(id) || !isHandoutId(id)) return null;
  try {
    const bytes = await fs.readFile(path.join(handoutDir(id), 'thumb.png'));
    return toDataUrl(bytes, 'png');
  } catch {
    return null;
  }
}

export async function reorderMaps(ids: string[]): Promise<boolean> {
  if (!Array.isArray(ids)) return false;
  return mutateIndex((index) => {
    if (
      ids.length !== index.maps.length ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => !index.maps.some((map) => map.id === id))
    ) {
      return false;
    }
    index.settings.mapOrder = [...ids];
    return true;
  });
}

/** Build a small PNG preview so the panel never decodes full-size maps. */
function makeThumb(img: Electron.NativeImage): Buffer | null {
  try {
    if (img.isEmpty()) return null;
    const { width } = img.getSize();
    const targetW = Math.min(240, width);
    const thumb = targetW < width ? img.resize({ width: targetW, quality: 'good' }) : img;
    return thumb.toPNG();
  } catch {
    // A preview is a nicety - never fail an import over it
    return null;
  }
}

const normalizeRotation = (rotation: number) => {
  const normalized = ((Math.round(rotation) % 360) + 360) % 360;
  return normalized % 90 === 0 ? normalized : 0;
};

/** Read the first few KB of a file so its type can be sniffed. */
async function readHeader(sourcePath: string): Promise<Buffer> {
  const file = await fs.open(sourcePath, 'r');
  try {
    const headerBuffer = Buffer.alloc(4096);
    const { bytesRead } = await file.read(headerBuffer, 0, headerBuffer.length, 0);
    return headerBuffer.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
}

export async function addMap(sourcePath: string): Promise<MapEntryMeta | null> {
  const ext = detectExt(await readHeader(sourcePath));
  if (!ext) return null;

  const id = newId(MAP_ID_PREFIX);
  const dir = mapDir(id);
  await fs.mkdir(dir, { recursive: true });

  const mediaPath = path.join(dir, `image.${ext}`);
  await fs.copyFile(sourcePath, mediaPath);

  // Decode straight from disk rather than buffering the whole file in JS
  const probe = ext === 'webm' ? null : nativeImage.createFromPath(mediaPath);
  const size = !probe || probe.isEmpty() ? { width: 0, height: 0 } : probe.getSize();
  const thumb = probe ? makeThumb(probe) : null;
  if (thumb) await fs.writeFile(path.join(dir, 'thumb.png'), thumb);

  const entry: MapEntryMeta = {
    id,
    name: path.basename(sourcePath).replace(/\.[^.]+$/, ''),
    mediaType: ext === 'webm' ? 'video' : 'image',
    width: size.width,
    height: size.height,
    zoom: 1,
    pan: { x: 0, y: 0 },
    rotation: 0,
    mirrorHorizontal: false,
    mirrorVertical: false,
    hasFog: false,
    grid: null,
    circles: [],
    addedAt: Date.now(),
  };
  await mutateIndex((index) => {
    index.maps.push(entry);
    index.settings = { ...index.settings, currentMapId: id };
  });
  return entry;
}

/** The video codec named in a WebM file's first bytes (its track header), or null. */
export function sniffVideoCodec(bytes: Buffer): VideoCodec | null {
  if (bytes.includes(Buffer.from('V_VP9'))) return 'vp9';
  if (bytes.includes(Buffer.from('V_AV1'))) return 'av1';
  if (bytes.includes(Buffer.from('V_VP8'))) return 'vp8';
  return null;
}

/** A video map's codec, read from the start of its file; null for images. */
export async function loadVideoCodec(id: string): Promise<VideoCodec | null> {
  const mediaPath = await resolveMapMediaPath(id);
  if (!mediaPath?.endsWith('.webm')) return null;
  const file = await fs.open(mediaPath, 'r');
  try {
    // The track header comes before any video data
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    return sniffVideoCodec(buffer.subarray(0, bytesRead));
  } catch {
    return null;
  } finally {
    await file.close();
  }
}

/** Read one of a map's assets, trying each known extension. */
async function findAsset(id: string, base: string): Promise<{ bytes: Buffer; ext: string } | null> {
  if (!SAFE_ID.test(id)) return null;
  for (const ext of EXTENSIONS) {
    try {
      return { bytes: await fs.readFile(path.join(mapDir(id), `${base}.${ext}`)), ext };
    } catch {
      // not this extension - try the next
    }
  }
  return null;
}

export async function resolveMapMediaPath(id: string): Promise<string | null> {
  if (!SAFE_ID.test(id)) return null;
  for (const ext of EXTENSIONS) {
    const assetPath = path.join(mapDir(id), `image.${ext}`);
    try {
      await fs.access(assetPath);
      return assetPath;
    } catch {
      // Try the next supported extension.
    }
  }
  return null;
}

export async function loadMapMediaUrl(id: string): Promise<string | null> {
  return (await resolveMapMediaPath(id)) ? `map-media://${id}` : null;
}

export async function loadMapThumb(id: string): Promise<string | null> {
  const found = await findAsset(id, 'thumb');
  return found ? toDataUrl(found.bytes, 'png') : null;
}

/**
 * Fog masks round-trip perfectly as PNG: the canvas holds a *binary* mask
 * (opaque where fog exists, transparent where revealed), and PNG is lossless.
 */
export async function loadMapFog(id: string): Promise<string | null> {
  const found = await findAsset(id, 'fog');
  return found ? toDataUrl(found.bytes, 'png') : null;
}

export async function saveMapFog(id: string, dataUrl: string): Promise<boolean> {
  if (!SAFE_ID.test(id)) return false;
  if (typeof dataUrl !== 'string') return false;
  const comma = dataUrl.indexOf(',');
  if (comma === -1) return false;
  // A late save for a map that was just deleted must not recreate its folder
  const exists = await withIndex((index) => index.maps.some((m) => m.id === id));
  if (!exists) return false;
  try {
    await fs.mkdir(mapDir(id), { recursive: true });
    const bytes = Buffer.from(dataUrl.slice(comma + 1), 'base64');
    if (detectExt(bytes) !== 'png') return false;
    await fs.writeFile(path.join(mapDir(id), 'fog.png'), bytes);
    await mutateIndex((index) => {
      const map = index.maps.find((m) => m.id === id);
      if (!map || map.hasFog) return false;
      map.hasFog = true;
      return true;
    });
    return true;
  } catch (err) {
    console.error('Failed to save fog mask:', err);
    return false;
  }
}

/** A map's painted effect layer as a PNG data URL, or null when it has none. */
export async function loadMapEffects(id: string): Promise<string | null> {
  if (!SAFE_ID.test(id)) return null;
  const bytes = await readOptional(path.join(mapDir(id), 'effects.png'));
  return bytes && detectExt(bytes) === 'png' ? toDataUrl(bytes, 'png') : null;
}

/** Save a map's effect layer; null removes it, so unused maps keep no file. */
export async function saveMapEffects(id: string, dataUrl: string | null): Promise<boolean> {
  if (!SAFE_ID.test(id) || isHandoutId(id)) return false;
  if (dataUrl !== null && typeof dataUrl !== 'string') return false;
  // A late save for a map that was just deleted must not recreate its folder
  const exists = await withIndex((index) => index.maps.some((m) => m.id === id));
  if (!exists) return false;
  const file = path.join(mapDir(id), 'effects.png');
  try {
    if (dataUrl === null) {
      await fs.rm(file, { force: true });
      return true;
    }
    const comma = dataUrl.indexOf(',');
    if (comma === -1) return false;
    const bytes = Buffer.from(dataUrl.slice(comma + 1), 'base64');
    if (detectExt(bytes) !== 'png') return false;
    await fs.writeFile(file, bytes);
    return true;
  } catch (err) {
    console.error('Failed to save effects:', err);
    return false;
  }
}

export async function saveMapView(id: string, view: MapView): Promise<boolean> {
  if (!SAFE_ID.test(id) || !view || typeof view !== 'object') return false;
  const { zoom, pan, rotation, mirrorHorizontal, mirrorVertical } = view;
  if (!Number.isFinite(zoom) || zoom <= 0) return false;
  // pan === null means the player frame was never positioned: keep the old value
  if (pan !== null && (!pan || !Number.isFinite(pan.x) || !Number.isFinite(pan.y))) return false;
  return mutateIndex((index) => {
    const map = index.maps.find((m) => m.id === id);
    if (!map) return false;
    map.zoom = zoom;
    if (pan) map.pan = { x: pan.x, y: pan.y };
    map.rotation = normalizeRotation(rotation);
    map.mirrorHorizontal = mirrorHorizontal === true;
    map.mirrorVertical = mirrorVertical === true;
    if (Array.isArray(view.circles)) map.circles = normalizeCircles(view.circles);
    return true;
  });
}

/** Save a map's measured grid; null removes the calibration. */
export async function saveMapGrid(id: string, grid: MapGrid | null): Promise<boolean> {
  if (!SAFE_ID.test(id)) return false;
  const clean = grid === null ? null : normalizeGrid(grid);
  if (grid !== null && !clean) return false;
  return mutateIndex((index) => {
    const map = index.maps.find((m) => m.id === id);
    if (!map) return false;
    map.grid = clean;
    return true;
  });
}

export async function renameMap(id: string, name: string): Promise<boolean> {
  if (!SAFE_ID.test(id) || typeof name !== 'string') return false;
  const trimmed = name.trim().slice(0, 80);
  if (!trimmed) return false;
  return mutateIndex((index) => {
    const map = index.maps.find((m) => m.id === id);
    if (!map) return false;
    map.name = trimmed;
    return true;
  });
}

/** Delete a map's folder and drop it from the index; false if its file is still in use. */
export async function removeMap(id: string): Promise<boolean> {
  if (!SAFE_ID.test(id)) return false;
  return removeEntry(
    mapDir(id),
    (index) => index.maps.some((m) => m.id === id),
    (index) => {
      index.maps = index.maps.filter((m) => m.id !== id);
      if (index.settings.currentMapId === id) index.settings.currentMapId = null;
      if (index.settings.mapOrder) {
        index.settings.mapOrder = index.settings.mapOrder.filter((entry) => entry !== id);
      }
    },
  );
}

/**
 * Apply a settings patch from the renderer. Only known keys with the expected
 * types are accepted; map order goes through reorderMaps instead.
 */
export async function saveSettings(patch: Partial<LibrarySettings>): Promise<boolean> {
  if (!patch || typeof patch !== 'object') return false;
  const clean: Partial<LibrarySettings> = {};
  if ('currentMapId' in patch) {
    const id = patch.currentMapId;
    if (id === null || (typeof id === 'string' && SAFE_ID.test(id))) clean.currentMapId = id;
  }
  if ('playerScreenDiagonal' in patch) {
    const diagonal = patch.playerScreenDiagonal;
    if (diagonal === null) clean.playerScreenDiagonal = null;
    else if (toPositiveNumber(diagonal) !== null) clean.playerScreenDiagonal = diagonal;
  }
  if (toPositiveNumber(patch.gridSize) !== null) clean.gridSize = patch.gridSize;
  if (typeof patch.showEffectTools === 'boolean') clean.showEffectTools = patch.showEffectTools;
  if (typeof patch.showLibrary === 'boolean') clean.showLibrary = patch.showLibrary;
  if (Object.keys(clean).length === 0) return false;
  await mutateIndex((index) => {
    index.settings = { ...index.settings, ...clean };
  });
  return true;
}

// ─── Project files ────────────────────────────────────────────────────────────
//
// A project file (.minivtt) carries the whole library to another computer in
// one file. Layout:
//
//   8 bytes   magic "MVTTPRJ1"
//   4 bytes   manifest length, uint32 little-endian
//   n bytes   manifest JSON (names, view state, settings, blob locations)
//   ...       blobs: media, thumbnails and fog masks, back to back
//
// Blob offsets are relative to the first byte after the manifest. Media is
// copied in fixed-size chunks in both directions, so even a large video never
// sits in memory whole. Importing adds new entries with fresh ids; nothing in
// the existing library is replaced.

const PROJECT_MAGIC = Buffer.from('MVTTPRJ1', 'ascii');
const PROJECT_HEADER_BYTES = PROJECT_MAGIC.length + 4;
const PROJECT_FORMAT = 'mini-vtt-project';
const PROJECT_VERSION = 1;
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_PROJECT_ENTRIES = 10_000;
// Thumbnails and fog masks are read into memory whole; fog masks are lossless
// PNGs of a binary mask, so they stay far below this even for huge maps
const MAX_SIDECAR_BYTES = 64 * 1024 * 1024;
const COPY_CHUNK_BYTES = 1024 * 1024;

/** A failure with a message that can be shown to the user as is. */
export class ProjectError extends Error {}

interface BlobRef {
  offset: number;
  size: number;
}

interface ProjectMapRecord {
  name: string;
  mediaType: MapEntryMeta['mediaType'];
  width: number;
  height: number;
  zoom: number;
  pan: MapEntryMeta['pan'];
  rotation: number;
  mirrorHorizontal: boolean;
  mirrorVertical: boolean;
  grid?: MapGrid | null;
  circles?: MapEntryMeta['circles'];
  media: BlobRef;
  thumb?: BlobRef;
  fog?: BlobRef;
  effects?: BlobRef;
}

interface ProjectHandoutRecord {
  name: string;
  width: number;
  height: number;
  rotation: number;
  media: BlobRef;
  thumb?: BlobRef;
}

interface ProjectManifest {
  format: typeof PROJECT_FORMAT;
  version: number;
  exportedAt: number;
  settings: Pick<LibrarySettings, 'playerScreenDiagonal' | 'gridSize'>;
  maps: ProjectMapRecord[];
  handouts: ProjectHandoutRecord[];
}

type FileHandle = fs.FileHandle;

async function writeAll(handle: FileHandle, bytes: Buffer, position: number): Promise<void> {
  let written = 0;
  while (written < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, written, bytes.length - written, position + written);
    written += bytesWritten;
  }
}

async function readExactly(handle: FileHandle, position: number, size: number): Promise<Buffer> {
  const bytes = Buffer.alloc(size);
  let done = 0;
  while (done < size) {
    const { bytesRead } = await handle.read(bytes, done, size - done, position + done);
    if (bytesRead === 0) throw new ProjectError('The project file is incomplete or damaged.');
    done += bytesRead;
  }
  return bytes;
}

/** Copy `size` bytes between open files through one reused chunk buffer. */
async function copyBytes(
  source: FileHandle,
  sourceStart: number,
  size: number,
  target: FileHandle,
  targetStart: number,
  chunk: Buffer,
): Promise<void> {
  let done = 0;
  while (done < size) {
    const { bytesRead } = await source.read(
      chunk,
      0,
      Math.min(chunk.length, size - done),
      sourceStart + done,
    );
    if (bytesRead === 0) throw new Error('File ended before all of it was copied');
    await writeAll(target, chunk.subarray(0, bytesRead), targetStart + done);
    done += bytesRead;
  }
}

async function readOptional(filePath: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(filePath);
  } catch {
    return null;
  }
}

/**
 * Write the whole library to `destPath`. Written to a temp file first, so a
 * failed export never leaves a half-written project behind.
 */
export async function exportProject(destPath: string): Promise<{ maps: number; handouts: number }> {
  const { maps, handouts, settings } = await loadSnapshot();

  type Source = { path: string; size: number } | { bytes: Buffer };
  const sources: Source[] = [];
  let dataSize = 0;
  const addSource = (source: Source): BlobRef => {
    const size = 'bytes' in source ? source.bytes.length : source.size;
    const ref = { offset: dataSize, size };
    sources.push(source);
    dataSize += size;
    return ref;
  };
  const addFile = async (filePath: string) =>
    addSource({ path: filePath, size: (await fs.stat(filePath)).size });
  const addOptionalPng = async (filePath: string) => {
    const bytes = await readOptional(filePath);
    return bytes && detectExt(bytes) === 'png' ? addSource({ bytes }) : undefined;
  };

  const manifest: ProjectManifest = {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    exportedAt: Date.now(),
    settings: { playerScreenDiagonal: settings.playerScreenDiagonal, gridSize: settings.gridSize },
    maps: [],
    handouts: [],
  };

  for (const map of maps) {
    const mediaPath = await resolveMapMediaPath(map.id);
    if (!mediaPath) continue; // media missing on disk: nothing to carry over
    const media = await addFile(mediaPath);
    const thumb = await addOptionalPng(path.join(mapDir(map.id), 'thumb.png'));
    const fog = map.hasFog ? await addOptionalPng(path.join(mapDir(map.id), 'fog.png')) : undefined;
    const effects = await addOptionalPng(path.join(mapDir(map.id), 'effects.png'));
    manifest.maps.push({
      name: map.name,
      mediaType: map.mediaType,
      width: map.width,
      height: map.height,
      zoom: map.zoom,
      pan: map.pan,
      rotation: map.rotation,
      mirrorHorizontal: map.mirrorHorizontal,
      mirrorVertical: map.mirrorVertical,
      grid: map.grid,
      circles: map.circles,
      media,
      ...(thumb ? { thumb } : {}),
      ...(fog ? { fog } : {}),
      ...(effects ? { effects } : {}),
    });
  }

  for (const handout of handouts) {
    const mediaPath = await resolveHandoutPath(handout.id);
    if (!mediaPath) continue;
    const media = await addFile(mediaPath);
    const thumb = await addOptionalPng(path.join(handoutDir(handout.id), 'thumb.png'));
    manifest.handouts.push({
      name: handout.name,
      width: handout.width,
      height: handout.height,
      rotation: handout.rotation,
      media,
      ...(thumb ? { thumb } : {}),
    });
  }

  if (manifest.maps.length === 0 && manifest.handouts.length === 0) {
    throw new ProjectError('The library is empty, so there is nothing to export.');
  }

  const manifestBytes = Buffer.from(JSON.stringify(manifest), 'utf8');
  const header = Buffer.alloc(PROJECT_HEADER_BYTES);
  PROJECT_MAGIC.copy(header);
  header.writeUInt32LE(manifestBytes.length, PROJECT_MAGIC.length);

  const tmp = `${destPath}.${process.pid}.${++tmpCounter}.tmp`;
  const out = await fs.open(tmp, 'w');
  try {
    await writeAll(out, header, 0);
    await writeAll(out, manifestBytes, header.length);
    let position = header.length + manifestBytes.length;
    const chunk = Buffer.alloc(COPY_CHUNK_BYTES);
    for (const source of sources) {
      if ('bytes' in source) {
        await writeAll(out, source.bytes, position);
        position += source.bytes.length;
      } else {
        const input = await fs.open(source.path, 'r');
        try {
          await copyBytes(input, 0, source.size, out, position, chunk);
        } finally {
          await input.close();
        }
        position += source.size;
      }
    }
    await out.close();
    await fs.rename(tmp, destPath);
  } catch (err) {
    await out.close().catch(() => undefined);
    await fs.rm(tmp, { force: true });
    throw err;
  }
  return { maps: manifest.maps.length, handouts: manifest.handouts.length };
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const cleanName = (value: unknown, fallback: string) => {
  const trimmed = typeof value === 'string' ? value.trim().slice(0, 80) : '';
  return trimmed || fallback;
};

const nonNegativeInt = (value: unknown) =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;

const finiteOr = (value: unknown, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

/**
 * Add everything in a project file to the library. The file is untrusted: every
 * field is validated, blob ranges must lie inside the file, and media types are
 * sniffed from the extracted bytes.
 */
export async function importProject(sourcePath: string): Promise<ProjectImportSummary> {
  const file = await fs.open(sourcePath, 'r');
  // Folders created so far; removed again unless the import is committed
  const created: string[] = [];
  try {
    const fileSize = (await file.stat()).size;
    if (fileSize < PROJECT_HEADER_BYTES) throw new ProjectError('This isn’t a Mini VTT project file.');
    const header = await readExactly(file, 0, PROJECT_HEADER_BYTES);
    if (!header.subarray(0, PROJECT_MAGIC.length).equals(PROJECT_MAGIC)) {
      throw new ProjectError('This isn’t a Mini VTT project file.');
    }
    const manifestLength = header.readUInt32LE(PROJECT_MAGIC.length);
    if (manifestLength > MAX_MANIFEST_BYTES || PROJECT_HEADER_BYTES + manifestLength > fileSize) {
      throw new ProjectError('The project file is incomplete or damaged.');
    }
    let manifest: Record<string, unknown>;
    try {
      manifest = asRecord(
        JSON.parse((await readExactly(file, PROJECT_HEADER_BYTES, manifestLength)).toString('utf8')),
      );
    } catch {
      throw new ProjectError('The project file is incomplete or damaged.');
    }
    if (manifest.format !== PROJECT_FORMAT || typeof manifest.version !== 'number') {
      throw new ProjectError('This isn’t a Mini VTT project file.');
    }
    if (manifest.version > PROJECT_VERSION) {
      throw new ProjectError(
        'This project was saved by a newer version of Mini VTT. Update the app to open it.',
      );
    }

    const dataStart = PROJECT_HEADER_BYTES + manifestLength;
    const dataSize = fileSize - dataStart;
    const blob = (value: unknown): BlobRef | null => {
      const { offset, size } = asRecord(value);
      if (typeof offset !== 'number' || typeof size !== 'number') return null;
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size)) return null;
      if (offset < 0 || size <= 0 || offset + size > dataSize) return null;
      return { offset, size };
    };
    const entries = (value: unknown) => (Array.isArray(value) ? value.slice(0, MAX_PROJECT_ENTRIES) : []);
    const chunk = Buffer.alloc(COPY_CHUNK_BYTES);

    /** Extract a media blob into `dir` and return its sniffed extension, or null. */
    const extractMedia = async (ref: BlobRef, dir: string) => {
      const tmp = path.join(dir, 'media.tmp');
      const out = await fs.open(tmp, 'w');
      try {
        await copyBytes(file, dataStart + ref.offset, ref.size, out, 0, chunk);
      } finally {
        await out.close();
      }
      const ext = detectExt(await readHeader(tmp));
      if (ext) await fs.rename(tmp, path.join(dir, `image.${ext}`));
      return ext;
    };
    /** A small PNG blob (thumbnail or fog), or null if missing or not a PNG. */
    const readPng = async (value: unknown) => {
      const ref = blob(value);
      if (!ref || ref.size > MAX_SIDECAR_BYTES) return null;
      const bytes = await readExactly(file, dataStart + ref.offset, ref.size);
      return detectExt(bytes) === 'png' ? bytes : null;
    };
    const writeThumb = async (dir: string, ext: string, stored: unknown) => {
      let thumb = await readPng(stored);
      if (!thumb && ext !== 'webm')
        thumb = makeThumb(nativeImage.createFromPath(path.join(dir, `image.${ext}`)));
      if (thumb) await fs.writeFile(path.join(dir, 'thumb.png'), thumb);
    };
    /** Make a folder for a new entry and extract its media; null if unusable. */
    const extractEntry = async (dir: string, media: BlobRef | null, allowVideo: boolean) => {
      if (!media) return null;
      await fs.mkdir(dir, { recursive: true });
      created.push(dir);
      const ext = await extractMedia(media, dir);
      if (ext && (allowVideo || ext !== 'webm')) return ext;
      await fs.rm(dir, { recursive: true, force: true });
      created.pop();
      return null;
    };

    const now = Date.now();
    let skipped = 0;

    const newMaps: MapEntryMeta[] = [];
    for (const raw of entries(manifest.maps)) {
      const record = asRecord(raw);
      const id = newId(MAP_ID_PREFIX);
      const dir = mapDir(id);
      const ext = await extractEntry(dir, blob(record.media), true);
      if (!ext) {
        skipped += 1;
        continue;
      }
      await writeThumb(dir, ext, record.thumb);
      const fog = await readPng(record.fog);
      if (fog) await fs.writeFile(path.join(dir, 'fog.png'), fog);
      // Optional field: files from before effects existed simply have none
      const effects = await readPng(record.effects);
      if (effects) await fs.writeFile(path.join(dir, 'effects.png'), effects);
      const pan = asRecord(record.pan);
      const zoom = finiteOr(record.zoom, 1);
      newMaps.push({
        id,
        name: cleanName(record.name, 'Imported map'),
        mediaType: ext === 'webm' ? 'video' : 'image',
        width: nonNegativeInt(record.width),
        height: nonNegativeInt(record.height),
        zoom: zoom > 0 ? zoom : 1,
        pan: { x: finiteOr(pan.x, 0), y: finiteOr(pan.y, 0) },
        rotation: normalizeRotation(finiteOr(record.rotation, 0)),
        mirrorHorizontal: record.mirrorHorizontal === true,
        mirrorVertical: record.mirrorVertical === true,
        hasFog: !!fog,
        // Optional fields: files from before calibration simply have none
        grid: normalizeGrid(record.grid),
        circles: normalizeCircles(record.circles),
        addedAt: now,
      });
    }

    const newHandouts: HandoutMeta[] = [];
    for (const raw of entries(manifest.handouts)) {
      const record = asRecord(raw);
      const id = newId(HANDOUT_ID_PREFIX);
      const dir = handoutDir(id);
      const ext = await extractEntry(dir, blob(record.media), false);
      if (!ext) {
        skipped += 1;
        continue;
      }
      await writeThumb(dir, ext, record.thumb);
      newHandouts.push({
        id,
        name: cleanName(record.name, 'Imported handout'),
        width: nonNegativeInt(record.width),
        height: nonNegativeInt(record.height),
        rotation: normalizeRotation(finiteOr(record.rotation, 0)),
        // Handouts are listed newest first: this keeps the file's order
        addedAt: now - newHandouts.length,
      });
    }

    if (newMaps.length === 0 && newHandouts.length === 0) {
      throw new ProjectError('Nothing in this project file could be imported.');
    }

    // Returns an object: a bare `false` would tell mutateIndex to skip the write
    const { settingsApplied } = await mutateIndex((index) => {
      const wasEmpty = index.maps.length === 0 && index.handouts.length === 0;
      // Imported maps go on top, in the order they had on the other computer
      const existingOrder = sortMaps([...index.maps], index.settings).map((map) => map.id);
      index.maps.push(...newMaps);
      index.handouts.push(...newHandouts);
      index.settings.mapOrder = [...newMaps.map((map) => map.id), ...existingOrder];
      const current = index.settings.currentMapId;
      if (!current || !index.maps.some((map) => map.id === current)) {
        index.settings.currentMapId = newMaps[0]?.id ?? null;
      }
      // Player screen settings belong to the screen, so only a fresh library takes them
      if (wasEmpty) {
        const imported = normalizeSettings(manifest.settings);
        index.settings.playerScreenDiagonal = imported.playerScreenDiagonal;
        index.settings.gridSize = imported.gridSize;
      }
      return { settingsApplied: wasEmpty };
    });
    created.length = 0;

    return {
      maps: newMaps.length,
      handouts: newHandouts.length,
      skipped,
      settingsApplied,
      firstMap: newMaps[0] ?? null,
    };
  } finally {
    await file.close();
    for (const dir of created) await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

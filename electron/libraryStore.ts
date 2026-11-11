// The library folder and its index: where every map's and handout's files
// live, and index.json, read and written one change at a time.
//
//   <userData>/library/index.json            settings + per-map metadata (small JSON)
//   <userData>/library/<id>/image.<ext>      the map's media file (image or WebM;
//                                            the name predates video support and is
//                                            kept so existing libraries still load)
//   <userData>/library/<id>/thumb.png        small panel preview
//   <userData>/library/<id>/fog.png          saved fog mask (optional)
//   <userData>/library/<id>/effects.png      painted effect layer (only once used)
//   <userData>/library/handouts/<id>/...     handouts, same layout

import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import type { HandoutMeta, LibrarySettings, LibrarySnapshot, MapEntryMeta } from '../src/types/map';
import { DEFAULT_SETTINGS, LIBRARY_ID, normalizeSettings } from '../src/lib/settings';
import { EXTENSIONS } from './mediaFiles';
import { normalizeAreas } from '../src/lib/areas';
import { normalizeRooms } from '../src/lib/rooms';
import { normalizeGrid } from '../src/lib/grid';

export const LIBRARY_DIR = () => path.join(app.getPath('userData'), 'library');
export const INDEX_FILE = () => path.join(LIBRARY_DIR(), 'index.json');
export const mapDir = (id: string) => path.join(LIBRARY_DIR(), id);

// Ids are prefixed by kind, so the media protocol can tell maps from handouts
export const MAP_ID_PREFIX = 'm_';
export const HANDOUT_ID_PREFIX = 'h_';
export const newId = (prefix: string) =>
  `${prefix}${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
export const isHandoutId = (id: string) => id.startsWith(HANDOUT_ID_PREFIX);

// Only allow ids we generated, so a corrupt index can't escape the library dir
export const SAFE_ID = LIBRARY_ID;

export const handoutsDir = () => path.join(LIBRARY_DIR(), 'handouts');
export const handoutDir = (id: string) => path.join(handoutsDir(), id);

/** Errors Windows gives while another program (antivirus, the search indexer) has a file open. */
export const IN_USE_CODES = ['EBUSY', 'EPERM', 'EACCES'];
const RENAME_ATTEMPTS = 6;

/**
 * Rename `from` over `to`. Windows refuses while another program has `to`
 * open, usually for a moment, so that is tried again a few times (about 0.75 s
 * in all) before giving up.
 */
async function renameOver(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fs.rename(from, to);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (!IN_USE_CODES.includes(code) || attempt === RENAME_ATTEMPTS) throw err;
      await new Promise((resolve) => setTimeout(resolve, attempt * 50));
    }
  }
}

/**
 * Replace `file` with `bytes` in one step: written next to it, then renamed
 * over it, so a reader or a crash never meets a half-written file.
 */
export async function writeFileAtomic(file: string, bytes: Buffer): Promise<void> {
  const tmp = tempPath(file);
  try {
    await fs.writeFile(tmp, bytes);
    await renameOver(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
}

// ─── Index read/write ─────────────────────────────────────────────────────────

export interface IndexShape {
  settings: LibrarySettings;
  maps: MapEntryMeta[];
  handouts: HandoutMeta[];
}

/** A damaged index is copied to `index.json.corrupt-<time>` before anything replaces it. */
export const CORRUPT_INDEX_SUFFIX = '.corrupt-';

/** Tries after the first at reading an index another program holds (0.1 + 0.2 + 0.3 s). */
const INDEX_READ_RETRIES = 3;

async function readIndex(): Promise<IndexShape> {
  let raw: string | null = null;
  for (let attempt = 0; raw === null; attempt++) {
    try {
      raw = await fs.readFile(INDEX_FILE(), 'utf8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // No index yet (first run): start with an empty library
      if (code === 'ENOENT') return { settings: { ...DEFAULT_SETTINGS }, maps: [], handouts: [] };
      // Anything else must never look like an empty library: the next save
      // would write it, and removeLeftovers would then delete every folder.
      // A virus scanner or backup holds a file for a moment: try again first.
      const locked = code === 'EBUSY' || code === 'EPERM' || code === 'EACCES';
      if (!locked || attempt >= INDEX_READ_RETRIES) throw err;
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
    }
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
            circles: normalizeAreas(m.circles),
            rooms: normalizeRooms(m.rooms),
          };
        }),
    };
  } catch (err) {
    // Unparseable index: keep a copy before the next save replaces it, so the
    // library can be recovered by hand instead of being silently lost. While
    // the copy is there, removeLeftovers deletes no unlisted folder: they hold
    // the maps the damaged index listed. Without a copy nothing would keep
    // them, so starting empty is then an error instead.
    const backup = `${INDEX_FILE()}${CORRUPT_INDEX_SUFFIX}${Date.now()}`;
    try {
      await fs.copyFile(INDEX_FILE(), backup);
    } catch (copyErr) {
      console.error('Library index is unreadable and couldn’t be backed up:', copyErr);
      throw err;
    }
    console.error(`Library index is unreadable; backed up to ${backup}:`, err);
    return { settings: { ...DEFAULT_SETTINGS }, maps: [], handouts: [] };
  }
}

async function writeIndex(index: IndexShape): Promise<void> {
  await fs.mkdir(LIBRARY_DIR(), { recursive: true });
  // Write to a temp file then rename, so an interrupted write can't truncate it
  const tmp = tempPath(INDEX_FILE());
  try {
    await fs.writeFile(tmp, JSON.stringify(index, null, 2), 'utf8');
    await renameOver(tmp, INDEX_FILE());
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
}

let tmpCounter = 0;

/** A name for a temporary file next to `file`, unique in this process. */
export const tempPath = (file: string) => `${file}.${process.pid}.${++tmpCounter}.tmp`;

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
export function withIndex<T>(fn: (index: IndexShape) => T | Promise<T>): Promise<T> {
  return enqueue(async () => fn(await readIndex()));
}

/**
 * Read, modify and write the index as one atomic step. Return `false` from
 * `fn` to skip the write (nothing changed); any other value is passed through.
 */
export function mutateIndex<T>(fn: (index: IndexShape) => T | Promise<T>): Promise<T> {
  return enqueue(async () => {
    const index = await readIndex();
    const result = await fn(index);
    if (result !== false) await writeIndex(index);
    return result;
  });
}

/**
 * The rotation for a map or handout being added: one taller than wide is
 * turned as the settings ask, so it lies along the player screen. Square and
 * wider images already fit a landscape screen.
 */
export const rotationForNew = (size: { width: number; height: number }, settings: LibrarySettings) =>
  size.height > size.width ? settings.portraitRotation : 0;

/** Sort maps in place into display order: unordered maps newest first, then mapOrder. */
export function sortMaps(maps: MapEntryMeta[], settings: LibrarySettings): MapEntryMeta[] {
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

export const normalizeRotation = (rotation: number) => {
  const normalized = ((Math.round(rotation) % 360) + 360) % 360;
  return normalized % 90 === 0 ? normalized : 0;
};

export async function readOptional(filePath: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(filePath);
  } catch {
    return null;
  }
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

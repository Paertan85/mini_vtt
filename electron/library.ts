// The map library: adding, changing and removing maps and handouts, and
// their thumbnails, fog and effect layers. The folder layout and index.json
// are in libraryStore.ts, reading media files in mediaFiles.ts, and project
// files (the whole library in one file) in project.ts.
//
// Only the small JSON crosses the IPC boundary. Media is served to the windows
// through the map-media:// protocol; thumbnails and fog masks are returned as
// data URLs because they are small.

import { nativeImage } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import type { HandoutMeta, MapEntryMeta, MapGrid, MapView, VideoCodec } from '../src/types/map';
import { cellFromNames, DEFAULT_FEET_PER_CELL, NAME_FOLDER_LEVELS, normalizeGrid } from '../src/lib/grid';
import { normalizeAreas } from '../src/lib/areas';
import { mediaUrlOf } from '../src/lib/media';
import { cleanSettingsPatch } from '../src/lib/settings';
import {
  HANDOUT_ID_PREFIX,
  INDEX_FILE,
  LIBRARY_DIR,
  MAP_ID_PREFIX,
  SAFE_ID,
  handoutDir,
  handoutsDir,
  isHandoutId,
  mapDir,
  mutateIndex,
  newId,
  normalizeRotation,
  readOptional,
  resolveMapMediaPath,
  rotationForNew,
  withIndex,
  writeFileAtomic,
  type IndexShape,
} from './libraryStore';
import {
  EXTENSIONS,
  HEADER_BYTES,
  detectExt,
  isCompletePng,
  makeThumb,
  readHeader,
  readJpegOrientation,
  readVideoSize,
  shownImageSize,
  sniffVideoCodec,
  toDataUrl,
} from './mediaFiles';

// The library's API, for main.ts and the tests, in one place
export { isHandoutId, loadSnapshot, resolveHandoutPath, resolveMapMediaPath } from './libraryStore';
export {
  byteRange,
  mediaMimeType,
  orientedSource,
  readImageSize,
  readJpegOrientation,
  readVideoSize,
  sniffVideoCodec,
} from './mediaFiles';
export { exportProject, importProject, ProjectError } from './project';

// A removed map's or handout's folder is first renamed with this prefix, then
// deleted. The dot keeps it from ever matching an id.
const REMOVED_PREFIX = '.removed-';
// Folders no index entry points to are deleted at startup once they are this
// old, so an import that is still copying its file is never touched
const LEFTOVER_AGE_MS = 10 * 60 * 1000;

export async function addHandout(sourcePath: string): Promise<HandoutMeta | null> {
  const header = await readHeader(sourcePath, HEADER_BYTES);
  const ext = detectExt(header);
  if (!ext || ext === 'webm') return null;

  const probe = nativeImage.createFromPath(sourcePath);
  const size = shownImageSize(probe, header, ext);
  if (!size) return null;
  const id = newId(HANDOUT_ID_PREFIX);
  const dir = handoutDir(id);
  await fs.mkdir(dir, { recursive: true });
  await fs.copyFile(sourcePath, path.join(dir, `image.${ext}`));
  // GIF, WebP and BMP get no preview: this process can't decode them
  const thumb = makeThumb(probe, ext === 'jpg' ? readJpegOrientation(header) : 1);
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
    handout.rotation = rotationForNew(size, index.settings);
    index.handouts.push(handout);
  });
  return handout;
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

/** A drawn thumbnail is a small PNG: anything bigger is refused */
const MAX_THUMB_BYTES = 2 * 1024 * 1024;
const MAX_THUMB_EDGE = 4096;

/**
 * Keep a thumbnail the DM window drew for a map or handout without one (this
 * process can't decode GIF, WebP or BMP). It must be a small PNG, for an
 * entry in the library, and never replaces a thumbnail already there.
 */
export async function saveThumb(id: unknown, png: unknown): Promise<boolean> {
  if (typeof id !== 'string' || !SAFE_ID.test(id)) return false;
  if (!(png instanceof Uint8Array) || png.length === 0 || png.length > MAX_THUMB_BYTES) return false;
  const bytes = Buffer.from(png.buffer, png.byteOffset, png.byteLength);
  if (detectExt(bytes) !== 'png') return false;
  const image = nativeImage.createFromBuffer(bytes);
  const { width, height } = image.getSize();
  if (image.isEmpty() || width > MAX_THUMB_EDGE || height > MAX_THUMB_EDGE) return false;
  const handout = isHandoutId(id);
  const listed = await withIndex((index) =>
    handout ? index.handouts.some((entry) => entry.id === id) : index.maps.some((m) => m.id === id),
  );
  if (!listed) return false;
  try {
    // 'wx': fails if the file exists, so a thumbnail is never replaced
    await fs.writeFile(path.join(handout ? handoutDir(id) : mapDir(id), 'thumb.png'), bytes, { flag: 'wx' });
    return true;
  } catch {
    return false;
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

/**
 * The grid a map's file or folder names give (`forest_32x32/map.jpg`,
 * `Saltmarsh (170x140).jpg`, `Crypt 140ppi.jpg`), lined up with the image's
 * top-left corner, or null.
 */
export function gridFromPath(sourcePath: string, size: { width: number; height: number }): MapGrid | null {
  const names = [path.basename(sourcePath).replace(/\.[^.]+$/, '')];
  let dir = path.dirname(sourcePath);
  while (names.length <= NAME_FOLDER_LEVELS && path.dirname(dir) !== dir) {
    names.push(path.basename(dir));
    dir = path.dirname(dir);
  }
  const cell = cellFromNames(names, size.width, size.height);
  return cell === null
    ? null
    : normalizeGrid({ cell, offsetX: 0, offsetY: 0, feetPerCell: DEFAULT_FEET_PER_CELL });
}

export async function addMap(sourcePath: string): Promise<MapEntryMeta | null> {
  const header = await readHeader(sourcePath, HEADER_BYTES);
  const ext = detectExt(header);
  if (!ext) return null;

  const id = newId(MAP_ID_PREFIX);
  const dir = mapDir(id);
  await fs.mkdir(dir, { recursive: true });

  const mediaPath = path.join(dir, `image.${ext}`);
  await fs.copyFile(sourcePath, mediaPath);

  // Decode straight from disk rather than buffering the whole file in JS; a
  // video's size comes from its track header
  const probe = ext === 'webm' ? null : nativeImage.createFromPath(mediaPath);
  const size = (probe ? shownImageSize(probe, header, ext) : readVideoSize(header)) ?? {
    width: 0,
    height: 0,
  };
  const thumb = probe ? makeThumb(probe, ext === 'jpg' ? readJpegOrientation(header) : 1) : null;
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
    grid: gridFromPath(sourcePath, size),
    circles: [],
    addedAt: Date.now(),
  };
  await mutateIndex((index) => {
    entry.rotation = rotationForNew(size, index.settings);
    index.maps.push(entry);
  });
  return entry;
}

/** A video map's codec, read from the start of its file; null for images. */
export async function loadVideoCodec(id: string): Promise<VideoCodec | null> {
  const mediaPath = await resolveMapMediaPath(id);
  if (!mediaPath?.endsWith('.webm')) return null;
  try {
    return sniffVideoCodec(await readHeader(mediaPath, HEADER_BYTES));
  } catch {
    return null;
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

export async function loadMapMediaUrl(id: string): Promise<string | null> {
  return (await resolveMapMediaPath(id)) ? mediaUrlOf(id) : null;
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
  if (!SAFE_ID.test(id)) return null;
  const bytes = await readOptional(path.join(mapDir(id), 'fog.png'));
  return bytes && isCompletePng(bytes) ? toDataUrl(bytes, 'png') : null;
}

/** The PNG in a data URL, or null if it isn't a complete PNG. */
function pngFromDataUrl(dataUrl: unknown): Buffer | null {
  if (typeof dataUrl !== 'string') return null;
  const comma = dataUrl.indexOf(',');
  if (comma === -1) return null;
  const bytes = Buffer.from(dataUrl.slice(comma + 1), 'base64');
  return isCompletePng(bytes) ? bytes : null;
}

export async function saveMapFog(id: string, dataUrl: string): Promise<boolean> {
  if (!SAFE_ID.test(id)) return false;
  const bytes = pngFromDataUrl(dataUrl);
  if (!bytes) return false;
  // A late save for a map that was just deleted must not recreate its folder
  // (nor does the write: it fails once the folder is gone)
  const exists = await withIndex((index) => index.maps.some((m) => m.id === id));
  if (!exists) return false;
  try {
    await writeFileAtomic(path.join(mapDir(id), 'fog.png'), bytes);
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
  return bytes && isCompletePng(bytes) ? toDataUrl(bytes, 'png') : null;
}

/** Save a map's effect layer; null removes it, so unused maps keep no file. */
export async function saveMapEffects(id: string, dataUrl: string | null): Promise<boolean> {
  if (!SAFE_ID.test(id) || isHandoutId(id)) return false;
  const bytes = dataUrl === null ? null : pngFromDataUrl(dataUrl);
  if (dataUrl !== null && !bytes) return false;
  // A late save for a map that was just deleted must not recreate its folder
  const exists = await withIndex((index) => index.maps.some((m) => m.id === id));
  if (!exists) return false;
  const file = path.join(mapDir(id), 'effects.png');
  try {
    if (bytes) await writeFileAtomic(file, bytes);
    else await fs.rm(file, { force: true });
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
    if (Array.isArray(view.circles)) map.circles = normalizeAreas(view.circles);
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
 * Apply a settings change from the renderer. Only known settings with valid
 * values are taken (see src/lib/settings.ts); map order goes through
 * reorderMaps instead.
 */
export async function saveSettings(patch: unknown): Promise<boolean> {
  const clean = cleanSettingsPatch(patch);
  if (Object.keys(clean).length === 0) return false;
  await mutateIndex((index) => {
    index.settings = { ...index.settings, ...clean };
  });
  return true;
}

import { app, nativeImage } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { type Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';
import * as yauzl from 'yauzl';
import * as yazl from 'yazl';
import type {
  SpellArea,
  HandoutMeta,
  LibrarySettings,
  LibrarySnapshot,
  MapEntryMeta,
  MapGrid,
  MapView,
  ProjectImportSummary,
  VideoCodec,
} from '../src/types/map';
import { cellFromNames, DEFAULT_FEET_PER_CELL, NAME_FOLDER_LEVELS, normalizeGrid } from '../src/lib/grid';
import { type AreaReport, normalizeAreas } from '../src/lib/areas';
import { EFFECT_STYLES } from '../src/lib/effects';
import { mediaUrlOf } from '../src/lib/media';
import { cleanSettingsPatch, DEFAULT_SETTINGS, LIBRARY_ID, normalizeSettings } from '../src/lib/settings';

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
const SAFE_ID = LIBRARY_ID;

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

// Every PNG ends with this chunk (length 0, "IEND", its CRC)
const PNG_END = Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);

/**
 * A PNG with its end intact. Chromium shows a PNG cut short (a write cut off
 * by a crash or power loss) without an error, its missing rows transparent:
 * in a fog mask that is revealed map. So a fog or effect layer is only used
 * when it is complete; otherwise the map starts fully fogged.
 */
export const isCompletePng = (bytes: Buffer) =>
  detectExt(bytes) === 'png' &&
  bytes.length >= PNG_END.length &&
  bytes.subarray(-PNG_END.length).equals(PNG_END);

/**
 * Replace `file` with `bytes` in one step: written next to it, then renamed
 * over it, so a reader or a crash never meets a half-written file.
 */
async function writeFileAtomic(file: string, bytes: Buffer): Promise<void> {
  const tmp = `${file}.${process.pid}.${++tmpCounter}.tmp`;
  try {
    await fs.writeFile(tmp, bytes);
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
}

const mimeFor = (ext: string) => {
  if (ext === 'jpg') return 'image/jpeg';
  if (ext === 'webm') return 'video/webm';
  return `image/${ext}`;
};
const toDataUrl = (bytes: Buffer, ext: string) => `data:${mimeFor(ext)};base64,${bytes.toString('base64')}`;

/** The content type of a library media file (named image.<ext> by its sniffed type). */
export const mediaMimeType = (filePath: string) => mimeFor(path.extname(filePath).slice(1));

/**
 * The bytes a `Range` header asks for, in a file of `size` bytes: null for
 * the whole file (no header, or one that isn't a single byte range), or
 * 'unsatisfiable' when it starts past the end.
 *
 * Chromium asks a video for "the rest from byte N" when it resumes loading or
 * loops, and takes the reply to start at N. Answering with the whole file
 * puts the file's start in the wrong place, and the decoder shows garbage.
 */
export function byteRange(
  header: string | null,
  size: number,
): { start: number; end: number } | 'unsatisfiable' | null {
  const match = header ? /^bytes=(\d*)-(\d*)$/.exec(header.trim()) : null;
  if (!match || (!match[1] && !match[2])) return null;
  const first = match[1] ? Number(match[1]) : null;
  const last = match[2] ? Number(match[2]) : null;
  if ((first !== null && !Number.isSafeInteger(first)) || (last !== null && !Number.isSafeInteger(last))) {
    return null;
  }
  if (first === null) {
    // "bytes=-500": the last 500 bytes
    if (last === 0 || size === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - (last ?? 0)), end: size - 1 };
  }
  if (first >= size) return 'unsatisfiable';
  if (last !== null && last < first) return null;
  return { start: first, end: last === null ? size - 1 : Math.min(last, size - 1) };
}

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
            circles: normalizeAreas(m.circles),
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

/**
 * The rotation for a map or handout being added: one taller than wide is
 * turned as the settings ask, so it lies along the player screen. Square and
 * wider images already fit a landscape screen.
 */
const rotationForNew = (size: { width: number; height: number }, settings: LibrarySettings) =>
  size.height > size.width ? settings.portraitRotation : 0;

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
 * Build a small PNG preview so the panel never decodes full-size maps, turned
 * upright by a JPEG's EXIF orientation as the windows show the image.
 */
function makeThumb(img: Electron.NativeImage, orientation = 1): Buffer | null {
  try {
    if (img.isEmpty()) return null;
    const { width } = img.getSize();
    const targetW = Math.min(240, width);
    const thumb = targetW < width ? img.resize({ width: targetW, quality: 'good' }) : img;
    return orient(thumb, orientation).toPNG();
  } catch {
    // A preview is a nicety - never fail an import over it
    return null;
  }
}

/**
 * Where pixel (x, y) of an image shown with EXIF `orientation` comes from in
 * the stored `w` × `h` image. Orientations 5 to 8 swap width and height.
 */
export function orientedSource(orientation: number, x: number, y: number, w: number, h: number) {
  switch (orientation) {
    case 2: // mirrored left to right
      return { x: w - 1 - x, y };
    case 3: // upside down
      return { x: w - 1 - x, y: h - 1 - y };
    case 4: // mirrored top to bottom
      return { x, y: h - 1 - y };
    case 5: // mirrored along the diagonal
      return { x: y, y: x };
    case 6: // turned right to be shown
      return { x: y, y: h - 1 - x };
    case 7: // mirrored along the other diagonal
      return { x: w - 1 - y, y: h - 1 - x };
    case 8: // turned left to be shown
      return { x: w - 1 - y, y: x };
    default:
      return { x, y };
  }
}

/** Turn a small image (a thumbnail) the way its EXIF orientation says it is shown. */
function orient(image: Electron.NativeImage, orientation: number): Electron.NativeImage {
  if (orientation < 2 || orientation > 8) return image;
  const { width: w, height: h } = image.getSize();
  const source = image.toBitmap();
  if (source.length !== w * h * 4) return image; // not a plain 4-byte-per-pixel bitmap
  const sideways = orientation >= 5;
  const outW = sideways ? h : w;
  const outH = sideways ? w : h;
  const out = Buffer.alloc(source.length);
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      const from = orientedSource(orientation, x, y, w, h);
      const at = (from.y * w + from.x) * 4;
      source.copy(out, (y * outW + x) * 4, at, at + 4);
    }
  }
  return nativeImage.createFromBitmap(out, { width: outW, height: outH });
}

/** A JPEG's EXIF orientation (1 to 8) from its first bytes; 1 when it has none. */
export function readJpegOrientation(bytes: Buffer): number {
  try {
    for (let at = 2; at + 4 <= bytes.length && bytes[at] === 0xff;) {
      const marker = bytes[at + 1];
      if (marker === 0xda || marker === 0xd9) break; // the image data starts
      const length = bytes.readUInt16BE(at + 2);
      if (marker === 0xe1 && bytes.toString('latin1', at + 4, at + 10) === 'Exif\0\0') {
        const tiff = at + 10;
        const little = bytes.toString('latin1', tiff, tiff + 2) === 'II';
        const u16 = (offset: number) => (little ? bytes.readUInt16LE(offset) : bytes.readUInt16BE(offset));
        const u32 = (offset: number) => (little ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset));
        const ifd = tiff + u32(tiff + 4);
        for (let i = 0; i < u16(ifd); i++) {
          const entry = ifd + 2 + i * 12;
          if (u16(entry) !== 0x0112) continue;
          const orientation = u16(entry + 8);
          return orientation >= 1 && orientation <= 8 ? orientation : 1;
        }
        return 1;
      }
      at += 2 + length;
    }
  } catch {
    // Cut short or malformed: treat it as upright
  }
  return 1;
}

/**
 * The size of a GIF, WebP or BMP image from its first bytes; Electron's
 * decoder in this process only reads PNG and JPEG. Null if unrecognised.
 */
export function readImageSize(bytes: Buffer, ext: string): { width: number; height: number } | null {
  let size: { width: number; height: number } | null = null;
  try {
    if (ext === 'gif') size = { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
    else if (ext === 'bmp') {
      // A core header (12 bytes) stores 16-bit sizes; the others signed 32-bit
      size =
        bytes.readUInt32LE(14) === 12
          ? { width: bytes.readUInt16LE(18), height: bytes.readUInt16LE(20) }
          : { width: Math.abs(bytes.readInt32LE(18)), height: Math.abs(bytes.readInt32LE(22)) };
    } else if (ext === 'webp') {
      const chunk = bytes.toString('latin1', 12, 16);
      if (chunk === 'VP8 ') {
        size = { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
      } else if (chunk === 'VP8L') {
        const bits = bytes.readUInt32LE(21);
        size = { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
      } else if (chunk === 'VP8X') {
        size = { width: bytes.readUIntLE(24, 3) + 1, height: bytes.readUIntLE(27, 3) + 1 };
      }
    }
  } catch {
    return null; // cut short
  }
  return size && size.width > 0 && size.height > 0 ? size : null;
}

/**
 * An image's size as the windows show it: decoded for PNG and JPEG (a JPEG
 * turned by its EXIF orientation, as browsers do), read from the header for
 * GIF, WebP and BMP. Null when it can't be told.
 */
function shownImageSize(probe: Electron.NativeImage, header: Buffer, ext: string) {
  if (ext !== 'png' && ext !== 'jpg') return readImageSize(header, ext);
  if (probe.isEmpty()) return null;
  const { width, height } = probe.getSize();
  const sideways = ext === 'jpg' && readJpegOrientation(header) >= 5;
  return sideways ? { width: height, height: width } : { width, height };
}

const normalizeRotation = (rotation: number) => {
  const normalized = ((Math.round(rotation) % 360) + 360) % 360;
  return normalized % 90 === 0 ? normalized : 0;
};

/** Read the first few KB of a file so its type can be sniffed. */
async function readHeader(sourcePath: string, bytes = 4096): Promise<Buffer> {
  const file = await fs.open(sourcePath, 'r');
  try {
    const headerBuffer = Buffer.alloc(bytes);
    const { bytesRead } = await file.read(headerBuffer, 0, headerBuffer.length, 0);
    return headerBuffer.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
}

/**
 * How much of a file to read for what its header says: a WebM's track
 * header, a JPEG's EXIF orientation. Both come before the image data.
 */
const HEADER_BYTES = 64 * 1024;

/** An EBML variable-length number: element ids keep their length marker, sizes don't. */
function readVint(bytes: Buffer, at: number, isId: boolean) {
  const first = bytes[at];
  if (first === undefined || first === 0) return null;
  const length = Math.clz32(first) - 23;
  if (length > (isId ? 4 : 8) || at + length > bytes.length) return null;
  let value = isId ? first : first & (0xff >> length);
  let allOnes = value === 0xff >> length;
  for (let i = 1; i < length; i++) {
    value = value * 256 + bytes[at + i];
    if (bytes[at + i] !== 0xff) allOnes = false;
  }
  // A size with every bit set means "unknown" (streamed files)
  return { value, length, unknown: !isId && allOnes };
}

const EBML_SEGMENT = 0x18538067;
const EBML_TRACKS = 0x1654ae6b;
const EBML_TRACK_ENTRY = 0xae;
const EBML_VIDEO = 0xe0;
const EBML_PIXEL_WIDTH = 0xb0;
const EBML_PIXEL_HEIGHT = 0xba;
const EBML_CLUSTER = 0x1f43b675;
/** The elements on the way to a video track's size; everything else is skipped */
const EBML_PATH = new Set([EBML_SEGMENT, EBML_TRACKS, EBML_TRACK_ENTRY, EBML_VIDEO]);

/**
 * A WebM video's frame size, from its track header (Segment > Tracks >
 * TrackEntry > Video > PixelWidth and PixelHeight), or null if the bytes
 * don't reach it.
 */
export function readVideoSize(bytes: Buffer): { width: number; height: number } | null {
  let width = 0;
  let height = 0;
  let at = 0;
  while (at < bytes.length) {
    const id = readVint(bytes, at, true);
    const size = id && readVint(bytes, at + id.length, false);
    if (!id || !size) return null;
    at += id.length + size.length;
    // Video data starts here: the track header is over
    if (id.value === EBML_CLUSTER) return null;
    // Step inside: its children follow directly
    if (EBML_PATH.has(id.value)) continue;
    if (id.value === EBML_PIXEL_WIDTH || id.value === EBML_PIXEL_HEIGHT) {
      if (size.value <= 6 && at + size.value <= bytes.length) {
        const value = size.value ? bytes.readUIntBE(at, size.value) : 0;
        if (id.value === EBML_PIXEL_WIDTH) width = value;
        else height = value;
      }
      if (width > 0 && height > 0) return { width, height };
    }
    if (size.unknown) return null; // can't be skipped
    at += size.value;
  }
  return null;
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

async function readOptional(filePath: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(filePath);
  } catch {
    return null;
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

// ─── Project files ────────────────────────────────────────────────────────────
//
// A project file (.minivtt) carries the whole library to another computer in
// one file. It is a ZIP archive, described for anyone who reads or writes one
// (forks included) in docs/project-format.md:
//
//   manifest.json              names, view state, settings, and the paths below
//   maps/<n>/media.<ext>       a map's image or WebM video
//   maps/<n>/thumb.png         optional, as are fog.png and effects.png
//   handouts/<n>/media.<ext>   a handout's image, and its thumb.png
//
// Files are stored without compression (the media is compressed already), and
// copied as streams both ways, so a large video never sits in memory whole.
// Importing adds new entries with fresh ids; nothing in the library is replaced.
//
// Compatibility with older and newer versions, and with forks:
//   - `version` goes up only for a change older versions would read wrongly.
//     New fields, files and values leave it as it is. A newer one is refused.
//   - `requires` names features a reader must have to read the file right. A
//     file requiring one this version lacks is refused, naming it.
//   - Anything else unknown is ignored: fields, files, `extensions`. Unknown
//     areas are handled as normalizeAreas describes, and fog that can't be
//     read means full fog, never a revealed map.
//   - Files from 1.1 and 1.2, in the format before ZIP, still import.

const PROJECT_FORMAT = 'mini-vtt-project';
/** Goes up only for changes older versions would read wrongly. Version 1 was the format before ZIP. */
const PROJECT_VERSION = 2;
/** Features a file may name in `requires` that this version has. Mini VTT itself requires none yet. */
const KNOWN_REQUIREMENTS: ReadonlySet<string> = new Set();
const MANIFEST_NAME = 'manifest.json';
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_PROJECT_ENTRIES = 10_000;
// Far more files than a project has (at most four per map), but bounded, as
// every file is listed in memory before anything is read
const MAX_ZIP_FILES = 100_000;
// Thumbnails and fog masks are read into memory whole; fog masks are lossless
// PNGs of a binary mask, so they stay far below this even for huge maps
const MAX_SIDECAR_BYTES = 64 * 1024 * 1024;
const STORED = { compress: false };

const NOT_A_PROJECT = 'This isn’t a Mini VTT project file.';
const DAMAGED = 'The project file is incomplete or damaged.';

/** A failure with a message that can be shown to the user as is. */
export class ProjectError extends Error {}

interface ProjectArea extends SpellArea {
  /** The kind's colour, so a version without that kind can show it alike */
  color: string;
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
  grid: MapGrid | null;
  circles: ProjectArea[];
  /** Paths inside the archive */
  media: string;
  thumb?: string;
  fog?: string;
  effects?: string;
}

interface ProjectHandoutRecord {
  name: string;
  width: number;
  height: number;
  rotation: number;
  media: string;
  thumb?: string;
}

interface ProjectManifest {
  format: typeof PROJECT_FORMAT;
  version: number;
  /** The app that wrote the file, shown when it can't be imported */
  generator: string;
  exportedAt: number;
  settings: Pick<LibrarySettings, 'playerScreenDiagonal' | 'gridSize' | 'portraitRotation'>;
  maps: ProjectMapRecord[];
  handouts: ProjectHandoutRecord[];
}

/** Whether a thumbnail, fog mask or effect layer exists and is a PNG. */
async function isPngFile(filePath: string): Promise<boolean> {
  try {
    return detectExt(await readHeader(filePath, 16)) === 'png';
  } catch {
    return false;
  }
}

/**
 * Write the whole library to `destPath`. Written to a temp file first, so a
 * failed export never leaves a half-written project behind.
 */
export async function exportProject(destPath: string): Promise<{ maps: number; handouts: number }> {
  const { maps, handouts, settings } = await loadSnapshot();

  // [path in the archive, file on disk], in the order they are written
  const files: [string, string][] = [];
  const add = (name: string, filePath: string) => {
    files.push([name, filePath]);
    return name;
  };
  const addPng = async (name: string, filePath: string) =>
    (await isPngFile(filePath)) ? add(name, filePath) : undefined;

  const manifest: ProjectManifest = {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    generator: `Mini VTT ${app.getVersion()}`,
    exportedAt: Date.now(),
    settings: {
      playerScreenDiagonal: settings.playerScreenDiagonal,
      gridSize: settings.gridSize,
      portraitRotation: settings.portraitRotation,
    },
    maps: [],
    handouts: [],
  };

  for (const map of maps) {
    const mediaPath = await resolveMapMediaPath(map.id);
    if (!mediaPath) continue; // media missing on disk: nothing to carry over
    const dir = `maps/${manifest.maps.length + 1}`;
    const media = add(`${dir}/media${path.extname(mediaPath)}`, mediaPath);
    const thumb = await addPng(`${dir}/thumb.png`, path.join(mapDir(map.id), 'thumb.png'));
    const fog = map.hasFog ? await addPng(`${dir}/fog.png`, path.join(mapDir(map.id), 'fog.png')) : undefined;
    const effects = await addPng(`${dir}/effects.png`, path.join(mapDir(map.id), 'effects.png'));
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
      circles: map.circles.map((area) => ({ ...area, color: EFFECT_STYLES[area.kind].color })),
      media,
      ...(thumb ? { thumb } : {}),
      ...(fog ? { fog } : {}),
      ...(effects ? { effects } : {}),
    });
  }

  for (const handout of handouts) {
    const mediaPath = await resolveHandoutPath(handout.id);
    if (!mediaPath) continue;
    const dir = `handouts/${manifest.handouts.length + 1}`;
    const media = add(`${dir}/media${path.extname(mediaPath)}`, mediaPath);
    const thumb = await addPng(`${dir}/thumb.png`, path.join(handoutDir(handout.id), 'thumb.png'));
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

  const tmp = `${destPath}.${process.pid}.${++tmpCounter}.tmp`;
  const zip = new yazl.ZipFile();
  // A PassThrough, though the type says less
  const output = zip.outputStream as Readable;
  // yazl reports a file it can't read on the ZipFile; failing the output
  // stream with it ends the export instead of leaving it waiting
  zip.on('error', (err: Error) => output.destroy(err));
  const written = pipeline(output, createWriteStream(tmp));
  // The manifest goes first, so even a reader that can't seek finds it first
  zip.addBuffer(Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'), MANIFEST_NAME, STORED);
  for (const [name, filePath] of files) zip.addFile(filePath, name, STORED);
  zip.end();
  try {
    await written;
    await fs.rename(tmp, destPath);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
  return { maps: manifest.maps.length, handouts: manifest.handouts.length };
}

/** A project file being imported: its manifest, and the files it names. */
interface ProjectSource {
  manifest: Record<string, unknown>;
  /** The highest `version` this kind of file can have */
  maxVersion: number;
  /** Size of the file `ref` names, or null if it names none */
  sizeOf(ref: unknown): number | null;
  /** Copy the file `ref` names to `dest`; false if it can't be read */
  extract(ref: unknown, dest: string): Promise<boolean>;
  /** The file `ref` names, if it can be read and is at most `maxBytes` */
  read(ref: unknown, maxBytes: number): Promise<Buffer | null>;
  close(): Promise<void>;
}

function parseManifest(bytes: Buffer): Record<string, unknown> {
  try {
    return asRecord(JSON.parse(bytes.toString('utf8')));
  } catch {
    throw new ProjectError(DAMAGED);
  }
}

/** Open a project file of either format. */
async function openProject(sourcePath: string): Promise<ProjectSource> {
  const file = await fs.open(sourcePath, 'r');
  let keepOpen = false;
  try {
    const start = Buffer.alloc(PROJECT_MAGIC.length);
    const { bytesRead } = await file.read(start, 0, start.length, 0);
    if (bytesRead === start.length && start.equals(PROJECT_MAGIC)) {
      const source = await openLegacyProject(file);
      keepOpen = true;
      return source;
    }
    // A ZIP file starts with "PK"; anything else isn't damaged, just not a project
    return await openZipProject(sourcePath, start.subarray(0, 2).toString('latin1') === 'PK');
  } finally {
    if (!keepOpen) await file.close();
  }
}

/** File system errors (a full disk, no access) are failures, not a damaged file in the archive. */
const isFileSystemError = (err: unknown) => !!err && typeof err === 'object' && 'syscall' in err;

/** Resolves once `stream` has closed, and so let go of its file. */
const closed = (stream: Writable) =>
  stream.closed ? Promise.resolve() : new Promise<void>((resolve) => stream.once('close', () => resolve()));

/**
 * Stream a file from the archive into `sink`, checking its size (yauzl does)
 * and its CRC-32. False if it is encrypted, compressed in a way yauzl can't
 * undo, or damaged.
 */
async function pipeEntry(zip: yauzl.ZipFile, entry: yauzl.Entry, sink: Writable): Promise<boolean> {
  let crc = 0;
  const checksum = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      crc = zlib.crc32(chunk, crc);
      done(null, chunk);
    },
  });
  try {
    if (!entry.canDecodeFileData()) throw new Error('Encrypted, or compressed in an unknown way');
    await pipeline(await zip.openReadStreamPromise(entry), checksum, sink);
  } catch (err) {
    sink.destroy();
    await closed(sink);
    if (isFileSystemError(err)) throw err;
    return false;
  }
  return crc === entry.crc32;
}

/** A ZIP project file, as versions after 1.2 write. */
async function openZipProject(sourcePath: string, looksLikeZip: boolean): Promise<ProjectSource> {
  let zip: yauzl.ZipFile;
  try {
    zip = await yauzl.openPromise(sourcePath, { autoClose: false });
  } catch {
    throw new ProjectError(looksLikeZip ? DAMAGED : NOT_A_PROJECT);
  }
  try {
    if (zip.entryCount > MAX_ZIP_FILES) throw new ProjectError(DAMAGED);
    // Files are looked up by the names in the manifest; a name is never used
    // as a path on disk. yauzl refuses names that climb out of the archive.
    const entries = new Map<string, yauzl.Entry>();
    try {
      for await (const entry of zip.eachEntry()) entries.set(entry.fileName, entry);
    } catch {
      throw new ProjectError(DAMAGED);
    }
    const entryFor = (ref: unknown) => (typeof ref === 'string' ? entries.get(ref) : undefined);
    const read = async (ref: unknown, maxBytes: number) => {
      const entry = entryFor(ref);
      if (!entry || entry.uncompressedSize > maxBytes) return null;
      const chunks: Buffer[] = [];
      const sink = new Writable({
        write(chunk: Buffer, _encoding, done) {
          chunks.push(chunk);
          done();
        },
      });
      return (await pipeEntry(zip, entry, sink)) ? Buffer.concat(chunks) : null;
    };
    if (!entries.has(MANIFEST_NAME)) {
      // The usual slip when zipping by hand: the folder, not what is in it
      const nested = [...entries.keys()].some((name) => name.endsWith(`/${MANIFEST_NAME}`));
      throw new ProjectError(
        nested
          ? `This project’s ${MANIFEST_NAME} is inside a folder. Zip what is in the folder, so ${MANIFEST_NAME} is at the top of the file.`
          : NOT_A_PROJECT,
      );
    }
    const manifestBytes = await read(MANIFEST_NAME, MAX_MANIFEST_BYTES);
    if (!manifestBytes) throw new ProjectError(DAMAGED);
    return {
      manifest: parseManifest(manifestBytes),
      maxVersion: PROJECT_VERSION,
      sizeOf: (ref) => entryFor(ref)?.uncompressedSize ?? null,
      extract: async (ref, dest) => {
        const entry = entryFor(ref);
        return !!entry && pipeEntry(zip, entry, createWriteStream(dest));
      },
      read,
      close: async () => zip.close(),
    };
  } catch (err) {
    zip.close();
    throw err;
  }
}

// The format of Mini VTT 1.1 and 1.2, still read so their files import:
//
//   8 bytes   magic "MVTTPRJ1"
//   4 bytes   manifest length, uint32 little-endian
//   n bytes   manifest JSON, naming each file as { offset, size }
//   ...       the files back to back; offsets count from the end of the manifest

const PROJECT_MAGIC = Buffer.from('MVTTPRJ1', 'ascii');
const PROJECT_HEADER_BYTES = PROJECT_MAGIC.length + 4;
const COPY_CHUNK_BYTES = 1024 * 1024;

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
    if (bytesRead === 0) throw new ProjectError(DAMAGED);
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

/** A project file from Mini VTT 1.1 or 1.2. Takes over `file` and closes it. */
async function openLegacyProject(file: FileHandle): Promise<ProjectSource> {
  const fileSize = (await file.stat()).size;
  if (fileSize < PROJECT_HEADER_BYTES) throw new ProjectError(DAMAGED);
  const header = await readExactly(file, 0, PROJECT_HEADER_BYTES);
  const manifestLength = header.readUInt32LE(PROJECT_MAGIC.length);
  if (manifestLength > MAX_MANIFEST_BYTES || PROJECT_HEADER_BYTES + manifestLength > fileSize) {
    throw new ProjectError(DAMAGED);
  }
  const manifest = parseManifest(await readExactly(file, PROJECT_HEADER_BYTES, manifestLength));
  const dataStart = PROJECT_HEADER_BYTES + manifestLength;
  const dataSize = fileSize - dataStart;
  /** A file's place in the data, if it lies inside it. */
  const range = (ref: unknown) => {
    const { offset, size } = asRecord(ref);
    if (typeof offset !== 'number' || typeof size !== 'number') return null;
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size)) return null;
    if (offset < 0 || size <= 0 || offset + size > dataSize) return null;
    return { offset, size };
  };
  const chunk = Buffer.alloc(COPY_CHUNK_BYTES);
  return {
    manifest,
    maxVersion: 1,
    sizeOf: (ref) => range(ref)?.size ?? null,
    extract: async (ref, dest) => {
      const found = range(ref);
      if (!found) return false;
      const out = await fs.open(dest, 'w');
      try {
        await copyBytes(file, dataStart + found.offset, found.size, out, 0, chunk);
      } finally {
        await out.close();
      }
      return true;
    },
    read: async (ref, maxBytes) => {
      const found = range(ref);
      return found && found.size <= maxBytes ? readExactly(file, dataStart + found.offset, found.size) : null;
    },
    close: () => file.close(),
  };
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

/** " It was made with …", from the file's `generator`, for messages about files from elsewhere. */
const madeWith = (manifest: Record<string, unknown>) => {
  const generator = typeof manifest.generator === 'string' ? manifest.generator.trim().slice(0, 60) : '';
  return generator ? ` It was made with ${generator}.` : '';
};

/** Refuse a file this version would read wrongly: newer, or requiring features it lacks. */
function checkManifest(manifest: Record<string, unknown>, maxVersion: number) {
  if (manifest.format !== PROJECT_FORMAT || typeof manifest.version !== 'number') {
    throw new ProjectError(NOT_A_PROJECT);
  }
  if (manifest.version > maxVersion) {
    throw new ProjectError(
      `This project was saved by a newer version of Mini VTT. Update the app to open it.${madeWith(manifest)}`,
    );
  }
  const { requires } = manifest;
  const required = requires === undefined ? [] : Array.isArray(requires) ? requires : [requires];
  const missing = required.filter((name) => typeof name !== 'string' || !KNOWN_REQUIREMENTS.has(name));
  if (missing.length > 0) {
    const names = missing
      .slice(0, 3)
      .map((name) => (typeof name === 'string' ? name.slice(0, 40) : '?'))
      .join(', ');
    throw new ProjectError(
      `This project needs features this version of Mini VTT doesn’t have (${names}).${madeWith(manifest)}`,
    );
  }
}

const sizeText = (bytes: number) =>
  bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.ceil(bytes / 1024 ** 2)} MB`;

/**
 * Refuse an import that wouldn't fit on the disk, before anything is written.
 * Sizes in a ZIP are checked as files are read, so a file can't claim to be
 * small and then fill the disk.
 */
async function checkFreeSpace(source: ProjectSource, records: Record<string, unknown>[]) {
  const sizeOf = (ref: unknown, max = Infinity) => {
    const size = source.sizeOf(ref);
    return size !== null && size <= max ? size : 0;
  };
  const needed = records.reduce(
    (sum, record) =>
      sum +
      sizeOf(record.media) +
      sizeOf(record.thumb, MAX_SIDECAR_BYTES) +
      sizeOf(record.fog, MAX_SIDECAR_BYTES) +
      sizeOf(record.effects, MAX_SIDECAR_BYTES),
    0,
  );
  await fs.mkdir(LIBRARY_DIR(), { recursive: true });
  let free: number;
  try {
    const disk = await fs.statfs(LIBRARY_DIR());
    free = disk.bavail * disk.bsize;
  } catch {
    return; // the system can't tell; a full disk still fails the import cleanly
  }
  if (needed > free) {
    throw new ProjectError(
      `There isn’t enough free disk space to import this project: it needs ${sizeText(needed)}, and ${sizeText(free)} is free.`,
    );
  }
}

/**
 * Add everything in a project file to the library. The file is untrusted: every
 * field is validated, only files the manifest names are read, and media types
 * are sniffed from the extracted bytes.
 */
export async function importProject(sourcePath: string): Promise<ProjectImportSummary> {
  const source = await openProject(sourcePath);
  // Folders created so far; removed again unless the import is committed
  const created: string[] = [];
  try {
    const { manifest } = source;
    checkManifest(manifest, source.maxVersion);
    const records = (value: unknown) =>
      Array.isArray(value) ? value.slice(0, MAX_PROJECT_ENTRIES).map(asRecord) : [];
    const mapRecords = records(manifest.maps);
    const handoutRecords = records(manifest.handouts);
    await checkFreeSpace(source, [...mapRecords, ...handoutRecords]);

    /** Extract a media file into `dir` and return its sniffed extension, or null. */
    const extractMedia = async (ref: unknown, dir: string) => {
      const tmp = path.join(dir, 'media.tmp');
      if (!(await source.extract(ref, tmp))) return null;
      const ext = detectExt(await readHeader(tmp));
      if (ext) await fs.rename(tmp, path.join(dir, `image.${ext}`));
      return ext;
    };
    /** A small PNG (thumbnail, fog or effects), or null if missing or not a PNG. */
    const readPng = async (ref: unknown) => {
      const bytes = await source.read(ref, MAX_SIDECAR_BYTES);
      return bytes && detectExt(bytes) === 'png' ? bytes : null;
    };
    /**
     * Write the entry's thumbnail and return its size. Both come from the
     * project file when it has them; otherwise from the media, which is then
     * decoded once (a file written by hand may give neither).
     */
    const describeMedia = async (dir: string, ext: string, record: Record<string, unknown>) => {
      let thumb = await readPng(record.thumb);
      let width = nonNegativeInt(record.width);
      let height = nonNegativeInt(record.height);
      if (!thumb || !width || !height) {
        const mediaPath = path.join(dir, `image.${ext}`);
        const header = await readHeader(mediaPath, HEADER_BYTES);
        const probe = ext === 'webm' ? null : nativeImage.createFromPath(mediaPath);
        if (!width || !height) {
          const size = probe ? shownImageSize(probe, header, ext) : readVideoSize(header);
          if (size) ({ width, height } = size);
        }
        if (!thumb && probe) thumb = makeThumb(probe, ext === 'jpg' ? readJpegOrientation(header) : 1);
      }
      if (thumb) await fs.writeFile(path.join(dir, 'thumb.png'), thumb);
      return { width, height };
    };
    /** Make a folder for a new entry and extract its media; null if unusable. */
    const extractEntry = async (dir: string, media: unknown, allowVideo: boolean) => {
      if (source.sizeOf(media) === null) return null;
      await fs.mkdir(dir, { recursive: true });
      created.push(dir);
      const ext = await extractMedia(media, dir);
      if (ext && (allowVideo || ext !== 'webm')) return ext;
      await fs.rm(dir, { recursive: true, force: true });
      created.pop();
      return null;
    };
    /** Copy a map's fog or effect layer: null if the file names none, false if it can't be read. */
    const copyLayer = async (ref: unknown, dest: string) => {
      if (ref === undefined || ref === null) return null;
      // Cut short, a fog mask would show part of the map revealed
      const bytes = await source.read(ref, MAX_SIDECAR_BYTES);
      const png = bytes && isCompletePng(bytes) ? bytes : null;
      if (png) await fs.writeFile(dest, png);
      return !!png;
    };

    const now = Date.now();
    let skipped = 0;
    let fogLeftOut = 0;
    let effectsLeftOut = 0;
    const areas: AreaReport = { leftOut: 0, restyled: 0 };

    const newMaps: MapEntryMeta[] = [];
    for (const record of mapRecords) {
      const id = newId(MAP_ID_PREFIX);
      const dir = mapDir(id);
      const ext = await extractEntry(dir, record.media, true);
      if (!ext) {
        skipped += 1;
        continue;
      }
      const { width, height } = await describeMedia(dir, ext, record);
      // Fog that can't be read is left out, so the map starts fully fogged
      const fog = await copyLayer(record.fog, path.join(dir, 'fog.png'));
      if (fog === false) fogLeftOut += 1;
      // Optional field: files from before effects existed simply have none
      if ((await copyLayer(record.effects, path.join(dir, 'effects.png'))) === false) effectsLeftOut += 1;
      const pan = asRecord(record.pan);
      const zoom = finiteOr(record.zoom, 1);
      newMaps.push({
        id,
        name: cleanName(record.name, 'Imported map'),
        mediaType: ext === 'webm' ? 'video' : 'image',
        width,
        height,
        zoom: zoom > 0 ? zoom : 1,
        pan: { x: finiteOr(pan.x, 0), y: finiteOr(pan.y, 0) },
        rotation: normalizeRotation(finiteOr(record.rotation, 0)),
        mirrorHorizontal: record.mirrorHorizontal === true,
        mirrorVertical: record.mirrorVertical === true,
        hasFog: fog === true,
        // Optional fields: files from before calibration simply have none
        grid: normalizeGrid(record.grid),
        circles: normalizeAreas(record.circles, areas),
        addedAt: now,
      });
    }

    const newHandouts: HandoutMeta[] = [];
    for (const record of handoutRecords) {
      const id = newId(HANDOUT_ID_PREFIX);
      const dir = handoutDir(id);
      const ext = await extractEntry(dir, record.media, false);
      if (!ext) {
        skipped += 1;
        continue;
      }
      const { width, height } = await describeMedia(dir, ext, record);
      newHandouts.push({
        id,
        name: cleanName(record.name, 'Imported handout'),
        width,
        height,
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
      // Player screen settings belong to the screen, so only a fresh library
      // takes them, and only those the file gives (one written by hand may give none)
      const given = asRecord(manifest.settings);
      const { gridSize, portraitRotation, playerScreenDiagonal = null } = cleanSettingsPatch(given);
      const taken = {
        // A screen size that is given but not valid means none
        ...('playerScreenDiagonal' in given ? { playerScreenDiagonal } : {}),
        ...(gridSize !== undefined ? { gridSize } : {}),
        ...(portraitRotation !== undefined ? { portraitRotation } : {}),
      };
      if (!wasEmpty || Object.keys(taken).length === 0) return { settingsApplied: false };
      index.settings = { ...index.settings, ...taken };
      return { settingsApplied: true };
    });
    created.length = 0;

    return {
      maps: newMaps.length,
      handouts: newHandouts.length,
      skipped,
      areasLeftOut: areas.leftOut,
      areasRestyled: areas.restyled,
      fogLeftOut,
      effectsLeftOut,
      settingsApplied,
      firstMap: newMaps[0] ?? null,
    };
  } finally {
    await source.close();
    for (const dir of created) await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

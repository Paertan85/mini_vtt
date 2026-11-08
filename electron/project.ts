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
  FogRoom,
  SpellArea,
  HandoutMeta,
  LibrarySettings,
  MapEntryMeta,
  MapGrid,
  ProjectImportSummary,
} from '../src/types/map';
import { normalizeGrid } from '../src/lib/grid';
import { type AreaReport, normalizeAreas } from '../src/lib/areas';
import { normalizeRooms } from '../src/lib/rooms';
import { EFFECT_STYLES } from '../src/lib/effects';
import { cleanSettingsPatch } from '../src/lib/settings';
import {
  HANDOUT_ID_PREFIX,
  LIBRARY_DIR,
  MAP_ID_PREFIX,
  handoutDir,
  loadSnapshot,
  mapDir,
  mutateIndex,
  newId,
  normalizeRotation,
  resolveHandoutPath,
  resolveMapMediaPath,
  sortMaps,
  tempPath,
} from './libraryStore';
import {
  HEADER_BYTES,
  detectExt,
  isCompletePng,
  makeThumb,
  readHeader,
  readJpegOrientation,
  readVideoSize,
  shownImageSize,
} from './mediaFiles';

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
  /** DM-only fog rooms; optional, so older readers ignore them (and show players nothing) */
  rooms?: FogRoom[];
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
      rooms: map.rooms,
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

  const tmp = tempPath(destPath);
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
        // Optional: files from before rooms existed simply have none
        rooms: normalizeRooms(record.rooms),
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

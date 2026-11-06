// Reading media files: their type from their first bytes, sizes, EXIF
// orientation, a WebM's frame size and codec, thumbnails, and the byte ranges
// the media protocol serves. Nothing here touches the library or its index.

import { nativeImage } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import type { VideoCodec } from '../src/types/map';

// Image extensions we accept, probed from magic bytes rather than trusting the
// filename
export const EXTENSIONS = ['png', 'jpg', 'gif', 'webp', 'bmp', 'webm'] as const;

/** Derive the extension from the file's magic bytes. */
export function detectExt(bytes: Buffer): 'png' | 'jpg' | 'gif' | 'webp' | 'bmp' | 'webm' | null {
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
export const PNG_END = Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);

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

export const mimeFor = (ext: string) => {
  if (ext === 'jpg') return 'image/jpeg';
  if (ext === 'webm') return 'video/webm';
  return `image/${ext}`;
};
export const toDataUrl = (bytes: Buffer, ext: string) =>
  `data:${mimeFor(ext)};base64,${bytes.toString('base64')}`;

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

/**
 * Build a small PNG preview so the panel never decodes full-size maps, turned
 * upright by a JPEG's EXIF orientation as the windows show the image.
 */
export function makeThumb(img: Electron.NativeImage, orientation = 1): Buffer | null {
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
export function orient(image: Electron.NativeImage, orientation: number): Electron.NativeImage {
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
export function shownImageSize(probe: Electron.NativeImage, header: Buffer, ext: string) {
  if (ext !== 'png' && ext !== 'jpg') return readImageSize(header, ext);
  if (probe.isEmpty()) return null;
  const { width, height } = probe.getSize();
  const sideways = ext === 'jpg' && readJpegOrientation(header) >= 5;
  return sideways ? { width: height, height: width } : { width, height };
}

/** Read the first few KB of a file so its type can be sniffed. */
export async function readHeader(sourcePath: string, bytes = 4096): Promise<Buffer> {
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
export const HEADER_BYTES = 64 * 1024;

/** An EBML variable-length number: element ids keep their length marker, sizes don't. */
export function readVint(bytes: Buffer, at: number, isId: boolean) {
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

export const EBML_SEGMENT = 0x18538067;
export const EBML_TRACKS = 0x1654ae6b;
export const EBML_TRACK_ENTRY = 0xae;
export const EBML_VIDEO = 0xe0;
export const EBML_PIXEL_WIDTH = 0xb0;
export const EBML_PIXEL_HEIGHT = 0xba;
export const EBML_CLUSTER = 0x1f43b675;
/** The elements on the way to a video track's size; everything else is skipped */
export const EBML_PATH = new Set([EBML_SEGMENT, EBML_TRACKS, EBML_TRACK_ENTRY, EBML_VIDEO]);

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

/** The video codec named in a WebM file's first bytes (its track header), or null. */
export function sniffVideoCodec(bytes: Buffer): VideoCodec | null {
  if (bytes.includes(Buffer.from('V_VP9'))) return 'vp9';
  if (bytes.includes(Buffer.from('V_AV1'))) return 'av1';
  if (bytes.includes(Buffer.from('V_VP8'))) return 'vp8';
  return null;
}

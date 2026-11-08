// Thumbnails the main process can't make. It decodes only PNG and JPEG, so
// GIF, WebP and BMP maps and handouts get theirs drawn here, in the DM
// window, once: the main process keeps the result next to the image.

import { encodePng } from './png';

/** As wide as the thumbnails the main process makes */
const THUMB_WIDTH = 240;

// One thumbnail at a time, so a long list never decodes many large images at once
let queue: Promise<unknown> = Promise.resolve();

/**
 * A PNG thumbnail of the image at `url`, at most THUMB_WIDTH wide (`width`
 * is the image's own, 0 when unknown); null when the image can't be read.
 */
export function drawThumbnail(url: string, width: number): Promise<Blob | null> {
  const run = queue.then(async () => {
    try {
      const source = await (await fetch(url)).blob();
      const resize = width === 0 || width > THUMB_WIDTH;
      const bitmap = await createImageBitmap(
        source,
        resize ? { resizeWidth: THUMB_WIDTH, resizeQuality: 'medium' } : {},
      );
      // Encoded in the worker the fog uses; the bitmap goes to it
      return await encodePng(bitmap);
    } catch (err) {
      console.warn('Could not draw a thumbnail:', err);
      return null;
    }
  });
  queue = run;
  return run;
}

/** A blob as a data URL, the form the library panel keeps thumbnails in. */
export const toDataUrl = (blob: Blob) =>
  new Promise<string | null>((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(blob);
  });

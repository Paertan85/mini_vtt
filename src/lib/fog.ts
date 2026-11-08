// Fog-of-war mask helpers shared by the DM window and the player screen.
//
// The mask is a BINARY canvas: opaque where fog exists, transparent where the
// map is revealed. The DM window shows it as a translucent tint (CSS opacity);
// the player screen recolours it solid black. Keeping the mask binary makes
// reveal and cover strokes exactly symmetric, with no alpha build-up.

import type { FogMode, FogStroke, Point } from '../types/map';
import type { Size } from './geometry';
import type { Rect } from './rect';

/** Longest mask edge in pixels; bounds memory and PNG size for huge maps. */
const MAX_FOG_EDGE = 1920;

/** Mask resolution for a map of the given size. Both windows must agree on it. */
export function fogMaskSize(media: Size): { width: number; height: number } {
  const scale = Math.min(1, MAX_FOG_EDGE / Math.max(media.w, media.h));
  return {
    width: Math.max(1, Math.round(media.w * scale)),
    height: Math.max(1, Math.round(media.h * scale)),
  };
}

/** Fill the whole mask with fog. */
export function fillMask(ctx: CanvasRenderingContext2D, color: string) {
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
}

/** Paint one stroke segment. Stroke coordinates are in map natural pixels. */
export function drawStroke(ctx: CanvasRenderingContext2D, stroke: FogStroke, media: Size, color: string) {
  if (!media.w || !media.h || ctx.canvas.width === 0) return;
  const scaleX = ctx.canvas.width / media.w;
  const scaleY = ctx.canvas.height / media.h;
  if (stroke.mode === 'cover') {
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = color;
  } else {
    ctx.globalCompositeOperation = 'destination-out';
  }
  ctx.lineWidth = stroke.radius * 2 * scaleX;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(stroke.from.x * scaleX, stroke.from.y * scaleY);
  ctx.lineTo(stroke.to.x * scaleX, stroke.to.y * scaleY);
  ctx.stroke();
  ctx.globalCompositeOperation = 'source-over';
}

/**
 * Reveal or cover everything inside an outline (map natural pixels): a
 * lasso, or a rectangle's or room's four corners. The outline is closed with
 * a straight line back to its start; overlapping loops all count as inside.
 * One fill, however large the area.
 */
export function fillOutline(
  ctx: CanvasRenderingContext2D,
  points: Point[],
  mode: FogMode,
  media: Size,
  color: string,
) {
  if (points.length < 3 || !media.w || !media.h || ctx.canvas.width === 0) return;
  const scaleX = ctx.canvas.width / media.w;
  const scaleY = ctx.canvas.height / media.h;
  ctx.globalCompositeOperation = mode === 'cover' ? 'source-over' : 'destination-out';
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(points[0].x * scaleX, points[0].y * scaleY);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x * scaleX, points[i].y * scaleY);
  ctx.closePath();
  ctx.fill('nonzero');
  ctx.globalCompositeOperation = 'source-over';
}

/**
 * Read the mask inside each rectangle (map natural pixels) at `samples` ×
 * `samples` evenly spread points, the rectangles side by side in one row of
 * `scratch`. One small draw per rectangle and one small read, never the whole
 * mask, so it costs the same however large the map is.
 */
export function sampleMaskRects(
  mask: HTMLCanvasElement,
  scratch: HTMLCanvasElement,
  rects: Rect[],
  media: Size,
  samples: number,
): ImageData | null {
  if (rects.length === 0 || !media.w || !media.h || mask.width === 0 || mask.height === 0) return null;
  const width = rects.length * samples;
  if (scratch.width !== width || scratch.height !== samples) {
    scratch.width = width;
    scratch.height = samples;
  }
  const ctx = scratch.getContext('2d');
  if (!ctx) return null;
  const scaleX = mask.width / media.w;
  const scaleY = mask.height / media.h;
  ctx.clearRect(0, 0, width, samples);
  // The nearest mask pixel at each point, not a blend
  ctx.imageSmoothingEnabled = false;
  rects.forEach((rect, index) => {
    if (rect.width <= 0 || rect.height <= 0) return;
    ctx.drawImage(
      mask,
      rect.x * scaleX,
      rect.y * scaleY,
      rect.width * scaleX,
      rect.height * scaleY,
      index * samples,
      0,
      samples,
      samples,
    );
  });
  return ctx.getImageData(0, 0, width, samples);
}

/**
 * Encode a mask as a PNG data URL without holding up the page. The canvas is
 * copied straight away, so later painting doesn't change the result, but the
 * PNG is compressed in the background: toDataURL would freeze the window for
 * the whole encode, tens of milliseconds for a large mask on a slow laptop.
 */
export function encodeMask(canvas: HTMLCanvasElement): Promise<string> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('Could not encode the fog mask'));
        return;
      }
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error ?? new Error('Could not read the encoded fog mask'));
      reader.readAsDataURL(blob);
    }, 'image/png');
  });
}

/** Decode a PNG data URL. */
export function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Could not decode the fog mask'));
    image.src = dataUrl;
  });
}

/** Replace the mask with a decoded snapshot, recoloured to `color`. */
export function drawSnapshot(ctx: CanvasRenderingContext2D, image: HTMLImageElement, color: string) {
  const { width, height } = ctx.canvas;
  ctx.globalCompositeOperation = 'source-over';
  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(image, 0, 0, width, height);
  // Recolour without reading pixels back: keep alpha, replace colour
  ctx.globalCompositeOperation = 'source-in';
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, width, height);
  ctx.globalCompositeOperation = 'source-over';
}

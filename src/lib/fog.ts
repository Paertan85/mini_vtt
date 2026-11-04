// Fog-of-war mask helpers shared by the DM window and the player screen.
//
// The mask is a BINARY canvas: opaque where fog exists, transparent where the
// map is revealed. The DM window shows it as a translucent tint (CSS opacity);
// the player screen recolours it solid black. Keeping the mask binary makes
// reveal and cover strokes exactly symmetric, with no alpha build-up.

import type { FogStroke } from '../types/map';
import type { Size } from './geometry';

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

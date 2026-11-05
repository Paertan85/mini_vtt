// Painted effect layer helpers (fire, poison, magic), shared by both windows.
//
// The layer is an RGBA canvas holding opaque colour; both windows show it with
// CSS opacity, so overlapping strokes never build up. Soft edges are baked in
// once when a stroke ends: the stroke is drawn hard-edged on a scratch canvas
// while the mouse moves, then only its bounding box is blurred and merged into
// the layer. Nothing is filtered while panning or zooming.

import type { EffectKind, Point } from '../types/map';
import type { Size } from './geometry';

/** Longest layer edge in pixels. Effects are soft, so a lower resolution than fog is fine. */
const MAX_EFFECT_EDGE = 1024;

/** How strongly the layer shows over the map, on both screens. */
export const EFFECT_OPACITY = 0.55;

export interface EffectStyle {
  label: string;
  color: string;
  /** Dark stripes baked into the paint, so poison doesn't rely on hue alone */
  hatch?: string;
}

export const EFFECT_STYLES: Record<EffectKind, EffectStyle> = {
  fire: { label: 'Fire', color: '#ff6a1a' },
  poison: { label: 'Poison', color: '#45b649', hatch: '#174d1d' },
  magic: { label: 'Magic', color: '#5c7cff' },
};

export const EFFECT_KINDS = Object.keys(EFFECT_STYLES) as EffectKind[];

/** Hue of a `#rrggbb` colour in degrees; null for anything else, or a grey. */
function hueOf(color: string): number | null {
  const match = /^#([0-9a-f]{6})$/i.exec(color);
  if (!match) return null;
  const value = parseInt(match[1], 16);
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  const max = Math.max(r, g, b);
  const range = max - Math.min(r, g, b);
  if (range < 24) return null;
  const sector = max === r ? (g - b) / range : max === g ? (b - r) / range + 2 : (r - g) / range + 4;
  return (sector * 60 + 360) % 360;
}

/**
 * The kind to show an area as when its kind is one this version doesn't have
 * (from a newer version or a fork): the kind closest in hue to the colour the
 * file gives for it, or magic when it gives none.
 */
export function nearestEffectKind(color: unknown): EffectKind {
  const hue = typeof color === 'string' ? hueOf(color) : null;
  if (hue === null) return 'magic';
  let nearest: EffectKind = 'magic';
  let nearestDistance = Infinity;
  for (const kind of EFFECT_KINDS) {
    const difference = Math.abs(hue - (hueOf(EFFECT_STYLES[kind].color) ?? 0));
    const distance = Math.min(difference, 360 - difference);
    if (distance < nearestDistance) {
      nearest = kind;
      nearestDistance = distance;
    }
  }
  return nearest;
}

/** Largest edge blur, in layer pixels (about a tenth of a typical square). */
const MAX_EDGE_SOFTNESS = 3;

/**
 * Blur for a brush of `radius` layer pixels. Kept narrow, so the paint stays
 * solid up to where it was painted and it's clear which squares it covers;
 * the edge is only softened enough not to look pixelated.
 */
export const edgeSoftness = (radius: number) => Math.max(0.5, Math.min(MAX_EDGE_SOFTNESS, radius * 0.1));

/** Layer resolution for a map of the given size. */
export function effectMaskSize(media: Size): { width: number; height: number } {
  const scale = Math.min(1, MAX_EFFECT_EDGE / Math.max(media.w, media.h));
  return {
    width: Math.max(1, Math.round(media.w * scale)),
    height: Math.max(1, Math.round(media.h * scale)),
  };
}

/** Axis-aligned box in layer pixels. */
export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Draw one hard-edged segment on the scratch canvas (in layer pixels) and grow
 * `box` to cover it.
 */
export function drawScratchSegment(
  ctx: CanvasRenderingContext2D,
  from: Point,
  to: Point,
  radius: number,
  color: string,
  box: Box,
) {
  ctx.globalCompositeOperation = 'source-over';
  ctx.strokeStyle = color;
  ctx.lineWidth = radius * 2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();
  box.x0 = Math.min(box.x0, from.x - radius, to.x - radius);
  box.y0 = Math.min(box.y0, from.y - radius, to.y - radius);
  box.x1 = Math.max(box.x1, from.x + radius, to.x + radius);
  box.y1 = Math.max(box.y1, from.y + radius, to.y + radius);
}

function fillFor(ctx: CanvasRenderingContext2D, style: EffectStyle): string | CanvasPattern {
  if (!style.hatch) return style.color;
  const tile = document.createElement('canvas');
  tile.width = 12;
  tile.height = 12;
  const t = tile.getContext('2d');
  if (!t) return style.color;
  t.fillStyle = style.color;
  t.fillRect(0, 0, 12, 12);
  t.strokeStyle = style.hatch;
  t.lineWidth = 3;
  t.beginPath();
  // Two segments so the stripes join seamlessly across tiles
  t.moveTo(-3, 3);
  t.lineTo(3, -3);
  t.moveTo(0, 12);
  t.lineTo(12, 0);
  t.moveTo(9, 15);
  t.lineTo(15, 9);
  t.stroke();
  return ctx.createPattern(tile, 'repeat') ?? style.color;
}

/**
 * Merge the scratch stroke into the layer with soft edges: paint `kind`, or
 * erase when `kind` is null. Only the stroke's box (plus the blur margin) is
 * processed.
 */
export function bakeStroke(
  layer: CanvasRenderingContext2D,
  scratch: HTMLCanvasElement,
  kind: EffectKind | null,
  box: Box,
  softness: number,
) {
  const margin = Math.ceil(softness * 3);
  const x = Math.max(0, Math.floor(box.x0) - margin);
  const y = Math.max(0, Math.floor(box.y0) - margin);
  const w = Math.min(scratch.width, Math.ceil(box.x1) + margin) - x;
  const h = Math.min(scratch.height, Math.ceil(box.y1) + margin) - y;
  if (w <= 0 || h <= 0) return;

  const temp = document.createElement('canvas');
  temp.width = w;
  temp.height = h;
  const t = temp.getContext('2d');
  if (!t) return;
  t.filter = `blur(${softness}px)`;
  t.drawImage(scratch, x, y, w, h, 0, 0, w, h);
  t.filter = 'none';
  if (kind) {
    // Keep the blurred alpha, replace the colour
    t.globalCompositeOperation = 'source-in';
    t.translate(-x, -y); // pattern aligned to the layer, not the box
    t.fillStyle = fillFor(t, EFFECT_STYLES[kind]);
    t.fillRect(x, y, w, h);
  }
  layer.globalCompositeOperation = kind ? 'source-over' : 'destination-out';
  layer.drawImage(temp, x, y);
  layer.globalCompositeOperation = 'source-over';
  temp.width = 0;
}

/** Show a decoded layer on `canvas`, sizing the canvas to it; null frees it. */
export function showLayer(canvas: HTMLCanvasElement, image: HTMLImageElement | null) {
  if (!image) {
    canvas.width = 0;
    canvas.height = 0;
    return;
  }
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  canvas.getContext('2d')?.drawImage(image, 0, 0);
}

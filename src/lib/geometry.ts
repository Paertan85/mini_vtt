// Small geometry helpers shared by the DM window components.

import type { MapGrid } from '../types/map';
import { snapToCorner } from './grid';

export interface Size {
  w: number;
  h: number;
}

export const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** Width and height after a rotation in 90-degree steps. */
export const orientedSize = (size: Size, rotation: number): Size =>
  rotation % 180 === 0 ? size : { w: size.h, h: size.w };

interface Vector {
  x: number;
  y: number;
}

/** How a map is shown: turned clockwise in 90° steps, after mirroring. */
export interface Orientation {
  rotation: number;
  mirrorHorizontal: boolean;
  mirrorVertical: boolean;
}

/**
 * A direction (or an offset from the map's centre) on the map → the same one
 * on screen: mirrored first, then turned, as the windows' CSS transforms do.
 */
export function mapToScreenDirection({ x, y }: Vector, orientation: Orientation): Vector {
  if (orientation.mirrorHorizontal) x = -x;
  if (orientation.mirrorVertical) y = -y;
  if (orientation.rotation === 90) return { x: -y, y: x };
  if (orientation.rotation === 180) return { x: -x, y: -y };
  if (orientation.rotation === 270) return { x: y, y: -x };
  return { x, y };
}

/** A direction on screen → the same one on the map: the turn undone, then the mirroring. */
export function screenToMapDirection({ x, y }: Vector, orientation: Orientation): Vector {
  if (orientation.rotation === 90) [x, y] = [y, -x];
  else if (orientation.rotation === 180) [x, y] = [-x, -y];
  else if (orientation.rotation === 270) [x, y] = [-y, x];
  if (orientation.mirrorHorizontal) x = -x;
  if (orientation.mirrorVertical) y = -y;
  return { x, y };
}

/**
 * A map point (natural pixels, unrotated) on the turned and mirrored map,
 * whose top-left corner is 0,0.
 */
export function mapToOriented(point: Vector, media: Size, orientation: Orientation): Vector {
  const at = mapToScreenDirection({ x: point.x - media.w / 2, y: point.y - media.h / 2 }, orientation);
  const oriented = orientedSize(media, orientation.rotation);
  return { x: at.x + oriented.w / 2, y: at.y + oriented.h / 2 };
}

/** A point on the turned and mirrored map (like the player view's pan) → map natural pixels. */
export function orientedToMap(point: Vector, media: Size, orientation: Orientation): Vector {
  const oriented = orientedSize(media, orientation.rotation);
  const at = screenToMapDirection({ x: point.x - oriented.w / 2, y: point.y - oriented.h / 2 }, orientation);
  return { x: at.x + media.w / 2, y: at.y + media.h / 2 };
}

/**
 * The player view's top-left corner (its pan, on the turned and mirrored
 * map) moved to the nearest corner of the map's grid squares, so whole
 * squares start at the edges of the player screen. At true scale the map's
 * squares then line up with the frame's own grid.
 */
export const snapPanToGrid = (pan: Vector, grid: MapGrid, media: Size, orientation: Orientation): Vector =>
  mapToOriented(snapToCorner(orientedToMap(pan, media, orientation), grid), media, orientation);

// ─── Player view zoom ────────────────────────────────────────────────────────

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 5;
export const clampZoom = (zoom: number) => clamp(zoom, MIN_ZOOM, MAX_ZOOM);

/** Wheel delta in pixels, whatever unit the device reports. */
export const wheelPixels = (event: WheelEvent) =>
  (event.deltaY || event.deltaX) * (event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? 800 : 1);

/** Familiar stops for the − and + buttons, like a browser's zoom. */
const ZOOM_STEPS = [0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];

export function stepZoom(zoom: number, direction: 1 | -1): number {
  const next =
    direction > 0
      ? ZOOM_STEPS.find((step) => step > zoom + 0.001)
      : [...ZOOM_STEPS].reverse().find((step) => step < zoom - 0.001);
  return next ?? clampZoom(zoom);
}

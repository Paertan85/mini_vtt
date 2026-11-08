// Axis-aligned rectangles in map natural pixels, unrotated: the Fog tool's
// Rectangle and the fog rooms. A map turned in 90° steps or mirrored still
// shows them as rectangles, so they are kept on the map's own axes.
//
// Pure functions with no DOM access. Snapping (Ctrl held) is asked for by
// passing the map's grid; null means no snapping.

import type { MapGrid, Point } from '../types/map';
import { clamp, screenToMapDirection, type Orientation, type Size } from './geometry';
import { snapToCorner } from './grid';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The edges a resize moves, on the map's own axes: -1 the left (or top)
 * edge, 1 the right (or bottom) one, 0 neither.
 */
export interface Edges {
  x: -1 | 0 | 1;
  y: -1 | 0 | 1;
}

const snapped = (point: Point, grid: MapGrid | null) => (grid ? snapToCorner(point, grid) : point);

/** Only a rectangle's own fields, whatever else the object carries. */
const rectOf = ({ x, y, width, height }: Rect): Rect => ({ x, y, width, height });

/** The rectangle between two corners, whichever way it was dragged; with a grid, both corners snap to it. */
export function rectFromCorners(a: Point, b: Point, grid: MapGrid | null = null): Rect {
  const p = snapped(a, grid);
  const q = snapped(b, grid);
  return {
    x: Math.min(p.x, q.x),
    y: Math.min(p.y, q.y),
    width: Math.abs(q.x - p.x),
    height: Math.abs(q.y - p.y),
  };
}

/** Its four corners, as an outline to fill. */
export const rectCorners = ({ x, y, width, height }: Rect): Point[] => [
  { x, y },
  { x: x + width, y },
  { x: x + width, y: y + height },
  { x, y: y + height },
];

/** The part of a rectangle on the map; zero wide or high when none of it is. */
export function clipToMap(rect: Rect, media: Size): Rect {
  const x = clamp(rect.x, 0, media.w);
  const y = clamp(rect.y, 0, media.h);
  return {
    x,
    y,
    width: clamp(rect.x + rect.width, 0, media.w) - x,
    height: clamp(rect.y + rect.height, 0, media.h) - y,
  };
}

/**
 * Moved by `delta`, and kept on the map. With a grid, its first corner (top
 * left on the unturned map) snaps to the nearest grid corner, so a room
 * drawn on the grid stays on it.
 */
export function moveRect(rect: Rect, delta: Point, media: Size, grid: MapGrid | null = null): Rect {
  const corner = snapped({ x: rect.x + delta.x, y: rect.y + delta.y }, grid);
  return {
    ...rectOf(rect),
    x: clamp(corner.x, 0, Math.max(0, media.w - rect.width)),
    y: clamp(corner.y, 0, Math.max(0, media.h - rect.height)),
  };
}

/**
 * The `edges` moved to `point`, and kept on the map; with a grid, the moved
 * edges snap to its lines. Dragged past the opposite edge, the rectangle
 * turns inside out rather than vanishing.
 */
export function resizeRect(
  rect: Rect,
  edges: Edges,
  point: Point,
  media: Size,
  grid: MapGrid | null = null,
): Rect {
  const to = snapped(point, grid);
  const left = edges.x < 0 ? to.x : rect.x;
  const right = edges.x > 0 ? to.x : rect.x + rect.width;
  const top = edges.y < 0 ? to.y : rect.y;
  const bottom = edges.y > 0 ? to.y : rect.y + rect.height;
  return clipToMap(rectFromCorners({ x: left, y: top }, { x: right, y: bottom }), media);
}

/**
 * The edges that a handle on one side or corner of the screen moves, on the
 * map's own axes. `side` is a direction on screen: (1, 0) for the right
 * edge, (-1, -1) for the top-left corner. Turning or mirroring the map
 * changes which of its edges that is.
 */
export function edgesOnMap(side: Point, orientation: Orientation): Edges {
  const { x, y } = screenToMapDirection(side, orientation);
  return { x: Math.sign(x) as Edges['x'], y: Math.sign(y) as Edges['y'] };
}

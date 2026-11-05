// A map's own grid (measured by the DM) and the area templates (circles,
// squares, cones and lines) placed on it.
//
// Pure functions with no DOM access: the main process uses the validators for
// everything that arrives over IPC or from a project file, and both windows
// use the geometry. All coordinates are map natural pixels, unrotated.

import type { AreaShape, AuraCircle, AuraDisc, EffectKind, MapGrid, Point } from '../types/map';
import { EFFECT_KINDS, nearestEffectKind } from './effects';

export const MAX_CIRCLES = 50;
export const MIN_RADIUS_FT = 1;
export const MAX_RADIUS_FT = 500;
export const DEFAULT_FEET_PER_CELL = 5;
export const AREA_SHAPES: readonly AreaShape[] = ['circle', 'square', 'cone', 'line'];
export const AREA_LABELS: Record<AreaShape, string> = {
  circle: 'Circle',
  square: 'Square',
  cone: 'Cone',
  line: 'Line',
};
/** Size of a new template: circle radius, square side, cone or line length */
export const DEFAULT_AREA_FT: Record<AreaShape, number> = { circle: 15, square: 10, cone: 15, line: 30 };
export const DEFAULT_LINE_WIDTH_FT = 5;
const CIRCLE_ID = /^[A-Za-z0-9_-]{1,32}$/;

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** A valid grid, or null. Offsets are wrapped into 0..cell. */
export function normalizeGrid(value: unknown): MapGrid | null {
  if (!value || typeof value !== 'object') return null;
  const { cell, offsetX, offsetY, feetPerCell } = value as Record<string, unknown>;
  if (!finite(cell) || cell < 2 || cell > 100_000) return null;
  if (!finite(feetPerCell) || feetPerCell <= 0 || feetPerCell > 1000) return null;
  const wrap = (offset: unknown) => (finite(offset) ? ((offset % cell) + cell) % cell : 0);
  return { cell, offsetX: wrap(offsetX), offsetY: wrap(offsetY), feetPerCell };
}

export const clampRadius = (radiusFt: number) =>
  Math.min(MAX_RADIUS_FT, Math.max(MIN_RADIUS_FT, Math.round(radiusFt)));

/** What `normalizeCircles` changed, so an import can tell the DM. */
export interface AreaReport {
  /** Left out: a shape this version doesn't have, damaged, or over MAX_CIRCLES */
  leftOut: number;
  /** Kept, but shown as another kind: a kind this version doesn't have */
  restyled: number;
}

/**
 * Valid areas only, at most MAX_CIRCLES, with unique ids. Areas can come from
 * a newer version or a fork: one of an unknown shape is left out, as which
 * squares it covers can't be known; one of an unknown kind is kept and shown
 * as the kind nearest to its `color`. `report` counts both.
 */
export function normalizeCircles(value: unknown, report?: AreaReport): AuraCircle[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const circles: AuraCircle[] = [];
  for (const raw of value) {
    const fields = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const { id, x, y, radiusFt, kind, shape, angle, widthFt, color } = fields;
    // Areas saved before shapes existed have none: they are circles
    const knownShape = shape === undefined ? 'circle' : AREA_SHAPES.find((name) => name === shape);
    if (
      circles.length >= MAX_CIRCLES ||
      !knownShape ||
      typeof id !== 'string' ||
      !CIRCLE_ID.test(id) ||
      seen.has(id) ||
      !finite(x) ||
      !finite(y) ||
      !finite(radiusFt)
    ) {
      if (report) report.leftOut += 1;
      continue;
    }
    const knownKind = EFFECT_KINDS.find((name) => name === kind);
    if (!knownKind && report) report.restyled += 1;
    seen.add(id);
    circles.push({
      id,
      x,
      y,
      radiusFt: clampRadius(radiusFt),
      kind: knownKind ?? nearestEffectKind(color),
      shape: knownShape,
      angle: finite(angle) ? ((angle % 360) + 360) % 360 : 0,
      widthFt: finite(widthFt) ? clampRadius(widthFt) : DEFAULT_LINE_WIDTH_FT,
    });
  }
  return circles;
}

/** Valid templates as the player screen draws them (map pixels), at most MAX_CIRCLES. */
export function normalizeDiscs(value: unknown): AuraDisc[] {
  if (!Array.isArray(value)) return [];
  const discs: AuraDisc[] = [];
  for (const raw of value.slice(0, MAX_CIRCLES)) {
    if (!raw || typeof raw !== 'object') continue;
    const { x, y, radius, kind, shape, angle, width } = raw as Record<string, unknown>;
    if (!finite(x) || !finite(y) || !finite(radius) || !finite(angle) || !finite(width)) continue;
    if (radius <= 0 || width < 0) continue;
    if (!EFFECT_KINDS.includes(kind as EffectKind) || !AREA_SHAPES.includes(shape as AreaShape)) continue;
    discs.push({ x, y, radius, kind: kind as EffectKind, shape: shape as AreaShape, angle, width });
  }
  return discs;
}

/**
 * Measure a grid from two clicked corners `squares` squares apart. Corners on
 * a diagonal average both axes; corners along one line use that axis.
 */
export function gridFromCorners(a: Point, b: Point, squares: number, feetPerCell: number): MapGrid | null {
  if (!(squares > 0) || !(feetPerCell > 0)) return null;
  const dx = Math.abs(b.x - a.x);
  const dy = Math.abs(b.y - a.y);
  const longer = Math.max(dx, dy);
  const diagonal = Math.min(dx, dy) > longer * 0.5;
  const cell = (diagonal ? (dx + dy) / 2 : longer) / squares;
  return normalizeGrid({ cell, offsetX: Math.min(a.x, b.x), offsetY: Math.min(a.y, b.y), feetPerCell });
}

/** The centre of the grid square containing `point`. */
export function snapToCell(point: Point, grid: MapGrid): Point {
  const snap = (value: number, offset: number) =>
    offset + (Math.floor((value - offset) / grid.cell) + 0.5) * grid.cell;
  return { x: snap(point.x, grid.offsetX), y: snap(point.y, grid.offsetY) };
}

/** The grid intersection nearest `point`. */
export function snapToCorner(point: Point, grid: MapGrid): Point {
  const snap = (value: number, offset: number) =>
    offset + Math.round((value - offset) / grid.cell) * grid.cell;
  return { x: snap(point.x, grid.offsetX), y: snap(point.y, grid.offsetY) };
}

/**
 * Where a template's point snaps: a circle to the middle of a square, a
 * square so its edges follow the grid lines, a cone or line to the nearest
 * grid corner (the usual origin point).
 */
export function snapArea(point: Point, area: AuraCircle, grid: MapGrid): Point {
  if (area.shape === 'circle') return snapToCell(point, grid);
  if (area.shape === 'square') {
    const squares = Math.max(1, Math.round(area.radiusFt / grid.feetPerCell));
    return squares % 2 === 1 ? snapToCell(point, grid) : snapToCorner(point, grid);
  }
  return snapToCorner(point, grid);
}

export const feetToPixels = (feet: number, grid: MapGrid) => (feet / grid.feetPerCell) * grid.cell;
export const pixelsToFeet = (pixels: number, grid: MapGrid) => (pixels / grid.cell) * grid.feetPerCell;

/** What the player screen needs to draw the templates. */
export const toDiscs = (circles: AuraCircle[], grid: MapGrid | null): AuraDisc[] =>
  grid
    ? circles.map(({ x, y, radiusFt, kind, shape, angle, widthFt }) => ({
        x,
        y,
        radius: feetToPixels(radiusFt, grid),
        kind,
        shape,
        angle,
        width: feetToPixels(widthFt, grid),
      }))
    : [];

/** The far end of a cone or line (map pixels). */
export function areaTip(disc: Pick<AuraDisc, 'x' | 'y' | 'radius' | 'angle'>): Point {
  const radians = (disc.angle * Math.PI) / 180;
  return { x: disc.x + Math.cos(radians) * disc.radius, y: disc.y + Math.sin(radians) * disc.radius };
}

/**
 * Where a template's handle sits (map pixels): the tip of a cone or line, the
 * middle of a square's front edge; null for a circle.
 */
export function areaHandle(disc: AuraDisc): Point | null {
  if (disc.shape === 'circle') return null;
  return areaTip(disc.shape === 'square' ? { ...disc, radius: disc.radius / 2 } : disc);
}

/**
 * Outline of a square, cone or line (map pixels); null for a circle. A square
 * turns about its centre; a cone is as wide at its end as it is long, as in
 * D&D 5e; a line is centred on its direction.
 */
export function areaOutline(disc: AuraDisc): Point[] | null {
  const { x, y, radius, shape } = disc;
  if (shape === 'circle') return null;
  const radians = (disc.angle * Math.PI) / 180;
  const along = { x: Math.cos(radians), y: Math.sin(radians) };
  const across = { x: -along.y, y: along.x };
  const side = (from: Point, half: number, sign: number) => ({
    x: from.x + across.x * half * sign,
    y: from.y + across.y * half * sign,
  });
  if (shape === 'square') {
    const half = radius / 2;
    const back = { x: x - along.x * half, y: y - along.y * half };
    const front = { x: x + along.x * half, y: y + along.y * half };
    return [side(back, half, -1), side(front, half, -1), side(front, half, 1), side(back, half, 1)];
  }
  const tip = { x: x + along.x * radius, y: y + along.y * radius };
  if (shape === 'cone') return [{ x, y }, side(tip, radius / 2, 1), side(tip, radius / 2, -1)];
  const half = disc.width / 2;
  return [side({ x, y }, half, 1), side(tip, half, 1), side(tip, half, -1), side({ x, y }, half, -1)];
}

/** Whether `point` (map pixels) is inside a template, with `margin` pixels to spare. */
export function areaContains(disc: AuraDisc, point: Point, margin: number): boolean {
  const outline = areaOutline(disc);
  if (!outline) return Math.hypot(point.x - disc.x, point.y - disc.y) <= disc.radius + margin;
  // Inside, or within `margin` of an edge (for thin lines and small shapes)
  let inside = false;
  for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
    const a = outline[i];
    const b = outline[j];
    if (a.y > point.y !== b.y > point.y && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  if (inside) return true;
  return outline.some((a, i) => {
    const b = outline[(i + 1) % outline.length];
    const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const t = Math.max(
      0,
      Math.min(1, ((point.x - a.x) * (b.x - a.x) + (point.y - a.y) * (b.y - a.y)) / length ** 2),
    );
    return Math.hypot(point.x - (a.x + t * (b.x - a.x)), point.y - (a.y + t * (b.y - a.y))) <= margin;
  });
}

export const newCircleId = () => `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

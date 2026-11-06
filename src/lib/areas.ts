// Spell areas: the templates (circles, squares, cones and lines) placed on a
// map, sized in feet against the map's grid.
//
// Pure functions with no DOM access: the main process uses the validators for
// everything that arrives over IPC or from a project file, both windows use
// the geometry, and the DM window the editing steps. All coordinates are map
// natural pixels, unrotated; angles are degrees in map space (0 points along
// +x).

import type { AreaShape, AuraCircle, AuraDisc, EffectKind, MapGrid, Point } from '../types/map';
import { EFFECT_KINDS, nearestEffectKind } from './effects';
import { feetToPixels, pixelsToFeet, snapToCell, snapToCorner } from './grid';

export const MAX_CIRCLES = 50;
export const MIN_RADIUS_FT = 1;
export const MAX_RADIUS_FT = 500;
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
/** Feet per wheel notch, and the steps an aimed length keeps to */
export const AREA_STEP_FT = 5;
/** A square turned within this many degrees of the grid settles onto it */
const SQUARE_SNAP_DEG = 5;
/** Cones and lines aimed with Ctrl held keep to these steps */
const AIM_SNAP_DEG = 45;
const CIRCLE_ID = /^[A-Za-z0-9_-]{1,32}$/;

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

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

// ─── Editing ──────────────────────────────────────────────────────────────────

/** The angle of a direction in map space, 0 to 360. */
const angleOf = (direction: Point) => ((Math.atan2(direction.y, direction.x) * 180) / Math.PI + 360) % 360;

/** A new template of `shape` at `center`, a cone or line pointing along `direction` (map space). */
export function newArea(shape: AreaShape, center: Point, kind: EffectKind, direction: Point): AuraCircle {
  return {
    id: newCircleId(),
    ...center,
    radiusFt: DEFAULT_AREA_FT[shape],
    kind,
    shape,
    angle: angleOf(direction),
    widthFt: DEFAULT_LINE_WIDTH_FT,
  };
}

/** `value` grown or shrunk by whole wheel notches, each to the next multiple of 5 ft. */
export function stepSize(value: number, notches: number): number {
  for (let i = 0; i < Math.abs(notches); i++) {
    value =
      notches > 0
        ? Math.floor(value / AREA_STEP_FT) * AREA_STEP_FT + AREA_STEP_FT
        : Math.ceil(value / AREA_STEP_FT) * AREA_STEP_FT - AREA_STEP_FT;
  }
  return clampRadius(Math.max(AREA_STEP_FT, value));
}

/** The wheel over a template: a line's width, any other template's size. */
export const resizeArea = (area: AuraCircle, notches: number): AuraCircle =>
  area.shape === 'line'
    ? { ...area, widthFt: stepSize(area.widthFt, notches) }
    : { ...area, radiusFt: stepSize(area.radiusFt, notches) };

/**
 * The handle dragged to `point`. A cone or line points at it and its length
 * follows, in 5 ft steps; with `snap` (Ctrl held) the direction keeps to 45°
 * steps. A square only turns, and settles onto the grid near a right angle.
 */
export function aimArea(area: AuraCircle, point: Point, grid: MapGrid, snap: boolean): AuraCircle {
  const dx = point.x - area.x;
  const dy = point.y - area.y;
  const angle = angleOf({ x: dx, y: dy });
  if (area.shape === 'square') {
    const square = Math.round(angle / 90) * 90;
    return { ...area, angle: Math.abs(angle - square) <= SQUARE_SNAP_DEG ? square % 360 : angle };
  }
  const feet = pixelsToFeet(Math.hypot(dx, dy), grid);
  return {
    ...area,
    angle: snap ? (Math.round(angle / AIM_SNAP_DEG) * AIM_SNAP_DEG) % 360 : angle,
    radiusFt: clampRadius(Math.max(AREA_STEP_FT, Math.round(feet / AREA_STEP_FT) * AREA_STEP_FT)),
  };
}

// Spell areas: the templates (areas, squares, cones and lines) placed on a
// map, sized in feet against the map's grid.
//
// Pure functions with no DOM access: the main process uses the validators for
// everything that arrives over IPC or from a project file, both windows use
// the geometry, and the DM window the editing steps. All coordinates are map
// natural pixels, unrotated; angles are degrees in map space (0 points along
// +x).

import type { AreaGrid, AreaShape, SpellArea, DrawnArea, EffectKind, MapGrid, Point } from '../types/map';
import { EFFECT_KINDS, nearestEffectKind } from './effects';
import { clamp, screenToMapDirection, type Orientation, type Size } from './geometry';
import { feetToPixels, pixelsToFeet, snapToCell, snapToCorner } from './grid';

export const MAX_AREAS = 50;
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
/**
 * How far (in steps) an aimed size must be dragged past its current one
 * before it changes, so it doesn't flicker between two sizes at the halfway
 * point
 */
const AIM_HOLD_STEPS = 0.8;
/** A square turned within this many degrees of the grid settles onto it */
const SQUARE_SNAP_DEG = 5;
/** Cones and lines aimed with Ctrl held keep to these steps */
const AIM_SNAP_DEG = 45;
const AREA_ID = /^[A-Za-z0-9_-]{1,32}$/;

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

export const clampRadius = (radiusFt: number) =>
  Math.min(MAX_RADIUS_FT, Math.max(MIN_RADIUS_FT, Math.round(radiusFt)));

/** `feet` rounded to the nearest 5 ft step, at least one step. */
export const nearestStep = (feet: number) =>
  clampRadius(Math.max(AREA_STEP_FT, Math.round(feet / AREA_STEP_FT) * AREA_STEP_FT));

/** What `normalizeAreas` changed, so an import can tell the DM. */
export interface AreaReport {
  /** Left out: a shape this version doesn't have, damaged, or over MAX_AREAS */
  leftOut: number;
  /** Kept, but shown as another kind: a kind this version doesn't have */
  restyled: number;
}

/**
 * Valid areas only, at most MAX_AREAS, with unique ids. Areas can come from
 * a newer version or a fork: one of an unknown shape is left out, as which
 * squares it covers can't be known; one of an unknown kind is kept and shown
 * as the kind nearest to its `color`. `report` counts both.
 */
export function normalizeAreas(value: unknown, report?: AreaReport): SpellArea[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const areas: SpellArea[] = [];
  for (const raw of value) {
    const fields = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const { id, x, y, radiusFt, kind, shape, angle, widthFt, color } = fields;
    // Areas saved before shapes existed have none: they are areas
    const knownShape = shape === undefined ? 'circle' : AREA_SHAPES.find((name) => name === shape);
    if (
      areas.length >= MAX_AREAS ||
      !knownShape ||
      typeof id !== 'string' ||
      !AREA_ID.test(id) ||
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
    areas.push({
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
  return areas;
}

/** Valid templates as the player screen draws them (map pixels), at most MAX_AREAS. */
export function normalizeDrawnAreas(value: unknown): DrawnArea[] {
  if (!Array.isArray(value)) return [];
  const discs: DrawnArea[] = [];
  for (const raw of value.slice(0, MAX_AREAS)) {
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
export function snapArea(point: Point, area: SpellArea, grid: MapGrid): Point {
  if (area.shape === 'circle') return snapToCell(point, grid);
  if (area.shape === 'square') {
    const squares = Math.max(1, Math.round(area.radiusFt / grid.feetPerCell));
    return squares % 2 === 1 ? snapToCell(point, grid) : snapToCorner(point, grid);
  }
  return snapToCorner(point, grid);
}

/** What the player screen needs to draw the templates. */
export const toDrawnAreas = (areas: SpellArea[], grid: MapGrid | null): DrawnArea[] =>
  grid
    ? areas.map(({ x, y, radiusFt, kind, shape, angle, widthFt }) => ({
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
export function areaTip(disc: Pick<DrawnArea, 'x' | 'y' | 'radius' | 'angle'>): Point {
  const radians = (disc.angle * Math.PI) / 180;
  return { x: disc.x + Math.cos(radians) * disc.radius, y: disc.y + Math.sin(radians) * disc.radius };
}

/**
 * Where a template's handle sits (map pixels): the tip of a cone or line, the
 * middle of a square's front edge; null for a circle.
 */
export function areaHandle(disc: DrawnArea): Point | null {
  if (disc.shape === 'circle') return null;
  return areaTip(disc.shape === 'square' ? { ...disc, radius: disc.radius / 2 } : disc);
}

/**
 * Outline of a square, cone or line (map pixels); null for a circle. A square
 * turns about its centre; a cone is as wide at its end as it is long, as in
 * D&D 5e; a line is centred on its direction.
 */
export function areaOutline(disc: DrawnArea): Point[] | null {
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

/** Whether `point` is inside `outline` (even-odd rule). */
function insideOutline(outline: readonly Point[], point: Point): boolean {
  let inside = false;
  for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
    const a = outline[i];
    const b = outline[j];
    if (a.y > point.y !== b.y > point.y && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/** Whether `point` (map pixels) is inside a template, with `margin` pixels to spare. */
export function areaContains(disc: DrawnArea, point: Point, margin: number): boolean {
  const outline = areaOutline(disc);
  if (!outline) return Math.hypot(point.x - disc.x, point.y - disc.y) <= disc.radius + margin;
  // Inside, or within `margin` of an edge (for thin lines and small shapes)
  if (insideOutline(outline, point)) return true;
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

// ─── The squares an area covers ───────────────────────────────────────────────

/** A grid square: its column and row, counted from the square at the grid's offset. */
export interface GridSquare {
  col: number;
  row: number;
}

/**
 * The most squares an area's bounding box may span for its squares to be
 * worked out: about a 250 ft circle. A larger area shows none, so a
 * 500 ft one can't hold up the window.
 */
export const MAX_AREA_SQUARES = 10_000;
/**
 * Sample points across each side of a square, for whether a shape covers
 * half of it. An odd count, nudged a little off centre, so a square a shape
 * covers exactly half of (a 5 ft line along a grid line) goes one way, the
 * same way every time, never both: the square right of or below the edge.
 */
const SQUARE_SAMPLES = 5;
const SAMPLE_NUDGE = 0.013;

/**
 * How many squares from a circle's centre each column (or row) is, along one
 * axis. A centre in the middle half of a square counts from that square, as
 * an emanation counts from its creature's space: the square itself is 0, its
 * neighbours 1. A centre near a grid line counts from the line, as a sphere
 * counts from a grid intersection: the squares on either side are 1.
 */
function axisSquares(value: number, offset: number, cell: number) {
  const at = (value - offset) / cell;
  const inSquare = at - Math.floor(at);
  if (inSquare >= 0.25 && inSquare < 0.75) {
    const square = Math.floor(at);
    return { first: square, distance: (index: number) => Math.abs(index - square) };
  }
  const line = Math.round(at);
  return { first: line, distance: (index: number) => (index >= line ? index - line + 1 : line - index) };
}

/**
 * The grid squares a spell area covers, or null when it spans more than
 * MAX_AREA_SQUARES. A circle (a sphere or an emanation) covers the squares
 * within its radius counted as movement is, with diagonals 5, 10, 5 ft under
 * the 5/10 rule, so it comes out as the familiar stepped shape. A square,
 * cone or line covers a square when it covers at least half of it, as the
 * D&D rules have it for areas on a grid (an exact half: see SQUARE_SAMPLES).
 */
export function coveredSquares(disc: DrawnArea, grid: AreaGrid): GridSquare[] | null {
  const { cell, offsetX, offsetY } = grid;
  if (!(cell > 0) || !(disc.radius > 0)) return [];
  const squares: GridSquare[] = [];
  if (disc.shape === 'circle') {
    const reach = disc.radius / cell;
    const across = axisSquares(disc.x, offsetX, cell);
    const down = axisSquares(disc.y, offsetY, cell);
    const span = Math.ceil(reach) + 1;
    if ((span * 2 + 1) ** 2 > MAX_AREA_SQUARES) return null;
    for (let row = down.first - span; row <= down.first + span; row++) {
      for (let col = across.first - span; col <= across.first + span; col++) {
        const a = across.distance(col);
        const b = down.distance(row);
        const longer = Math.max(a, b);
        const moved = grid.rule === 'uniform' ? longer : longer + Math.floor(Math.min(a, b) / 2);
        if (moved <= reach + 1e-9) squares.push({ col, row });
      }
    }
    return squares;
  }
  const outline = areaOutline(disc) ?? [];
  const xs = outline.map((point) => point.x);
  const ys = outline.map((point) => point.y);
  const firstCol = Math.floor((Math.min(...xs) - offsetX) / cell);
  const lastCol = Math.floor((Math.max(...xs) - offsetX) / cell);
  const firstRow = Math.floor((Math.min(...ys) - offsetY) / cell);
  const lastRow = Math.floor((Math.max(...ys) - offsetY) / cell);
  if ((lastCol - firstCol + 1) * (lastRow - firstRow + 1) > MAX_AREA_SQUARES) return null;
  const half = (SQUARE_SAMPLES * SQUARE_SAMPLES) / 2;
  const sample = (index: number) => (index + 0.5) / SQUARE_SAMPLES + SAMPLE_NUDGE;
  for (let row = firstRow; row <= lastRow; row++) {
    for (let col = firstCol; col <= lastCol; col++) {
      let inside = 0;
      for (let i = 0; i < SQUARE_SAMPLES; i++) {
        for (let j = 0; j < SQUARE_SAMPLES; j++) {
          const point = {
            x: offsetX + (col + sample(i)) * cell,
            y: offsetY + (row + sample(j)) * cell,
          };
          if (insideOutline(outline, point)) inside += 1;
        }
      }
      if (inside > half) squares.push({ col, row });
    }
  }
  return squares;
}

/**
 * SVG paths (map pixels) for covered squares: `fill`, every square, and
 * `edge`, only the outline round them, so squares side by side read as one
 * stepped shape.
 */
export function squaresPaths(squares: readonly GridSquare[], grid: AreaGrid): { fill: string; edge: string } {
  const { cell, offsetX, offsetY } = grid;
  const covered = new Set(squares.map(({ col, row }) => `${col},${row}`));
  const has = (col: number, row: number) => covered.has(`${col},${row}`);
  const round = (value: number) => Math.round(value * 100) / 100;
  let fill = '';
  let edge = '';
  for (const { col, row } of squares) {
    const left = round(offsetX + col * cell);
    const top = round(offsetY + row * cell);
    const right = round(offsetX + (col + 1) * cell);
    const bottom = round(offsetY + (row + 1) * cell);
    fill += `M${left} ${top}H${right}V${bottom}H${left}Z`;
    if (!has(col, row - 1)) edge += `M${left} ${top}H${right}`;
    if (!has(col, row + 1)) edge += `M${left} ${bottom}H${right}`;
    if (!has(col - 1, row)) edge += `M${left} ${top}V${bottom}`;
    if (!has(col + 1, row)) edge += `M${right} ${top}V${bottom}`;
  }
  return { fill, edge };
}

export const newAreaId = () => `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

// ─── Editing ──────────────────────────────────────────────────────────────────

/** The angle of a direction in map space, 0 to 360. */
const angleOf = (direction: Point) => ((Math.atan2(direction.y, direction.x) * 180) / Math.PI + 360) % 360;

/** A new template of `shape` at `center`, a cone or line pointing along `direction` (map space). */
export function newArea(shape: AreaShape, center: Point, kind: EffectKind, direction: Point): SpellArea {
  return {
    id: newAreaId(),
    ...center,
    radiusFt: DEFAULT_AREA_FT[shape],
    kind,
    shape,
    angle: angleOf(direction),
    widthFt: DEFAULT_LINE_WIDTH_FT,
  };
}

/** How far apart (screen px) areas added one after another land, so each dot can be grabbed */
export const NEW_AREA_GAP_PX = 32;

/**
 * The step between areas added one after another: down and to the right on
 * screen, by whole squares, at least NEW_AREA_GAP_PX across on screen.
 * `displayScale` is screen px per map px.
 */
export function newAreaStep(grid: MapGrid, orientation: Orientation, displayScale: number): Point {
  const squarePx = grid.cell * displayScale;
  const squares = squarePx > 0 ? Math.max(1, Math.ceil(NEW_AREA_GAP_PX / squarePx)) : 1;
  const { x, y } = screenToMapDirection({ x: 1, y: 1 }, orientation);
  return { x: x * squares * grid.cell, y: y * squares * grid.cell };
}

/** `value` brought into 0..size by whole sizes, so a row that runs off one edge goes on from the other. */
const wrap = (value: number, size: number) => ((value % size) + size) % size;

/**
 * Where a new area goes: `start`, or, while another area's centre is there,
 * a `step` further on, so areas added one after another don't land on top
 * of each other. Nearer than half a step counts as the same spot.
 *
 * With the map's size, every spot is on the map: `start` is kept on it, and
 * a row that runs off one edge goes on from the opposite one. Such a row can
 * come back round to spots already tried, so it stops after a few times as
 * many tries as there are areas and settles for `start`, which is on the map.
 */
export function freeSpot(
  start: Point,
  step: Point,
  areas: readonly Point[],
  media: Size | null = null,
): Point {
  const near = Math.hypot(step.x, step.y) / 2;
  // Only a spot past an edge is wrapped; one on the edge stays where it is
  const onAxis = (value: number, size: number) => (value < 0 || value > size ? wrap(value, size) : value);
  const onMap = (point: Point) =>
    media && media.w > 0 && media.h > 0
      ? { x: onAxis(point.x, media.w), y: onAxis(point.y, media.h) }
      : point;
  const first = media ? { x: clamp(start.x, 0, media.w), y: clamp(start.y, 0, media.h) } : start;
  const tries = (areas.length + 1) * 4;
  for (let k = 0; k < tries; k++) {
    const spot = onMap({ x: first.x + step.x * k, y: first.y + step.y * k });
    if (!areas.some((area) => Math.hypot(area.x - spot.x, area.y - spot.y) < near)) return spot;
  }
  return first;
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
export const resizeArea = (area: SpellArea, notches: number): SpellArea =>
  area.shape === 'line'
    ? { ...area, widthFt: stepSize(area.widthFt, notches) }
    : { ...area, radiusFt: stepSize(area.radiusFt, notches) };

/**
 * The handle dragged to `point`. A cone or line points at it and its length
 * follows, in 5 ft steps; with `snap` (Ctrl held) the direction keeps to 45°
 * steps. A square turns, settling onto the grid near a right angle, and its
 * side follows the handle (the middle of its front edge) in 5 ft steps, about
 * its centre. A size only changes once the handle is AIM_HOLD_STEPS of a
 * step past it, then lands on the nearest step.
 */
export function aimArea(area: SpellArea, point: Point, grid: MapGrid, snap: boolean): SpellArea {
  const dx = point.x - area.x;
  const dy = point.y - area.y;
  const angle = angleOf({ x: dx, y: dy });
  const feet = pixelsToFeet(Math.hypot(dx, dy), grid);
  const inSteps = (value: number) =>
    Math.abs(value - area.radiusFt) < AIM_HOLD_STEPS * AREA_STEP_FT ? area.radiusFt : nearestStep(value);
  if (area.shape === 'square') {
    const square = Math.round(angle / 90) * 90;
    return {
      ...area,
      angle: Math.abs(angle - square) <= SQUARE_SNAP_DEG ? square % 360 : angle,
      radiusFt: inSteps(feet * 2),
    };
  }
  return {
    ...area,
    angle: snap ? (Math.round(angle / AIM_SNAP_DEG) * AIM_SNAP_DEG) % 360 : angle,
    radiusFt: inSteps(feet),
  };
}

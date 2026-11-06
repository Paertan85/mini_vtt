// A map's own grid (measured by the DM, or read from its file name) and
// measuring on it. Spell areas placed on the grid are in areas.ts.
//
// Pure functions with no DOM access: the main process uses the validators for
// everything that arrives over IPC or from a project file, and both windows
// use the geometry. All coordinates are map natural pixels, unrotated.

import type { DiagonalRule, MapGrid, MovementRule, Point } from '../types/map';

export const DEFAULT_FEET_PER_CELL = 5;

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

// ─── Grid size from a file or folder name ─────────────────────────────────────
// The same rules as Mini Gridder: `forest_32x32`, `[27 x 19]`, `(40×40)` give
// the squares across × down, `300PPI` the pixels per square.

/** Smallest and largest square, in pixels, a name may give */
const NAME_MIN_CELL = 8;
const NAME_MAX_CELL = 1000;
/** Width- and height-based square sizes may differ by this much and still fit */
const NAME_FIT_TOLERANCE = 0.02;
/** The file name, then its folder, then up to two folders above it */
export const NAME_FOLDER_LEVELS = 3;

// A number not continuing another one, `x` or `×`, a number not running into
// a version-like `.N`, and not marked `px` (an image size, not squares)
const NAME_PAIR = /(?<![\d.])(\d+(?:\.\d+)?) *[xX×] *(\d+(?:\.\d+)?)(?!\d|\.\d| *px)/gi;
const NAME_PPI = /(?<![\d.])(\d+(?:\.\d+)?) *ppi/i;

const inCellRange = (cell: number) => cell >= NAME_MIN_CELL && cell <= NAME_MAX_CELL;
const relDiff = (a: number, b: number) => Math.abs(a - b) / Math.max(a, b);

/**
 * The square size in pixels one name gives a `width` × `height` image, or
 * null. A pair may be read across × down or down × across, whichever fits the
 * image; a pair that is the image's own pixel size is skipped. Of several that
 * fit, the last one in the name wins. A pair that fits neither way is not used.
 */
function cellFromPairs(name: string, width: number, height: number): number | null {
  let cell: number | null = null;
  for (const match of name.matchAll(NAME_PAIR)) {
    const a = Number(match[1]);
    const b = Number(match[2]);
    if (!(a > 0 && b > 0)) continue;
    if ((a === width && b === height) || (a === height && b === width)) continue;
    for (const [across, down] of [
      [a, b],
      [b, a],
    ]) {
      const cellW = width / across;
      if (inCellRange(cellW) && relDiff(cellW, height / down) <= NAME_FIT_TOLERANCE) {
        cell = cellW;
        break;
      }
    }
  }
  return cell;
}

/**
 * The square size in pixels that a map's names give, or null. `names` holds
 * the file name without its extension, then the folders above it, nearest
 * first. A squares count anywhere wins over a PPI value; nearer names win
 * over farther ones.
 */
export function cellFromNames(names: readonly string[], width: number, height: number): number | null {
  if (!(width > 0 && height > 0)) return null;
  const searched = names.slice(0, NAME_FOLDER_LEVELS + 1);
  for (const name of searched) {
    const cell = cellFromPairs(name, width, height);
    if (cell !== null) return cell;
  }
  for (const name of searched) {
    const ppi = NAME_PPI.exec(name);
    if (ppi && inCellRange(Number(ppi[1]))) return Number(ppi[1]);
  }
  return null;
}

/** The grid squares across × down a map holds, for showing in the library. */
export const gridSquares = (grid: MapGrid, width: number, height: number) =>
  width > 0 && height > 0
    ? `${Math.round((width / grid.cell) * 10) / 10} × ${Math.round((height / grid.cell) * 10) / 10}`
    : null;

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

export const MOVEMENT_RULES: readonly MovementRule[] = ['alternate', 'uniform'];
export const DEFAULT_MOVEMENT_RULE: MovementRule = 'alternate';
/** The settings menu's names for the Movement ruler's rules */
export const MOVEMENT_LABELS: Record<MovementRule, string> = {
  alternate: 'Movement: 5/10 diagonals',
  uniform: 'Movement: every square',
};
/** How each rule counts, for tooltips */
export const MOVEMENT_TITLES: Record<MovementRule, string> = {
  alternate: 'every second diagonal square counts double: 5, 10, 5 ft…',
  uniform: 'diagonal squares count like any other',
};
export const isMovementRule = (value: unknown): value is MovementRule =>
  MOVEMENT_RULES.includes(value as MovementRule);

/** The most points a measured path can have */
export const MAX_RULER_POINTS = 100;

/**
 * The length in feet of a path through `points` (map pixels). The rules that
 * count squares count the squares moved from the one holding each point to
 * the one holding the next, and the 5/10 rule counts diagonals across the
 * whole path, so two single diagonal steps round a corner are 5 + 10 ft. A
 * straight line is rounded to the foot.
 */
export function measurePathFeet(points: readonly Point[], grid: MapGrid, rule: DiagonalRule): number {
  if (rule === 'straight') {
    let pixels = 0;
    for (let i = 1; i < points.length; i++) {
      pixels += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    }
    return Math.round(pixelsToFeet(pixels, grid));
  }
  const square = (value: number, offset: number) => Math.floor((value - offset) / grid.cell);
  let straight = 0;
  let diagonal = 0;
  for (let i = 1; i < points.length; i++) {
    const dx = Math.abs(square(points[i].x, grid.offsetX) - square(points[i - 1].x, grid.offsetX));
    const dy = Math.abs(square(points[i].y, grid.offsetY) - square(points[i - 1].y, grid.offsetY));
    diagonal += Math.min(dx, dy);
    straight += Math.max(dx, dy) - Math.min(dx, dy);
  }
  const squares = rule === 'uniform' ? straight + diagonal : straight + diagonal + Math.floor(diagonal / 2);
  return squares * grid.feetPerCell;
}

/** The distance in feet from `a` to `b` (map pixels); see `measurePathFeet`. */
export const measureFeet = (a: Point, b: Point, grid: MapGrid, rule: DiagonalRule) =>
  measurePathFeet([a, b], grid, rule);

export const feetToPixels = (feet: number, grid: MapGrid) => (feet / grid.feetPerCell) * grid.cell;
export const pixelsToFeet = (pixels: number, grid: MapGrid) => (pixels / grid.cell) * grid.feetPerCell;

// A map's own grid (measured by the DM) and the aura circles placed on it.
//
// Pure functions with no DOM access: the main process uses the validators for
// everything that arrives over IPC or from a project file, and both windows
// use the geometry. All coordinates are map natural pixels, unrotated.

import type { AuraCircle, AuraDisc, EffectKind, MapGrid, Point } from '../types/map';

export const MAX_CIRCLES = 50;
export const MIN_RADIUS_FT = 1;
export const MAX_RADIUS_FT = 500;
export const DEFAULT_FEET_PER_CELL = 5;
const EFFECT_KIND_NAMES: readonly EffectKind[] = ['fire', 'poison', 'magic'];
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

/** Valid circles only, at most MAX_CIRCLES, with unique ids. */
export function normalizeCircles(value: unknown): AuraCircle[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const circles: AuraCircle[] = [];
  for (const raw of value) {
    if (circles.length >= MAX_CIRCLES) break;
    if (!raw || typeof raw !== 'object') continue;
    const { id, x, y, radiusFt, kind } = raw as Record<string, unknown>;
    if (typeof id !== 'string' || !CIRCLE_ID.test(id) || seen.has(id)) continue;
    if (!finite(x) || !finite(y) || !finite(radiusFt)) continue;
    if (!EFFECT_KIND_NAMES.includes(kind as EffectKind)) continue;
    seen.add(id);
    circles.push({ id, x, y, radiusFt: clampRadius(radiusFt), kind: kind as EffectKind });
  }
  return circles;
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

export const feetToPixels = (feet: number, grid: MapGrid) => (feet / grid.feetPerCell) * grid.cell;

/** What the player screen needs to draw the circles. */
export const toDiscs = (circles: AuraCircle[], grid: MapGrid | null): AuraDisc[] =>
  grid
    ? circles.map(({ x, y, radiusFt, kind }) => ({ x, y, radius: feetToPixels(radiusFt, grid), kind }))
    : [];

export const newCircleId = () => `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

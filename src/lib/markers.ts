// Markers: round marks the DM puts on a map to plan with, such as where
// enemies will appear or where something invisible stands. Only the DM sees
// them; they are never sent to the player screen.
//
// On a map with a grid a marker covers whole squares (1 for a Medium
// creature, 2 for Large…) and sits on them. Without a grid its size is in map
// pixels, like the fog brush, so it grows and shrinks with the DM view zoom.
// Each shows a capital letter, so the DM can keep track of what it stands for.
//
// Pure functions with no DOM access: the main process validates with them
// everything that arrives over IPC or from a project file, and the DM window
// edits markers with them. All coordinates are map natural pixels, unrotated.

import type { MapGrid, MapMarker, MarkerColor, Point } from '../types/map';
import { FRAME_COLOR_STYLES } from './frameColors';
import { snapToCell, snapToCorner } from './grid';

export const MAX_MARKERS = 100;
/** On a grid: a marker's size in squares across */
export const MIN_MARKER_SQUARES = 1;
export const MAX_MARKER_SQUARES = 8;
/** Without a grid: a marker's radius in map pixels, in the fog brush's range and steps */
export const MIN_MARKER_RADIUS = 10;
export const MAX_MARKER_RADIUS = 600;
export const MARKER_RADIUS_STEP = 10;
export const DEFAULT_MARKER_RADIUS = 40;
/** Largest radius a saved marker may have (a marker of many large squares) */
const MAX_SAVED_RADIUS = 1_000_000;
const MARKER_ID = /^[A-Za-z0-9_-]{1,32}$/;

export const MARKER_COLORS: readonly MarkerColor[] = ['red', 'blue', 'green', 'yellow'];

/**
 * Label, and the colour as space-separated RGB so it can take an alpha. The
 * app's own colours: the frame's crimson, sky blue and gold, and the poison
 * effect's green (#45b649).
 */
export const MARKER_STYLES: Record<MarkerColor, { label: string; rgb: string }> = {
  red: { label: 'Red', rgb: FRAME_COLOR_STYLES.crimson.rgb },
  blue: { label: 'Blue', rgb: FRAME_COLOR_STYLES.sky.rgb },
  green: { label: 'Green', rgb: '69 182 73' },
  yellow: { label: 'Yellow', rgb: FRAME_COLOR_STYLES.gold.rgb },
};

export const isMarkerColor = (value: unknown): value is MarkerColor =>
  MARKER_COLORS.includes(value as MarkerColor);

/** The letters a marker can show: capitals A to Z. */
export const MARKER_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

export const isMarkerLetter = (value: unknown): value is string =>
  typeof value === 'string' && value.length === 1 && MARKER_LETTERS.includes(value);

/**
 * The letter typed into a marker's letter field: the last character typed,
 * as a capital; '' for none (the field emptied); null for anything that
 * isn't a letter A to Z, which leaves the letter as it was.
 */
export function typedMarkerLetter(text: string): string | null {
  if (text === '') return '';
  const letter = text.slice(-1).toUpperCase();
  return isMarkerLetter(letter) ? letter : null;
}

/** The letter a new marker gets: the first not yet on the map, A again once all are. */
export function nextMarkerLetter(markers: readonly MapMarker[]): string {
  const used = new Set(markers.map((marker) => marker.letter));
  return [...MARKER_LETTERS].find((letter) => !used.has(letter)) ?? MARKER_LETTERS[0];
}

/** A marker with `letter`; none when it is ''. */
export function withLetter(marker: MapMarker, letter: string): MapMarker {
  const { letter: _old, ...rest } = marker;
  return letter ? { ...rest, letter } : rest;
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export const newMarkerId = () => `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/**
 * Valid markers only, at most MAX_MARKERS, with unique ids and a positive
 * size. A colour this version doesn't have (from a newer version or a fork)
 * shows as red; a letter that isn't a capital A to Z is left out.
 */
export function normalizeMarkers(value: unknown): MapMarker[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const markers: MapMarker[] = [];
  for (const raw of value) {
    if (markers.length >= MAX_MARKERS) break;
    const { id, x, y, radius, color, letter } = (raw && typeof raw === 'object' ? raw : {}) as Record<
      string,
      unknown
    >;
    if (typeof id !== 'string' || !MARKER_ID.test(id) || seen.has(id)) continue;
    if (!finite(x) || !finite(y) || !finite(radius) || radius <= 0) continue;
    seen.add(id);
    markers.push({
      id,
      x,
      y,
      radius: Math.min(radius, MAX_SAVED_RADIUS),
      color: isMarkerColor(color) ? color : 'red',
      ...(isMarkerLetter(letter) ? { letter } : {}),
    });
  }
  return markers;
}

// ─── Size and place ───────────────────────────────────────────────────────────

/** The size the DM picks: squares across on a map with a grid, else a radius in map pixels. */
export const clampMarkerSize = (size: number, grid: MapGrid | null) =>
  grid
    ? clamp(Math.round(size), MIN_MARKER_SQUARES, MAX_MARKER_SQUARES)
    : clamp(Math.round(size / MARKER_RADIUS_STEP) * MARKER_RADIUS_STEP, MIN_MARKER_RADIUS, MAX_MARKER_RADIUS);

/** One size step (a square, or MARKER_RADIUS_STEP pixels) per wheel notch; positive grows. */
export const stepMarkerSize = (size: number, notches: number, grid: MapGrid | null) =>
  clampMarkerSize(size + notches * (grid ? 1 : MARKER_RADIUS_STEP), grid);

/** A marker's radius in map pixels for a size as clampMarkerSize gives it. */
export const markerRadius = (size: number, grid: MapGrid | null) => (grid ? (size * grid.cell) / 2 : size);

/** A marker's size as the DM picks it: its squares on a grid, else its radius. */
export const markerSize = (marker: Pick<MapMarker, 'radius'>, grid: MapGrid | null) =>
  clampMarkerSize(grid ? (marker.radius * 2) / grid.cell : marker.radius, grid);

/**
 * Where a marker of `radius` dropped at `point` goes: on a grid, onto the
 * squares it covers (an odd number across centres in a square, an even
 * number on a corner), else just there.
 */
export function placeMarker(point: Point, radius: number, grid: MapGrid | null): Point {
  if (!grid) return { x: point.x, y: point.y };
  return markerSize({ radius }, grid) % 2 === 1 ? snapToCell(point, grid) : snapToCorner(point, grid);
}

/** A marker is never drawn smaller than this (screen px), however far the DM view is zoomed out */
const MIN_SHOWN_RADIUS_PX = 6;

/** The smallest radius (map px) a marker is drawn and hit at, at `displayScale` screen px per map px. */
export const markerMinRadius = (displayScale: number) => MIN_SHOWN_RADIUS_PX / displayScale;

/**
 * The topmost marker at `point`, with `margin` map pixels to spare; null if
 * none. Markers smaller than `minRadius` count as that big, as they are drawn.
 */
export function markerAt(
  markers: readonly MapMarker[],
  point: Point,
  margin: number,
  minRadius = 0,
): MapMarker | null {
  for (let i = markers.length - 1; i >= 0; i--) {
    const marker = markers[i];
    const reach = Math.max(marker.radius, minRadius) + margin;
    if (Math.hypot(point.x - marker.x, point.y - marker.y) <= reach) return marker;
  }
  return null;
}

// ─── Editing ──────────────────────────────────────────────────────────────────

/** With a new marker; unchanged when the map already has MAX_MARKERS. */
export const addMarker = (markers: MapMarker[], marker: MapMarker): MapMarker[] =>
  markers.length >= MAX_MARKERS ? markers : [...markers, marker];

/** With one marker changed by `change`. */
export const changeMarker = (
  markers: MapMarker[],
  id: string,
  change: (marker: MapMarker) => MapMarker,
): MapMarker[] => markers.map((marker) => (marker.id === id ? change(marker) : marker));

/**
 * A marker made `size` (as clampMarkerSize gives it), kept on the squares it
 * covers. Between an odd and an even number of squares it must move half a
 * square: to an even size always down and right, back to an odd size always
 * up and left, so shrinking it again puts it back where it was.
 */
export function resizeMarker(marker: MapMarker, size: number, grid: MapGrid | null): MapMarker {
  const clean = clampMarkerSize(size, grid);
  const radius = markerRadius(clean, grid);
  const nudge = grid ? (clean % 2 === 0 ? grid.cell : -grid.cell) / 4 : 0;
  return { ...marker, ...placeMarker({ x: marker.x + nudge, y: marker.y + nudge }, radius, grid), radius };
}

export const removeMarker = (markers: MapMarker[], id: string): MapMarker[] =>
  markers.filter((marker) => marker.id !== id);

/** Whether two lists hold the same markers, field for field, in the same order (an edit that changed nothing). */
export const sameMarkers = (a: readonly MapMarker[], b: readonly MapMarker[]) =>
  a === b ||
  (a.length === b.length &&
    a.every((marker, i) => {
      const other = b[i];
      return (
        marker.id === other.id &&
        marker.x === other.x &&
        marker.y === other.y &&
        marker.radius === other.radius &&
        marker.color === other.color &&
        marker.letter === other.letter
      );
    }));

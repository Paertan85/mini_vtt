// The DM's markers on the loaded map, and the Markers tool's colour, size,
// selection and undo history. The markers are part of the loaded map
// (useLoadedMap), so they are replaced whole when another map loads; the
// editing steps are lib/markers.ts's. useDmController saves them with the
// map's view, a moment after each change.
//
// Selecting a marker makes its colour and size the tool's, so the toolbar
// shows them; changing either then changes the marker too, and the next one
// placed is alike. The size is in squares on a map with a grid, else a radius
// in map pixels. A new marker gets the first letter not yet on the map; the
// selected one's letter can be changed.
//
// Every change to the markers goes through `commit`, which keeps the list
// from before it for undo: at most MAX_HISTORY steps, each a copy of at most
// MAX_MARKERS small objects, dropped when another map loads. Resizing one
// marker again and again (wheel notches, the size slider) is one step.

import { useCallback, useMemo, useRef, useState } from 'react';
import type { MapGrid, MapMarker, MarkerColor, Point } from '../types/map';
import {
  addMarker,
  changeMarker,
  clampMarkerSize,
  DEFAULT_MARKER_RADIUS,
  MAX_MARKERS,
  markerRadius,
  markerSize,
  newMarkerId,
  nextMarkerLetter,
  placeMarker,
  removeMarker,
  resizeMarker,
  sameMarkers,
  stepMarkerSize,
  withLetter,
} from '../lib/markers';
import { notify } from '../ui/notify';

/** Undo steps kept for the loaded map's markers */
const MAX_HISTORY = 50;

export interface MarkerEdits {
  /** A marker of the tool's colour and size and the next letter, placed on the squares at `point`; selected */
  add: (point: Point) => void;
  /** Dropped at `center`, already placed on its squares */
  move: (id: string, center: Point) => void;
  remove: (id: string) => void;
  /** Its colour and size become the tool's; null deselects */
  select: (id: string | null) => void;
  /** Wheel notches over a marker: it is selected and resized, a square (or 10 px) per notch */
  resize: (id: string, notches: number) => void;
  /** Wheel notches away from the markers: the size of the next one */
  stepSize: (notches: number) => void;
  /** The tool's colour, and the selected marker's */
  setColor: (color: MarkerColor) => void;
  /** The tool's size, and the selected marker's */
  setSize: (size: number) => void;
  /** The selected marker's letter, A to Z; '' for none */
  setLetter: (letter: string) => void;
  /** Removes them all; undo brings them back */
  clear: () => void;
}

/** Undo and redo for the markers, shaped like the fog's and the effects' */
export interface MarkerHistory {
  canUndo: boolean;
  canRedo: boolean;
  undo: () => void;
  redo: () => void;
}

interface History {
  /** The map the steps belong to */
  mapId: string | null;
  undo: MapMarker[][];
  redo: MapMarker[][];
  /** What the last step was, so repeating it adds no step (resizing one marker); null: anything */
  lastKey: string | null;
}

export function useMarkers(
  mapId: string | null,
  markers: MapMarker[],
  setMarkers: (change: (current: MapMarker[]) => MapMarker[]) => void,
  grid: MapGrid | null,
) {
  const [color, setColorState] = useState<MarkerColor>('red');
  // Kept apart, so a map with a grid and one without each keep their own
  const [squares, setSquares] = useState(1);
  const [radiusPx, setRadiusPx] = useState(DEFAULT_MARKER_RADIUS);
  const [chosenId, setChosenId] = useState<string | null>(null);
  // A marker removed, or one of another map, is no longer selected
  const selectedId = chosenId && markers.some((marker) => marker.id === chosenId) ? chosenId : null;
  const size = grid ? squares : radiusPx;

  // The steps live in a ref (nothing shows them); a change to how many there
  // are re-renders, so the undo and redo buttons follow
  const historyRef = useRef<History>({ mapId, undo: [], redo: [], lastKey: null });
  if (historyRef.current.mapId !== mapId) historyRef.current = { mapId, undo: [], redo: [], lastKey: null };
  const [, setSteps] = useState(0);
  const counted = useCallback(() => setSteps((count) => count + 1), []);

  // Read by the edits, so they keep a fixed identity. `markers` is updated
  // straight away by each change, so two in one frame build on each other.
  const latest = useRef({ markers, grid, color, size, selectedId });
  latest.current = { markers, grid, color, size, selectedId };

  const setSizeState = useCallback((next: number, mapGrid: MapGrid | null) => {
    if (mapGrid) setSquares(next);
    else setRadiusPx(next);
  }, []);

  /** Show `next` and save it, without a step of its own (undo and redo). */
  const show = useCallback(
    (next: MapMarker[]) => {
      latest.current.markers = next;
      setMarkers(() => next);
      counted();
    },
    [setMarkers, counted],
  );

  /** Change the markers, keeping the list from before for undo. */
  const commit = useCallback(
    (change: (current: MapMarker[]) => MapMarker[], key: string | null = null) => {
      const before = latest.current.markers;
      const after = change(before);
      if (sameMarkers(before, after)) return;
      const history = historyRef.current;
      if (!key || key !== history.lastKey || history.undo.length === 0) {
        history.undo.push(before);
        if (history.undo.length > MAX_HISTORY) history.undo.shift();
      }
      history.lastKey = key;
      history.redo = [];
      show(after);
    },
    [show],
  );

  const edits = useMemo<MarkerEdits>(() => {
    const select = (id: string | null) => {
      const marker = latest.current.markers.find((entry) => entry.id === id);
      setChosenId(marker ? marker.id : null);
      if (!marker) return;
      setColorState(marker.color);
      setSizeState(markerSize(marker, latest.current.grid), latest.current.grid);
    };
    const resizeTo = (id: string, next: number) => {
      const { grid: mapGrid } = latest.current;
      commit(
        (current) => changeMarker(current, id, (marker) => resizeMarker(marker, next, mapGrid)),
        `size:${id}`,
      );
    };
    return {
      add: (point) => {
        const { markers: current, grid: mapGrid, color: chosen, size: chosenSize } = latest.current;
        if (current.length >= MAX_MARKERS) {
          notify(`A map can have up to ${MAX_MARKERS} markers. Remove one to put down another.`, 'error');
          return;
        }
        const radius = markerRadius(chosenSize, mapGrid);
        const marker = {
          id: newMarkerId(),
          ...placeMarker(point, radius, mapGrid),
          radius,
          color: chosen,
          letter: nextMarkerLetter(current),
        };
        commit((list) => addMarker(list, marker));
        setChosenId(marker.id);
      },
      move: (id, center) =>
        commit((current) => changeMarker(current, id, (marker) => ({ ...marker, ...center }))),
      remove: (id) => commit((current) => removeMarker(current, id)),
      select,
      resize: (id, notches) => {
        const { markers: current, grid: mapGrid } = latest.current;
        const marker = current.find((entry) => entry.id === id);
        if (!marker) return;
        const next = stepMarkerSize(markerSize(marker, mapGrid), notches, mapGrid);
        setChosenId(id);
        setColorState(marker.color);
        setSizeState(next, mapGrid);
        resizeTo(id, next);
      },
      stepSize: (notches) => {
        const { size: current, grid: mapGrid } = latest.current;
        setSizeState(stepMarkerSize(current, notches, mapGrid), mapGrid);
      },
      setColor: (next) => {
        setColorState(next);
        const { selectedId: id } = latest.current;
        if (id) commit((current) => changeMarker(current, id, (marker) => ({ ...marker, color: next })));
      },
      setSize: (next) => {
        const { selectedId: id, grid: mapGrid } = latest.current;
        const clean = clampMarkerSize(next, mapGrid);
        setSizeState(clean, mapGrid);
        if (id) resizeTo(id, clean);
      },
      setLetter: (letter) => {
        const { selectedId: id } = latest.current;
        if (id) commit((current) => changeMarker(current, id, (marker) => withLetter(marker, letter)));
      },
      clear: () => {
        commit(() => []);
        setChosenId(null);
      },
    };
  }, [commit, setSizeState]);

  const undo = useCallback(() => {
    const history = historyRef.current;
    const previous = history.undo.pop();
    if (!previous) return;
    history.redo.push(latest.current.markers);
    history.lastKey = null;
    show(previous);
  }, [show]);
  const redo = useCallback(() => {
    const history = historyRef.current;
    const next = history.redo.pop();
    if (!next) return;
    history.undo.push(latest.current.markers);
    history.lastKey = null;
    show(next);
  }, [show]);
  const canUndo = historyRef.current.undo.length > 0;
  const canRedo = historyRef.current.redo.length > 0;
  const history = useMemo<MarkerHistory>(
    () => ({ canUndo, canRedo, undo, redo }),
    [canUndo, canRedo, undo, redo],
  );

  // The selected marker's letter, else the one the next marker gets
  const selected = markers.find((marker) => marker.id === selectedId);
  const letter = selected ? (selected.letter ?? '') : nextMarkerLetter(markers);
  return { color, size, radius: markerRadius(size, grid), selectedId, letter, edits, history };
}

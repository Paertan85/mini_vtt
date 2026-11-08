// The spell areas on the loaded map, in the DM window: the list, the selected
// one, and every edit. The geometry and the editing steps are pure functions
// in lib/areas.ts; this hook keeps the state and keeps it cheap:
//
// Dragging and wheel-resizing update a ref on every event; React renders (and
// the player screen is updated) at most once per animation frame. While an
// area is dragged, players keep the list from before the drag, so they see it
// jump to where it is dropped rather than slide across the map.

import { useCallback, useRef, useState } from 'react';
import type { AreaShape, SpellArea, EffectKind, MapGrid, Point } from '../types/map';
import { type Orientation, screenToMapDirection, type Size } from '../lib/geometry';
import {
  aimArea,
  clampRadius,
  freeSpot,
  MAX_AREAS,
  newArea,
  newAreaId,
  newAreaStep,
  resizeArea,
} from '../lib/areas';
import { notify } from '../ui/notify';

export interface Areas {
  /** The areas as the DM window shows them */
  areas: SpellArea[];
  /** The areas as the player screen shows them: unchanged while one is dragged */
  shownToPlayers: SpellArea[];
  selectedId: string | null;
  select: (id: string | null) => void;
  /** A map was loaded (or unloaded): its areas, none selected. */
  load: (areas: SpellArea[]) => void;
  /**
   * Add a shape at `center` (map pixels), or further down and to the right
   * on screen while another area is there, pointing right on screen; false
   * when the map is full. `displayScale` (screen px per map px in the DM
   * view) keeps shapes added one after another far enough apart to grab.
   */
  add: (shape: AreaShape, center: Point, kind: EffectKind, displayScale: number) => boolean;
  /** A drag started (true) or ended (false). */
  drag: (dragging: boolean) => void;
  move: (id: string, center: Point) => void;
  /** Wheel notches: a line's width, any other area's size, 5 ft per notch. */
  resize: (id: string, notches: number) => void;
  setSize: (id: string, feet: number) => void;
  setWidth: (id: string, feet: number) => void;
  /** The handle dragged to `point`; `snap` (Ctrl) keeps a cone or line to 45° steps. */
  aim: (id: string, point: Point, snap: boolean) => void;
  /** A copy one square along the map, or further along while another area is there */
  duplicate: (id: string) => void;
  /** Arrow keys: one square, or 1 ft when `fine`, in the direction shown on screen. */
  nudge: (id: string, direction: Point, fine: boolean) => void;
  remove: (id: string) => void;
  recolor: (id: string, kind: EffectKind) => void;
}

/** `media`: the map's natural size, so new areas are always placed on it; null until it has loaded. */
export function useAreas(grid: MapGrid | null, orientation: Orientation, media: Size | null): Areas {
  const [areas, setAreas] = useState<SpellArea[]>([]);
  // While the DM drags an area, players keep seeing it where it was
  const [playerAreas, setPlayerAreas] = useState<SpellArea[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const areasRef = useRef<SpellArea[]>([]);
  const frameRequest = useRef<number | null>(null);
  // The latest grid and orientation, so the edits keep a fixed identity
  const latest = useRef({ grid, orientation, media });
  latest.current = { grid, orientation, media };

  /** Change the areas now; rendered on the next animation frame. */
  const update = useCallback((change: (current: SpellArea[]) => SpellArea[]) => {
    areasRef.current = change(areasRef.current);
    if (frameRequest.current === null) {
      frameRequest.current = requestAnimationFrame(() => {
        frameRequest.current = null;
        setAreas(areasRef.current);
      });
    }
  }, []);

  const updateOne = useCallback(
    (id: string, change: (area: SpellArea) => SpellArea) =>
      update((current) => current.map((area) => (area.id === id ? change(area) : area))),
    [update],
  );

  /** Change the areas and render them now, players included. */
  const replace = useCallback((next: SpellArea[]) => {
    areasRef.current = next;
    setAreas(next);
    setPlayerAreas(null);
  }, []);

  const load = useCallback(
    (next: SpellArea[]) => {
      replace(next);
      setSelectedId(null);
    },
    [replace],
  );

  const add = useCallback(
    (shape: AreaShape, center: Point, kind: EffectKind, displayScale: number) => {
      if (areasRef.current.length >= MAX_AREAS) return false;
      const { grid: mapGrid, orientation, media: size } = latest.current;
      // Cones and lines start pointing right on screen, whatever the map's orientation
      const right = screenToMapDirection({ x: 1, y: 0 }, orientation);
      const step = mapGrid ? newAreaStep(mapGrid, orientation, displayScale) : { x: 0, y: 0 };
      const spot = freeSpot(center, step, areasRef.current, size);
      const area = newArea(shape, spot, kind, right);
      replace([...areasRef.current, area]);
      setSelectedId(area.id);
      return true;
    },
    [replace],
  );

  const drag = useCallback((dragging: boolean) => {
    if (dragging) {
      setPlayerAreas(areasRef.current);
      return;
    }
    // Render the drop position now rather than on the pending frame
    if (frameRequest.current !== null) {
      cancelAnimationFrame(frameRequest.current);
      frameRequest.current = null;
    }
    setAreas(areasRef.current);
    setPlayerAreas(null);
  }, []);

  const move = useCallback(
    (id: string, center: Point) => updateOne(id, (area) => ({ ...area, ...center })),
    [updateOne],
  );
  const resize = useCallback(
    (id: string, notches: number) => updateOne(id, (area) => resizeArea(area, notches)),
    [updateOne],
  );
  const setSize = useCallback(
    (id: string, feet: number) => updateOne(id, (area) => ({ ...area, radiusFt: clampRadius(feet) })),
    [updateOne],
  );
  const setWidth = useCallback(
    (id: string, feet: number) => updateOne(id, (area) => ({ ...area, widthFt: clampRadius(feet) })),
    [updateOne],
  );
  const aim = useCallback(
    (id: string, point: Point, snap: boolean) => {
      const { grid: mapGrid } = latest.current;
      if (mapGrid) updateOne(id, (area) => aimArea(area, point, mapGrid, snap));
    },
    [updateOne],
  );

  const duplicate = useCallback(
    (id: string) => {
      const source = areasRef.current.find((area) => area.id === id);
      const { grid: mapGrid } = latest.current;
      if (!source || !mapGrid) return;
      if (areasRef.current.length >= MAX_AREAS) {
        notify(`A map can have at most ${MAX_AREAS} areas.`, 'error');
        return;
      }
      const step = { x: mapGrid.cell, y: 0 };
      const spot = freeSpot(
        { x: source.x + step.x, y: source.y },
        step,
        areasRef.current,
        latest.current.media,
      );
      const copy = { ...source, id: newAreaId(), ...spot };
      replace([...areasRef.current, copy]);
      setSelectedId(copy.id);
    },
    [replace],
  );

  const nudge = useCallback(
    (id: string, direction: Point, fine: boolean) => {
      const { grid: mapGrid, orientation: shown } = latest.current;
      if (!mapGrid) return;
      const step = fine ? mapGrid.cell / mapGrid.feetPerCell : mapGrid.cell;
      const by = screenToMapDirection(direction, shown);
      updateOne(id, (area) => ({ ...area, x: area.x + by.x * step, y: area.y + by.y * step }));
    },
    [updateOne],
  );

  const remove = useCallback(
    (id: string) => {
      replace(areasRef.current.filter((area) => area.id !== id));
      setSelectedId((selected) => (selected === id ? null : selected));
    },
    [replace],
  );

  const recolor = useCallback(
    (id: string, kind: EffectKind) =>
      replace(areasRef.current.map((area) => (area.id === id ? { ...area, kind } : area))),
    [replace],
  );

  return {
    areas,
    shownToPlayers: playerAreas ?? areas,
    selectedId,
    select: setSelectedId,
    load,
    add,
    drag,
    move,
    resize,
    setSize,
    setWidth,
    aim,
    duplicate,
    nudge,
    remove,
    recolor,
  };
}

// Drawing a fog shape in the Fog tool: a lasso (a freehand outline) or a
// rectangle. Nothing changes while it is drawn; when the mouse comes up its
// inside is filled in one step, which players see all at once, as with a
// brush stroke. A dashed outline previews it, changed directly rather than by
// re-rendering.

import { useCallback, useRef } from 'react';
import type { FogMode, MapGrid, Point } from '../types/map';
import { rectCorners, rectFromCorners } from '../lib/rect';

export type FogShapeKind = 'lasso' | 'rect';

/** A lasso point closer than this (screen px) to the last one adds nothing to the outline */
const LASSO_STEP_PX = 2;
/** A rectangle narrower than this (screen px) is a click or a slip, and fills nothing */
const MIN_RECT_PX = 4;

interface ShapeDrag {
  kind: FogShapeKind;
  mode: FogMode;
  start: Point;
  /** The lasso's outline so far */
  points: Point[];
}

export interface FogShapeDrag {
  /** The preview: a polygon in map pixels */
  previewRef: React.RefObject<SVGPolygonElement>;
  /** `snap` (Ctrl held): a rectangle's corners snap to the grid */
  begin: (kind: FogShapeKind, mode: FogMode, point: Point, snap: boolean) => void;
  /** Whether a shape is being drawn: if so, the move was the shape's */
  move: (point: Point, snap: boolean) => boolean;
  /** The mouse came up at `point`, and the shape is filled; null: cancelled, nothing changes */
  end: (point: Point | null, snap: boolean) => void;
}

/** Show `outline` as the preview; an empty one hides it. */
const showOutline = (polygon: SVGPolygonElement | null, outline: Point[]) =>
  polygon?.setAttribute('points', outline.map((point) => `${point.x},${point.y}`).join(' '));

/** Extend the lasso's preview by one point, without rewriting the rest. */
function appendToOutline(polygon: SVGPolygonElement | null, point: Point) {
  const svg = polygon?.ownerSVGElement;
  if (!polygon || !svg) return;
  const added = svg.createSVGPoint();
  added.x = point.x;
  added.y = point.y;
  polygon.points.appendItem(added);
}

export function useFogShapeDrag(
  fill: (outline: Point[], mode: FogMode) => void,
  grid: MapGrid | null,
  displayScale: number,
): FogShapeDrag {
  const previewRef = useRef<SVGPolygonElement>(null);
  const dragRef = useRef<ShapeDrag | null>(null);
  // The latest values, so the callbacks keep a fixed identity
  const latest = useRef({ fill, grid, displayScale });
  latest.current = { fill, grid, displayScale };

  /** The rectangle from where the drag started to `point`. */
  const rectTo = useCallback(
    (drag: ShapeDrag, point: Point, snap: boolean) =>
      rectFromCorners(drag.start, point, snap ? latest.current.grid : null),
    [],
  );

  const begin = useCallback(
    (kind: FogShapeKind, mode: FogMode, point: Point, snap: boolean) => {
      const drag: ShapeDrag = { kind, mode, start: point, points: [point] };
      dragRef.current = drag;
      previewRef.current?.setAttribute('data-mode', mode);
      showOutline(previewRef.current, kind === 'rect' ? rectCorners(rectTo(drag, point, snap)) : [point]);
    },
    [rectTo],
  );

  const move = useCallback(
    (point: Point, snap: boolean) => {
      const drag = dragRef.current;
      if (!drag) return false;
      if (drag.kind === 'rect') {
        showOutline(previewRef.current, rectCorners(rectTo(drag, point, snap)));
        return true;
      }
      const last = drag.points[drag.points.length - 1];
      if (Math.hypot(point.x - last.x, point.y - last.y) * latest.current.displayScale < LASSO_STEP_PX) {
        return true;
      }
      drag.points.push(point);
      appendToOutline(previewRef.current, point);
      return true;
    },
    [rectTo],
  );

  const end = useCallback(
    (point: Point | null, snap: boolean) => {
      const drag = dragRef.current;
      dragRef.current = null;
      showOutline(previewRef.current, []);
      if (!drag || !point) return;
      const { fill: fillShape, displayScale: scale } = latest.current;
      if (drag.kind === 'lasso') {
        // The outline is where the mouse went; a click or a line encloses nothing
        fillShape(drag.points, drag.mode);
        return;
      }
      const rect = rectTo(drag, point, snap);
      if (Math.min(rect.width, rect.height) * scale >= MIN_RECT_PX) fillShape(rectCorners(rect), drag.mode);
    },
    [rectTo],
  );

  return { previewRef, begin, move, end };
}

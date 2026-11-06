// The Measure tool's ruler.
//
//   drag           a straight ruler from where the drag started
//   click          starts a path: the next leg follows the mouse, and each
//                  click adds a point, to measure round corners
//   double-click or Enter   finishes the path
//   right-click    takes back the last point (a finished ruler: clears it)
//   Esc or Backspace   clears it
//
// Movement counts squares, from the middle of one to the middle of another;
// the straight line goes exactly where the mouse went (Ctrl snaps its points
// to square centres).
//
// The ruler lives in this component's state, so it goes when the tool is
// left or another map loads, and a drag re-renders nothing else. Each change
// is reported through `onChange` (null when it goes), for the player screen.

import React, { useEffect, useState } from 'react';
import type { DiagonalRule, MapGrid, Point, RulerState } from '../types/map';
import { MAX_RULER_POINTS, measurePathFeet, snapToCell } from '../lib/grid';

interface MeasureLayerProps {
  grid: MapGrid;
  rule: DiagonalRule;
  /** Client coordinates → map natural pixels */
  toMapPoint: (clientX: number, clientY: number) => Point | null;
  /** Map natural pixels → position on the stage surface */
  mapToSurface: (point: Point) => Point;
  /** Lets the mouse through, so Shift + drag paints fog under the ruler */
  passThrough: boolean;
  /** The ruler changed, or went (null) */
  onChange: (ruler: RulerState | null) => void;
}

interface Ruler {
  /** The points placed so far; the first is the start */
  points: Point[];
  /** Where the mouse is, while dragging or building a path */
  cursor: Point | null;
  /** `drag`: the button is held from the start; `path`: clicks add points; `done`: finished */
  mode: 'drag' | 'path' | 'done';
}

const samePoint = (a: Point, b: Point) => a.x === b.x && a.y === b.y;

/** Every point of the ruler, the one following the mouse last. */
const rulerPoints = (ruler: Ruler) => (ruler.cursor ? [...ruler.points, ruler.cursor] : ruler.points);

/** Without the path's last point; a finished ruler, or a path's only point, goes. */
function takeBack(ruler: Ruler): Ruler | null {
  if (ruler.mode !== 'path') return null;
  const kept = ruler.points.slice(0, -1);
  return kept.length > 0 ? { ...ruler, points: kept } : null;
}

/** The finished ruler, or null when it has no length. */
function finish(ruler: Ruler): Ruler | null {
  // A path's points are placed by clicks; the mouse's spot only ends a drag
  const source = ruler.mode === 'path' ? ruler.points : rulerPoints(ruler);
  const points = source.filter((point, index) => index === 0 || !samePoint(point, source[index - 1]));
  return points.length >= 2 ? { points, cursor: null, mode: 'done' } : null;
}

export const formatFeet = (feet: number) => `${Number.isInteger(feet) ? feet : feet.toFixed(1)} ft`;

export function MeasureLayer({
  grid,
  rule,
  toMapPoint,
  mapToSurface,
  passThrough,
  onChange,
}: MeasureLayerProps) {
  const [ruler, setRuler] = useState<Ruler | null>(null);
  const points = ruler ? rulerPoints(ruler) : [];
  const feet = points.length >= 2 ? measurePathFeet(points, grid, rule) : 0;

  // Reported only when the ruler or its distance changes; a Movement ruler
  // changes once per square crossed, not on every mouse move
  useEffect(() => {
    onChange(points.length >= 2 ? { points, feet } : null);
    // `points` is derived from `ruler`
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ruler, feet, onChange]);
  useEffect(() => () => onChange(null), [onChange]);

  // Enter, Backspace and Esc while there is a ruler, taken before the app's
  // own shortcuts (Enter would load the selected map). Listening only then.
  const hasRuler = ruler !== null;
  useEffect(() => {
    if (!hasRuler) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || document.querySelector('[role="dialog"]')) return;
      if (event.key === 'Escape' || event.key === 'Backspace' || event.key === 'Delete') setRuler(null);
      else if (event.key === 'Enter') setRuler((current) => current && finish(current));
      else return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [hasRuler]);

  const pointAt = (event: React.MouseEvent) => {
    const point = toMapPoint(event.clientX, event.clientY);
    if (!point) return null;
    const snaps = rule !== 'straight' || event.ctrlKey || event.metaKey;
    return snaps ? snapToCell(point, grid) : point;
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button === 2) {
      event.preventDefault();
      setRuler((current) => current && takeBack(current));
      return;
    }
    if (event.button !== 0) return;
    const point = pointAt(event);
    if (!point) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    // Building a path: the point is added when the button comes up
    if (ruler?.mode !== 'path') setRuler({ points: [point], cursor: point, mode: 'drag' });
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!ruler?.cursor) return;
    const point = pointAt(event);
    if (point && !samePoint(point, ruler.cursor)) setRuler({ ...ruler, cursor: point });
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !ruler) return;
    const point = pointAt(event) ?? ruler.cursor;
    if (!point) return;
    if (ruler.mode === 'drag') {
      // A click without a drag starts a path; a drag is a finished ruler
      setRuler(
        samePoint(point, ruler.points[0])
          ? { points: ruler.points, cursor: point, mode: 'path' }
          : finish({ ...ruler, cursor: point }),
      );
    } else if (ruler.mode === 'path') {
      const last = ruler.points[ruler.points.length - 1];
      const adds = !samePoint(point, last) && ruler.points.length < MAX_RULER_POINTS - 1;
      setRuler({ ...ruler, points: adds ? [...ruler.points, point] : ruler.points, cursor: point });
    }
  };

  return (
    <div
      aria-label="Measure distance"
      className={`absolute inset-0 z-40 ${passThrough ? 'pointer-events-none' : 'cursor-crosshair'}`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={() => setRuler((current) => (current?.mode === 'drag' ? finish(current) : current))}
      onDoubleClick={() => setRuler((current) => current && finish(current))}
      onContextMenu={(event) => event.preventDefault()}
    >
      {points.length >= 2 && <RulerGraphic points={points.map(mapToSurface)} feet={feet} />}
    </div>
  );
}

/**
 * The ruler's path, its points and the distance, in the parent's pixels.
 * `large` is for the player screen, read from across the table.
 */
export function RulerGraphic({
  points,
  feet,
  large = false,
}: {
  points: Point[];
  feet: number;
  large?: boolean;
}) {
  const scale = large ? 2 : 1;
  const path = points.map((point) => `${point.x},${point.y}`).join(' ');
  const end = points[points.length - 1];
  return (
    <>
      <svg aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full overflow-visible">
        <polyline
          points={path}
          fill="none"
          className="stroke-ground"
          strokeWidth={4 * scale}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <polyline
          points={path}
          fill="none"
          className="stroke-gold"
          strokeWidth={2 * scale}
          strokeDasharray={`${6 * scale} ${4 * scale}`}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {points.map((point, index) => (
          <circle
            key={index}
            cx={point.x}
            cy={point.y}
            r={(index === 0 || index === points.length - 1 ? 4 : 3) * scale}
            className="fill-gold stroke-ground"
            strokeWidth={1.5 * scale}
          />
        ))}
      </svg>
      <output
        aria-label="Distance"
        className={`pointer-events-none absolute -translate-x-1/2 whitespace-nowrap rounded border border-line bg-panel/95 font-medium tabular-nums text-ink ${
          large ? 'px-3 py-1 text-[24px]' : 'px-1.5 py-0.5 text-[12px]'
        }`}
        style={{ left: end.x, top: end.y + 10 * scale }}
      >
        {formatFeet(feet)}
      </output>
    </>
  );
}

// The DM's markers, drawn over the fog in the DM window and never on the
// player screen. They show in every tool; in the Markers tool they can be
// put down and changed:
//
//   click on the map        puts down a marker of the chosen colour and size
//                           (on a grid, on the squares it covers)
//   drag a marker           moves it (on a grid, square by square)
//   right-click a marker    removes it
//   click a marker          selects it: its colour, size and letter show in
//                           the toolbar, and changing them changes it
//
// The wheel (sizes) and Delete are handled with the stage's other wheel and
// keys. A static SVG in map coordinates inside the rotated map container, so
// it turns and mirrors with the map; each marker's letter is turned back, so
// it reads upright and unmirrored however the map is turned. A ring under the pointer shows where the
// next marker goes; it is moved directly, without re-rendering. A drag
// re-renders only this layer, and moves the marker (which is then saved)
// once, when it is dropped. Nothing is mounted on a map without markers
// outside the Markers tool.

import React, { memo, useRef, useState } from 'react';
import type { MapGrid, MapMarker, MarkerColor, Point } from '../types/map';
import type { Orientation, Size } from '../lib/geometry';
import { MARKER_STYLES, markerAt, markerMinRadius, placeMarker } from '../lib/markers';
import type { MarkerEdits } from '../hooks/useMarkers';

interface MarkersLayerProps {
  markers: MapMarker[];
  media: Size;
  grid: MapGrid | null;
  /** How the map is turned and mirrored, so the letters can be turned back upright */
  orientation: Orientation;
  /** Screen px per map px */
  displayScale: number;
  /** The Markers tool: markers can be put down and changed, not just seen */
  editable: boolean;
  selectedId: string | null;
  /** The next marker's colour and radius (map px), for the ring under the pointer */
  color: MarkerColor;
  radius: number;
  /** Client coordinates → map natural pixels */
  toMapPoint: (clientX: number, clientY: number) => Point | null;
  edits: MarkerEdits;
}

/** Moving less than this (screen px) between press and release is a click, not a drag */
const CLICK_SLOP_PX = 4;
/** Fill strength of a marker's body; its edge is solid */
const FILL_OPACITY = 0.35;
/** A letter's height, as a share of the marker's radius: large, with room to spare inside */
const LETTER_SIZE = 1.25;

interface Drag {
  pointerId: number;
  id: string;
  /** From the pointer to the marker's centre when it was pressed, map px */
  offset: Point;
  /** Where it was pressed, screen px */
  from: Point;
  /** Where it would be dropped; null until the mouse has moved far enough to be a drag */
  center: Point | null;
}

/**
 * The SVG transform that undoes the map's turn and mirroring about `at`. The
 * map's container is rotated after it is mirrored, so this mirrors back
 * after turning back.
 */
const upright = (at: Point, { rotation, mirrorHorizontal, mirrorVertical }: Orientation) =>
  `translate(${at.x} ${at.y}) scale(${mirrorHorizontal ? -1 : 1} ${mirrorVertical ? -1 : 1}) rotate(${-rotation}) translate(${-at.x} ${-at.y})`;

const MarkerShape = ({
  marker,
  radius,
  selected,
  scale,
  orientation,
}: {
  marker: MapMarker;
  radius: number;
  selected: boolean;
  scale: number;
  orientation: Orientation;
}) => {
  const { rgb } = MARKER_STYLES[marker.color];
  const fontSize = radius * LETTER_SIZE;
  return (
    <g data-marker={marker.id} data-color={marker.color} data-letter={marker.letter}>
      {/* A dark edge under the coloured one, so it stands out on light and dark maps alike */}
      <circle
        cx={marker.x}
        cy={marker.y}
        r={radius}
        fill={`rgb(${rgb} / ${FILL_OPACITY})`}
        stroke="rgb(0 0 0 / 0.6)"
        strokeWidth={5}
        vectorEffect="non-scaling-stroke"
      />
      <circle
        cx={marker.x}
        cy={marker.y}
        r={radius}
        fill="none"
        stroke={`rgb(${rgb})`}
        strokeWidth={2.5}
        vectorEffect="non-scaling-stroke"
      />
      {marker.letter && (
        <text
          x={marker.x}
          y={marker.y}
          transform={upright(marker, orientation)}
          textAnchor="middle"
          dominantBaseline="central"
          fontSize={fontSize}
          fontWeight={600}
          className="pointer-events-none fill-ink font-sans select-none"
          stroke="rgb(0 0 0 / 0.7)"
          strokeWidth={fontSize * 0.08}
          strokeLinejoin="round"
          paintOrder="stroke"
        >
          {marker.letter}
        </text>
      )}
      {selected && (
        <circle
          data-marker-selected
          cx={marker.x}
          cy={marker.y}
          r={radius + 5 / scale}
          fill="none"
          className="stroke-ink"
          strokeWidth={1.5}
          strokeDasharray="5 4"
          vectorEffect="non-scaling-stroke"
        />
      )}
    </g>
  );
};

// Memoized: the DM window re-renders on every frame of a player frame drag
export const MarkersLayer = memo(function MarkersLayer({
  markers,
  media,
  grid,
  orientation,
  displayScale,
  editable,
  selectedId,
  color,
  radius,
  toMapPoint,
  edits,
}: MarkersLayerProps) {
  const [drag, setDrag] = useState<Drag | null>(null);
  const ghostRef = useRef<SVGCircleElement>(null);
  const minRadius = markerMinRadius(displayScale);
  const shownRadius = (value: number) => Math.max(minRadius, value);
  // Hit at the size it is drawn, with its edge
  const hit = (point: Point) => markerAt(markers, point, 2 / displayScale, minRadius);

  if (!editable && markers.length === 0) return null;

  const hideGhost = () => ghostRef.current?.setAttribute('visibility', 'hidden');
  const moveGhost = (point: Point) => {
    const ghost = ghostRef.current;
    if (!ghost) return;
    const at = placeMarker(point, radius, grid);
    ghost.setAttribute('cx', String(at.x));
    ghost.setAttribute('cy', String(at.y));
    ghost.setAttribute('visibility', 'visible');
  };

  const handlePointerDown = (event: React.PointerEvent<SVGSVGElement>) => {
    if (event.button !== 0 && event.button !== 2) return;
    const point = toMapPoint(event.clientX, event.clientY);
    if (!point) return;
    event.preventDefault();
    const pressed = hit(point);
    if (event.button === 2) {
      if (pressed) edits.remove(pressed.id);
      return;
    }
    if (!pressed) {
      edits.add(point);
      hideGhost();
      return;
    }
    edits.select(pressed.id);
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({
      pointerId: event.pointerId,
      id: pressed.id,
      offset: { x: pressed.x - point.x, y: pressed.y - point.y },
      from: { x: event.clientX, y: event.clientY },
      center: null,
    });
  };

  const handlePointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    const point = toMapPoint(event.clientX, event.clientY);
    if (!point) return;
    if (!drag || drag.pointerId !== event.pointerId) {
      if (hit(point)) hideGhost();
      else moveGhost(point);
      return;
    }
    const slipped = Math.hypot(event.clientX - drag.from.x, event.clientY - drag.from.y) >= CLICK_SLOP_PX;
    if (!drag.center && !slipped) return;
    const marker = markers.find((entry) => entry.id === drag.id);
    if (!marker) return;
    const center = placeMarker(
      { x: point.x + drag.offset.x, y: point.y + drag.offset.y },
      marker.radius,
      grid,
    );
    if (drag.center && center.x === drag.center.x && center.y === drag.center.y) return;
    setDrag({ ...drag, center });
  };

  const handlePointerUp = (event: React.PointerEvent<SVGSVGElement>) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    // A cancelled drag (the window lost the mouse) leaves the marker where it was
    if (drag.center && event.type !== 'pointercancel') edits.move(drag.id, drag.center);
    setDrag(null);
  };

  return (
    <svg
      aria-label={editable ? 'Markers' : undefined}
      aria-hidden={editable ? undefined : 'true'}
      className={`absolute inset-0 h-full w-full overflow-visible ${
        editable ? 'cursor-crosshair' : 'pointer-events-none'
      }`}
      viewBox={`0 0 ${media.w} ${media.h}`}
      preserveAspectRatio="none"
      onPointerDown={editable ? handlePointerDown : undefined}
      onPointerMove={editable ? handlePointerMove : undefined}
      onPointerUp={editable ? handlePointerUp : undefined}
      onPointerCancel={editable ? handlePointerUp : undefined}
      onPointerLeave={editable ? hideGhost : undefined}
      onContextMenu={(event) => event.preventDefault()}
    >
      {markers.map((marker) => {
        const moved = drag?.id === marker.id && drag.center ? { ...marker, ...drag.center } : marker;
        return (
          <MarkerShape
            key={marker.id}
            marker={moved}
            radius={shownRadius(marker.radius)}
            selected={editable && marker.id === selectedId}
            scale={displayScale}
            orientation={orientation}
          />
        );
      })}
      {editable && (
        <circle
          ref={ghostRef}
          data-marker-ghost
          visibility="hidden"
          cx={0}
          cy={0}
          r={shownRadius(radius)}
          fill={`rgb(${MARKER_STYLES[color].rgb} / 0.15)`}
          stroke={`rgb(${MARKER_STYLES[color].rgb})`}
          strokeWidth={1.5}
          strokeDasharray="6 4"
          vectorEffect="non-scaling-stroke"
          className="pointer-events-none"
        />
      )}
    </svg>
  );
});

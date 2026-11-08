// The spell areas' handles in the DM window (View and Shapes tools): the dot
// that moves an area, the handle that aims a cone or line or turns a square,
// the size label, and the selected area's outline and toolbar. The areas
// themselves are drawn by DrawnAreas, the same way in both windows.

import React, { useRef } from 'react';
import { Copy, Trash2 } from 'lucide-react';
import type { SpellArea, DrawnArea, EffectKind, MapGrid, Point } from '../types/map';
import { EFFECT_KINDS, EFFECT_STYLES } from '../lib/effects';
import { feetToPixels } from '../lib/grid';
import { AREA_LABELS, areaHandle, areaOutline, snapArea } from '../lib/areas';
import { ctrlHeld, keyLabel } from '../lib/platform';

interface AreaHandlesProps {
  areas: SpellArea[];
  /** The same areas in map pixels, in the same order */
  discs: DrawnArea[];
  grid: MapGrid;
  selectedId: string | null;
  /** Surface pixels per map pixel */
  displayScale: number;
  /** Client coordinates → map natural pixels */
  toMapPoint: (clientX: number, clientY: number) => Point | null;
  /** Map natural pixels → position on the stage surface */
  mapToSurface: (point: Point) => Point;
  /** A drag began */
  onDragStart: () => void;
  onSelect: (id: string | null) => void;
  /** A drag started (true) or ended (false); players only see where it lands. */
  onDrag: (dragging: boolean) => void;
  onMove: (id: string, center: Point) => void;
  /** The handle dragged to `point`; `snap` (Ctrl held) keeps a cone or line to 45° steps */
  onAim: (id: string, point: Point, snap: boolean) => void;
  /** A size typed into the toolbar: radius, side or length */
  onSetSize: (id: string, feet: number) => void;
  /** A line width typed into its toolbar */
  onSetWidth: (id: string, feet: number) => void;
  onRecolor: (id: string, kind: EffectKind) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
}

export function AreaHandles({
  areas,
  discs,
  grid,
  selectedId,
  displayScale,
  toMapPoint,
  mapToSurface,
  onDragStart,
  onSelect,
  onDrag,
  onMove,
  onAim,
  onSetSize,
  onSetWidth,
  onRecolor,
  onDuplicate,
  onDelete,
}: AreaHandlesProps) {
  // Drag the dot to move, the handle to aim and stretch
  const areaDragRef = useRef<{ id: string; pointerId: number; aim: boolean } | null>(null);

  const handleAreaPointerDown = (event: React.PointerEvent<HTMLElement>, id: string, aim = false) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    areaDragRef.current = { id, pointerId: event.pointerId, aim };
    onDragStart();
    onSelect(id);
    onDrag(true);
  };

  const handleAreaPointerMove = (event: React.PointerEvent<HTMLElement>) => {
    const drag = areaDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const point = toMapPoint(event.clientX, event.clientY);
    if (!point) return;
    if (drag.aim) {
      onAim(drag.id, point, ctrlHeld(event));
      return;
    }
    const area = areas.find((area) => area.id === drag.id);
    onMove(drag.id, grid && area && ctrlHeld(event) ? snapArea(point, area, grid) : point);
  };

  const endAreaDrag = () => {
    if (!areaDragRef.current) return;
    areaDragRef.current = null;
    onDrag(false);
  };

  return (
    <>
      {areas.map((area, index) => {
        const center = mapToSurface(area);
        const selected = area.id === selectedId;
        const diameter = feetToPixels(area.radiusFt, grid) * 2 * displayScale;
        const outline = areaOutline(discs[index]);
        const handle = areaHandle(discs[index]);
        const tip = handle ? mapToSurface(handle) : null;
        const turns = area.shape === 'square';
        const label = AREA_LABELS[area.shape];
        const sizeText =
          area.shape === 'line' ? `${area.radiusFt} × ${area.widthFt} ft` : `${area.radiusFt} ft`;
        const sizeName = area.shape === 'circle' ? 'Radius' : area.shape === 'square' ? 'Side' : 'Length';
        return (
          <div key={area.id} data-area-control="">
            {selected && outline && (
              <svg
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 z-20 h-full w-full overflow-visible"
              >
                <polygon
                  points={outline
                    .map(mapToSurface)
                    .map((point) => `${point.x},${point.y}`)
                    .join(' ')}
                  className="fill-none stroke-gold"
                  strokeWidth={2}
                  strokeDasharray="6 4"
                  strokeLinejoin="round"
                />
              </svg>
            )}
            {tip && (
              <button
                type="button"
                aria-label={`${turns ? 'Turn' : 'Aim'} the ${label.toLowerCase()}`}
                title={
                  turns
                    ? 'Drag to turn the square (it settles square to the grid near a right angle)'
                    : 'Drag to aim and set the length (5 ft steps; Ctrl: turn in 45° steps)'
                }
                className="absolute z-40 h-3.5 w-3.5 rotate-45 cursor-crosshair border-2 border-gold bg-ground"
                style={{ left: tip.x - 7, top: tip.y - 7 }}
                onPointerDown={(event) => handleAreaPointerDown(event, area.id, true)}
                onPointerMove={handleAreaPointerMove}
                onPointerUp={endAreaDrag}
                onPointerCancel={endAreaDrag}
              />
            )}
            {selected && !outline && (
              <div
                aria-hidden="true"
                className="pointer-events-none absolute z-20 rounded-full border-2 border-dashed border-gold"
                style={{
                  left: center.x - diameter / 2,
                  top: center.y - diameter / 2,
                  width: diameter,
                  height: diameter,
                }}
              />
            )}
            <button
              type="button"
              aria-label={`${label}, ${sizeText}`}
              title={keyLabel(
                `Drag to move (Ctrl: snap to the grid). Mouse wheel over it changes the ${
                  area.shape === 'line' ? 'width' : 'size'
                }; arrow keys nudge it.`,
              )}
              className={`absolute z-30 h-4 w-4 cursor-move rounded-full border-2 ${
                selected ? 'border-ground bg-gold' : 'border-gold'
              }`}
              style={{
                left: center.x - 8,
                top: center.y - 8,
                backgroundColor: selected ? undefined : EFFECT_STYLES[area.kind].color,
              }}
              onPointerDown={(event) => handleAreaPointerDown(event, area.id)}
              onPointerMove={handleAreaPointerMove}
              onPointerUp={endAreaDrag}
              onPointerCancel={endAreaDrag}
            />
            <div
              className="pointer-events-none absolute z-30 -translate-x-1/2 whitespace-nowrap rounded bg-ground/85 px-1.5 text-[11px] font-medium tabular-nums text-ink"
              style={{ left: center.x, top: center.y + 10 }}
            >
              {sizeText}
            </div>
            {selected && (
              <div
                role="toolbar"
                aria-label={`Selected ${label.toLowerCase()}`}
                className="absolute z-30 flex -translate-x-1/2 items-center gap-0.5 rounded border border-line bg-panel p-0.5"
                style={{ left: center.x, top: center.y + 30 }}
              >
                <label className="flex items-center gap-1 px-1 text-[11px] text-muted">
                  <input
                    type="number"
                    aria-label={`${sizeName} in feet`}
                    title={`${sizeName} in feet`}
                    min={1}
                    max={500}
                    step={1}
                    value={area.radiusFt}
                    onChange={(event) => {
                      const value = event.currentTarget.valueAsNumber;
                      if (Number.isFinite(value) && value > 0) onSetSize(area.id, value);
                    }}
                    className="w-12 rounded border border-line bg-ground px-1 py-0.5 text-right text-[12px] tabular-nums text-ink"
                  />
                  ft
                </label>
                {area.shape === 'line' && (
                  <label className="flex items-center gap-1 px-1 text-[11px] text-muted">
                    wide
                    <input
                      type="number"
                      aria-label="Width in feet"
                      title="Width in feet"
                      min={1}
                      max={500}
                      step={1}
                      value={area.widthFt}
                      onChange={(event) => {
                        const value = event.currentTarget.valueAsNumber;
                        if (Number.isFinite(value) && value > 0) onSetWidth(area.id, value);
                      }}
                      className="w-12 rounded border border-line bg-ground px-1 py-0.5 text-right text-[12px] tabular-nums text-ink"
                    />
                  </label>
                )}
                {EFFECT_KINDS.map((kind) => (
                  <button
                    key={kind}
                    type="button"
                    title={EFFECT_STYLES[kind].label}
                    aria-label={EFFECT_STYLES[kind].label}
                    aria-pressed={area.kind === kind}
                    onClick={() => onRecolor(area.id, kind)}
                    className={`h-5 w-5 rounded-sm border-2 ${area.kind === kind ? 'border-gold' : 'border-transparent'}`}
                    style={{ backgroundColor: EFFECT_STYLES[kind].color }}
                  />
                ))}
                <button
                  type="button"
                  title="Duplicate"
                  aria-label={`Duplicate ${label.toLowerCase()}`}
                  onClick={() => onDuplicate(area.id)}
                  className="flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-raised hover:text-ink"
                >
                  <Copy className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  title="Delete (Del)"
                  aria-label={`Delete ${label.toLowerCase()}`}
                  onClick={() => onDelete(area.id)}
                  className="flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-raised hover:text-crimson-bright"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

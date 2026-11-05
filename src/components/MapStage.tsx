// The DM window's map area: the map, its fog, the player frame and the brush.
//
// Mouse:  fog tool      left button reveals, right button covers
//         effects tool  left button paints the chosen effect, right button erases
//         frame tool    drag the frame to move the player view
//         any tool      Shift + left/right paints fog, Ctrl + wheel zooms the
//                       player view (Frame tool) or resizes the brush (Fog and
//                       Effects tools)
//         circles       (Frame and Effects tools) drag the centre dot to move,
//                       freely (Alt: snap to square centres); wheel over the
//                       selected circle resizes it, 5 ft per notch (Shift: 1 ft)

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Copy, Trash2 } from 'lucide-react';
import type { AuraCircle, EffectKind, MapGrid, MapPan, MediaType, Point } from '../types/map';
import type { Fog } from '../hooks/useFog';
import type { EffectLayer } from '../hooks/useEffectLayer';
import { EFFECT_KINDS, EFFECT_OPACITY, EFFECT_STYLES } from '../lib/effects';
import { feetToPixels, snapToCell, toDiscs } from '../lib/grid';
import { AuraDiscs } from './AuraDiscs';
import { orientedSize, type Size } from '../lib/geometry';

export type Tool = 'frame' | 'fog' | 'effect';

interface MapStageProps {
  mediaUrl: string | null;
  mediaType: MediaType;
  /** Natural size of the loaded media; null until it has loaded */
  mediaSize: Size | null;
  rotation: number;
  mirrorHorizontal: boolean;
  mirrorVertical: boolean;
  onMediaLoad: (size: Size) => void;
  onMediaError: () => void;

  fog: Fog;
  effects: EffectLayer;
  effectKind: EffectKind;
  tool: Tool;
  shiftHeld: boolean;
  brushSize: number;
  onBrushResize: (direction: 1 | -1) => void;

  /** Player frame; hidden while the player window is closed */
  pan: MapPan | null;
  viewportSize: Size | null;
  zoom: number;
  /** Grid cell size in map pixels, or 0 for no grid */
  gridCell: number;
  constrainPan: (pan: MapPan) => MapPan;
  onPanChange: (pan: MapPan) => void;
  onZoomWheel: (factor: number) => void;

  /** The map's measured grid, needed to size and snap circles */
  grid: MapGrid | null;
  /** A grid drawn over the map, while calibrating */
  gridPreview: MapGrid | null;
  circles: AuraCircle[];
  selectedCircleId: string | null;
  /** Whether circle handles are shown and respond to the mouse */
  circlesInteractive: boolean;
  onSelectCircle: (id: string | null) => void;
  /** A circle drag started (true) or ended (false); players only see where it lands. */
  onCircleDrag: (dragging: boolean) => void;
  onMoveCircle: (id: string, center: Point) => void;
  /** Wheel notches: positive grows; `fine` steps 1 ft instead of 5 */
  onResizeCircle: (id: string, notches: number, fine: boolean) => void;
  onDuplicateCircle: (id: string) => void;
  onDeleteCircle: (id: string) => void;
  onRecolorCircle: (id: string, kind: EffectKind) => void;

  /** Corners clicked so far while calibrating the grid; null when not calibrating */
  calibrationPoints: Point[] | null;
  onCalibrationPoint: (point: Point) => void;
}

const STAGE_PADDING = 24;
/** Wheel distance that counts as one notch; trackpads send many small deltas */
const WHEEL_NOTCH = 100;
/** How close (screen px) the pointer must be to a small circle for the wheel to resize it */
const MIN_WHEEL_TARGET = 24;

const mediaSizeOf = (element: HTMLImageElement | HTMLVideoElement): Size =>
  element instanceof HTMLVideoElement
    ? { w: element.videoWidth, h: element.videoHeight }
    : { w: element.naturalWidth, h: element.naturalHeight };

export function MapStage(props: MapStageProps) {
  const {
    mediaUrl,
    mediaType,
    mediaSize,
    rotation,
    mirrorHorizontal,
    mirrorVertical,
    fog,
    effects,
    effectKind,
    tool,
    shiftHeld,
    brushSize,
    pan,
    viewportSize,
    zoom,
    gridCell,
    grid,
    gridPreview,
    circles,
    selectedCircleId,
    circlesInteractive,
    calibrationPoints,
  } = props;

  const containerRef = useRef<HTMLElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const cursorRef = useRef<HTMLDivElement>(null);
  const frameDragRef = useRef<{ start: Point; startPan: MapPan } | null>(null);
  const circleDragRef = useRef<{ id: string; pointerId: number } | null>(null);
  const wheelRemainderRef = useRef(0);
  const [available, setAvailable] = useState<Size>({ w: 0, h: 0 });

  // Latest props for the native listeners, which are registered once
  const latest = useRef(props);
  latest.current = props;

  // Track the space the map can use
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => {
      setAvailable({
        w: container.clientWidth - STAGE_PADDING * 2,
        h: container.clientHeight - STAGE_PADDING * 2,
      });
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  // Fit the (rotated) map into the available space, never upscaling
  const oriented = mediaSize ? orientedSize(mediaSize, rotation) : null;
  const displayScale =
    oriented && available.w > 0 && available.h > 0
      ? Math.min(1, available.w / oriented.w, available.h / oriented.h)
      : 1;
  const surfaceSize = oriented
    ? { w: oriented.w * displayScale, h: oriented.h * displayScale }
    : { w: 0, h: 0 };
  const mediaDisplay = mediaSize
    ? { w: mediaSize.w * displayScale, h: mediaSize.h * displayScale }
    : { w: 0, h: 0 };

  // Shift always paints fog, whatever the tool
  const paintsEffects = tool === 'effect' && !shiftHeld;
  const canPaint = tool === 'fog' || tool === 'effect' || shiftHeld;

  /** Client coordinates → map natural pixels, undoing rotation and mirroring. */
  const toMapPoint = useCallback(
    (clientX: number, clientY: number): Point | null => {
      const surface = surfaceRef.current;
      if (!surface || !mediaSize) return null;
      const rect = surface.getBoundingClientRect();
      const width = rotation % 180 === 0 ? rect.width : rect.height;
      const height = rotation % 180 === 0 ? rect.height : rect.width;
      const x = clientX - rect.left - rect.width / 2;
      const y = clientY - rect.top - rect.height / 2;
      let mapX = x;
      let mapY = y;
      if (rotation === 90) [mapX, mapY] = [y, -x];
      else if (rotation === 180) [mapX, mapY] = [-x, -y];
      else if (rotation === 270) [mapX, mapY] = [-y, x];
      if (mirrorHorizontal) mapX = -mapX;
      if (mirrorVertical) mapY = -mapY;
      return {
        x: (mapX + width / 2) * (mediaSize.w / width),
        y: (mapY + height / 2) * (mediaSize.h / height),
      };
    },
    [mediaSize, rotation, mirrorHorizontal, mirrorVertical],
  );

  /** Map natural pixels → position on the surface (CSS px), applying mirroring then rotation. */
  const mapToSurface = (point: Point): Point => {
    if (!mediaSize) return { x: 0, y: 0 };
    let x = (point.x - mediaSize.w / 2) * displayScale;
    let y = (point.y - mediaSize.h / 2) * displayScale;
    if (mirrorHorizontal) x = -x;
    if (mirrorVertical) y = -y;
    if (rotation === 90) [x, y] = [-y, x];
    else if (rotation === 180) [x, y] = [-x, -y];
    else if (rotation === 270) [x, y] = [y, -x];
    return { x: x + surfaceSize.w / 2, y: y + surfaceSize.h / 2 };
  };
  const geometry = useRef({ mapToSurface, displayScale });
  geometry.current = { mapToSurface, displayScale };

  // ─── Brush cursor (moved directly, without re-rendering) ──────────────────

  const moveCursor = (clientX: number, clientY: number) => {
    const cursor = cursorRef.current;
    const surface = surfaceRef.current;
    if (!cursor || !surface) return;
    const rect = surface.getBoundingClientRect();
    cursor.style.transform = `translate(${clientX - rect.left}px, ${clientY - rect.top}px)`;
    cursor.style.visibility = 'visible';
  };
  const hideCursor = () => {
    if (cursorRef.current) cursorRef.current.style.visibility = 'hidden';
  };
  useEffect(() => {
    if (!canPaint) hideCursor();
  }, [canPaint]);

  // ─── Painting ──────────────────────────────────────────────────────────────

  const handlePointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!canPaint || (event.button !== 0 && event.button !== 2)) return;
    const point = toMapPoint(event.clientX, event.clientY);
    if (!point) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    if (paintsEffects) effects.beginStroke(event.button === 0 ? effectKind : null, point, brushSize);
    else fog.beginStroke(event.button === 0 ? 'reveal' : 'cover', point, brushSize);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (canPaint) moveCursor(event.clientX, event.clientY);
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const point = toMapPoint(event.clientX, event.clientY);
    if (!point) return;
    fog.continueStroke(point);
    effects.continueStroke(point);
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    fog.endStroke();
    effects.endStroke();
  };

  // ─── Wheel: zoom and brush size (native, so preventDefault works) ─────────

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onWheel = (event: WheelEvent) => {
      const current = latest.current;
      if (!current.mediaUrl) return;
      // The wheel over the selected circle resizes it, with or without Ctrl
      const selected = current.circlesInteractive
        ? current.circles.find((circle) => circle.id === current.selectedCircleId)
        : undefined;
      const surface = surfaceRef.current;
      if (selected && current.grid && surface) {
        const { mapToSurface: toSurface, displayScale: scale } = geometry.current;
        const rect = surface.getBoundingClientRect();
        const center = toSurface(selected);
        const reach = Math.max(MIN_WHEEL_TARGET, feetToPixels(selected.radiusFt, current.grid) * scale);
        const distance = Math.hypot(
          event.clientX - rect.left - center.x,
          event.clientY - rect.top - center.y,
        );
        if (distance <= reach) {
          event.preventDefault();
          // Shift turns vertical scrolling horizontal in Chromium, so read both axes
          const raw = event.deltaY || event.deltaX;
          const delta = raw * (event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? 800 : 1);
          const total = wheelRemainderRef.current - delta;
          const notches = Math.trunc(total / WHEEL_NOTCH);
          wheelRemainderRef.current = total - notches * WHEEL_NOTCH;
          if (notches !== 0) current.onResizeCircle(selected.id, notches, event.shiftKey);
          return;
        }
      }
      if (event.ctrlKey && (current.tool === 'fog' || current.tool === 'effect')) {
        event.preventDefault();
        current.onBrushResize(Math.sign(event.deltaY || event.deltaX) > 0 ? -1 : 1);
      } else if (event.ctrlKey) {
        event.preventDefault();
        const delta = event.deltaY || event.deltaX;
        current.onZoomWheel(Math.exp(-delta * 0.001));
      }
    };
    container.addEventListener('wheel', onWheel, { passive: false });
    return () => container.removeEventListener('wheel', onWheel);
  }, []);

  // ─── Player frame dragging ────────────────────────────────────────────────

  const frameDraggable = tool === 'frame' && !shiftHeld;

  const handleFramePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!pan || event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    frameDragRef.current = { start: { x: event.clientX, y: event.clientY }, startPan: pan };
  };

  const handleFramePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = frameDragRef.current;
    if (!drag) return;
    const next = {
      x: drag.startPan.x + (event.clientX - drag.start.x) / displayScale,
      y: drag.startPan.y + (event.clientY - drag.start.y) / displayScale,
    };
    props.onPanChange(props.constrainPan(next));
  };

  const endFrameDrag = () => {
    frameDragRef.current = null;
  };

  // ─── Circles: drag the centre dot to move ──────────────────────────────────

  const handleCirclePointerDown = (event: React.PointerEvent<HTMLElement>, id: string) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    circleDragRef.current = { id, pointerId: event.pointerId };
    wheelRemainderRef.current = 0;
    props.onSelectCircle(id);
    props.onCircleDrag(true);
  };

  const handleCirclePointerMove = (event: React.PointerEvent<HTMLElement>) => {
    const drag = circleDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const point = toMapPoint(event.clientX, event.clientY);
    if (!point) return;
    props.onMoveCircle(drag.id, grid && event.altKey ? snapToCell(point, grid) : point);
  };

  const endCircleDrag = () => {
    if (!circleDragRef.current) return;
    circleDragRef.current = null;
    props.onCircleDrag(false);
  };

  // ─── Grid calibration: clicks pick the corners ────────────────────────────

  const handleCalibrationPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const point = toMapPoint(event.clientX, event.clientY);
    if (point) props.onCalibrationPoint(point);
  };

  // ─── Render ────────────────────────────────────────────────────────────────

  const cursorDiameter = Math.max(4, brushSize * 2 * displayScale);
  const discs = toDiscs(circles, grid);
  const previewCell = gridPreview ? gridPreview.cell * displayScale : 0;
  const gridPx = gridCell * displayScale;
  const handleMediaLoad = (event: React.SyntheticEvent<HTMLImageElement | HTMLVideoElement>) => {
    const size = mediaSizeOf(event.currentTarget);
    if (size.w && size.h) props.onMediaLoad(size);
  };

  return (
    <main
      ref={containerRef}
      className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden"
      style={{ padding: STAGE_PADDING }}
    >
      {mediaUrl ? (
        <div
          ref={surfaceRef}
          className="relative shrink-0"
          style={{ width: surfaceSize.w, height: surfaceSize.h }}
          onPointerLeave={hideCursor}
          onPointerDownCapture={(event) => {
            const target = event.target as HTMLElement;
            if (selectedCircleId && !target.closest('[data-circle-control]')) props.onSelectCircle(null);
          }}
        >
          <div
            className="absolute"
            style={{
              width: mediaDisplay.w,
              height: mediaDisplay.h,
              left: (surfaceSize.w - mediaDisplay.w) / 2,
              top: (surfaceSize.h - mediaDisplay.h) / 2,
              transform: `rotate(${rotation}deg) scaleX(${mirrorHorizontal ? -1 : 1}) scaleY(${mirrorVertical ? -1 : 1})`,
            }}
          >
            {mediaType === 'video' ? (
              <video
                key={mediaUrl}
                src={mediaUrl}
                muted
                playsInline
                preload="metadata"
                onLoadedData={handleMediaLoad}
                onError={props.onMediaError}
                className="block h-full w-full"
              />
            ) : (
              <img
                key={mediaUrl}
                src={mediaUrl}
                alt=""
                draggable={false}
                onLoad={handleMediaLoad}
                onError={props.onMediaError}
                className="block h-full w-full"
              />
            )}
            {/* Draw order: map, effects, fog. Both effect canvases are 0×0 until used. */}
            <canvas
              ref={effects.canvasRef}
              width={0}
              height={0}
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 h-full w-full"
              style={{ opacity: EFFECT_OPACITY }}
            />
            <canvas
              ref={effects.scratchRef}
              width={0}
              height={0}
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 h-full w-full"
              style={{ opacity: EFFECT_OPACITY }}
            />
            <AuraDiscs discs={discs} media={mediaSize} />
            {gridPreview && previewCell > 1 && (
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 z-10"
                style={{
                  backgroundImage:
                    'linear-gradient(to right, rgb(212 175 55 / 0.8) 0 1px, transparent 1px),' +
                    'linear-gradient(to bottom, rgb(212 175 55 / 0.8) 0 1px, transparent 1px)',
                  backgroundSize: `${previewCell}px ${previewCell}px`,
                  backgroundPosition: `${gridPreview.offsetX * displayScale}px ${gridPreview.offsetY * displayScale}px`,
                }}
              />
            )}
            <canvas
              ref={fog.canvasRef}
              aria-label="Fog of war"
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerUp}
              onContextMenu={(event) => event.preventDefault()}
              className={`absolute inset-0 h-full w-full opacity-80 ${canPaint ? 'cursor-none' : 'cursor-default'}`}
            />
          </div>

          {pan && viewportSize && (
            <div
              aria-label="Player view"
              className={`absolute z-10 border-2 border-arcane bg-arcane/10 ${
                frameDraggable ? 'cursor-move' : 'pointer-events-none'
              }`}
              style={{
                left: pan.x * displayScale,
                top: pan.y * displayScale,
                width: (viewportSize.w / zoom) * displayScale,
                height: (viewportSize.h / zoom) * displayScale,
                backgroundImage:
                  gridPx > 2
                    ? `repeating-linear-gradient(to right, rgb(74 168 160 / 0.35) 0 1px, transparent 1px ${gridPx}px),` +
                      `repeating-linear-gradient(to bottom, rgb(74 168 160 / 0.35) 0 1px, transparent 1px ${gridPx}px)`
                    : undefined,
              }}
              onPointerDown={handleFramePointerDown}
              onPointerMove={handleFramePointerMove}
              onPointerUp={endFrameDrag}
              onPointerCancel={endFrameDrag}
            />
          )}

          {circlesInteractive &&
            grid &&
            circles.map((circle) => {
              const center = mapToSurface(circle);
              const selected = circle.id === selectedCircleId;
              const diameter = feetToPixels(circle.radiusFt, grid) * 2 * displayScale;
              return (
                <div key={circle.id} data-circle-control="">
                  {selected && (
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
                    aria-label={`Circle, ${circle.radiusFt} ft`}
                    title="Drag to move (Alt: snap to square centres). Mouse wheel over the circle resizes it (Shift: 1 ft steps)."
                    className={`absolute z-30 h-4 w-4 cursor-move rounded-full border-2 ${
                      selected ? 'border-ground bg-gold' : 'border-gold'
                    }`}
                    style={{
                      left: center.x - 8,
                      top: center.y - 8,
                      backgroundColor: selected ? undefined : EFFECT_STYLES[circle.kind].color,
                    }}
                    onPointerDown={(event) => handleCirclePointerDown(event, circle.id)}
                    onPointerMove={handleCirclePointerMove}
                    onPointerUp={endCircleDrag}
                    onPointerCancel={endCircleDrag}
                  />
                  <div
                    className="pointer-events-none absolute z-30 -translate-x-1/2 whitespace-nowrap rounded bg-ground/85 px-1.5 text-[11px] font-medium tabular-nums text-ink"
                    style={{ left: center.x, top: center.y + 10 }}
                  >
                    {circle.radiusFt} ft
                  </div>
                  {selected && (
                    <div
                      role="toolbar"
                      aria-label="Selected circle"
                      className="absolute z-30 flex -translate-x-1/2 items-center gap-0.5 rounded border border-line bg-panel p-0.5"
                      style={{ left: center.x, top: center.y + 30 }}
                    >
                      {EFFECT_KINDS.map((kind) => (
                        <button
                          key={kind}
                          type="button"
                          title={EFFECT_STYLES[kind].label}
                          aria-label={EFFECT_STYLES[kind].label}
                          aria-pressed={circle.kind === kind}
                          onClick={() => props.onRecolorCircle(circle.id, kind)}
                          className={`h-5 w-5 rounded-sm border-2 ${circle.kind === kind ? 'border-gold' : 'border-transparent'}`}
                          style={{ backgroundColor: EFFECT_STYLES[kind].color }}
                        />
                      ))}
                      <button
                        type="button"
                        title="Duplicate"
                        aria-label="Duplicate circle"
                        onClick={() => props.onDuplicateCircle(circle.id)}
                        className="flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-raised hover:text-ink"
                      >
                        <Copy className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        title="Delete (Del)"
                        aria-label="Delete circle"
                        onClick={() => props.onDeleteCircle(circle.id)}
                        className="flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-raised hover:text-crimson-bright"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  )}
                </div>
              );
            })}

          {calibrationPoints && (
            <div
              aria-label="Grid calibration"
              className="absolute inset-0 z-40 cursor-crosshair"
              onPointerDown={handleCalibrationPointerDown}
            >
              {calibrationPoints.map((point, index) => {
                const at = mapToSurface(point);
                return (
                  <span
                    key={index}
                    aria-hidden="true"
                    className="pointer-events-none absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-ground bg-gold"
                    style={{ left: at.x, top: at.y }}
                  />
                );
              })}
            </div>
          )}

          <div
            ref={cursorRef}
            aria-hidden="true"
            className="pointer-events-none absolute left-0 top-0 z-20 rounded-full border-2 border-gold"
            style={{
              borderColor: paintsEffects ? EFFECT_STYLES[effectKind].color : undefined,
              visibility: 'hidden',
              width: cursorDiameter,
              height: cursorDiameter,
              marginLeft: -cursorDiameter / 2,
              marginTop: -cursorDiameter / 2,
            }}
          />
        </div>
      ) : (
        <div className="max-w-xs text-center">
          <p className="font-display text-lg text-ink">No map loaded</p>
          <p className="mt-2 text-[13px] leading-relaxed text-muted">
            Add maps in the library, or drop image and WebM files onto it. Double-click a map to load it.
          </p>
        </div>
      )}
    </main>
  );
}

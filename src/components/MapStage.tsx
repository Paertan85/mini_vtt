// The DM window's map area: the map, its fog, the player frame and the brush.
//
// Mouse:  fog tool      left button reveals, right button covers
//         frame tool    drag the frame to move the player view
//         either tool   Shift + left/right paints fog, Ctrl + wheel zooms the
//                       player view, wheel (fog tool) or Shift + wheel resizes
//                       the brush

import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { MapPan, MediaType, Point } from '../types/map';
import type { Fog } from '../hooks/useFog';
import { orientedSize, type Size } from '../lib/geometry';

export type Tool = 'frame' | 'fog';

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
}

const STAGE_PADDING = 24;

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
    tool,
    shiftHeld,
    brushSize,
    pan,
    viewportSize,
    zoom,
    gridCell,
  } = props;

  const containerRef = useRef<HTMLElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const cursorRef = useRef<HTMLDivElement>(null);
  const frameDragRef = useRef<{ start: Point; startPan: MapPan } | null>(null);
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

  const canPaint = tool === 'fog' || shiftHeld;

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
    fog.beginStroke(event.button === 0 ? 'reveal' : 'cover', point, brushSize);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (canPaint) moveCursor(event.clientX, event.clientY);
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const point = toMapPoint(event.clientX, event.clientY);
    if (point) fog.continueStroke(point);
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    fog.endStroke();
  };

  // ─── Wheel: zoom and brush size (native, so preventDefault works) ─────────

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onWheel = (event: WheelEvent) => {
      const current = latest.current;
      if (!current.mediaUrl) return;
      if (event.ctrlKey && current.tool === 'fog') {
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

  // ─── Render ────────────────────────────────────────────────────────────────

  const cursorDiameter = Math.max(4, brushSize * 2 * displayScale);
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

          <div
            ref={cursorRef}
            aria-hidden="true"
            className="pointer-events-none absolute left-0 top-0 z-20 rounded-full border-2 border-gold"
            style={{
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

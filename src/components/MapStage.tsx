// The DM window's map area: the map, its fog, the player frame and the brush.
//
// Mouse:  fog tool      left button reveals, right button covers
//         effects tool  left button paints the chosen effect, right button erases
//         frame tool    drag the frame to move the player view
//         measure tool  drag to measure a distance in feet
//         any tool      Shift + left/right paints fog
//
// Wheel:  Ctrl          zooms the DM view around the pointer (touchpad pinch
//                       too); players are unaffected
//         Alt           zooms the player view in 1% steps, in any tool
//         plain         resizes what you work with: the selected circle under
//                       the pointer (5 ft per notch), else the brush (Fog and
//                       Effects tools, or while Shift is held), else the player
//                       view when over the frame (View tool, unless its zoom
//                       is locked)
//
// Panning a zoomed DM view: middle-button drag. Alt + drag on the player
// frame moves it from any tool, zoomed in or not.
// Circles (View and Shapes tools): drag the centre dot to move (Ctrl: snap
// to square centres).

import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Copy, Lock, Trash2 } from 'lucide-react';
import type {
  AuraCircle,
  DiagonalRule,
  EffectKind,
  MapGrid,
  MapPan,
  MediaType,
  Point,
  RulerState,
} from '../types/map';
import type { Fog } from '../hooks/useFog';
import type { EffectLayer } from '../hooks/useEffectLayer';
import { EFFECT_KINDS, EFFECT_OPACITY, EFFECT_STYLES } from '../lib/effects';
import {
  AREA_LABELS,
  areaContains,
  areaOutline,
  areaHandle,
  feetToPixels,
  snapArea,
  toDiscs,
} from '../lib/grid';
import { AuraDiscs } from './AuraDiscs';
import { MeasureLayer } from './MeasureLayer';
import { mapToOriented, orientedSize, wheelPixels, type Size } from '../lib/geometry';
import { keyLabel } from '../lib/platform';
import { releaseVideo } from '../lib/video';
import { FRAME_COLOR_STYLES, type FrameColor } from '../lib/frameColors';

export type Tool = 'view' | 'fog' | 'effect' | 'shapes' | 'measure';

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
  /** Fog tool draws outlines whose inside is revealed or covered, not brush strokes */
  fogLasso: boolean;
  /** Alt held: the player frame can be dragged from any tool */
  altHeld: boolean;
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
  /** The player view zoom is locked: the wheel over the frame leaves it alone */
  zoomLocked: boolean;
  /** Colour of the player view frame */
  frameColor: FrameColor;
  onZoomWheel: (factor: number) => void;
  /** Alt + wheel: the player view zoom, by whole percent steps (positive zooms in) */
  onZoomPercentStep: (steps: number) => void;

  /** The map's measured grid, needed to size and snap circles */
  grid: MapGrid | null;
  /** How the Measure tool counts diagonal squares */
  diagonalRule: DiagonalRule;
  /** The Measure tool's ruler changed, or went (null) */
  onRulerChange: (ruler: RulerState | null) => void;
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
  /** Wheel notches: positive grows, 5 ft per notch */
  onResizeCircle: (id: string, notches: number) => void;
  /** A size typed into the template's toolbar: radius, side or length */
  onSetCircleRadius: (id: string, radiusFt: number) => void;
  /** A line width typed into its toolbar */
  onSetCircleWidth: (id: string, widthFt: number) => void;
  /**
   * Cones and lines: the aim handle was dragged to `point` (direction and
   * length); `snap` (Ctrl held) keeps the direction to 45° steps
   */
  onAimCircle: (id: string, point: Point, snap: boolean) => void;
  onDuplicateCircle: (id: string) => void;
  onDeleteCircle: (id: string) => void;
  onRecolorCircle: (id: string, kind: EffectKind) => void;

  /** Corners clicked so far while calibrating the grid; null when not calibrating */
  calibrationPoints: Point[] | null;
  onCalibrationPoint: (point: Point) => void;

  /** Filled in by the stage, so keyboard shortcuts can zoom the DM view */
  viewControls: React.MutableRefObject<ViewControls | null>;
}

export interface ViewControls {
  /** Zoom the DM view around the middle of the stage */
  zoomBy: (factor: number) => void;
  fit: () => void;
}

const STAGE_PADDING = 24;
/** Wheel distance that counts as one notch; trackpads send many small deltas */
const WHEEL_NOTCH = 100;
/** How close (screen px) the pointer must be to a small circle for the wheel to resize it */
const MIN_WHEEL_TARGET = 24;
/** DM view zoom range, relative to fitting the whole map */
const MAX_VIEW_ZOOM = 8;

interface ViewZoom {
  zoom: number;
  /** Offset of the map from the centre of the stage, in screen px */
  x: number;
  y: number;
}
const FIT_VIEW: ViewZoom = { zoom: 1, x: 0, y: 0 };

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
    fogLasso,
    altHeld,
    brushSize,
    pan,
    viewportSize,
    zoom,
    gridCell,
    grid,
    diagonalRule,
    gridPreview,
    circles,
    selectedCircleId,
    circlesInteractive,
    calibrationPoints,
  } = props;

  const containerRef = useRef<HTMLElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  // A video map lets go of its file and decoder as soon as it is replaced or unloaded
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const setVideo = useCallback((element: HTMLVideoElement | null) => {
    if (!element) releaseVideo(videoRef.current);
    videoRef.current = element;
  }, []);
  const cursorRef = useRef<HTMLDivElement>(null);
  const frameDragRef = useRef<{ start: Point; startPan: MapPan } | null>(null);
  const circleDragRef = useRef<{ id: string; pointerId: number; aim: boolean } | null>(null);
  const wheelRemainderRef = useRef(0);
  const brushWheelRef = useRef(0);
  const playerWheelRef = useRef(0);
  const viewDragRef = useRef<{ start: Point; startView: ViewZoom; pointerId: number } | null>(null);
  const altFrameDragRef = useRef<{ start: Point; startPan: MapPan; pointerId: number } | null>(null);
  const [available, setAvailable] = useState<Size>({ w: 0, h: 0 });
  // DM-only zoom and pan; the player screen never sees it
  const [view, setView] = useState<ViewZoom>(FIT_VIEW);
  useEffect(() => setView(FIT_VIEW), [mediaUrl]);

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

  // Fit the (rotated) map into the available space, never upscaling; the DM
  // view zoom scales up from there
  const oriented = mediaSize ? orientedSize(mediaSize, rotation) : null;
  const fitScale =
    oriented && available.w > 0 && available.h > 0
      ? Math.min(1, available.w / oriented.w, available.h / oriented.h)
      : 1;
  const displayScale = fitScale * view.zoom;
  const surfaceSize = oriented
    ? { w: oriented.w * displayScale, h: oriented.h * displayScale }
    : { w: 0, h: 0 };
  const mediaDisplay = mediaSize
    ? { w: mediaSize.w * displayScale, h: mediaSize.h * displayScale }
    : { w: 0, h: 0 };

  // Shift always paints fog, whatever the tool
  const paintsEffects = tool === 'effect' && !shiftHeld;
  const canPaint = tool === 'fog' || tool === 'effect' || shiftHeld;
  // The lasso is a Fog tool mode; Shift from another tool is always the brush
  const drawsLasso = fogLasso && tool === 'fog';
  const lassoRef = useRef<SVGPolygonElement>(null);
  const lastLassoPointRef = useRef<Point | null>(null);

  /** Extend the outline preview without re-rendering. */
  const addLassoPoint = (point: Point) => {
    const polygon = lassoRef.current;
    const svg = polygon?.ownerSVGElement;
    if (!polygon || !svg) return;
    const added = svg.createSVGPoint();
    added.x = point.x;
    added.y = point.y;
    polygon.points.appendItem(added);
  };
  const clearLassoPreview = () => {
    lassoRef.current?.points.clear();
    lastLassoPointRef.current = null;
  };

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
    const oriented = mapToOriented(point, mediaSize, rotation, mirrorHorizontal, mirrorVertical);
    return { x: oriented.x * displayScale, y: oriented.y * displayScale };
  };
  /** Keep a zoomed map covering the stage: it can be panned edge to edge, no further. */
  const clampView = (next: ViewZoom): ViewZoom => {
    if (!oriented || next.zoom <= 1) return FIT_VIEW;
    const limitX = Math.max(0, (oriented.w * fitScale * next.zoom - available.w) / 2);
    const limitY = Math.max(0, (oriented.h * fitScale * next.zoom - available.h) / 2);
    return {
      zoom: next.zoom,
      x: Math.max(-limitX, Math.min(limitX, next.x)),
      y: Math.max(-limitY, Math.min(limitY, next.y)),
    };
  };
  const shownView = clampView(view);

  const geometry = useRef({ mapToSurface, toMapPoint, displayScale, clampView });
  geometry.current = { mapToSurface, toMapPoint, displayScale, clampView };

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
  // Where the pointer last was over the map, so pressing Shift shows the brush
  // straight away instead of on the next move
  const lastPointerRef = useRef<Point | null>(null);
  useEffect(() => {
    const last = lastPointerRef.current;
    if (!canPaint || drawsLasso) hideCursor();
    else if (last) moveCursor(last.x, last.y);
  }, [canPaint, drawsLasso]);

  // ─── Painting ──────────────────────────────────────────────────────────────

  const handlePointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!canPaint || (event.button !== 0 && event.button !== 2)) return;
    const point = toMapPoint(event.clientX, event.clientY);
    if (!point) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    if (paintsEffects) effects.beginStroke(event.button === 0 ? effectKind : null, point, brushSize);
    else if (drawsLasso) {
      fog.beginLasso(event.button === 0 ? 'reveal' : 'cover', point);
      clearLassoPreview();
      addLassoPoint(point);
      lastLassoPointRef.current = point;
      lassoRef.current?.setAttribute('data-mode', event.button === 0 ? 'reveal' : 'cover');
    } else fog.beginStroke(event.button === 0 ? 'reveal' : 'cover', point, brushSize);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (canPaint && !drawsLasso) moveCursor(event.clientX, event.clientY);
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const point = toMapPoint(event.clientX, event.clientY);
    if (!point) return;
    const last = lastLassoPointRef.current;
    if (last) {
      // Skip points under ~2 screen pixels apart; the outline needs no more
      if (Math.hypot(point.x - last.x, point.y - last.y) * displayScale < 2) return;
      lastLassoPointRef.current = point;
      fog.continueLasso(point);
      addLassoPoint(point);
      return;
    }
    fog.continueStroke(point);
    effects.continueStroke(point);
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    fog.endStroke();
    fog.endLasso();
    effects.endStroke();
    clearLassoPreview();
  };

  // ─── DM view zoom ──────────────────────────────────────────────────────────

  /** Zoom by `factor`, keeping the point at (fromCenterX, fromCenterY) — screen px from the stage centre — in place. */
  const zoomViewAt = (fromCenterX: number, fromCenterY: number, factor: number) =>
    setView((previous) => {
      const { clampView: clamp } = geometry.current;
      const start = clamp(previous);
      const zoom = Math.max(1, Math.min(MAX_VIEW_ZOOM, start.zoom * factor));
      const grow = zoom / start.zoom;
      return clamp({
        zoom,
        x: fromCenterX - (fromCenterX - start.x) * grow,
        y: fromCenterY - (fromCenterY - start.y) * grow,
      });
    });
  props.viewControls.current = {
    zoomBy: (factor) => zoomViewAt(0, 0, factor),
    fit: () => setView(FIT_VIEW),
  };

  // ─── Wheel: zoom, circle, brush and player view (native, so preventDefault works)

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onWheel = (event: WheelEvent) => {
      const current = latest.current;
      if (!current.mediaUrl) return;
      // Ctrl or Cmd + wheel zooms the DM view in any tool, keeping the spot
      // under the pointer. A touchpad pinch arrives as Ctrl + wheel.
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        const rect = container.getBoundingClientRect();
        hideCursor(); // it would sit off the pointer until the next move
        zoomViewAt(
          event.clientX - rect.left - rect.width / 2,
          event.clientY - rect.top - rect.height / 2,
          Math.exp(-wheelPixels(event) * 0.002),
        );
        return;
      }
      /** Whole notches so far; trackpads send many small deltas */
      const notchesFrom = (remainder: React.MutableRefObject<number>) => {
        const total = remainder.current - wheelPixels(event);
        const notches = Math.trunc(total / WHEEL_NOTCH);
        remainder.current = total - notches * WHEEL_NOTCH;
        return notches;
      };
      // Alt + wheel, like Alt + drag, works on the player view: its zoom in
      // 1% steps, anywhere over the map and in any tool, unless it is locked
      if (event.altKey) {
        event.preventDefault();
        if (current.zoomLocked) return;
        const notches = notchesFrom(playerWheelRef);
        if (notches !== 0) current.onZoomPercentStep(notches);
        return;
      }
      // The wheel over the selected circle resizes it
      const selected = current.circlesInteractive
        ? current.circles.find((circle) => circle.id === current.selectedCircleId)
        : undefined;
      const surface = surfaceRef.current;
      if (selected && current.grid && surface) {
        const { toMapPoint: toMap, displayScale: scale } = geometry.current;
        const pointer = toMap(event.clientX, event.clientY);
        const [disc] = toDiscs([selected], current.grid);
        if (pointer && areaContains(disc, pointer, MIN_WHEEL_TARGET / scale)) {
          event.preventDefault();
          const notches = notchesFrom(wheelRemainderRef);
          if (notches !== 0) current.onResizeCircle(selected.id, notches);
          return;
        }
      }
      // Painting tools (or Shift, which paints fog from any tool): brush size.
      // Shift turns vertical scrolling horizontal in Chromium; wheelPixels reads both axes.
      if (current.tool === 'fog' || current.tool === 'effect' || event.shiftKey || current.shiftHeld) {
        event.preventDefault();
        const notches = notchesFrom(brushWheelRef);
        for (let i = 0; i < Math.abs(notches); i++) current.onBrushResize(notches > 0 ? 1 : -1);
        return;
      }
      // View tool, pointer over the player frame: the player view zoom. Not in
      // the Shapes tool, where a wheel that just misses a shape would zoom it.
      const { pan: framePan, viewportSize: viewport, zoom: playerZoom } = current;
      if (current.tool === 'view' && !current.zoomLocked && framePan && viewport && surface) {
        const { displayScale: scale } = geometry.current;
        const rect = surface.getBoundingClientRect();
        const x = (event.clientX - rect.left) / scale - framePan.x;
        const y = (event.clientY - rect.top) / scale - framePan.y;
        if (x >= 0 && y >= 0 && x <= viewport.w / playerZoom && y <= viewport.h / playerZoom) {
          event.preventDefault();
          current.onZoomWheel(Math.exp(-wheelPixels(event) * 0.001));
        }
      }
    };
    container.addEventListener('wheel', onWheel, { passive: false });
    return () => container.removeEventListener('wheel', onWheel);
  }, []);

  // ─── DM view: middle-button drag pans a zoomed map; Alt + drag the frame ───

  /**
   * Runs in the capture phase, so a pan never also paints or drags the frame.
   * Alt + drag also moves the player frame from any tool. Alt is read from the
   * press itself as well as the key: Windows doesn't always deliver the Alt
   * keydown before the press.
   */
  const handleViewPointerDown = (event: React.PointerEvent<HTMLElement>) => {
    const alt = event.button === 0 && (altHeld || event.altKey);
    if (event.button === 1 && shownView.zoom > 1) {
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);
      viewDragRef.current = {
        start: { x: event.clientX, y: event.clientY },
        startView: shownView,
        pointerId: event.pointerId,
      };
      return;
    }
    // Alt + drag on the frame moves it, whatever the tool; an area's own
    // handles still drag the area
    const surface = surfaceRef.current;
    if (!alt || !pan || !viewportSize || !surface) return;
    if (event.target instanceof Element && event.target.closest('button')) return;
    const rect = surface.getBoundingClientRect();
    const x = (event.clientX - rect.left) / displayScale - pan.x;
    const y = (event.clientY - rect.top) / displayScale - pan.y;
    if (x < 0 || y < 0 || x > viewportSize.w / zoom || y > viewportSize.h / zoom) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    altFrameDragRef.current = {
      start: { x: event.clientX, y: event.clientY },
      startPan: pan,
      pointerId: event.pointerId,
    };
  };

  const handleViewPointerMove = (event: React.PointerEvent<HTMLElement>) => {
    const frameDrag = altFrameDragRef.current;
    if (frameDrag?.pointerId === event.pointerId) {
      props.onPanChange(
        props.constrainPan({
          x: frameDrag.startPan.x + (event.clientX - frameDrag.start.x) / displayScale,
          y: frameDrag.startPan.y + (event.clientY - frameDrag.start.y) / displayScale,
        }),
      );
      return;
    }
    const drag = viewDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setView(
      clampView({
        zoom: drag.startView.zoom,
        x: drag.startView.x + event.clientX - drag.start.x,
        y: drag.startView.y + event.clientY - drag.start.y,
      }),
    );
  };

  const endViewDrag = (event: React.PointerEvent<HTMLElement>) => {
    if (viewDragRef.current?.pointerId === event.pointerId) viewDragRef.current = null;
    if (altFrameDragRef.current?.pointerId === event.pointerId) altFrameDragRef.current = null;
  };

  // ─── Player frame dragging ────────────────────────────────────────────────

  const frameDraggable = tool === 'view' && !shiftHeld;

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

  // ─── Templates: drag the dot to move, the aim handle to point and stretch ──

  const handleCirclePointerDown = (event: React.PointerEvent<HTMLElement>, id: string, aim = false) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    circleDragRef.current = { id, pointerId: event.pointerId, aim };
    wheelRemainderRef.current = 0;
    props.onSelectCircle(id);
    props.onCircleDrag(true);
  };

  const handleCirclePointerMove = (event: React.PointerEvent<HTMLElement>) => {
    const drag = circleDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const point = toMapPoint(event.clientX, event.clientY);
    if (!point) return;
    if (drag.aim) {
      props.onAimCircle(drag.id, point, event.ctrlKey || event.metaKey);
      return;
    }
    const area = circles.find((circle) => circle.id === drag.id);
    props.onMoveCircle(
      drag.id,
      grid && area && (event.ctrlKey || event.metaKey) ? snapArea(point, area, grid) : point,
    );
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
  // The same array while the templates are unchanged, so AuraDiscs skips the
  // renders that moving the player frame causes
  const discs = useMemo(() => toDiscs(circles, grid), [circles, grid]);
  const previewCell = gridPreview ? gridPreview.cell * displayScale : 0;
  const gridPx = gridCell * displayScale;
  const frameRgb = FRAME_COLOR_STYLES[props.frameColor].rgb;
  const handleMediaLoad = (event: React.SyntheticEvent<HTMLImageElement | HTMLVideoElement>) => {
    const size = mediaSizeOf(event.currentTarget);
    if (size.w && size.h) props.onMediaLoad(size);
  };

  return (
    <main
      ref={containerRef}
      className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden"
      style={{ padding: STAGE_PADDING }}
      onPointerDownCapture={handleViewPointerDown}
      onPointerMove={handleViewPointerMove}
      onPointerUp={endViewDrag}
      onPointerCancel={endViewDrag}
      // No autoscroll on a middle click
      onMouseDown={(event) => event.button === 1 && event.preventDefault()}
    >
      {mediaUrl ? (
        <div
          ref={surfaceRef}
          className="relative shrink-0"
          style={{
            width: surfaceSize.w,
            height: surfaceSize.h,
            transform: shownView.zoom > 1 ? `translate(${shownView.x}px, ${shownView.y}px)` : undefined,
          }}
          onPointerMove={(event) => {
            lastPointerRef.current = { x: event.clientX, y: event.clientY };
          }}
          onPointerLeave={() => {
            lastPointerRef.current = null;
            hideCursor();
          }}
          onPointerDownCapture={(event) => {
            const target = event.target as HTMLElement;
            if (event.button === 1) return; // panning the view keeps the selection
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
                ref={setVideo}
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
              <GridLines
                cell={previewCell}
                color="rgb(212 175 55 / 0.8)"
                offsetX={gridPreview.offsetX * displayScale}
                offsetY={gridPreview.offsetY * displayScale}
                className="z-10"
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
              className={`absolute inset-0 h-full w-full opacity-80 ${
                drawsLasso ? 'cursor-crosshair' : canPaint ? 'cursor-none' : 'cursor-default'
              }`}
            />
            {/* The lasso's outline while drawing; the closing edge is implied */}
            {mediaSize && drawsLasso && (
              <svg
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 h-full w-full overflow-visible"
                viewBox={`0 0 ${mediaSize.w} ${mediaSize.h}`}
                preserveAspectRatio="none"
              >
                <polygon
                  ref={lassoRef}
                  className="fill-gold/15 stroke-gold data-[mode=cover]:fill-ground/40"
                  strokeWidth={2}
                  strokeDasharray="6 4"
                  vectorEffect="non-scaling-stroke"
                  strokeLinejoin="round"
                />
              </svg>
            )}
          </div>

          {pan && viewportSize && (
            <div
              aria-label="Player view"
              className={`absolute z-10 border-2 ${frameDraggable ? 'cursor-move' : 'pointer-events-none'}`}
              style={{
                left: pan.x * displayScale,
                top: pan.y * displayScale,
                width: (viewportSize.w / zoom) * displayScale,
                height: (viewportSize.h / zoom) * displayScale,
                borderColor: `rgb(${frameRgb})`,
                backgroundColor: `rgb(${frameRgb} / 0.1)`,
              }}
              onPointerDown={handleFramePointerDown}
              onPointerMove={handleFramePointerMove}
              onPointerUp={endFrameDrag}
              onPointerCancel={endFrameDrag}
            >
              {gridPx > 2 && <GridLines cell={gridPx} color={`rgb(${frameRgb} / 0.35)`} />}
              {/* A locked zoom shows as a padlock, like a locked layer in an image editor */}
              {props.zoomLocked && (
                <span
                  aria-label="Zoom locked"
                  className="pointer-events-none absolute right-1 top-1 flex items-center rounded border bg-ground/85 p-1 text-ink"
                  style={{ borderColor: `rgb(${frameRgb})` }}
                >
                  <Lock className="h-3 w-3" aria-hidden="true" />
                </span>
              )}
            </div>
          )}

          {circlesInteractive &&
            grid &&
            circles.map((circle, index) => {
              const center = mapToSurface(circle);
              const selected = circle.id === selectedCircleId;
              const diameter = feetToPixels(circle.radiusFt, grid) * 2 * displayScale;
              const outline = areaOutline(discs[index]);
              const handle = areaHandle(discs[index]);
              const tip = handle ? mapToSurface(handle) : null;
              const turns = circle.shape === 'square';
              const label = AREA_LABELS[circle.shape];
              const sizeText =
                circle.shape === 'line'
                  ? `${circle.radiusFt} × ${circle.widthFt} ft`
                  : `${circle.radiusFt} ft`;
              const sizeName =
                circle.shape === 'circle' ? 'Radius' : circle.shape === 'square' ? 'Side' : 'Length';
              return (
                <div key={circle.id} data-circle-control="">
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
                      onPointerDown={(event) => handleCirclePointerDown(event, circle.id, true)}
                      onPointerMove={handleCirclePointerMove}
                      onPointerUp={endCircleDrag}
                      onPointerCancel={endCircleDrag}
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
                        circle.shape === 'line' ? 'width' : 'size'
                      }; arrow keys nudge it.`,
                    )}
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
                          value={circle.radiusFt}
                          onChange={(event) => {
                            const value = event.currentTarget.valueAsNumber;
                            if (Number.isFinite(value) && value > 0)
                              props.onSetCircleRadius(circle.id, value);
                          }}
                          className="w-12 rounded border border-line bg-ground px-1 py-0.5 text-right text-[12px] tabular-nums text-ink"
                        />
                        ft
                      </label>
                      {circle.shape === 'line' && (
                        <label className="flex items-center gap-1 px-1 text-[11px] text-muted">
                          wide
                          <input
                            type="number"
                            aria-label="Width in feet"
                            title="Width in feet"
                            min={1}
                            max={500}
                            step={1}
                            value={circle.widthFt}
                            onChange={(event) => {
                              const value = event.currentTarget.valueAsNumber;
                              if (Number.isFinite(value) && value > 0)
                                props.onSetCircleWidth(circle.id, value);
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
                          aria-pressed={circle.kind === kind}
                          onClick={() => props.onRecolorCircle(circle.id, kind)}
                          className={`h-5 w-5 rounded-sm border-2 ${circle.kind === kind ? 'border-gold' : 'border-transparent'}`}
                          style={{ backgroundColor: EFFECT_STYLES[kind].color }}
                        />
                      ))}
                      <button
                        type="button"
                        title="Duplicate"
                        aria-label={`Duplicate ${label.toLowerCase()}`}
                        onClick={() => props.onDuplicateCircle(circle.id)}
                        className="flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-raised hover:text-ink"
                      >
                        <Copy className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        title="Delete (Del)"
                        aria-label={`Delete ${label.toLowerCase()}`}
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

          {tool === 'measure' && grid && !calibrationPoints && (
            <MeasureLayer
              key={mediaUrl}
              passThrough={shiftHeld}
              grid={grid}
              rule={diagonalRule}
              toMapPoint={toMapPoint}
              mapToSurface={mapToSurface}
              onChange={props.onRulerChange}
            />
          )}

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
      {mediaUrl && shownView.zoom > 1 && (
        <button
          type="button"
          title={keyLabel(
            'DM view only; players are unaffected. Ctrl + mouse wheel zooms, middle-drag pans. Click to fit the map.',
          )}
          onClick={() => setView(FIT_VIEW)}
          className="absolute bottom-3 right-3 z-50 rounded border border-line bg-panel/90 px-2 py-1 text-[12px] tabular-nums text-ink hover:bg-raised"
        >
          DM view {Math.round(shownView.zoom * 100)}% · Fit
        </button>
      )}
    </main>
  );
}

/**
 * Square grid lines, `cell` screen px apart, the first at (offsetX, offsetY).
 * An SVG pattern rather than a CSS gradient: Chromium samples a gradient's
 * colours at a limited resolution, so a 1px line in a square hundreds of
 * pixels wide (a DM view zoomed far in) falls between samples and vanishes.
 */
function GridLines({
  cell,
  color,
  offsetX = 0,
  offsetY = 0,
  className = '',
}: {
  cell: number;
  color: string;
  offsetX?: number;
  offsetY?: number;
  className?: string;
}) {
  // useId's colons would need escaping inside url()
  const id = `grid-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  return (
    <svg aria-hidden="true" className={`pointer-events-none absolute inset-0 h-full w-full ${className}`}>
      <defs>
        <pattern id={id} patternUnits="userSpaceOnUse" x={offsetX} y={offsetY} width={cell} height={cell}>
          <path
            d={`M0 0.5H${cell}M0.5 0V${cell}`}
            stroke={color}
            strokeWidth={1}
            shapeRendering="crispEdges"
          />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill={`url(#${id})`} />
    </svg>
  );
}

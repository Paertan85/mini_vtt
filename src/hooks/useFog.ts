// The DM window's fog of war: the mask canvas, painting, undo/redo, and keeping
// the player screen in sync.
//
// Sync model: strokes are painted locally only. When a stroke ends the whole
// mask is encoded once and sent as a snapshot, which the main process relays
// to the player screen and saves to disk. Players never watch the brush move:
// a room the DM reveals in one drag appears all at once when the mouse is
// released, and the encode happens exactly once per stroke.
//
// The encode runs in the background, so the window doesn't freeze when the
// mouse is released. Encoded snapshots and undo/redo steps wait their turn in
// one queue, so they apply in the order they happened.
//
// A lasso (freehand outline) only collects points while the mouse moves; the
// inside is filled once on release and published like a stroke.
//
// Undo needs no extra work: the state before a stroke is the snapshot that was
// encoded at the end of the previous one.

import { useCallback, useRef, useState } from 'react';
import type { FogMode, Point } from '../types/map';
import type { Size } from '../lib/geometry';
import {
  drawSnapshot,
  drawStroke,
  encodeMask,
  fillMask,
  fillOutline,
  fogMaskSize,
  loadImage,
} from '../lib/fog';

/** Mask colour in the DM window: a deep indigo, so fog never blends into dark maps. */
export const DM_FOG_COLOR = '#1d1a2e';

const MAX_HISTORY = 20;

export interface Fog {
  canvasRef: React.RefObject<HTMLCanvasElement>;
  /** Size the mask for a newly loaded map and show its saved fog (or full fog). */
  initialize: (mapId: string, media: Size, savedMask: string | null) => Promise<void>;
  beginStroke: (mode: FogMode, point: Point, radius: number) => void;
  continueStroke: (point: Point) => void;
  endStroke: () => void;
  /** Freehand outline: reveal or cover its inside when it ends */
  beginLasso: (mode: FogMode, point: Point) => void;
  continueLasso: (point: Point) => void;
  endLasso: () => void;
  revealAll: () => void;
  coverAll: () => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  /** Resolves once every change so far has been encoded and sent. */
  whenIdle: () => Promise<void>;
}

export function useFog(): Fog {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mapIdRef = useRef<string | null>(null);
  const mediaRef = useRef<Size>({ w: 0, h: 0 });
  const strokeRef = useRef<{ mode: FogMode; last: Point; radius: number } | null>(null);
  const lassoRef = useRef<{ mode: FogMode; points: Point[] } | null>(null);
  // The encoded current mask, and masks to step back or forward to
  const currentRef = useRef<string | null>(null);
  const undoRef = useRef<string[]>([]);
  const redoRef = useRef<string[]>([]);
  // Counts initialize calls: one that is overtaken while decoding stops, and a
  // snapshot still encoding for an earlier map leaves this one's history alone
  const initializeRunRef = useRef(0);
  // Encoded snapshots and history steps, applied one after another
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const [history, setHistory] = useState({ canUndo: false, canRedo: false });

  const context = () => canvasRef.current?.getContext('2d') ?? null;
  const syncHistoryState = () =>
    setHistory({ canUndo: undoRef.current.length > 0, canRedo: redoRef.current.length > 0 });

  const enqueue = useCallback((task: () => Promise<void> | void) => {
    queueRef.current = queueRef.current
      .then(task)
      .catch((err) => console.error('Could not update the fog.', err));
  }, []);

  const whenIdle = useCallback(() => queueRef.current, []);

  /**
   * Copy the mask now and hand it to the main process (relay + optional save)
   * once it is encoded. `then` gets the encoded mask, in order, if the same
   * map is still loaded.
   */
  const publish = useCallback(
    (persist: boolean, then?: (dataUrl: string) => void) => {
      const canvas = canvasRef.current;
      const mapId = mapIdRef.current;
      if (!canvas || !mapId) return;
      const run = initializeRunRef.current;
      const encoded = encodeMask(canvas);
      enqueue(async () => {
        const dataUrl = await encoded;
        window.electronAPI?.sendFogSnapshot({ mapId, dataUrl, persist });
        if (run === initializeRunRef.current) then?.(dataUrl);
      });
    },
    [enqueue],
  );

  /** Record a finished change: the previous mask becomes an undo step. */
  const commit = useCallback(() => {
    publish(true, (next) => {
      const previous = currentRef.current;
      if (previous) undoRef.current = [...undoRef.current.slice(-(MAX_HISTORY - 1)), previous];
      redoRef.current = [];
      currentRef.current = next;
      syncHistoryState();
    });
  }, [publish]);

  const initialize = useCallback(
    async (mapId: string, media: Size, savedMask: string | null) => {
      const canvas = canvasRef.current;
      const ctx = context();
      if (!canvas || !ctx) return;
      const run = ++initializeRunRef.current;
      mapIdRef.current = mapId;
      mediaRef.current = media;
      strokeRef.current = null;
      lassoRef.current = null;
      undoRef.current = [];
      redoRef.current = [];
      const size = fogMaskSize(media);
      canvas.width = size.width;
      canvas.height = size.height;
      let restored = false;
      if (savedMask) {
        try {
          const image = await loadImage(savedMask);
          // Another map started loading while this mask decoded: it owns the canvas now
          if (run !== initializeRunRef.current) return;
          drawSnapshot(ctx, image, DM_FOG_COLOR);
          restored = true;
        } catch (err) {
          if (run !== initializeRunRef.current) return;
          console.error('Saved fog is unreadable; starting fully fogged instead.', err);
        }
      }
      if (!restored) fillMask(ctx, DM_FOG_COLOR);
      window.electronAPI?.sendFogReset();
      if (restored && savedMask) {
        // Already saved: relay the mask as loaded, without encoding it again
        window.electronAPI?.sendFogSnapshot({ mapId, dataUrl: savedMask, persist: false });
        currentRef.current = savedMask;
      } else {
        // A freshly fogged map has nothing on disk yet, so save it
        currentRef.current = null;
        publish(true, (encoded) => {
          currentRef.current = encoded;
        });
      }
      syncHistoryState();
    },
    [publish],
  );

  /** Paint one segment in the DM window only. Uses refs only. */
  const paint = useCallback((mode: FogMode, from: Point, to: Point, radius: number) => {
    const ctx = canvasRef.current?.getContext('2d');
    if (ctx) drawStroke(ctx, { mode, from, to, radius }, mediaRef.current, DM_FOG_COLOR);
  }, []);

  const beginStroke = useCallback(
    (mode: FogMode, point: Point, radius: number) => {
      strokeRef.current = { mode, last: point, radius };
      // A zero-length segment paints a dot where the stroke starts
      paint(mode, point, { x: point.x + 0.01, y: point.y + 0.01 }, radius);
    },
    [paint],
  );

  const continueStroke = useCallback(
    (point: Point) => {
      const stroke = strokeRef.current;
      if (!stroke) return;
      paint(stroke.mode, stroke.last, point, stroke.radius);
      stroke.last = point;
    },
    [paint],
  );

  const endStroke = useCallback(() => {
    if (!strokeRef.current) return;
    strokeRef.current = null;
    commit();
  }, [commit]);

  const beginLasso = useCallback((mode: FogMode, point: Point) => {
    lassoRef.current = { mode, points: [point] };
  }, []);

  const continueLasso = useCallback((point: Point) => {
    lassoRef.current?.points.push(point);
  }, []);

  const endLasso = useCallback(() => {
    const shape = lassoRef.current;
    lassoRef.current = null;
    const ctx = context();
    // A click or a line encloses nothing
    if (!shape || shape.points.length < 3 || !ctx) return;
    fillOutline(ctx, shape.points, shape.mode, mediaRef.current, DM_FOG_COLOR);
    commit();
  }, [commit]);

  const revealAll = useCallback(() => {
    const ctx = context();
    if (!ctx) return;
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    commit();
  }, [commit]);

  const coverAll = useCallback(() => {
    const ctx = context();
    if (!ctx) return;
    fillMask(ctx, DM_FOG_COLOR);
    commit();
  }, [commit]);

  /** Show a mask from history; `from` loses it, `to` gains the current one. */
  const step = useCallback(
    async (from: React.MutableRefObject<string[]>, to: React.MutableRefObject<string[]>) => {
      const ctx = context();
      const target = from.current[from.current.length - 1];
      const current = currentRef.current;
      if (!ctx || !target || !current || strokeRef.current || lassoRef.current) return;
      from.current = from.current.slice(0, -1);
      to.current = [...to.current.slice(-(MAX_HISTORY - 1)), current];
      currentRef.current = target;
      syncHistoryState();
      const mapId = mapIdRef.current;
      try {
        const image = await loadImage(target);
        if (mapIdRef.current !== mapId) return; // the map changed while decoding
        drawSnapshot(ctx, image, DM_FOG_COLOR);
        if (mapId) window.electronAPI?.sendFogSnapshot({ mapId, dataUrl: target, persist: true });
      } catch (err) {
        console.error('Could not restore that fog step.', err);
      }
    },
    [],
  );

  // Behind any snapshot still encoding, so a step always starts from the latest change
  const undo = useCallback(() => enqueue(() => step(undoRef, redoRef)), [enqueue, step]);
  const redo = useCallback(() => enqueue(() => step(redoRef, undoRef)), [enqueue, step]);

  return {
    canvasRef,
    initialize,
    beginStroke,
    continueStroke,
    endStroke,
    beginLasso,
    continueLasso,
    endLasso,
    revealAll,
    coverAll,
    undo,
    redo,
    canUndo: history.canUndo,
    canRedo: history.canRedo,
    whenIdle,
  };
}

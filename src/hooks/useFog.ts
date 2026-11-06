// The DM window's fog of war: the mask canvas and painting it. Undo, redo and
// keeping the player screen in sync are useLayerHistory's.
//
// Sync model: strokes are painted locally only. When a stroke ends the whole
// mask is encoded once and sent as a snapshot, which the main process relays
// to the player screen and saves to disk. Players never watch the brush move:
// a room the DM reveals in one drag appears all at once when the mouse is
// released, and the encode happens exactly once per stroke.
//
// A lasso (freehand outline) only collects points while the mouse moves; the
// inside is filled once on release and published like a stroke.

import { useCallback, useRef } from 'react';
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
import { useLayerHistory } from './useLayerHistory';

/** Mask colour in the DM window: a deep indigo, so fog never blends into dark maps. */
export const DM_FOG_COLOR = '#1d1a2e';

export interface Fog {
  canvasRef: React.RefObject<HTMLCanvasElement>;
  /** Size the mask for a newly loaded map and show its saved fog (or full fog). */
  initialize: (mapId: string, media: Size, savedMask: string | null) => Promise<void>;
  /** No map loaded any more: free the mask and its history, and clear the player's copy. */
  release: () => void;
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
  const mediaRef = useRef<Size>({ w: 0, h: 0 });
  const strokeRef = useRef<{ mode: FogMode; last: Point; radius: number } | null>(null);
  const lassoRef = useRef<{ mode: FogMode; points: Point[] } | null>(null);

  const context = () => canvasRef.current?.getContext('2d') ?? null;

  const history = useLayerHistory({
    // A fog state is never empty: the mask always exists
    send: (mapId, state, persist) => {
      if (state) window.electronAPI?.sendFogSnapshot({ mapId, dataUrl: state, persist });
    },
    show: async (state, stillCurrent) => {
      if (!state) return;
      const image = await loadImage(state);
      const ctx = context();
      if (ctx && stillCurrent()) drawSnapshot(ctx, image, DM_FOG_COLOR);
    },
    busy: () => !!strokeRef.current || !!lassoRef.current,
  });
  const { start, adopt, commit, release: releaseHistory } = history;

  /** Send the mask as it is now; encoded in the background. */
  const publish = useCallback(() => {
    const canvas = canvasRef.current;
    if (canvas) commit(encodeMask(canvas));
  }, [commit]);

  const initialize = useCallback(
    async (mapId: string, media: Size, savedMask: string | null) => {
      const canvas = canvasRef.current;
      const ctx = context();
      if (!canvas || !ctx) return;
      const isLatest = start(mapId);
      mediaRef.current = media;
      strokeRef.current = null;
      lassoRef.current = null;
      const size = fogMaskSize(media);
      canvas.width = size.width;
      canvas.height = size.height;
      let restored = false;
      if (savedMask) {
        try {
          const image = await loadImage(savedMask);
          // Another map started loading while this mask decoded: it owns the canvas now
          if (!isLatest()) return;
          drawSnapshot(ctx, image, DM_FOG_COLOR);
          restored = true;
        } catch (err) {
          if (!isLatest()) return;
          console.error('Saved fog is unreadable; starting fully fogged instead.', err);
        }
      }
      if (!restored) fillMask(ctx, DM_FOG_COLOR);
      window.electronAPI?.sendFogReset();
      if (restored && savedMask) {
        // Already saved: relay the mask as loaded, without encoding it again
        window.electronAPI?.sendFogSnapshot({ mapId, dataUrl: savedMask, persist: false });
        adopt(savedMask);
      } else {
        // A freshly fogged map has nothing on disk yet, so save it (not an undo step)
        commit(encodeMask(canvas), false);
      }
    },
    [start, adopt, commit],
  );

  const release = useCallback(() => {
    releaseHistory();
    strokeRef.current = null;
    lassoRef.current = null;
    const canvas = canvasRef.current;
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
    window.electronAPI?.sendFogReset();
  }, [releaseHistory]);

  /** Paint one segment in the DM window only. */
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
    publish();
  }, [publish]);

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
    publish();
  }, [publish]);

  const revealAll = useCallback(() => {
    const ctx = context();
    if (!ctx) return;
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    publish();
  }, [publish]);

  const coverAll = useCallback(() => {
    const ctx = context();
    if (!ctx) return;
    fillMask(ctx, DM_FOG_COLOR);
    publish();
  }, [publish]);

  return {
    canvasRef,
    initialize,
    release,
    beginStroke,
    continueStroke,
    endStroke,
    beginLasso,
    continueLasso,
    endLasso,
    revealAll,
    coverAll,
    undo: history.undo,
    redo: history.redo,
    canUndo: history.canUndo,
    canRedo: history.canRedo,
    whenIdle: history.whenIdle,
  };
}

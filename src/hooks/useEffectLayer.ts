// The DM window's painted effect layer (fire, poison, magic): the canvases and
// painting them. Undo, redo and keeping the player screen in sync are
// useLayerHistory's, as for the fog: when a change is finished the layer is
// encoded once in the background and sent as a snapshot, which the main
// process relays to the player screen and saves. The player screen only gets
// that snapshot, not the stroke: the soft edges are only known once it is baked.
//
// The layer costs nothing until it's used: its canvas stays 0×0 until the
// first stroke on a map, and is freed again when the map is switched or the
// layer is cleared. An empty layer's state is null.

import { useCallback, useRef } from 'react';
import type { EffectKind, Point } from '../types/map';
import type { Size } from '../lib/geometry';
import { encodeMask, loadImage } from '../lib/fog';
import {
  EFFECT_STYLES,
  bakeStroke,
  drawScratchSegment,
  effectMaskSize,
  showLayer,
  type Box,
  edgeSoftness,
} from '../lib/effects';
import { useLayerHistory } from './useLayerHistory';

/** Preview colour of an erase stroke while it is being drawn */
const ERASE_PREVIEW_COLOR = '#f2ece4';

export interface EffectLayer {
  canvasRef: React.RefObject<HTMLCanvasElement>;
  /** Hard-edged preview of the stroke being drawn */
  scratchRef: React.RefObject<HTMLCanvasElement>;
  /** Show a newly loaded map's saved layer (or nothing). */
  initialize: (mapId: string, media: Size, saved: string | null) => Promise<void>;
  /** No map loaded any more: free the layer and clear the player's copy. */
  release: () => void;
  /** Start painting `kind`, or erasing when `kind` is null. Point and radius in map pixels. */
  beginStroke: (kind: EffectKind | null, point: Point, radius: number) => void;
  continueStroke: (point: Point) => void;
  endStroke: () => void;
  clear: () => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  isEmpty: boolean;
  /** Resolves once every change so far has been encoded and sent. */
  whenIdle: () => Promise<void>;
}

export function useEffectLayer(): EffectLayer {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scratchRef = useRef<HTMLCanvasElement>(null);
  const mediaRef = useRef<Size>({ w: 0, h: 0 });
  const strokeRef = useRef<{ kind: EffectKind | null; last: Point; radius: number; box: Box } | null>(null);

  const send = (mapId: string, dataUrl: string | null, persist: boolean) =>
    window.electronAPI?.sendEffectsSnapshot({ mapId, dataUrl, persist });

  const history = useLayerHistory({
    send,
    show: async (state, stillCurrent) => {
      const image = state ? await loadImage(state) : null;
      const canvas = canvasRef.current;
      if (canvas && stillCurrent()) showLayer(canvas, image);
    },
    busy: () => !!strokeRef.current,
  });
  const { start, adopt, commit, release: releaseHistory, mapId: currentMapId } = history;

  const initialize = useCallback(
    async (mapId: string, media: Size, saved: string | null) => {
      const isLatest = start(mapId);
      mediaRef.current = media;
      strokeRef.current = null;
      if (scratchRef.current) showLayer(scratchRef.current, null);
      let shown: string | null = null;
      try {
        const image = saved ? await loadImage(saved) : null;
        // Another map started loading while this layer decoded: it owns the layer now
        if (!isLatest()) return;
        if (canvasRef.current) showLayer(canvasRef.current, image);
        shown = saved;
      } catch (err) {
        if (!isLatest()) return;
        console.error('Saved effects are unreadable; starting without them.', err);
        if (canvasRef.current) showLayer(canvasRef.current, null);
      }
      adopt(shown);
      // Already saved: only relayed
      send(mapId, shown, false);
    },
    [start, adopt],
  );

  const release = useCallback(() => {
    const mapId = currentMapId();
    releaseHistory();
    strokeRef.current = null;
    if (canvasRef.current) showLayer(canvasRef.current, null);
    if (scratchRef.current) showLayer(scratchRef.current, null);
    if (mapId) send(mapId, null, false);
  }, [currentMapId, releaseHistory]);

  /** Map pixels → layer pixels. */
  const toLayer = (point: Point): Point => {
    const canvas = scratchRef.current;
    const media = mediaRef.current;
    if (!canvas || !media.w) return point;
    return { x: (point.x * canvas.width) / media.w, y: (point.y * canvas.height) / media.h };
  };

  const segment = (from: Point, to: Point) => {
    const stroke = strokeRef.current;
    const ctx = scratchRef.current?.getContext('2d');
    if (!stroke || !ctx) return;
    const color = stroke.kind ? EFFECT_STYLES[stroke.kind].color : ERASE_PREVIEW_COLOR;
    drawScratchSegment(ctx, toLayer(from), toLayer(to), stroke.radius, color, stroke.box);
  };

  const beginStroke = useCallback(
    (kind: EffectKind | null, point: Point, radius: number) => {
      const canvas = canvasRef.current;
      const scratch = scratchRef.current;
      const media = mediaRef.current;
      if (!canvas || !scratch || !currentMapId() || !media.w || strokeRef.current) return;
      // Nothing to erase on an empty layer (a 0×0 canvas)
      if (!kind && canvas.width === 0) return;
      const size = effectMaskSize(media);
      // Allocate on first use
      if (canvas.width === 0) {
        canvas.width = size.width;
        canvas.height = size.height;
      }
      scratch.width = size.width;
      scratch.height = size.height;
      strokeRef.current = {
        kind,
        last: point,
        radius: (radius * size.width) / media.w,
        box: { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity },
      };
      segment(point, { x: point.x + 0.01, y: point.y + 0.01 });
    },
    [currentMapId], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const continueStroke = useCallback((point: Point) => {
    const stroke = strokeRef.current;
    if (!stroke) return;
    segment(stroke.last, point);
    stroke.last = point;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const endStroke = useCallback(() => {
    const stroke = strokeRef.current;
    const canvas = canvasRef.current;
    const scratch = scratchRef.current;
    strokeRef.current = null;
    if (!stroke || !canvas || !scratch) return;
    const ctx = canvas.getContext('2d');
    if (ctx) bakeStroke(ctx, scratch, stroke.kind, stroke.box, edgeSoftness(stroke.radius));
    showLayer(scratch, null);
    // Encoded in the background, like the fog: the window doesn't freeze on release
    commit(encodeMask(canvas));
  }, [commit]);

  const clear = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || canvas.width === 0 || strokeRef.current) return;
    showLayer(canvas, null);
    commit(null);
  }, [commit]);

  return {
    canvasRef,
    scratchRef,
    initialize,
    release,
    beginStroke,
    continueStroke,
    endStroke,
    clear,
    undo: history.undo,
    redo: history.redo,
    canUndo: history.canUndo,
    canRedo: history.canRedo,
    isEmpty: history.isEmpty,
    whenIdle: history.whenIdle,
  };
}

// The DM window's painted effect layer (fire, poison, magic): painting,
// clearing, undo/redo, and keeping the player screen in sync.
//
// Same model as useFog: when a change is finished the layer is encoded once
// and sent as a snapshot, which the main process relays to the player screen
// and saves. Unlike fog, the player screen only gets that snapshot, not the
// individual segments: the soft edges are only known once the stroke is baked.
//
// The layer costs nothing until it's used: its canvas stays 0×0 until the
// first stroke on a map, and is freed again when the map is switched or the
// layer is cleared. History entries are PNG data URLs, null for "empty".

import { useCallback, useRef, useState } from 'react';
import type { EffectKind, Point } from '../types/map';
import type { Size } from '../lib/geometry';
import { loadImage } from '../lib/fog';
import {
  EFFECT_STYLES,
  bakeStroke,
  drawScratchSegment,
  effectMaskSize,
  showLayer,
  type Box,
  edgeSoftness,
} from '../lib/effects';

const MAX_HISTORY = 20;
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
}

export function useEffectLayer(): EffectLayer {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scratchRef = useRef<HTMLCanvasElement>(null);
  const mapIdRef = useRef<string | null>(null);
  const mediaRef = useRef<Size>({ w: 0, h: 0 });
  const strokeRef = useRef<{ kind: EffectKind | null; last: Point; radius: number; box: Box } | null>(null);
  const currentRef = useRef<string | null>(null);
  const undoRef = useRef<(string | null)[]>([]);
  const redoRef = useRef<(string | null)[]>([]);
  // Bumped whenever the shown layer changes, so a late decode can't overwrite it
  const versionRef = useRef(0);
  // Counts initialize calls, so one that is overtaken while decoding stops
  const initializeRunRef = useRef(0);
  const [status, setStatus] = useState({ canUndo: false, canRedo: false, isEmpty: true });

  const syncStatus = () =>
    setStatus({
      canUndo: undoRef.current.length > 0,
      canRedo: redoRef.current.length > 0,
      isEmpty: currentRef.current === null,
    });

  const send = (dataUrl: string | null, persist: boolean) => {
    const mapId = mapIdRef.current;
    if (mapId) window.electronAPI?.sendEffectsSnapshot({ mapId, dataUrl, persist });
  };

  /** Make the layer the next state, keeping the previous one for undo. */
  const commit = useCallback((next: string | null) => {
    undoRef.current = [...undoRef.current.slice(-(MAX_HISTORY - 1)), currentRef.current];
    redoRef.current = [];
    currentRef.current = next;
    send(next, true);
    syncStatus();
  }, []);

  /** Show a history state on the canvas (decoding it if needed). */
  const show = useCallback(async (dataUrl: string | null) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const version = ++versionRef.current;
    if (!dataUrl) {
      showLayer(canvas, null);
      return;
    }
    const image = await loadImage(dataUrl);
    if (version === versionRef.current) showLayer(canvas, image);
  }, []);

  const initialize = useCallback(
    async (mapId: string, media: Size, saved: string | null) => {
      mapIdRef.current = mapId;
      mediaRef.current = media;
      strokeRef.current = null;
      undoRef.current = [];
      redoRef.current = [];
      currentRef.current = null;
      if (scratchRef.current) showLayer(scratchRef.current, null);
      const run = ++initializeRunRef.current;
      try {
        await show(saved);
        // Another map started loading while this layer decoded: it owns the layer now
        if (run !== initializeRunRef.current) return;
        currentRef.current = saved;
      } catch (err) {
        if (run !== initializeRunRef.current) return;
        console.error('Saved effects are unreadable; starting without them.', err);
        await show(null);
      }
      send(currentRef.current, false);
      syncStatus();
    },
    [show],
  );

  const release = useCallback(() => {
    versionRef.current += 1;
    initializeRunRef.current += 1;
    if (canvasRef.current) showLayer(canvasRef.current, null);
    if (scratchRef.current) showLayer(scratchRef.current, null);
    send(null, false);
    mapIdRef.current = null;
    strokeRef.current = null;
    undoRef.current = [];
    redoRef.current = [];
    currentRef.current = null;
    syncStatus();
  }, []);

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

  const beginStroke = useCallback((kind: EffectKind | null, point: Point, radius: number) => {
    const canvas = canvasRef.current;
    const scratch = scratchRef.current;
    const media = mediaRef.current;
    if (!canvas || !scratch || !mapIdRef.current || !media.w || strokeRef.current) return;
    // Nothing to erase on an empty layer
    if (!kind && currentRef.current === null) return;
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
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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
    versionRef.current += 1;
    commit(canvas.toDataURL());
  }, [commit]);

  const clear = useCallback(() => {
    if (currentRef.current === null || strokeRef.current) return;
    versionRef.current += 1;
    if (canvasRef.current) showLayer(canvasRef.current, null);
    commit(null);
  }, [commit]);

  const step = useCallback(
    async (
      from: React.MutableRefObject<(string | null)[]>,
      to: React.MutableRefObject<(string | null)[]>,
    ) => {
      if (from.current.length === 0 || strokeRef.current) return;
      const target = from.current[from.current.length - 1];
      from.current = from.current.slice(0, -1);
      to.current = [...to.current.slice(-(MAX_HISTORY - 1)), currentRef.current];
      currentRef.current = target;
      syncStatus();
      send(target, true);
      try {
        await show(target);
      } catch (err) {
        console.error('Could not restore that effects step.', err);
      }
    },
    [show],
  );

  const undo = useCallback(() => void step(undoRef, redoRef), [step]);
  const redo = useCallback(() => void step(redoRef, undoRef), [step]);

  return {
    canvasRef,
    scratchRef,
    initialize,
    release,
    beginStroke,
    continueStroke,
    endStroke,
    clear,
    undo,
    redo,
    canUndo: status.canUndo,
    canRedo: status.canRedo,
    isEmpty: status.isEmpty,
  };
}

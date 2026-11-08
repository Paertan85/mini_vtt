// What the fog and the painted effects share: a map layer whose states are
// PNG data URLs (null: an empty layer), with undo and redo, and every finished
// change sent once to the main process, which relays it to the player screen
// and saves it.
//
// A change is encoded in the background, so the window doesn't freeze when the
// mouse is released. Encoded changes and undo/redo steps wait their turn in one
// queue, so they apply in the order they happened, and `whenIdle` tells when
// everything so far has been sent.
//
// Undo needs no extra work: the state before a change is the one encoded at
// the end of the change before it.

import { useCallback, useRef, useState } from 'react';

const MAX_HISTORY = 20;

/** An encoded layer: a PNG data URL, or null for an empty layer. */
export type LayerState = string | null;

export interface LayerHistoryOptions {
  /** Hand a state to the main process: relayed to players, and saved when `persist` is set. */
  send: (mapId: string, state: LayerState, persist: boolean) => void;
  /**
   * Show a state from the history on the canvas, decoding it first; draw
   * only if `stillCurrent()` holds once it is decoded (no other map loaded, no
   * stroke begun).
   */
  show: (state: LayerState, stillCurrent: () => boolean) => Promise<void>;
  /** Whether a stroke is under way; undo and redo do nothing then. */
  busy: () => boolean;
}

export interface LayerHistory {
  /** A map was loaded into the layer: an empty history. Returns whether this is still the latest load. */
  start: (mapId: string) => () => boolean;
  /** The state the layer shows now, as loaded: no undo step, nothing sent. */
  adopt: (state: LayerState) => void;
  /**
   * A finished change, perhaps still encoding: sent and saved, and, unless
   * `record` is false, the previous state becomes an undo step.
   */
  commit: (state: LayerState | Promise<LayerState>, record?: boolean) => void;
  undo: () => void;
  redo: () => void;
  /** No map any more: an empty history. Changes still encoding are saved for their own map. */
  release: () => void;
  /** Resolves once every change so far has been encoded and sent. */
  whenIdle: () => Promise<void>;
  /** The map whose layer this is, or null. */
  mapId: () => string | null;
  canUndo: boolean;
  canRedo: boolean;
  /** Whether the layer is empty, as of the last change sent */
  isEmpty: boolean;
}

export function useLayerHistory(options: LayerHistoryOptions): LayerHistory {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const mapIdRef = useRef<string | null>(null);
  // Bumped by every start and release, so work for an earlier map leaves this one alone
  const runRef = useRef(0);
  const currentRef = useRef<LayerState>(null);
  const undoRef = useRef<LayerState[]>([]);
  const redoRef = useRef<LayerState[]>([]);
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const [status, setStatus] = useState({ canUndo: false, canRedo: false, isEmpty: true });

  const sync = useCallback(
    () =>
      setStatus({
        canUndo: undoRef.current.length > 0,
        canRedo: redoRef.current.length > 0,
        isEmpty: currentRef.current === null,
      }),
    [],
  );

  const enqueue = useCallback((task: () => Promise<void> | void) => {
    queueRef.current = queueRef.current
      .then(task)
      .catch((err) => console.error('Could not update the layer.', err));
  }, []);

  const reset = useCallback(
    (mapId: string | null) => {
      const run = ++runRef.current;
      mapIdRef.current = mapId;
      currentRef.current = null;
      undoRef.current = [];
      redoRef.current = [];
      sync();
      return run;
    },
    [sync],
  );

  const start = useCallback(
    (mapId: string) => {
      const run = reset(mapId);
      return () => run === runRef.current;
    },
    [reset],
  );

  const release = useCallback(() => void reset(null), [reset]);

  const adopt = useCallback(
    (state: LayerState) => {
      currentRef.current = state;
      sync();
    },
    [sync],
  );

  const commit = useCallback(
    (state: LayerState | Promise<LayerState>, record = true) => {
      const mapId = mapIdRef.current;
      const run = runRef.current;
      if (!mapId) return;
      enqueue(async () => {
        const encoded = await state;
        // Saved even when another map has been loaded since: it belongs to this one
        optionsRef.current.send(mapId, encoded, true);
        if (run !== runRef.current) return;
        if (record) {
          undoRef.current = [...undoRef.current.slice(-(MAX_HISTORY - 1)), currentRef.current];
          redoRef.current = [];
        }
        currentRef.current = encoded;
        sync();
      });
    },
    [enqueue, sync],
  );

  /** Show a state from history; `from` loses it, `to` gains the current one. */
  const step = useCallback(
    (from: React.RefObject<LayerState[]>, to: React.RefObject<LayerState[]>) =>
      enqueue(async () => {
        const mapId = mapIdRef.current;
        if (!mapId || from.current.length === 0 || optionsRef.current.busy()) return;
        const run = runRef.current;
        const target = from.current[from.current.length - 1];
        from.current = from.current.slice(0, -1);
        to.current = [...to.current.slice(-(MAX_HISTORY - 1)), currentRef.current];
        currentRef.current = target;
        sync();
        try {
          await optionsRef.current.show(target, () => run === runRef.current && !optionsRef.current.busy());
        } catch (err) {
          console.error('Could not restore that step.', err);
          return;
        }
        if (run === runRef.current) optionsRef.current.send(mapId, target, true);
      }),
    [enqueue, sync],
  );

  // Behind any change still encoding, so a step always starts from the latest one
  const undo = useCallback(() => step(undoRef, redoRef), [step]);
  const redo = useCallback(() => step(redoRef, undoRef), [step]);
  const whenIdle = useCallback(() => queueRef.current, []);
  const mapId = useCallback(() => mapIdRef.current, []);

  return {
    start,
    adopt,
    commit,
    undo,
    redo,
    release,
    whenIdle,
    mapId,
    canUndo: status.canUndo,
    canRedo: status.canRedo,
    isEmpty: status.isEmpty,
  };
}

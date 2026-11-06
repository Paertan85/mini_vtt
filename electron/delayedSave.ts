// Saving a map's fog mask or effect layer a short while after it changes.
//
// The DM window sends a snapshot after every change. Saving it after a short
// pause turns a burst of strokes into one write. A waiting save is written
// (never dropped) when another map's snapshot arrives, and whenever a caller
// flushes: before the map's layer is read back, the map is removed, the
// library is exported, or the app quits.
//
// Saves run one after another, and a save being written still counts until it
// is done, so a flush always waits for the file to be complete.

export interface DelayedMapSave<T> {
  /** Save after the delay, replacing a waiting save for the same map. */
  schedule(mapId: string, value: T): void;
  /** Write the waiting save now; resolves once every save so far is on disk. */
  flush(): Promise<void>;
  /** Resolves once this map's latest change is on disk. */
  flushFor(mapId: string): Promise<void>;
  /** Whether a save is waiting or being written. */
  isBusy(): boolean;
}

export function delayedMapSave<T>(
  label: string,
  save: (mapId: string, value: T) => Promise<boolean>,
  delayMs: number,
): DelayedMapSave<T> {
  let pending: { mapId: string; value: T; timer: ReturnType<typeof setTimeout> } | null = null;
  // The saves started so far, in order; resolves when the last is written
  let written: Promise<void> = Promise.resolve();
  let writing = 0;

  const flush = (): Promise<void> => {
    const current = pending;
    if (current) {
      clearTimeout(current.timer);
      pending = null;
      writing += 1;
      written = written.then(async () => {
        try {
          await save(current.mapId, current.value);
        } catch (err) {
          console.error(`Failed to save ${label} for ${current.mapId}:`, err);
        } finally {
          writing -= 1;
        }
      });
    }
    return written;
  };

  return {
    schedule(mapId, value) {
      if (pending && pending.mapId !== mapId) void flush();
      if (pending) clearTimeout(pending.timer);
      pending = { mapId, value, timer: setTimeout(() => void flush(), delayMs) };
    },
    flush,
    // A save of this map may already be on its way: wait for it too
    flushFor: (mapId) => (pending?.mapId === mapId ? flush() : written),
    isBusy: () => pending !== null || writing > 0,
  };
}

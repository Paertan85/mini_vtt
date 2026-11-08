// The DM's settings in the DM window: one object, saved as it changes.

import { useCallback, useState } from 'react';
import type { LibrarySettings } from '../types/map';
import { DEFAULT_SETTINGS, type Preferences } from '../lib/settings';

export interface Settings {
  settings: Preferences;
  /** Change some settings and save them. */
  update: (patch: Partial<Preferences>) => void;
  /** Take the settings as the library has them (on start-up, after an import); nothing is saved. */
  restore: (stored: LibrarySettings) => void;
}

export function useSettings(): Settings {
  const [settings, setSettings] = useState<Preferences>(DEFAULT_SETTINGS);
  const update = useCallback((patch: Partial<Preferences>) => {
    setSettings((current) => ({ ...current, ...patch }));
    void window.electronAPI?.saveSettings(patch);
  }, []);
  const restore = useCallback(
    // Everything but the loaded map and the map order, which useDmController and the library keep
    ({ currentMapId: _current, mapOrder: _order, ...stored }: LibrarySettings) => setSettings(stored),
    [],
  );
  return { settings, update, restore };
}

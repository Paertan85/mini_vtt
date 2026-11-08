// The map loaded in the DM window: its media and the per-map view the DM
// changes (zoom, orientation, grid, fog rooms), held as one object.
//
// Loading and unloading replace the whole object, so no per-map value can be
// left over from the previous map: a new field gets its value from the
// library entry in `loadedFrom`, or the type check fails. The player frame's
// pan, the fog, the effects and the spell areas have their own owners and are
// restored by loadMap in App.tsx.

import { useCallback, useState } from 'react';
import type { FogRoom, MapEntryMeta, MapGrid, MediaType } from '../types/map';
import type { Size } from '../lib/geometry';

export interface LoadedMap {
  /** Library id, or null when no map is loaded */
  id: string | null;
  mediaUrl: string | null;
  mediaType: MediaType;
  /** Natural size of the media; null until it has loaded */
  mediaSize: Size | null;
  /** Player view zoom */
  zoom: number;
  rotation: number;
  mirrorHorizontal: boolean;
  mirrorVertical: boolean;
  grid: MapGrid | null;
  /** Fog rooms marked out on the map; only the DM sees them */
  rooms: FogRoom[];
}

const NO_MAP: LoadedMap = {
  id: null,
  mediaUrl: null,
  mediaType: 'image',
  mediaSize: null,
  zoom: 1,
  rotation: 0,
  mirrorHorizontal: false,
  mirrorVertical: false,
  grid: null,
  rooms: [],
};

/** A library entry, loaded from `mediaUrl`; its size follows once the media has loaded. */
const loadedFrom = (meta: MapEntryMeta, mediaUrl: string): LoadedMap => ({
  id: meta.id,
  mediaUrl,
  mediaType: meta.mediaType,
  mediaSize: null,
  zoom: meta.zoom,
  rotation: meta.rotation,
  mirrorHorizontal: meta.mirrorHorizontal,
  mirrorVertical: meta.mirrorVertical,
  grid: meta.grid,
  rooms: meta.rooms,
});

type Change<T> = T | ((current: T) => T);

export function useLoadedMap() {
  const [map, setMap] = useState<LoadedMap>(NO_MAP);

  const set = useCallback(
    <K extends keyof LoadedMap>(key: K, change: Change<LoadedMap[K]>) =>
      setMap((current) => ({
        ...current,
        [key]:
          typeof change === 'function'
            ? (change as (value: LoadedMap[K]) => LoadedMap[K])(current[key])
            : change,
      })),
    [],
  );

  return {
    map,
    load: useCallback((meta: MapEntryMeta, mediaUrl: string) => setMap(loadedFrom(meta, mediaUrl)), []),
    unload: useCallback(() => setMap(NO_MAP), []),
    setMediaSize: useCallback((size: Size) => set('mediaSize', size), [set]),
    setZoom: useCallback((change: Change<number>) => set('zoom', change), [set]),
    setRotation: useCallback((rotation: number) => set('rotation', rotation), [set]),
    setMirrorHorizontal: useCallback((mirrored: boolean) => set('mirrorHorizontal', mirrored), [set]),
    setMirrorVertical: useCallback((mirrored: boolean) => set('mirrorVertical', mirrored), [set]),
    setGrid: useCallback((grid: MapGrid | null) => set('grid', grid), [set]),
    setRooms: useCallback((change: Change<FogRoom[]>) => set('rooms', change), [set]),
  };
}

// Types shared by the main process, the preload bridge and both windows.

export type MediaType = 'image' | 'video';

/** What a fog stroke does: `reveal` erases fog, `cover` paints it back. */
export type FogMode = 'reveal' | 'cover';

export interface Point {
  x: number;
  y: number;
}

/**
 * Pan offset of the top-left corner of the player viewport, in rotated-map
 * natural coordinates. Persisted per map so reopening restores the framed area.
 */
export type MapPan = Point;

/** Everything the player screen needs to render; pushed from the DM window. */
export interface MapState {
  /** `map-media://` URL of the loaded map, or null when no map is loaded */
  mediaUrl: string | null;
  mediaType: MediaType;
  /** Zoom factor of the player view (1 = one map pixel per screen pixel) */
  zoom: number;
  /** Clockwise rotation in degrees, in 90-degree steps */
  rotation: number;
  mirrorHorizontal: boolean;
  mirrorVertical: boolean;
  /** Fullscreen handout shown over the map, if any */
  handoutUrl: string | null;
  handoutRotation: number;
  /** When true the player screen shows nothing but black */
  blackout: boolean;
}

/** The per-map view settings that are saved and restored. */
export interface MapView {
  zoom: number;
  /** null until the player frame has been positioned for this map */
  pan: MapPan | null;
  rotation: number;
  mirrorHorizontal: boolean;
  mirrorVertical: boolean;
}

/**
 * Library entry metadata. The heavy payloads (media, thumbnail, fog mask) live
 * on disk under the Electron userData directory and are loaded on demand.
 */
export interface MapEntryMeta {
  id: string;
  name: string;
  mediaType: MediaType;
  /** Media dimensions in pixels (0 for video until playback starts) */
  width: number;
  height: number;
  zoom: number;
  pan: MapPan;
  rotation: number;
  mirrorHorizontal: boolean;
  mirrorVertical: boolean;
  /** Whether a fog mask has been saved for this map */
  hasFog: boolean;
  /** Epoch ms when the map was added */
  addedAt: number;
}

export interface HandoutMeta {
  id: string;
  name: string;
  width: number;
  height: number;
  rotation: number;
  addedAt: number;
}

/** App-level settings that are not per map. */
export interface LibrarySettings {
  /** Map loaded in the DM window, or null when none */
  currentMapId: string | null;
  /** Diagonal of the player's physical screen, or null for no grid */
  playerScreenDiagonal: number | null;
  /** Grid cell size, in the same unit as the diagonal */
  gridSize: number;
  /** Custom map order; maps not listed are shown newest first above it */
  mapOrder?: string[];
}

/** The library plus settings, as returned on startup. */
export interface LibrarySnapshot {
  maps: MapEntryMeta[];
  handouts: HandoutMeta[];
  settings: LibrarySettings;
}

/** Result of importing a map. */
export interface AddMapResult {
  entry: MapEntryMeta;
  mediaUrl: string;
  thumbDataUrl: string;
}

/** Result of a batch import: how many files were added and which were skipped. */
export interface ImportResult {
  added: number;
  skipped: string[];
  /** The first map added, so the DM window can load it straight away */
  firstMap: MapEntryMeta | null;
}

/** One painted fog segment, in map natural pixels. */
export interface FogStroke {
  mode: FogMode;
  from: Point;
  to: Point;
  radius: number;
}

/** A full copy of a map's fog mask, as a PNG data URL. */
export interface FogSnapshot {
  mapId: string;
  dataUrl: string;
  /**
   * Whether the main process should save it. False when the snapshot only
   * re-sends a mask that was just loaded from disk.
   */
  persist: boolean;
}

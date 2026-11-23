// Types shared by the main process, the preload bridge and both windows.

import type { FrameColor } from '../lib/frameColors';

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
  /** Red words on black over everything after a kill, or null */
  killScreen: KillScreen | null;
  /** Pictures shown one after another in place of the map, or null */
  slideshow: Slideshow | null;
  /** Spell areas, drawn under the fog */
  areas: DrawnArea[];
  /** The map's grid, drawn under the fog when the DM shows it to players; null: no grid */
  grid: PlayerGrid | null;
  /** The grid the squares each spell area covers are shown on; null: not shown */
  areaGrid: AreaGrid | null;
  /** How strongly the painted effects show (the Effects opacity setting) */
  effectOpacity: number;
  /** How strongly spell areas are filled (the Spell areas opacity setting) */
  areaOpacity: number;
}

/** The kill screen: one of KILL_PHRASES (src/lib/killScreen.ts), turned like a portrait handout. */
export interface KillScreen {
  text: string;
  /** Clockwise: 0, 90, 180 or 270 */
  rotation: number;
}

/**
 * The slideshow on the player screen: pictures from the slideshow folder,
 * shown one after another over the map while the DM gets the next one ready.
 * The pictures are those of one listing of the folder (see SlideshowListing).
 */
export interface Slideshow {
  /** The listing the pictures come from */
  listing: string;
  /** How many pictures it has, at least one */
  count: number;
  /** How long each picture is shown */
  seconds: number;
  /** How pictures taller than wide are turned: 0, 90 or 270, as portrait handouts */
  portraitRotation: number;
}

/**
 * The pictures the main process found in the slideshow folder. They are
 * served by number (see slideshowPictureUrl), so no path leaves it.
 */
export interface SlideshowListing {
  listing: string;
  count: number;
  /** The folder's name, to tell the DM where the pictures come from */
  folderName: string;
}

/** The part of a map's grid the player screen needs to draw it (map natural pixels). */
export type PlayerGrid = Pick<MapGrid, 'cell' | 'offsetX' | 'offsetY'>;

/**
 * What both windows need to work out the squares a spell area covers: the
 * map's grid, and how a circle counts diagonal squares (the Movement setting).
 */
export interface AreaGrid extends PlayerGrid {
  rule: MovementRule;
}

/** An area template as the player screen draws it: map pixels, already converted from feet. */
export interface DrawnArea {
  x: number;
  y: number;
  /** Circle radius, square side, cone or line length, emanation distance */
  radius: number;
  kind: EffectKind;
  shape: AreaShape;
  /** Degrees, map space (0 points along +x); cones and lines */
  angle: number;
  /** Line width; for an emanation, the side of the square it comes from (one grid square) */
  width: number;
}

/** The per-map view settings that are saved and restored. */
export interface MapView {
  zoom: number;
  /** null until the player frame has been positioned for this map */
  pan: MapPan | null;
  rotation: number;
  mirrorHorizontal: boolean;
  mirrorVertical: boolean;
  /** Spell areas placed on this map (saved as `circles`, after the first shape) */
  circles: SpellArea[];
  /** Fog rooms marked out on this map */
  rooms: FogRoom[];
  /** The DM's markers on this map */
  markers: MapMarker[];
}

/** The colours a marker can be. */
export type MarkerColor = 'red' | 'blue' | 'green' | 'yellow';

/**
 * A round marker the DM puts on a map, such as where enemies will appear or
 * where something invisible stands. Only the DM sees it. Map natural pixels,
 * unrotated; on a map with a grid it covers whole squares.
 */
export interface MapMarker {
  id: string;
  x: number;
  y: number;
  radius: number;
  color: MarkerColor;
  /** One capital letter, A to Z, shown large in its middle so the DM knows what it stands for */
  letter?: string;
}

/**
 * A room the DM marked out on a map ahead of time, to reveal (or cover) in one
 * click. Only the DM sees it; players see the fog it changes. An axis-aligned
 * rectangle in map natural pixels, unrotated: rotating or mirroring the map in
 * 90° steps keeps it a rectangle on screen.
 */
export interface FogRoom {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** The DM's name for it, such as "Throne room"; without one it shows its number */
  name?: string;
}

/**
 * The map image's own grid, measured by the DM. All values are in map natural
 * pixels (unrotated), so the calibration survives rotation and mirroring.
 */
export interface MapGrid {
  /** Width of one grid square */
  cell: number;
  /** Position of a grid line, in 0..cell */
  offsetX: number;
  offsetY: number;
  /** Feet one square stands for, usually 5 */
  feetPerCell: number;
}

/** The shapes of spell areas: sphere (circle), cube (square), cone, line/wall and emanation. */
export type AreaShape = 'circle' | 'square' | 'cone' | 'line' | 'emanation';

/**
 * A spell area on the map: a circle, square, cone, line or emanation. The
 * point is the centre of a circle or square, the origin of a cone or line,
 * and the middle of the square an emanation comes from. Saved as
 * it is (`radiusFt` is named for the circle, the first shape).
 */
export interface SpellArea {
  id: string;
  x: number;
  y: number;
  /** Circle radius, square side, cone or line length, emanation distance, in feet */
  radiusFt: number;
  kind: EffectKind;
  shape: AreaShape;
  /** Degrees, map space (0 points along +x); cones and lines */
  angle: number;
  /** Line width in feet */
  widthFt: number;
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
  /** The map's measured grid, or null until it is calibrated */
  grid: MapGrid | null;
  circles: SpellArea[];
  rooms: FogRoom[];
  markers: MapMarker[];
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
  /** Whether the Effects and Spells tools and the spell areas are offered */
  showEffectTools: boolean;
  /** Whether a line at the bottom of the map says how the current tool works */
  showToolHints: boolean;
  /** Whether the welcome screen opens on start-up */
  showWelcome: boolean;
  /** Whether the map and handout library panel is shown */
  showLibrary: boolean;
  /**
   * Rotation given to maps and handouts taller than wide when they are added,
   * so they lie along a landscape player screen: 0 (none), 90 or 270
   */
  portraitRotation: number;
  /** How the Measure tool's Movement ruler counts diagonal squares */
  diagonalRule: MovementRule;
  /** Whether the map's measured grid is drawn on the player screen */
  showGridToPlayers: boolean;
  /** Whether the Measure tool's ruler is also shown on the player screen */
  showRulerToPlayers: boolean;
  /** Whether the player view zoom is locked, so a stray wheel or key can't change it */
  lockZoom: boolean;
  /** Colour of the player view frame in the DM window */
  frameColor: FrameColor;
  /**
   * Whether maps start fully fogged when they are added. Otherwise they start
   * revealed: the main process saves them a fog mask that hides nothing.
   */
  fogNewMaps: boolean;
  /** Whether the grid squares each spell area covers are outlined, in both windows (the Spells tool's Squares) */
  showAreaSquares: boolean;
  /** How strongly markers are filled, 0.1 to 1 (DM window only) */
  markerOpacity: number;
  /** How strongly painted effects show, 0.1 to 1, in both windows */
  effectOpacity: number;
  /** How strongly spell areas are filled, 0.1 to 1, in both windows */
  areaOpacity: number;
  /** How long the slideshow shows each picture, in seconds */
  slideshowSeconds: number;
  /**
   * The folder the DM chose for the slideshow; the library's own slideshow
   * folder when not set. Only the main process sets it, from its folder dialog.
   */
  slideshowFolder?: string;
}

/**
 * How the Measure tool counts a diagonal: `alternate` makes every second
 * diagonal square count double (5, 10, 5 ft…), `uniform` counts every square
 * the same, `straight` is the straight-line distance, not counted in squares.
 */
export type DiagonalRule = 'alternate' | 'uniform' | 'straight';

/** The rules that count squares, for the Measure tool's Movement ruler; a setting. */
export type MovementRule = Exclude<DiagonalRule, 'straight'>;

/** The Measure tool's ruler as the player screen draws it: map pixels, and the distance */
export interface RulerState {
  /** The start, any waypoints, and the end; at least two */
  points: Point[];
  feet: number;
}

/** The library plus settings, as returned on startup. */
export interface LibrarySnapshot {
  maps: MapEntryMeta[];
  handouts: HandoutMeta[];
  settings: LibrarySettings;
}

/** Video codecs a WebM map can use. */
export type VideoCodec = 'vp8' | 'vp9' | 'av1';

/** Result of a batch import: how many files were added and which were skipped. */
export interface ImportResult {
  added: number;
  skipped: string[];
  /** The first map added, so the DM window can load it straight away */
  firstMap: MapEntryMeta | null;
}

/** What a project import added to the library. */
export interface ProjectImportSummary {
  maps: number;
  handouts: number;
  /** Entries in the file that were damaged or not a supported format */
  skipped: number;
  /** Spell areas left out: a shape this version doesn't have, damaged, or over the limit */
  areasLeftOut: number;
  /** Spell areas of a kind this version doesn't have, shown as the nearest kind */
  areasRestyled: number;
  /** Maps whose saved fog couldn't be read; they start fully fogged */
  fogLeftOut: number;
  /** Maps whose painted effects couldn't be read */
  effectsLeftOut: number;
  /** Whether the file's player screen settings were adopted (only into an empty library) */
  settingsApplied: boolean;
  /** The first imported map, so the DM window can open it if nothing is loaded */
  firstMap: MapEntryMeta | null;
}

/** Outcome of exporting or importing a project file; null from the API means cancelled. */
export type ProjectResult<T> = ({ ok: true; fileName: string } & T) | { ok: false; error: string };

/** One painted fog segment, in map natural pixels. */
export interface FogStroke {
  mode: FogMode;
  from: Point;
  to: Point;
  radius: number;
}

/** The painted effect colours. */
export type EffectKind = 'fire' | 'poison' | 'magic';

/** A full copy of a map's effect layer; `dataUrl` is null when the layer is empty. */
export interface EffectSnapshot {
  mapId: string;
  dataUrl: string | null;
  /** Whether the main process should save it (false when just restored from disk) */
  persist: boolean;
}

/**
 * Everything a player window needs when it starts (or reloads), as the main
 * process has it: all for the same map. The ruler is not kept; it shows
 * from its next change.
 */
export interface PlayerSync {
  state: MapState | null;
  /** The framed area's top-left corner, once it has been sent for this map */
  pan: Point | null;
  fog: FogSnapshot | null;
  effects: EffectSnapshot | null;
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

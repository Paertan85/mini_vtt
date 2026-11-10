// The DM window's state and what can be done with it, apart from how it is
// laid out (App.tsx). It owns the library and the loaded map's state and wires
// the pieces together: the fog lives in useFog, the painted effects in
// useEffectLayer, the spell areas in useAreas. The keyboard shortcuts are
// handled here too; their keys are in lib/shortcuts.ts.
//
// The window gets it in groups (library, tools, player view…), each the same
// object until one of its values changes and with actions of a fixed identity,
// so memoized parts of the layout skip the renders that dragging the player
// frame or an area causes on every animation frame.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AreaShape,
  EffectKind,
  HandoutMeta,
  ImportResult,
  KillScreen,
  LibrarySnapshot,
  MapEntryMeta,
  MapGrid,
  MapPan,
  MapView,
  MediaType,
  MovementRule,
  Point,
  RulerState,
} from '../types/map';
import { forgetThumb } from '../components/MapLibraryPanel';
import type { FogShape, MapStageProps, Tool, ViewControls } from '../components/MapStage';
import { screenDimensions } from '../components/Dialogs';
import type { Calibration } from '../components/GridCalibrationBar';
import { useFog } from './useFog';
import { useHandlers } from './useHandlers';
import { useEffectLayer } from './useEffectLayer';
import { useSettings } from './useSettings';
import { useAreas } from './useAreas';
import { useLoadedMap } from './useLoadedMap';
import { useRoomEdits } from './useRoomEdits';
import { commandFor, type Command } from '../lib/shortcuts';
import { pickKillPhrase } from '../lib/killScreen';
import {
  clamp,
  clampZoom,
  MAX_ZOOM,
  MIN_ZOOM,
  orientedSize,
  orientedToMap,
  stepZoom,
  type Size,
} from '../lib/geometry';
import { isTypingTarget, keyLabel } from '../lib/platform';
import { smallerVideoSize } from '../lib/video';
import type { FrameColor } from '../lib/frameColors';
import { DEFAULT_FEET_PER_CELL, gridFromCorners } from '../lib/grid';
import { MAX_AREAS, toDrawnAreas } from '../lib/areas';
import { confirmAction, notify, pressedControl, type Anchor } from '../ui/notify';

export const MIN_BRUSH = 10;
export const MAX_BRUSH = 600;
export const BRUSH_STEP = 10;

/** What True scale needs first: the screen size, the player screen open (to know its pixels), or the map's grid. */
export type TrueScaleNeed = 'setup' | 'player' | 'grid';
/** What adding a shape needs first: the map's grid, or room (the map has as many as it can). */
export type ShapesNeed = 'grid' | 'full';

/** A change to a map's orientation, from its menu in the library. */
export interface OrientationChange {
  rotation?: number;
  mirrorHorizontal?: boolean;
  mirrorVertical?: boolean;
}

/** The map library: the maps and handouts, which are selected, and what can be done with them. */
export interface DmLibrary {
  /** Until the library has been read on start-up */
  loading: boolean;
  maps: MapEntryMeta[];
  /** The map loaded in the DM window, or null */
  currentMapId: string | null;
  selectedMapId: string | null;
  selectMap: (id: string) => void;
  loadMap: (id: string) => void;
  /** Loads the map if need be and starts measuring its grid */
  measureMapGrid: (id: string) => void;
  reorderMaps: (ids: string[]) => void;
  renameMap: (id: string, name: string) => void;
  /** Asks first; a loaded map is let go of in both windows before its files go */
  removeMap: (id: string) => void;
  changeOrientation: (id: string, change: OrientationChange) => void;
  /** Opens the file dialog; the first map added is loaded */
  addMaps: () => void;
  dropMaps: (files: File[]) => void;
  handouts: HandoutMeta[];
  selectedHandoutId: string | null;
  selectHandout: (id: string) => void;
  /** Shows the handout on the player screen, or hides it if it is shown */
  toggleHandout: (handout: HandoutMeta) => void;
  rotateHandout: (id: string) => void;
  /** Asks first */
  removeHandout: (id: string) => void;
  addHandouts: () => void;
  dropHandouts: (files: File[]) => void;
}

/** The active tool and its options, and what they do to the loaded map. */
export interface DmTools {
  /** Whether a map is loaded; every tool but View needs one */
  hasMap: boolean;
  tool: Tool;
  /** Leaving the View and Shapes tools drops the selected spell area */
  setTool: (tool: Tool) => void;
  brushSize: number;
  setBrushSize: (size: number) => void;
  /** How the Fog tool draws */
  fogShape: FogShape;
  setFogShape: (shape: FogShape) => void;
  /** The colour painted, and given to new shapes */
  effectKind: EffectKind;
  /** In the Shapes tool, the selected shape takes the colour too */
  setEffectKind: (kind: EffectKind) => void;
  /** Undo and redo apply to the layer of the active tool: effects in the Effects tool, otherwise fog */
  canUndo: boolean;
  canRedo: boolean;
  undo: () => void;
  redo: () => void;
  canClearEffects: boolean;
  clearEffects: () => void;
  /** Asks first */
  revealAll: () => void;
  coverAll: () => void;
  /** Adds a spell area, or starts measuring the grid when the map has none (it follows the save) */
  addArea: (shape: AreaShape) => void;
  shapesNeed: ShapesNeed | null;
  /** The Measure tool measures a straight line instead of movement */
  measureStraight: boolean;
  setMeasureStraight: (straight: boolean) => void;
  /** The loaded map has no grid yet, so distances can't be measured */
  measureNeedsGrid: boolean;
  /** Starts measuring the loaded map's grid */
  measureGrid: () => void;
}

/** The player view: its zoom, and the ways of setting it. */
export interface DmPlayerView {
  zoom: number;
  /** Kept within the zoom range */
  setZoom: (zoom: number) => void;
  /** Locked, the zoom is left alone by the wheel, the keys and the zoom controls */
  zoomLocked: boolean;
  toggleZoomLock: () => void;
  fit16by9: boolean;
  toggleFit16by9: () => void;
  /** Whether the zoom is true scale: the map's squares the size set in Player screen setup */
  atTrueScale: boolean;
  trueScaleNeeds: TrueScaleNeed | null;
  /** Applies true scale, or starts measuring the grid when that is what it needs */
  trueScale: () => void;
}

/** The player screen: whether it is open, and what it shows besides the map. */
export interface DmPlayerScreen {
  playerOpen: boolean;
  /** Opens the player window, or brings it to the front */
  openPlayer: () => void;
  blackout: boolean;
  toggleBlackout: () => void;
  /** The handout players see, or null */
  activeHandoutId: string | null;
  activeHandoutName: string | null;
  hideHandout: () => void;
  /** Whether players see the kill screen (shown and hidden with Ctrl+K) */
  killScreen: boolean;
}

/** The DM's settings that the toolbar and its menu change; saved as they change. */
export interface DmSettings {
  showLibrary: boolean;
  /** Brings the interface back first if it is hidden */
  toggleLibrary: () => void;
  /** Toolbar and panel hidden so the map fills the window; not saved, so the app always starts with them */
  interfaceHidden: boolean;
  toggleInterface: () => void;
  showEffectTools: boolean;
  /** Hiding them also leaves the Effects and Shapes tools */
  toggleEffectTools: () => void;
  showGridToPlayers: boolean;
  toggleGridToPlayers: () => void;
  /** Whether maps start fully fogged when they are added */
  fogNewMaps: boolean;
  toggleFogNewMaps: () => void;
  /** How the Measure tool's Movement ruler counts diagonals */
  movementRule: MovementRule;
  setMovementRule: (rule: MovementRule) => void;
  showRulerToPlayers: boolean;
  setShowRulerToPlayers: (show: boolean) => void;
}

/** Commands for the app as a whole: dialogs, project files and the window. */
export interface DmApp {
  openPlayerSetup: () => void;
  openShortcuts: () => void;
  openWelcome: () => void;
  exportProject: () => void;
  importProject: () => void;
  revealLibraryFolder: () => void;
  toggleFullScreen: () => void;
  /** Sends what is still on its way first */
  reload: () => void;
  toggleDevTools: () => void;
  /** Sends what is still on its way first */
  quit: () => void;
}

/** The dialog that is open, if any, and what the dialogs show and change. */
export interface DmDialogs {
  open: 'welcome' | 'setup' | 'shortcuts' | null;
  close: () => void;
  /** Player screen setup */
  screenDiagonal: number | null;
  gridSize: number;
  portraitRotation: number;
  frameColor: FrameColor;
  viewportSize: Size | null;
  savePlayerSetup: (diagonal: number | null, grid: number, rotation: number, color: FrameColor) => void;
  /** Welcome: whether it opens on start-up */
  showWelcome: boolean;
  setShowWelcome: (show: boolean) => void;
}

/** Measuring the loaded map's grid, while it goes on. */
export interface DmCalibration {
  calibration: Calibration;
  /** The grid the corners and fields give, or null until there are two corners */
  preview: MapGrid | null;
  hasGrid: boolean;
  change: (calibration: Calibration) => void;
  save: () => void;
  remove: () => void;
  cancel: () => void;
}

/** Everything the DM window shows and does. */
export interface DmController {
  library: DmLibrary;
  tools: DmTools;
  playerView: DmPlayerView;
  playerScreen: DmPlayerScreen;
  settings: DmSettings;
  app: DmApp;
  dialogs: DmDialogs;
  /** Null unless the grid is being measured */
  calibration: DmCalibration | null;
  /** The map area: map, fog, player frame, spell areas, ruler (changes with every frame of a drag) */
  stage: MapStageProps;
}

const VIEW_SAVE_DELAY_MS = 400;

/** The arrow keys' directions on screen, for nudging an area. */
const ARROW_DIRECTIONS: Record<string, Point> = {
  ArrowLeft: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
  ArrowUp: { x: 0, y: -1 },
  ArrowDown: { x: 0, y: 1 },
};

/** Pan and fog to apply once the map being loaded has finished loading. */
interface PendingRestore {
  /** The load this belongs to; a newer load replaces it */
  token: number;
  mapId: string;
  name: string;
  mediaType: MediaType;
  /** null: never framed, so centre the player frame */
  pan: MapPan | null;
  fog: string | null;
  effects: string | null;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** Resolves once React has rendered and the browser has painted. */
const afterPaint = () =>
  new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

// Video maps already checked this session: the advice shows once per map
const checkedVideos = new Set<string>();

/** Suggest a smaller copy of a video map this computer can't decode in hardware. */
async function adviseOnVideo(mapId: string, name: string, size: Size) {
  if (checkedVideos.has(mapId)) return;
  checkedVideos.add(mapId);
  const codec = await window.electronAPI?.loadVideoCodec(mapId);
  if (!codec) return;
  const smaller = await smallerVideoSize(codec, size);
  if (!smaller) return;
  notify(
    `“${name}” is a ${size.w} × ${size.h} video, too large for this computer to decode in hardware. ` +
      `It will use a lot of CPU and may stutter on the player screen; a copy at ${smaller.w} × ${smaller.h} ` +
      'plays much more smoothly.',
    'info',
    { durationMs: 15000 },
  );
}

export function useDmController(): DmController {
  const api = window.electronAPI;

  // ─── Library ────────────────────────────────────────────────────────────────
  const [loading, setLoading] = useState(true);
  const [maps, setMaps] = useState<MapEntryMeta[]>([]);
  const [handouts, setHandouts] = useState<HandoutMeta[]>([]);
  const [selectedMapId, setSelectedMapId] = useState<string | null>(null);
  const [selectedHandoutId, setSelectedHandoutId] = useState<string | null>(null);

  // ─── Loaded map ─────────────────────────────────────────────────────────────
  // One object, replaced whole when a map is loaded or unloaded (useLoadedMap)
  const loadedMap = useLoadedMap();
  const {
    id: currentMapId,
    mediaUrl,
    mediaType,
    mediaSize,
    zoom,
    rotation,
    mirrorHorizontal,
    mirrorVertical,
    grid,
    rooms,
  } = loadedMap.map;
  const { setMediaSize, setZoom, setRotation, setMirrorHorizontal, setMirrorVertical, setGrid, setRooms } =
    loadedMap;
  // The player frame, moved once per animation frame while dragged (see applyPan)
  const [pan, setPan] = useState<MapPan | null>(null);

  // ─── Tools ──────────────────────────────────────────────────────────────────
  const [tool, setTool] = useState<Tool>('view');
  const [altHeld, setAltHeld] = useState(false);
  const [shiftHeld, setShiftHeld] = useState(false);
  const [brushSize, setBrushSize] = useState(80);
  const fog = useFog();
  const effects = useEffectLayer();
  const { whenIdle: fogIdle } = fog;
  const { whenIdle: effectsIdle } = effects;
  const [effectKind, setEffectKind] = useState<EffectKind>('fire');
  // Fog tool: brush, freehand lasso, rectangle, or marking out rooms
  const [fogShape, setFogShape] = useState<FogShape>('brush');
  // Measure tool: whether the toolbar picked the straight line instead of
  // movement (counted by the movementRule setting)
  const [measureStraight, setMeasureStraight] = useState(false);

  // ─── Settings (saved as they change) ────────────────────────────────────────
  const { settings, update: updateSettings, restore: restoreSettings } = useSettings();
  const {
    showEffectTools,
    showLibrary,
    showWelcome,
    diagonalRule: movementRule,
    // The ruler can be shown on the player screen too; it is sent as it changes
    showRulerToPlayers,
    // The map's own grid can be drawn on the player screen
    showGridToPlayers,
    // Locks the player view zoom: the wheel, the keys and the toolbar leave it alone
    lockZoom: zoomLocked,
    playerScreenDiagonal: screenDiagonal,
    gridSize,
    // New maps and handouts taller than wide are turned this much (the main process applies it)
    portraitRotation,
    frameColor,
    // Whether maps start fully fogged when added (the main process applies it)
    fogNewMaps,
  } = settings;
  const showRulerRef = useRef(false);
  showRulerRef.current = showRulerToPlayers;
  const rulerRef = useRef<RulerState | null>(null);

  // ─── Spell areas and grid measuring (per map) ───────────────────────────────
  const spellAreas = useAreas(grid, { rotation, mirrorHorizontal, mirrorVertical }, mediaSize);
  const { areas, selectedId: selectedAreaId, select: setSelectedAreaId } = spellAreas;
  const [calibration, setCalibration] = useState<Calibration | null>(null);

  // ─── Fog rooms (per map, part of the loaded map; saved with its view) ────────
  const roomEdits = useRoomEdits(rooms, setRooms);

  // ─── Player screen ──────────────────────────────────────────────────────────
  const [playerOpen, setPlayerOpen] = useState(false);
  const [viewportSize, setViewportSize] = useState<Size | null>(null);
  const [fit16by9, setFit16by9] = useState(false);
  const [blackout, setBlackout] = useState(false);
  const [killScreen, setKillScreen] = useState<KillScreen | null>(null);
  // So the next kill screen says something else
  const lastKillPhraseRef = useRef<string | null>(null);
  const [activeHandout, setActiveHandout] = useState<{ id: string; url: string; rotation: number } | null>(
    null,
  );
  const [dialog, setDialog] = useState<'welcome' | 'setup' | 'shortcuts' | null>(null);

  // Suppresses view saves while a map is being restored, so the restore can't
  // overwrite what it is loading
  const restoringRef = useRef(false);
  const pendingRestoreRef = useRef<PendingRestore | null>(null);
  // Bumped by every load and unload, so only the latest of quick loads applies
  const loadTokenRef = useRef(0);

  const reloadLibrary = useCallback(async () => {
    let snapshot: LibrarySnapshot | null | undefined;
    try {
      snapshot = await api?.loadLibrary();
    } catch (err) {
      // Not an empty library: the index is there but can't be read. Saves
      // fail the same way, so nothing overwrites it.
      console.error('Could not read the library.', err);
      notify(
        'Couldn’t read the library. If another program (a virus scanner or backup) has it open, wait a moment and restart Mini VTT.',
        'error',
      );
      return null;
    }
    if (!snapshot) return null;
    setMaps(snapshot.maps);
    setHandouts(snapshot.handouts);
    return snapshot;
  }, [api]);

  // ─── Player frame (pan) ─────────────────────────────────────────────────────
  //
  // The pan is pushed to the player screen immediately, but React re-renders at
  // most once per animation frame while the frame is being dragged.

  const panRef = useRef<MapPan | null>(null);
  // Frame size (map pixels) the current pan was set for, to keep its centre when zooming
  const frameSizeRef = useRef<Size | null>(null);
  const panFrameRequest = useRef<number | null>(null);

  const applyPan = useCallback(
    (next: MapPan | null, frameSize: Size | null) => {
      panRef.current = next;
      frameSizeRef.current = frameSize;
      if (next) api?.sendViewportPan(next.x, next.y);
      if (panFrameRequest.current === null) {
        panFrameRequest.current = requestAnimationFrame(() => {
          panFrameRequest.current = null;
          setPan(panRef.current);
        });
      }
    },
    [api],
  );

  const frameSize = viewportSize ? { w: viewportSize.w / zoom, h: viewportSize.h / zoom } : null;

  const constrainPan = useCallback(
    (next: MapPan): MapPan => {
      if (!fit16by9 || !mediaSize || !frameSize) return next;
      const map = orientedSize(mediaSize, rotation);
      return {
        x: clamp(next.x, 0, Math.max(0, map.w - frameSize.w)),
        y: clamp(next.y, 0, Math.max(0, map.h - frameSize.h)),
      };
    },
    [fit16by9, mediaSize, frameSize?.w, frameSize?.h, rotation], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // Keep the frame centred on the same spot when the zoom, viewport or map changes
  useEffect(() => {
    if (!mediaSize || !frameSize) return;
    const map = orientedSize(mediaSize, rotation);
    const previous = panRef.current;
    const previousFrame = frameSizeRef.current ?? frameSize;
    const center = previous
      ? { x: previous.x + previousFrame.w / 2, y: previous.y + previousFrame.h / 2 }
      : { x: map.w / 2, y: map.h / 2 };
    applyPan(constrainPan({ x: center.x - frameSize.w / 2, y: center.y - frameSize.h / 2 }), frameSize);
  }, [mediaSize, rotation, frameSize?.w, frameSize?.h, constrainPan, applyPan]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── View persistence ───────────────────────────────────────────────────────

  const saveView = useCallback(
    (id: string, view: MapView) => {
      void api?.saveMapView(id, view);
      // Mirror the save in memory, so switching back restores the latest view
      setMaps((entries) =>
        entries.map((entry) => (entry.id === id ? { ...entry, ...view, pan: view.pan ?? entry.pan } : entry)),
      );
    },
    [api],
  );

  const pendingViewSave = useRef<{ id: string; view: MapView; timer: number } | null>(null);

  const flushViewSave = useCallback(() => {
    const pending = pendingViewSave.current;
    if (!pending) return;
    window.clearTimeout(pending.timer);
    pendingViewSave.current = null;
    saveView(pending.id, pending.view);
  }, [saveView]);

  /**
   * Send everything still on its way: a fog or effects change being encoded
   * and a view change waiting out its delay. Before a map is switched, the library is
   * exported, or the window reloads or quits.
   */
  const settleSaves = useCallback(async () => {
    await Promise.all([fogIdle(), effectsIdle()]);
    flushViewSave();
  }, [fogIdle, effectsIdle, flushViewSave]);

  useEffect(() => {
    if (!currentMapId || restoringRef.current) return;
    const view: MapView = { zoom, pan, rotation, mirrorHorizontal, mirrorVertical, circles: areas, rooms };
    if (pendingViewSave.current) window.clearTimeout(pendingViewSave.current.timer);
    const timer = window.setTimeout(() => {
      pendingViewSave.current = null;
      saveView(currentMapId, view);
    }, VIEW_SAVE_DELAY_MS);
    pendingViewSave.current = { id: currentMapId, view, timer };
  }, [currentMapId, zoom, pan, rotation, mirrorHorizontal, mirrorVertical, areas, rooms, saveView]);

  useEffect(() => {
    window.addEventListener('beforeunload', flushViewSave);
    return () => window.removeEventListener('beforeunload', flushViewSave);
  }, [flushViewSave]);

  useEffect(() => {
    if (!loading) void api?.saveSettings({ currentMapId });
  }, [api, currentMapId, loading]);

  // ─── Loading maps ───────────────────────────────────────────────────────────

  /**
   * The one place a map gets loaded: on startup, from the library, after an
   * import and after deleting the current map. Per-map state is applied
   * together; pan and fog follow once the media has loaded.
   */
  const loadAreas = spellAreas.load;
  const loadMapState = loadedMap.load;
  const loadMap = useCallback(
    async (meta: MapEntryMeta, options: { centerFrame?: boolean } = {}) => {
      const token = ++loadTokenRef.current;
      // The last stroke reaches the disk before this map's fog is read back
      await settleSaves();
      // A map just added has fog saved too, unless it starts fully fogged
      const [url, savedFog, savedEffects] = await Promise.all([
        api?.loadMapMedia(meta.id),
        api?.loadMapFog(meta.id),
        api?.loadMapEffects(meta.id),
      ]);
      // Another map was picked while this one's files were read
      if (token !== loadTokenRef.current) return false;
      if (!url) {
        notify(`Couldn’t find the file for “${meta.name}” in the library folder.`, 'error');
        return false;
      }
      // Saved fog that is damaged (cut short by a crash) is never shown: it
      // would reveal part of the map, so the map starts fully fogged instead
      if (meta.hasFog && !savedFog) {
        notify(
          `The saved fog of “${meta.name}” couldn’t be read, so the map starts fully fogged. Undo can’t bring it back; reveal it again with the Fog tool.`,
          'error',
          { durationMs: 10000 },
        );
      }
      restoringRef.current = true;
      pendingRestoreRef.current = {
        token,
        mapId: meta.id,
        name: meta.name,
        mediaType: meta.mediaType,
        pan: options.centerFrame ? null : meta.pan,
        fog: savedFog ?? null,
        effects: savedEffects ?? null,
      };
      loadMapState(meta, url);
      setSelectedMapId(meta.id);
      loadAreas(meta.circles);
      setCalibration(null);
      return true;
    },
    [api, settleSaves, loadAreas, loadMapState],
  );

  const handleMediaLoad = useCallback(
    async (size: Size) => {
      const restore = pendingRestoreRef.current;
      pendingRestoreRef.current = null;
      if (!restore) return;
      // A saved pan is the frame's top-left corner at the current frame size
      panRef.current = restore.pan;
      frameSizeRef.current = null;
      setPan(restore.pan);
      if (restore.pan) api?.sendViewportPan(restore.pan.x, restore.pan.y);
      setMediaSize(size);
      await fog.initialize(restore.mapId, size, restore.fog);
      await effects.initialize(restore.mapId, size, restore.effects);
      // A newer load started meanwhile; it ends the restore when it is done
      if (restore.token !== loadTokenRef.current) return;
      restoringRef.current = false;
      if (restore.mediaType === 'video') void adviseOnVideo(restore.mapId, restore.name, size);
    },
    [api, fog, effects, setMediaSize],
  );

  const handleMediaError = useCallback(() => {
    pendingRestoreRef.current = null;
    restoringRef.current = false;
    const name = maps.find((entry) => entry.id === currentMapId)?.name ?? 'this map';
    notify(`Couldn’t open “${name}”. The file may be damaged or in an unsupported format.`, 'error');
  }, [maps, currentMapId]);

  // Load the library on start-up and reopen the last map
  const startedRef = useRef(false);
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void (async () => {
      const snapshot = await reloadLibrary();
      if (snapshot) {
        restoreSettings(snapshot.settings);
        if (snapshot.settings.showWelcome) setDialog('welcome');
        const last = snapshot.maps.find((entry) => entry.id === snapshot.settings.currentMapId);
        if (last) await loadMap(last);
      }
      setLoading(false);
    })();
  }, [reloadLibrary, loadMap, restoreSettings]);

  // Actions that wait for a file dialog or a confirmation take the pressed
  // button at their start, so their messages still show beneath it
  const reportImport = (result: ImportResult, kind: 'map' | 'handout', anchor: Anchor | null) => {
    if (result.added > 0) notify(`${plural(result.added, kind)} added`, 'info', { anchor });
    if (result.skipped.length > 0) {
      const what = kind === 'map' ? 'an image or WebM video' : 'an image';
      notify(`Skipped ${result.skipped.join(', ')}: not ${what} Mini VTT can open.`, 'error', { anchor });
    }
  };

  const handleAddMaps = async () => {
    const anchor = pressedControl();
    const result = await api?.importMapsFromDialog();
    if (!result) return;
    reportImport(result, 'map', anchor);
    await reloadLibrary();
    if (result.firstMap) await loadMap(result.firstMap, { centerFrame: true });
  };

  const handleDropFiles = async (files: File[], kind: 'map' | 'handout') => {
    if (!api) return;
    const paths = api.getDroppedFilePaths(files).filter(Boolean);
    if (paths.length === 0) return;
    const result = kind === 'map' ? await api.importMaps(paths) : await api.importHandouts(paths);
    // Dropped files have no button to point at
    reportImport(result, kind, null);
    await reloadLibrary();
    // With no map loaded, the first dropped map is, as with Add maps…
    if (!currentMapId && result.firstMap) await loadMap(result.firstMap, { centerFrame: true });
  };

  const handleLoadMap = (id: string) => {
    const meta = maps.find((entry) => entry.id === id);
    if (meta && id !== currentMapId) void loadMap(meta);
  };

  const handleRenameMap = async (id: string, name: string) => {
    if (await api?.renameMap(id, name)) await reloadLibrary();
    else notify('Couldn’t rename the map.', 'error');
  };

  const handleReorderMaps = async (ids: string[]) => {
    setMaps((entries) => ids.map((id) => entries.find((entry) => entry.id === id)!).filter(Boolean));
    if (!(await api?.reorderMaps(ids))) {
      notify('Couldn’t save the new order.', 'error');
      await reloadLibrary();
    }
  };

  const handleChangeOrientation = (id: string, change: OrientationChange) => {
    if (id === currentMapId) {
      if (change.rotation !== undefined) setRotation(change.rotation);
      if (change.mirrorHorizontal !== undefined) setMirrorHorizontal(change.mirrorHorizontal);
      if (change.mirrorVertical !== undefined) setMirrorVertical(change.mirrorVertical);
      return;
    }
    const meta = maps.find((entry) => entry.id === id);
    if (meta) saveView(id, { ...meta, ...change });
  };

  /** Show no map, in either window. */
  const unloadMap = () => {
    loadTokenRef.current += 1; // a load still reading its files must not apply
    pendingRestoreRef.current = null;
    restoringRef.current = false;
    loadedMap.unload();
    applyPan(null, null);
    fog.release();
    effects.release();
    spellAreas.load([]);
    setCalibration(null);
  };

  const handleRemoveMap = async (id: string) => {
    const meta = maps.find((entry) => entry.id === id);
    if (!meta) return;
    const anchor = pressedControl();
    const confirmed = await confirmAction({
      title: 'Remove map',
      message: `Remove “${meta.name}” from the library? Its fog and framing are deleted too. The original file isn’t affected.`,
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!confirmed) return;
    const wasLoaded = id === currentMapId;
    if (wasLoaded) {
      // Save the latest framing, in case the map can't be removed after all
      flushViewSave();
      // Both windows let go of the map's file first: a video stays open while
      // it is shown, and Windows can't delete an open file
      unloadMap();
      await afterPaint();
    }
    const removed = await api?.removeMap(id).catch(() => false);
    const snapshot = await reloadLibrary();
    if (!removed) {
      notify(
        `Couldn’t remove “${meta.name}”: its file is in use. If another program has it open, close it and try again.`,
        'error',
        { anchor },
      );
      const stillThere = snapshot?.maps.find((entry) => entry.id === id);
      if (wasLoaded && stillThere) await loadMap(stillThere);
      return;
    }
    forgetThumb(id);
    if (id === selectedMapId) setSelectedMapId(null);
    const next = snapshot?.maps[0];
    if (wasLoaded && next) await loadMap(next);
  };

  // ─── Project files ──────────────────────────────────────────────────────────

  const handleExportProject = async () => {
    const anchor = pressedControl();
    // Save the latest fog and framing first, so the file has them
    await settleSaves();
    const result = await api?.exportProject();
    if (!result) return;
    if (!result.ok) {
      notify(result.error, 'error', { anchor });
      return;
    }
    notify(
      `Exported ${plural(result.maps, 'map')} and ${plural(result.handouts, 'handout')} to “${result.fileName}”`,
      'info',
      { anchor },
    );
  };

  const handleImportProject = async () => {
    const anchor = pressedControl();
    const result = await api?.importProject();
    if (!result) return;
    if (!result.ok) {
      notify(result.error, 'error', { anchor });
      return;
    }
    notify(
      `Imported ${plural(result.maps, 'map')} and ${plural(result.handouts, 'handout')} from “${result.fileName}”`,
      'info',
      { anchor },
    );
    // What didn't come across, e.g. from a newer version or a fork of Mini VTT
    const leftOut = [
      result.skipped > 0 &&
        `Skipped ${plural(result.skipped, 'item')} that were damaged or in an unsupported format.`,
      result.areasLeftOut > 0 &&
        `Left out ${plural(result.areasLeftOut, 'spell area')} this version can’t show.`,
      result.areasRestyled > 0 &&
        `${plural(result.areasRestyled, 'spell area')} of a kind this version doesn’t have ${result.areasRestyled === 1 ? 'is' : 'are'} shown in the nearest colour.`,
      result.fogLeftOut > 0 &&
        `The fog of ${plural(result.fogLeftOut, 'map')} couldn’t be read, so ${result.fogLeftOut === 1 ? 'it starts' : 'they start'} fully fogged.`,
      result.effectsLeftOut > 0 &&
        `The painted effects of ${plural(result.effectsLeftOut, 'map')} couldn’t be read.`,
    ].filter(Boolean);
    if (leftOut.length > 0) notify(leftOut.join(' '), 'error', { anchor });
    const snapshot = await reloadLibrary();
    if (snapshot && result.settingsApplied) restoreSettings(snapshot.settings);
    if (!currentMapId && result.firstMap) await loadMap(result.firstMap);
  };

  // ─── Handouts ───────────────────────────────────────────────────────────────

  const handleAddHandouts = async () => {
    const anchor = pressedControl();
    const result = await api?.importHandoutsFromDialog();
    if (!result) return;
    reportImport(result, 'handout', anchor);
    await reloadLibrary();
  };

  const handleToggleHandout = async (handout: HandoutMeta) => {
    if (activeHandout?.id === handout.id) {
      setActiveHandout(null);
      return;
    }
    const url = await api?.loadHandoutMedia(handout.id);
    if (!url) {
      notify(`Couldn’t find the file for “${handout.name}”.`, 'error');
      return;
    }
    setSelectedHandoutId(handout.id);
    setActiveHandout({ id: handout.id, url, rotation: handout.rotation });
  };

  const handleRotateHandout = async (id: string) => {
    const handout = handouts.find((entry) => entry.id === id);
    if (!handout) return;
    const next = (handout.rotation + 90) % 360;
    if (!(await api?.rotateHandout(id, next))) {
      notify('Couldn’t rotate the handout.', 'error');
      return;
    }
    setHandouts((entries) =>
      entries.map((entry) => (entry.id === id ? { ...entry, rotation: next } : entry)),
    );
    setActiveHandout((active) => (active?.id === id ? { ...active, rotation: next } : active));
  };

  const handleRemoveHandout = async (id: string) => {
    const handout = handouts.find((entry) => entry.id === id);
    if (!handout) return;
    const anchor = pressedControl();
    const confirmed = await confirmAction({
      title: 'Remove handout',
      message: `Remove “${handout.name}” from the library? The original file isn’t affected.`,
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!confirmed) return;
    if (!(await api?.removeHandout(id).catch(() => false))) {
      notify(
        `Couldn’t remove “${handout.name}”. If another program has its file open, close it and try again.`,
        'error',
        { anchor },
      );
      return;
    }
    forgetThumb(id);
    setHandouts((entries) => entries.filter((entry) => entry.id !== id));
    setSelectedHandoutId((selected) => (selected === id ? null : selected));
    setActiveHandout((active) => (active?.id === id ? null : active));
  };

  useEffect(() => api?.onHandoutClosed(() => setActiveHandout(null)), [api]);

  // ─── Player window ──────────────────────────────────────────────────────────

  useEffect(() => api?.onViewportSize((w, h) => setViewportSize({ w, h })), [api]);
  // The bare Alt key's release never reaches the page (it would open the
  // hidden menu); the main process says when it happens instead
  useEffect(() => api?.onAltReleased(() => setAltHeld(false)), [api]);
  useEffect(
    () =>
      api?.onPlayerWindowClosed(() => {
        setPlayerOpen(false);
        setViewportSize(null);
        setFit16by9(false);
      }),
    [api],
  );

  // While an area is dragged, players keep the copy from before the drag, so
  // this stays the same object and nothing is sent until it is dropped
  const shownAreas = spellAreas.shownToPlayers;
  const playerAreas = useMemo(() => toDrawnAreas(shownAreas, grid), [shownAreas, grid]);
  // The same object until the grid or the setting changes, so a pan sends nothing new
  const playerGrid = useMemo(
    () =>
      showGridToPlayers && grid ? { cell: grid.cell, offsetX: grid.offsetX, offsetY: grid.offsetY } : null,
    [showGridToPlayers, grid],
  );

  useEffect(() => {
    api?.sendMapState({
      mediaUrl,
      mediaType,
      zoom,
      rotation,
      mirrorHorizontal,
      mirrorVertical,
      handoutUrl: activeHandout?.url ?? null,
      handoutRotation: activeHandout?.rotation ?? 0,
      blackout,
      killScreen,
      areas: playerAreas,
      grid: playerGrid,
    });
  }, [
    killScreen,
    api,
    mediaUrl,
    mediaType,
    zoom,
    rotation,
    mirrorHorizontal,
    mirrorVertical,
    activeHandout,
    blackout,
    playerAreas,
    playerGrid,
  ]);

  // A new random phrase each time, facing the way portrait handouts are turned
  const handleToggleKillScreen = () => {
    if (killScreen) {
      setKillScreen(null);
      return;
    }
    const text = pickKillPhrase(lastKillPhraseRef.current);
    lastKillPhraseRef.current = text;
    setKillScreen({ text, rotation: portraitRotation });
  };

  const handleOpenPlayer = async () => {
    await api?.openPlayerWindow();
    setPlayerOpen(true);
  };

  const handleToggleFit16by9 = async () => {
    if (fit16by9) {
      setFit16by9(false);
      return;
    }
    if (!mediaSize || !viewportSize) return;
    const width = Math.max(640, viewportSize.w);
    const resized = await api?.resizePlayerWindow(width, Math.round((width * 9) / 16));
    if (!resized) return;
    const map = orientedSize(mediaSize, rotation);
    const fitZoom = clampZoom(Math.max(resized.width / map.w, resized.height / map.h));
    const frame = { w: resized.width / fitZoom, h: resized.height / fitZoom };
    setViewportSize({ w: resized.width, h: resized.height });
    setZoom(fitZoom);
    applyPan({ x: Math.max(0, (map.w - frame.w) / 2), y: Math.max(0, (map.h - frame.h) / 2) }, frame);
    setFit16by9(true);
  };

  // True scale: the player view zoom at which the map's own squares come out
  // at the grid square size of Player screen setup on the player screen, so
  // miniatures fit them. Like the frame's grid, it takes the player window to
  // fill the screen.
  const trueScaleFor = (mapGrid: MapGrid | null) =>
    screenDiagonal && viewportSize && mapGrid
      ? (gridSize * viewportSize.w) / (screenDimensions(screenDiagonal, viewportSize).width * mapGrid.cell)
      : null;
  const trueScaleZoom = trueScaleFor(grid);
  // What it needs first, explained beneath the button on a click; a missing
  // grid is measured on the click instead
  const trueScaleNeeds: TrueScaleNeed | null = !screenDiagonal
    ? 'setup'
    : !viewportSize
      ? 'player'
      : !grid
        ? 'grid'
        : null;
  const atTrueScale = trueScaleZoom !== null && Math.abs(zoom / trueScaleZoom - 1) < 1e-3;
  // What to do once the grid being measured is saved: True scale, or add the
  // shape that was asked for. Forgotten when measuring ends without a save.
  const afterGridRef = useRef<'trueScale' | AreaShape | null>(null);
  useEffect(() => {
    if (!calibration) afterGridRef.current = null;
  }, [calibration]);

  const applyTrueScale = (target: number) => {
    const next = clampZoom(target);
    setZoom(next);
    if (next !== target) {
      notify(
        `True scale would need ${Math.round(target * 100)}% zoom for this map, but the player view goes from ${Math.round(MIN_ZOOM * 100)}% to ${Math.round(MAX_ZOOM * 100)}%. It is zoomed as close as it can be.`,
        'error',
      );
    }
  };

  // The note beneath the button explains what is missing; for the grid, its
  // button comes here to start measuring, and true scale follows the save
  const handleTrueScale = () => {
    if (trueScaleNeeds === 'grid') {
      startCalibration();
      afterGridRef.current = 'trueScale';
    } else if (!trueScaleNeeds && trueScaleZoom !== null) applyTrueScale(trueScaleZoom);
  };

  const handleSavePlayerSetup = (
    diagonal: number | null,
    grid: number,
    rotation: number,
    color: FrameColor,
  ) =>
    updateSettings({
      playerScreenDiagonal: diagonal,
      gridSize: grid,
      portraitRotation: rotation,
      frameColor: color,
    });

  const handleRevealAll = async () => {
    const confirmed = await confirmAction({
      title: 'Reveal entire map',
      message: keyLabel('Players will see the whole map straight away. You can undo this with Ctrl+Z.'),
      confirmLabel: 'Reveal map',
      danger: true,
    });
    if (confirmed) fog.revealAll();
  };

  // ─── Grid calibration ───────────────────────────────────────────────────────

  const beginCalibration = (feetPerCell = DEFAULT_FEET_PER_CELL) => {
    setSelectedAreaId(null);
    setCalibration({ points: [], squares: '1', feet: String(feetPerCell) });
  };
  const startCalibration = () => {
    if (mediaUrl) beginCalibration(grid?.feetPerCell);
  };
  // From a map's menu in the library: another map is loaded first
  const handleMeasureMapGrid = async (id: string) => {
    if (id === currentMapId) return startCalibration();
    const meta = maps.find((entry) => entry.id === id);
    if (meta && (await loadMap(meta))) beginCalibration(meta.grid?.feetPerCell);
  };

  const calibrationPreview = calibration
    ? calibration.points.length === 2
      ? gridFromCorners(
          calibration.points[0],
          calibration.points[1],
          parseFloat(calibration.squares),
          parseFloat(calibration.feet),
        )
      : null
    : null;

  const handleCalibrationPoint = (point: Point) =>
    setCalibration((current) =>
      current
        ? { ...current, points: current.points.length >= 2 ? [point] : [...current.points, point] }
        : current,
    );

  const saveGrid = async (next: MapGrid | null) => {
    if (!currentMapId) return;
    if (!(await api?.saveMapGrid(currentMapId, next))) {
      notify('Couldn’t save the grid.', 'error');
      return;
    }
    setGrid(next);
    setMaps((entries) =>
      entries.map((entry) => (entry.id === currentMapId ? { ...entry, grid: next } : entry)),
    );
    const after = next ? afterGridRef.current : null;
    setCalibration(null);
    notify(next ? 'Grid saved for this map' : 'Grid removed from this map');
    if (after === 'trueScale') {
      const target = trueScaleFor(next);
      if (target !== null) applyTrueScale(target);
    } else if (after) addArea(after);
  };

  // ─── Spell areas ────────────────────────────────────────────────────────────

  // What adding a shape needs first, explained beneath the shape's button
  const shapesNeed: ShapesNeed | null = !grid ? 'grid' : areas.length >= MAX_AREAS ? 'full' : null;

  // Without a grid, the note's Measure grid button comes here: the shape is
  // added once the grid is saved
  const handleAddArea = (shape: AreaShape) => {
    if (!grid) {
      startCalibration();
      afterGridRef.current = shape;
    } else addArea(shape);
  };

  /** A new area in the middle of what the players see, or of the map. */
  const addArea = (shape: AreaShape) => {
    if (!mediaSize) return;
    const center =
      pan && frameSize
        ? orientedToMap({ x: pan.x + frameSize.w / 2, y: pan.y + frameSize.h / 2 }, mediaSize, {
            rotation,
            mirrorHorizontal,
            mirrorVertical,
          })
        : { x: mediaSize.w / 2, y: mediaSize.h / 2 };
    // Zoomed in on another part of the map, the DM would not see it appear
    const view = viewControls.current;
    spellAreas.add(shape, view?.placeInView(center) ?? center, effectKind, view?.displayScale ?? 1);
  };

  // The colour picked in the Shapes tool also goes to the selected shape
  const handleEffectKindChange = (kind: EffectKind) => {
    setEffectKind(kind);
    if (tool === 'shapes' && selectedAreaId) spellAreas.recolor(selectedAreaId, kind);
  };

  // Areas can only be edited in the View and Shapes tools: leaving them
  // drops the selection, so Delete can't remove an area that isn't shown
  const changeTool = useCallback(
    (next: Tool) => {
      setTool(next);
      if (next !== 'view' && next !== 'shapes') setSelectedAreaId(null);
    },
    [setSelectedAreaId],
  );

  // Kept in a ref, so a drag re-renders nothing here
  const handleRulerChange = useCallback((ruler: RulerState | null) => {
    if (ruler === rulerRef.current) return;
    rulerRef.current = ruler;
    if (showRulerRef.current) window.electronAPI?.sendRuler(ruler);
  }, []);

  const handleShowRulerToPlayers = (show: boolean) => {
    updateSettings({ showRulerToPlayers: show });
    showRulerRef.current = show;
    api?.sendRuler(show ? rulerRef.current : null);
  };

  const handleToggleZoomLock = () => updateSettings({ lockZoom: !zoomLocked });
  const handleToggleGridToPlayers = () => updateSettings({ showGridToPlayers: !showGridToPlayers });
  const handleToggleFogNewMaps = () => updateSettings({ fogNewMaps: !fogNewMaps });

  const handleMovementRuleChange = (rule: MovementRule) => updateSettings({ diagonalRule: rule });

  const [interfaceHidden, setInterfaceHidden] = useState(false);
  const handleToggleInterface = () => setInterfaceHidden((hidden) => !hidden);

  // With the interface hidden, Ctrl+B brings it back with the panel showing
  const handleToggleLibrary = () => {
    if (!interfaceHidden) updateSettings({ showLibrary: !showLibrary });
    else {
      setInterfaceHidden(false);
      if (!showLibrary) updateSettings({ showLibrary: true });
    }
  };

  const handleToggleEffectTools = () => {
    const next = !showEffectTools;
    updateSettings({ showEffectTools: next });
    if (!next) {
      setSelectedAreaId(null);
      setTool((current) => (current === 'effect' || current === 'shapes' ? 'view' : current));
    }
  };

  // ─── Keyboard ───────────────────────────────────────────────────────────────

  const resizeBrush = useCallback(
    (direction: 1 | -1) => setBrushSize((size) => clamp(size + direction * BRUSH_STEP, MIN_BRUSH, MAX_BRUSH)),
    [],
  );

  // Undo and redo apply to the layer of the active tool
  const history = tool === 'effect' ? effects : fog;
  const viewControls = useRef<ViewControls | null>(null);
  const hasMap = !!mediaUrl;

  /** The Fog tool drawing with `shape`, or back with the brush if it already was (L, R). */
  const toggleFogShape = (shape: FogShape) => {
    if (!hasMap) return false;
    changeTool('fog');
    setFogShape((current) => (current === shape ? 'brush' : shape));
  };

  // What each shortcut does (the keys are in lib/shortcuts.ts). A handler
  // that returns false didn't apply, so the key keeps its usual effect.
  const commands: Record<Command, (event: KeyboardEvent) => boolean | void> = {
    cancel: () => (calibration ? setCalibration(null) : setSelectedAreaId(null)),
    deleteArea: () => !!selectedAreaId && spellAreas.remove(selectedAreaId),
    brushSize: (event) => hasMap && resizeBrush(event.key === ']' ? 1 : -1),
    undo: () => history.undo(),
    redo: () => history.redo(),
    viewZoomIn: () => viewControls.current?.zoomBy(1.25),
    viewZoomOut: () => viewControls.current?.zoomBy(0.8),
    viewFit: () => viewControls.current?.fit(),
    duplicateArea: () => !!selectedAreaId && spellAreas.duplicate(selectedAreaId),
    addMaps: () => void handleAddMaps(),
    toggleLibrary: () => handleToggleLibrary(),
    toggleInterface: () => handleToggleInterface(),
    nudgeArea: (event) =>
      !!selectedAreaId && spellAreas.nudge(selectedAreaId, ARROW_DIRECTIONS[event.key], event.shiftKey),
    // A focused button handles Enter itself
    loadSelectedMap: (event) =>
      !!selectedMapId && !(event.target instanceof HTMLButtonElement) && handleLoadMap(selectedMapId),
    showShortcuts: () => setDialog('shortcuts'),
    zoomIn: () => hasMap && !zoomLocked && setZoom((current) => stepZoom(current, 1)),
    zoomOut: () => hasMap && !zoomLocked && setZoom((current) => stepZoom(current, -1)),
    // A held Space keeps its first toggle (and never scrolls or presses a button)
    toggleZoomLock: (event) => {
      if (!event.repeat) handleToggleZoomLock();
    },
    viewTool: () => changeTool('view'),
    fogTool: () => hasMap && changeTool('fog'),
    lasso: () => toggleFogShape('lasso'),
    rectangle: () => toggleFogShape('rect'),
    effectsTool: () => hasMap && showEffectTools && changeTool('effect'),
    shapesTool: () => hasMap && showEffectTools && changeTool('shapes'),
    measureTool: () => hasMap && changeTool('measure'),
    blackout: () => setBlackout((value) => !value),
    // A held Ctrl+K toggles once
    killScreen: (event) => {
      if (!event.repeat) handleToggleKillScreen();
    },
  };
  // Read by the key listener, which is registered once
  const commandsRef = useRef(commands);
  commandsRef.current = commands;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Shift') setShiftHeld(true);
      // Held Alt moves the player frame from any tool (AltGr reports AltGraph, so typing is unaffected)
      if (event.key === 'Alt') setAltHeld(true);
      if (isTypingTarget(event.target) || document.querySelector('[role="dialog"]')) return;
      const command = commandFor(event);
      if (command && commandsRef.current[command](event) !== false) event.preventDefault();
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === 'Shift') setShiftHeld(false);
      if (event.key === 'Alt') setAltHeld(false);
    };
    const onBlur = () => {
      setShiftHeld(false);
      setAltHeld(false);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  // ─── What the window shows ──────────────────────────────────────────────────

  const libraryActions = useHandlers({
    selectMap: setSelectedMapId,
    loadMap: handleLoadMap,
    measureMapGrid: handleMeasureMapGrid,
    reorderMaps: handleReorderMaps,
    renameMap: handleRenameMap,
    removeMap: handleRemoveMap,
    changeOrientation: handleChangeOrientation,
    addMaps: handleAddMaps,
    dropMaps: (files: File[]) => handleDropFiles(files, 'map'),
    selectHandout: setSelectedHandoutId,
    toggleHandout: handleToggleHandout,
    rotateHandout: handleRotateHandout,
    removeHandout: handleRemoveHandout,
    addHandouts: handleAddHandouts,
    dropHandouts: (files: File[]) => handleDropFiles(files, 'handout'),
  });
  const library = useMemo<DmLibrary>(
    () => ({ loading, maps, currentMapId, selectedMapId, handouts, selectedHandoutId, ...libraryActions }),
    [loading, maps, currentMapId, selectedMapId, handouts, selectedHandoutId, libraryActions],
  );

  const toolActions = useHandlers({
    setTool: changeTool,
    setBrushSize,
    setFogShape,
    setEffectKind: handleEffectKindChange,
    undo: () => history.undo(),
    redo: () => history.redo(),
    clearEffects: () => effects.clear(),
    revealAll: handleRevealAll,
    coverAll: () => fog.coverAll(),
    addArea: handleAddArea,
    setMeasureStraight,
    measureGrid: startCalibration,
  });
  const canUndo = history.canUndo;
  const canRedo = history.canRedo;
  const canClearEffects = !effects.isEmpty;
  const measureNeedsGrid = !grid;
  const tools = useMemo<DmTools>(
    () => ({
      hasMap,
      tool,
      brushSize,
      fogShape,
      effectKind,
      canUndo,
      canRedo,
      canClearEffects,
      shapesNeed,
      measureStraight,
      measureNeedsGrid,
      ...toolActions,
    }),
    [
      hasMap,
      tool,
      brushSize,
      fogShape,
      effectKind,
      canUndo,
      canRedo,
      canClearEffects,
      shapesNeed,
      measureStraight,
      measureNeedsGrid,
      toolActions,
    ],
  );

  const playerViewActions = useHandlers({
    setZoom: (next: number) => setZoom(clampZoom(next)),
    toggleZoomLock: handleToggleZoomLock,
    toggleFit16by9: handleToggleFit16by9,
    trueScale: handleTrueScale,
  });
  const playerView = useMemo<DmPlayerView>(
    () => ({ zoom, zoomLocked, fit16by9, atTrueScale, trueScaleNeeds, ...playerViewActions }),
    [zoom, zoomLocked, fit16by9, atTrueScale, trueScaleNeeds, playerViewActions],
  );

  const playerScreenActions = useHandlers({
    openPlayer: handleOpenPlayer,
    toggleBlackout: () => setBlackout((value) => !value),
    hideHandout: () => setActiveHandout(null),
  });
  const activeHandoutId = activeHandout?.id ?? null;
  const activeHandoutName = handouts.find((entry) => entry.id === activeHandoutId)?.name ?? null;
  const killScreenShown = killScreen !== null;
  const playerScreen = useMemo<DmPlayerScreen>(
    () => ({
      playerOpen,
      blackout,
      activeHandoutId,
      activeHandoutName,
      killScreen: killScreenShown,
      ...playerScreenActions,
    }),
    [playerOpen, blackout, activeHandoutId, activeHandoutName, killScreenShown, playerScreenActions],
  );

  const settingsActions = useHandlers({
    toggleLibrary: handleToggleLibrary,
    toggleInterface: handleToggleInterface,
    toggleEffectTools: handleToggleEffectTools,
    toggleGridToPlayers: handleToggleGridToPlayers,
    toggleFogNewMaps: handleToggleFogNewMaps,
    setMovementRule: handleMovementRuleChange,
    setShowRulerToPlayers: handleShowRulerToPlayers,
  });
  const settingsGroup = useMemo<DmSettings>(
    () => ({
      showLibrary,
      interfaceHidden,
      showEffectTools,
      showGridToPlayers,
      fogNewMaps,
      movementRule,
      showRulerToPlayers,
      ...settingsActions,
    }),
    [
      showLibrary,
      interfaceHidden,
      showEffectTools,
      showGridToPlayers,
      fogNewMaps,
      movementRule,
      showRulerToPlayers,
      settingsActions,
    ],
  );

  // Nothing but actions, so always the same object
  const appCommands: DmApp = useHandlers({
    openPlayerSetup: () => setDialog('setup'),
    openShortcuts: () => setDialog('shortcuts'),
    openWelcome: () => setDialog('welcome'),
    exportProject: () => void handleExportProject(),
    importProject: () => void handleImportProject(),
    revealLibraryFolder: () => void api?.revealLibraryFolder(),
    toggleFullScreen: () => void api?.toggleFullScreen(),
    reload: async () => {
      await settleSaves();
      api?.reloadWindow();
    },
    toggleDevTools: () => api?.toggleDevTools(),
    quit: async () => {
      await settleSaves();
      api?.quitApp();
    },
  });

  const dialogActions = useHandlers({
    close: () => setDialog(null),
    savePlayerSetup: handleSavePlayerSetup,
    setShowWelcome: (show: boolean) => updateSettings({ showWelcome: show }),
  });
  const dialogs = useMemo<DmDialogs>(
    () => ({
      open: dialog,
      screenDiagonal,
      gridSize,
      portraitRotation,
      frameColor,
      viewportSize,
      showWelcome,
      ...dialogActions,
    }),
    [
      dialog,
      screenDiagonal,
      gridSize,
      portraitRotation,
      frameColor,
      viewportSize,
      showWelcome,
      dialogActions,
    ],
  );

  const calibrationActions = useHandlers({
    change: (next: Calibration) => setCalibration(next),
    save: () => {
      if (calibrationPreview) void saveGrid(calibrationPreview);
    },
    remove: () => void saveGrid(null),
    cancel: () => setCalibration(null),
  });
  const calibrationGroup: DmCalibration | null = calibration
    ? { calibration, preview: calibrationPreview, hasGrid: !!grid, ...calibrationActions }
    : null;

  const gridCell =
    screenDiagonal && viewportSize && frameSize
      ? frameSize.w / (screenDimensions(screenDiagonal, viewportSize).width / gridSize)
      : 0;
  const stage: MapStageProps = {
    mediaUrl,
    mediaType,
    mediaSize,
    rotation,
    mirrorHorizontal,
    mirrorVertical,
    onMediaLoad: handleMediaLoad,
    onMediaError: handleMediaError,
    fog,
    effects,
    effectKind,
    tool: altHeld ? 'view' : tool,
    shiftHeld,
    fogShape,
    rooms,
    roomEdits,
    altHeld,
    brushSize,
    onBrushResize: resizeBrush,
    pan,
    viewportSize,
    zoom,
    gridCell,
    constrainPan,
    onPanChange: (next) => applyPan(next, frameSize),
    zoomLocked,
    frameColor,
    onZoomWheel: (factor) => setZoom((current) => clampZoom(current * factor)),
    onZoomPercentStep: (steps) => setZoom((current) => clampZoom((Math.round(current * 100) + steps) / 100)),
    grid,
    diagonalRule: measureStraight ? 'straight' : movementRule,
    onRulerChange: handleRulerChange,
    gridPreview: calibrationPreview,
    areas,
    selectedAreaId,
    areasInteractive:
      showEffectTools && !calibration && !shiftHeld && (altHeld || tool === 'view' || tool === 'shapes'),
    onSelectArea: setSelectedAreaId,
    onAreaDrag: spellAreas.drag,
    onMoveArea: spellAreas.move,
    onResizeArea: spellAreas.resize,
    onSetAreaSize: spellAreas.setSize,
    onSetAreaWidth: spellAreas.setWidth,
    onAimArea: spellAreas.aim,
    onDuplicateArea: spellAreas.duplicate,
    onDeleteArea: spellAreas.remove,
    onRecolorArea: spellAreas.recolor,
    calibrationPoints: calibration?.points ?? null,
    onCalibrationPoint: handleCalibrationPoint,
    viewControls,
  };

  return {
    library,
    tools,
    playerView,
    playerScreen,
    settings: settingsGroup,
    app: appCommands,
    dialogs,
    calibration: calibrationGroup,
    stage,
  };
}

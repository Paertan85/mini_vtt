// The DM window. This component owns the library and the loaded map's state
// and wires the pieces together; the fog lives in useFog, the map area in
// MapStage, and the controls in Toolbar and MapLibraryPanel.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AreaShape,
  AuraCircle,
  EffectKind,
  HandoutMeta,
  ImportResult,
  MapEntryMeta,
  MapGrid,
  MapPan,
  MapView,
  MediaType,
  Point,
} from './types/map';
import { MapLibraryPanel, forgetThumb, type OrientationChange } from './components/MapLibraryPanel';
import { MapStage, type Tool, type ViewControls } from './components/MapStage';
import {
  BRUSH_STEP,
  MAX_BRUSH,
  MIN_BRUSH,
  Toolbar,
  type ShapesNeed,
  type TrueScaleNeed,
} from './components/Toolbar';
import { PlayerSetupDialog, ShortcutsDialog, screenDimensions } from './components/Dialogs';
import { useFog } from './hooks/useFog';
import { useHandlers } from './hooks/useHandlers';
import { useEffectLayer } from './hooks/useEffectLayer';
import { clamp, clampZoom, MAX_ZOOM, MIN_ZOOM, orientedSize, stepZoom, type Size } from './lib/geometry';
import { keyLabel } from './lib/platform';
import { smallerVideoSize } from './lib/video';
import {
  clampRadius,
  DEFAULT_AREA_FT,
  DEFAULT_FEET_PER_CELL,
  DEFAULT_LINE_WIDTH_FT,
  gridFromCorners,
  MAX_CIRCLES,
  newCircleId,
  pixelsToFeet,
  toDiscs,
} from './lib/grid';
import { GridCalibrationBar, type Calibration } from './components/GridCalibrationBar';
import { Button } from './ui/controls';
import { NotificationHost, confirmAction, notify, pressedControl, type Anchor } from './ui/notify';

const VIEW_SAVE_DELAY_MS = 400;
/** A square turned within this many degrees of the grid settles onto it. */
const SQUARE_SNAP_DEG = 5;

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

/** True when a key press should go to a text field or dialog rather than a shortcut. */
const isTypingTarget = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));

export function App() {
  const api = window.electronAPI;

  // ─── Library ────────────────────────────────────────────────────────────────
  const [loading, setLoading] = useState(true);
  const [maps, setMaps] = useState<MapEntryMeta[]>([]);
  const [handouts, setHandouts] = useState<HandoutMeta[]>([]);
  const [selectedMapId, setSelectedMapId] = useState<string | null>(null);
  const [selectedHandoutId, setSelectedHandoutId] = useState<string | null>(null);

  // ─── Loaded map ─────────────────────────────────────────────────────────────
  const [currentMapId, setCurrentMapId] = useState<string | null>(null);
  const [mediaUrl, setMediaUrl] = useState<string | null>(null);
  const [mediaType, setMediaType] = useState<MediaType>('image');
  const [mediaSize, setMediaSize] = useState<Size | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<MapPan | null>(null);
  const [rotation, setRotation] = useState(0);
  const [mirrorHorizontal, setMirrorHorizontal] = useState(false);
  const [mirrorVertical, setMirrorVertical] = useState(false);

  // ─── Tools ──────────────────────────────────────────────────────────────────
  const [tool, setTool] = useState<Tool>('view');
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [shiftHeld, setShiftHeld] = useState(false);
  const [brushSize, setBrushSize] = useState(80);
  const fog = useFog();
  const fogIdle = fog.whenIdle;
  const effects = useEffectLayer();
  const [effectKind, setEffectKind] = useState<EffectKind>('fire');
  const [showEffectTools, setShowEffectTools] = useState(true);
  const [showLibrary, setShowLibrary] = useState(true);
  // Fog tool: freehand shapes instead of the brush
  const [fogLasso, setFogLasso] = useState(false);

  // ─── Grid and circles (per map) ─────────────────────────────────────────────
  const [grid, setGrid] = useState<MapGrid | null>(null);
  const [circles, setCircles] = useState<AuraCircle[]>([]);
  // While the DM drags a circle, players keep seeing it where it was
  const [playerCircles, setPlayerCircles] = useState<AuraCircle[] | null>(null);
  const [selectedCircleId, setSelectedCircleId] = useState<string | null>(null);
  const [calibration, setCalibration] = useState<Calibration | null>(null);

  // ─── Player screen ──────────────────────────────────────────────────────────
  const [playerOpen, setPlayerOpen] = useState(false);
  const [viewportSize, setViewportSize] = useState<Size | null>(null);
  const [fit16by9, setFit16by9] = useState(false);
  const [blackout, setBlackout] = useState(false);
  const [activeHandout, setActiveHandout] = useState<{ id: string; url: string; rotation: number } | null>(
    null,
  );
  const [screenDiagonal, setScreenDiagonal] = useState<number | null>(null);
  const [gridSize, setGridSize] = useState(1);
  // New maps and handouts taller than wide are turned this much (the main process applies it)
  const [portraitRotation, setPortraitRotation] = useState(270);
  const [dialog, setDialog] = useState<'setup' | 'shortcuts' | null>(null);

  // Suppresses view saves while a map is being restored, so the restore can't
  // overwrite what it is loading
  const restoringRef = useRef(false);
  const pendingRestoreRef = useRef<PendingRestore | null>(null);
  // Bumped by every load and unload, so only the latest of quick loads applies
  const loadTokenRef = useRef(0);

  const reloadLibrary = useCallback(async () => {
    const snapshot = await api?.loadLibrary();
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

  // ─── Circles ────────────────────────────────────────────────────────────────
  //
  // Dragging and wheel-resizing update the ref on every event; React renders
  // (and the player screen is updated) at most once per animation frame.

  const circlesRef = useRef<AuraCircle[]>([]);
  const circlesFrameRequest = useRef<number | null>(null);

  const updateCircles = useCallback((change: (current: AuraCircle[]) => AuraCircle[]) => {
    circlesRef.current = change(circlesRef.current);
    if (circlesFrameRequest.current === null) {
      circlesFrameRequest.current = requestAnimationFrame(() => {
        circlesFrameRequest.current = null;
        setCircles(circlesRef.current);
      });
    }
  }, []);

  const replaceCircles = (next: AuraCircle[]) => {
    circlesRef.current = next;
    setCircles(next);
    setPlayerCircles(null);
  };

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
   * Send everything still on its way: a fog change being encoded and a view
   * change waiting out its delay. Before a map is switched, the library is
   * exported, or the window reloads or quits.
   */
  const settleSaves = useCallback(async () => {
    await fogIdle();
    flushViewSave();
  }, [fogIdle, flushViewSave]);

  useEffect(() => {
    if (!currentMapId || restoringRef.current) return;
    const view: MapView = { zoom, pan, rotation, mirrorHorizontal, mirrorVertical, circles };
    if (pendingViewSave.current) window.clearTimeout(pendingViewSave.current.timer);
    const timer = window.setTimeout(() => {
      pendingViewSave.current = null;
      saveView(currentMapId, view);
    }, VIEW_SAVE_DELAY_MS);
    pendingViewSave.current = { id: currentMapId, view, timer };
  }, [currentMapId, zoom, pan, rotation, mirrorHorizontal, mirrorVertical, circles, saveView]);

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
  const loadMap = useCallback(
    async (meta: MapEntryMeta, options: { centerFrame?: boolean } = {}) => {
      const token = ++loadTokenRef.current;
      // The last stroke reaches the disk before this map's fog is read back
      await settleSaves();
      const [url, savedFog, savedEffects] = await Promise.all([
        api?.loadMapMedia(meta.id),
        options.centerFrame ? null : api?.loadMapFog(meta.id),
        options.centerFrame ? null : api?.loadMapEffects(meta.id),
      ]);
      // Another map was picked while this one's files were read
      if (token !== loadTokenRef.current) return;
      if (!url) {
        notify(`Couldn’t find the file for “${meta.name}” in the library folder.`, 'error');
        return;
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
      setCurrentMapId(meta.id);
      setSelectedMapId(meta.id);
      setMediaType(meta.mediaType);
      setMediaSize(null);
      setZoom(meta.zoom);
      setRotation(meta.rotation);
      setMirrorHorizontal(meta.mirrorHorizontal);
      setMirrorVertical(meta.mirrorVertical);
      setGrid(meta.grid);
      replaceCircles(meta.circles);
      setSelectedCircleId(null);
      setCalibration(null);
      setMediaUrl(url);
    },
    [api, settleSaves],
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
    [api, fog, effects],
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
        setScreenDiagonal(snapshot.settings.playerScreenDiagonal);
        setGridSize(snapshot.settings.gridSize);
        setPortraitRotation(snapshot.settings.portraitRotation);
        setShowEffectTools(snapshot.settings.showEffectTools);
        setShowLibrary(snapshot.settings.showLibrary);
        const last = snapshot.maps.find((entry) => entry.id === snapshot.settings.currentMapId);
        if (last) await loadMap(last);
      }
      setLoading(false);
    })();
  }, [reloadLibrary, loadMap]);

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
    setCurrentMapId(null);
    setMediaUrl(null);
    setMediaSize(null);
    applyPan(null, null);
    api?.sendFogReset();
    effects.release();
    setGrid(null);
    replaceCircles([]);
    setSelectedCircleId(null);
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
    if (snapshot && result.settingsApplied) {
      setScreenDiagonal(snapshot.settings.playerScreenDiagonal);
      setGridSize(snapshot.settings.gridSize);
      setPortraitRotation(snapshot.settings.portraitRotation);
    }
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
  const shownCircles = playerCircles ?? circles;
  const playerDiscs = useMemo(() => toDiscs(shownCircles, grid), [shownCircles, grid]);

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
      circles: playerDiscs,
    });
  }, [
    api,
    mediaUrl,
    mediaType,
    zoom,
    rotation,
    mirrorHorizontal,
    mirrorVertical,
    activeHandout,
    blackout,
    playerDiscs,
  ]);

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

  const handleSavePlayerSetup = (diagonal: number | null, grid: number, rotation: number) => {
    setScreenDiagonal(diagonal);
    setGridSize(grid);
    setPortraitRotation(rotation);
    void api?.saveSettings({ playerScreenDiagonal: diagonal, gridSize: grid, portraitRotation: rotation });
  };

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

  const startCalibration = () => {
    if (!mediaUrl) return;
    setSelectedCircleId(null);
    setCalibration({ points: [], squares: '1', feet: String(grid?.feetPerCell ?? DEFAULT_FEET_PER_CELL) });
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
    } else if (after) addCircle(after);
  };

  // ─── Circle actions ─────────────────────────────────────────────────────────

  /** A direction on screen → the same direction on the map, undoing rotation and mirroring. */
  const screenToMapDirection = ({ x, y }: Point): Point => {
    if (rotation === 90) [x, y] = [y, -x];
    else if (rotation === 180) [x, y] = [-x, -y];
    else if (rotation === 270) [x, y] = [-y, x];
    if (mirrorHorizontal) x = -x;
    if (mirrorVertical) y = -y;
    return { x, y };
  };

  /** A point in rotated-map coordinates (like the pan) → map natural pixels. */
  const orientedToMap = (point: Point, media: Size): Point => {
    const oriented = orientedSize(media, rotation);
    const offset = screenToMapDirection({ x: point.x - oriented.w / 2, y: point.y - oriented.h / 2 });
    return { x: offset.x + media.w / 2, y: offset.y + media.h / 2 };
  };

  // What adding a shape needs first, explained beneath the shape's button
  const shapesNeed: ShapesNeed | null = !grid ? 'grid' : circles.length >= MAX_CIRCLES ? 'full' : null;

  // Without a grid, the note's Measure grid button comes here: the shape is
  // added once the grid is saved
  const handleAddCircle = (shape: AreaShape) => {
    if (!grid) {
      startCalibration();
      afterGridRef.current = shape;
    } else addCircle(shape);
  };

  const addCircle = (shape: AreaShape) => {
    if (!mediaSize || circlesRef.current.length >= MAX_CIRCLES) return;
    // Cones and lines start pointing right on screen, whatever the map's orientation
    const right = screenToMapDirection({ x: 1, y: 0 });
    // In the middle of what the players see, or of the map
    const center =
      pan && frameSize
        ? orientedToMap({ x: pan.x + frameSize.w / 2, y: pan.y + frameSize.h / 2 }, mediaSize)
        : { x: mediaSize.w / 2, y: mediaSize.h / 2 };
    const circle: AuraCircle = {
      id: newCircleId(),
      ...center,
      radiusFt: DEFAULT_AREA_FT[shape],
      kind: effectKind,
      shape,
      angle: ((Math.atan2(right.y, right.x) * 180) / Math.PI + 360) % 360,
      widthFt: DEFAULT_LINE_WIDTH_FT,
    };
    replaceCircles([...circlesRef.current, circle]);
    setSelectedCircleId(circle.id);
  };

  // Players see the circle jump to where it is dropped, not slide across the map
  const handleCircleDrag = useCallback((dragging: boolean) => {
    if (dragging) {
      setPlayerCircles(circlesRef.current);
      return;
    }
    // Render the drop position now rather than on the pending frame
    if (circlesFrameRequest.current !== null) {
      cancelAnimationFrame(circlesFrameRequest.current);
      circlesFrameRequest.current = null;
    }
    setCircles(circlesRef.current);
    setPlayerCircles(null);
  }, []);

  const handleMoveCircle = useCallback(
    (id: string, center: Point) =>
      updateCircles((current) =>
        current.map((circle) => (circle.id === id ? { ...circle, ...center } : circle)),
      ),
    [updateCircles],
  );

  /** The wheel: a line's width, any other template's size, in 5 ft steps. */
  const handleResizeCircle = useCallback(
    (id: string, notches: number) => {
      const step = 5;
      // Grow or shrink to the next multiple of the step, one step per notch
      const stepped = (value: number) => {
        for (let i = 0; i < Math.abs(notches); i++) {
          value =
            notches > 0 ? Math.floor(value / step) * step + step : Math.ceil(value / step) * step - step;
        }
        return clampRadius(Math.max(step, value));
      };
      updateCircles((current) =>
        current.map((circle) => {
          if (circle.id !== id) return circle;
          return circle.shape === 'line'
            ? { ...circle, widthFt: stepped(circle.widthFt) }
            : { ...circle, radiusFt: stepped(circle.radiusFt) };
        }),
      );
    },
    [updateCircles],
  );

  const handleSetCircleWidth = useCallback(
    (id: string, widthFt: number) =>
      updateCircles((current) =>
        current.map((circle) =>
          circle.id === id ? { ...circle, widthFt: clampRadius(Math.round(widthFt)) } : circle,
        ),
      ),
    [updateCircles],
  );

  /**
   * Cones and lines: point the template at `point`; its length follows, in
   * 5 ft steps. Squares only turn, and settle onto the grid near a right angle.
   */
  const handleAimCircle = useCallback(
    (id: string, point: Point) => {
      if (!grid) return;
      updateCircles((current) =>
        current.map((circle) => {
          if (circle.id !== id) return circle;
          const dx = point.x - circle.x;
          const dy = point.y - circle.y;
          const angle = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360;
          if (circle.shape === 'square') {
            const square = Math.round(angle / 90) * 90;
            return { ...circle, angle: Math.abs(angle - square) <= SQUARE_SNAP_DEG ? square % 360 : angle };
          }
          const feet = pixelsToFeet(Math.hypot(dx, dy), grid);
          return {
            ...circle,
            angle,
            radiusFt: clampRadius(Math.max(5, Math.round(feet / 5) * 5)),
          };
        }),
      );
    },
    [grid, updateCircles],
  );

  const handleDuplicateCircle = (id: string) => {
    const source = circlesRef.current.find((circle) => circle.id === id);
    if (!source || !grid) return;
    if (circlesRef.current.length >= MAX_CIRCLES) {
      notify(`A map can have at most ${MAX_CIRCLES} areas.`, 'error');
      return;
    }
    const copy = { ...source, id: newCircleId(), x: source.x + grid.cell };
    replaceCircles([...circlesRef.current, copy]);
    setSelectedCircleId(copy.id);
  };

  const handleSetCircleRadius = useCallback(
    (id: string, radiusFt: number) =>
      updateCircles((current) =>
        current.map((circle) =>
          circle.id === id ? { ...circle, radiusFt: clampRadius(Math.round(radiusFt)) } : circle,
        ),
      ),
    [updateCircles],
  );

  /** Alt + drag: a copy stays where the circle was, the original moves. */
  const handleCopyCircleInPlace = (id: string) => {
    const source = circlesRef.current.find((circle) => circle.id === id);
    if (!source || circlesRef.current.length >= MAX_CIRCLES) return;
    replaceCircles([...circlesRef.current, { ...source, id: newCircleId() }]);
  };

  /** Arrow keys: one square, or 1 ft with Shift, in the direction shown on screen. */
  const handleNudgeCircle = (id: string, direction: Point, fine: boolean) => {
    if (!grid) return;
    const step = fine ? grid.cell / grid.feetPerCell : grid.cell;
    const move = screenToMapDirection(direction);
    updateCircles((current) =>
      current.map((circle) =>
        circle.id === id ? { ...circle, x: circle.x + move.x * step, y: circle.y + move.y * step } : circle,
      ),
    );
  };

  const handleDeleteCircle = useCallback((id: string) => {
    replaceCircles(circlesRef.current.filter((circle) => circle.id !== id));
    setSelectedCircleId((selected) => (selected === id ? null : selected));
  }, []);

  const handleRecolorCircle = (id: string, kind: EffectKind) =>
    replaceCircles(circlesRef.current.map((circle) => (circle.id === id ? { ...circle, kind } : circle)));

  // The colour picked in the Shapes tool also goes to the selected shape
  const handleEffectKindChange = (kind: EffectKind) => {
    setEffectKind(kind);
    if (tool === 'shapes' && selectedCircleId) handleRecolorCircle(selectedCircleId, kind);
  };

  // Areas can only be edited in the View and Shapes tools: leaving them
  // drops the selection, so Delete can't remove an area that isn't shown
  const changeTool = useCallback((next: Tool) => {
    setTool(next);
    if (next === 'fog' || next === 'effect') setSelectedCircleId(null);
  }, []);

  const handleToggleLibrary = useCallback(() => {
    setShowLibrary((shown) => {
      void window.electronAPI?.saveSettings({ showLibrary: !shown });
      return !shown;
    });
  }, []);

  const handleToggleEffectTools = () => {
    const next = !showEffectTools;
    setShowEffectTools(next);
    if (!next) {
      setSelectedCircleId(null);
      setTool((current) => (current === 'effect' || current === 'shapes' ? 'view' : current));
    }
    void api?.saveSettings({ showEffectTools: next });
  };

  // ─── Keyboard ───────────────────────────────────────────────────────────────

  const resizeBrush = useCallback(
    (direction: 1 | -1) => setBrushSize((size) => clamp(size + direction * BRUSH_STEP, MIN_BRUSH, MAX_BRUSH)),
    [],
  );

  // Undo and redo apply to the layer of the active tool
  const history = tool === 'effect' ? effects : fog;
  const shortcutState = useRef({
    hasMap: false,
    history,
    showEffectTools,
    selectedCircleId,
    calibrating: false,
    deleteCircle: handleDeleteCircle,
    duplicateCircle: (_id: string) => {},
    nudgeCircle: (_id: string, _direction: Point, _fine: boolean) => {},
    selectedMapId: null as string | null,
    loadMap: (_id: string) => {},
    addMaps: () => {},
    toggleLibrary: () => {},
  });
  shortcutState.current = {
    hasMap: !!mediaUrl,
    history,
    showEffectTools,
    selectedCircleId,
    calibrating: !!calibration,
    deleteCircle: handleDeleteCircle,
    duplicateCircle: handleDuplicateCircle,
    nudgeCircle: handleNudgeCircle,
    selectedMapId,
    loadMap: handleLoadMap,
    addMaps: () => void handleAddMaps(),
    toggleLibrary: handleToggleLibrary,
  };
  const viewControls = useRef<ViewControls | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Shift') setShiftHeld(true);
      if (isTypingTarget(event.target) || document.querySelector('[role="dialog"]')) return;
      const current = shortcutState.current;
      const { hasMap, history: currentHistory } = current;
      const key = event.key.toLowerCase();
      if (event.key === 'Escape') {
        if (current.calibrating) setCalibration(null);
        else setSelectedCircleId(null);
        return;
      }
      if ((event.key === 'Delete' || event.key === 'Backspace') && current.selectedCircleId) {
        event.preventDefault();
        current.deleteCircle(current.selectedCircleId);
        return;
      }
      // Before the modifier checks: on Nordic keyboards [ and ] are typed with AltGr (Ctrl+Alt)
      if ((event.key === '[' || event.key === ']') && hasMap) {
        event.preventDefault();
        resizeBrush(event.key === ']' ? 1 : -1);
        return;
      }
      if (event.ctrlKey || event.metaKey) {
        if (key === 'z' && !event.shiftKey) currentHistory.undo();
        else if (key === 'y' || (key === 'z' && event.shiftKey)) currentHistory.redo();
        // Your own view, like a browser or Photoshop; the player view is untouched
        else if (key === '=' || key === '+') viewControls.current?.zoomBy(1.25);
        else if (key === '-' || key === '_') viewControls.current?.zoomBy(0.8);
        else if (key === '0') viewControls.current?.fit();
        else if (key === 'd' && current.selectedCircleId) current.duplicateCircle(current.selectedCircleId);
        else if (key === 'o') current.addMaps();
        else if (key === 'b')
          current.toggleLibrary(); // the sidebar toggle in editors and file browsers
        else return;
        event.preventDefault();
        return;
      }
      if (event.altKey) return;
      const arrows: Record<string, Point> = {
        ArrowLeft: { x: -1, y: 0 },
        ArrowRight: { x: 1, y: 0 },
        ArrowUp: { x: 0, y: -1 },
        ArrowDown: { x: 0, y: 1 },
      };
      if (arrows[event.key] && current.selectedCircleId) {
        event.preventDefault();
        current.nudgeCircle(current.selectedCircleId, arrows[event.key], event.shiftKey);
        return;
      }
      if (event.key === 'Enter' && current.selectedMapId) {
        // A focused button handles Enter itself
        if (event.target instanceof HTMLButtonElement) return;
        event.preventDefault();
        current.loadMap(current.selectedMapId);
        return;
      }
      if (event.key === '?') setDialog('shortcuts');
      else if ((event.key === '+' || event.key === '=') && hasMap) setZoom((zoom) => stepZoom(zoom, 1));
      else if (event.key === '-' && hasMap) setZoom((zoom) => stepZoom(zoom, -1));
      else if (event.key === ' ') {
        event.preventDefault();
        setSpaceHeld(true);
      } else if (key === 'v') changeTool('view');
      else if (key === 'f' && hasMap) changeTool('fog');
      else if (key === 'l' && hasMap) {
        // L for lasso, as in Photoshop: switches the Fog tool between brush and lasso
        changeTool('fog');
        setFogLasso((lasso) => !lasso);
      } else if (key === 'e' && hasMap && current.showEffectTools) changeTool('effect');
      else if (key === 's' && hasMap && current.showEffectTools) changeTool('shapes');
      else if (key === 'b') setBlackout((value) => !value);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === 'Shift') setShiftHeld(false);
      if (event.key === ' ') setSpaceHeld(false);
    };
    const onBlur = () => {
      setShiftHeld(false);
      setSpaceHeld(false);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [resizeBrush, changeTool]);

  // ─── Render ─────────────────────────────────────────────────────────────────

  // Fixed identities, so the library panel and toolbar skip the renders that
  // dragging the frame or an area causes on every animation frame
  const panelHandlers = useHandlers({
    onLoadMap: handleLoadMap,
    onReorderMaps: handleReorderMaps,
    onRenameMap: handleRenameMap,
    onRemoveMap: handleRemoveMap,
    onChangeOrientation: handleChangeOrientation,
    onAddMaps: handleAddMaps,
    onDropMaps: (files: File[]) => handleDropFiles(files, 'map'),
    onToggleHandout: handleToggleHandout,
    onRotateHandout: handleRotateHandout,
    onRemoveHandout: handleRemoveHandout,
    onAddHandouts: handleAddHandouts,
    onDropHandouts: (files: File[]) => handleDropFiles(files, 'handout'),
  });
  const toolbarHandlers = useHandlers({
    onAddCircle: handleAddCircle,
    onEffectKindChange: handleEffectKindChange,
    onToggleEffectTools: handleToggleEffectTools,
    onCalibrateGrid: startCalibration,
    onRevealAll: handleRevealAll,
    onZoomChange: (next: number) => setZoom(clampZoom(next)),
    onToggleFit16by9: handleToggleFit16by9,
    onTrueScale: handleTrueScale,
    onOpenPlayer: handleOpenPlayer,
    onToggleBlackout: () => setBlackout((value) => !value),
    onOpenPlayerSetup: () => setDialog('setup'),
    onOpenShortcuts: () => setDialog('shortcuts'),
    onExportProject: () => void handleExportProject(),
    onImportProject: () => void handleImportProject(),
    onRevealLibraryFolder: () => void api?.revealLibraryFolder(),
    onToggleFullScreen: () => void api?.toggleFullScreen(),
    onReload: async () => {
      await settleSaves();
      api?.reloadWindow();
    },
    onToggleDevTools: () => api?.toggleDevTools(),
    onQuit: async () => {
      await settleSaves();
      api?.quitApp();
    },
  });

  const gridCell =
    screenDiagonal && viewportSize && frameSize
      ? frameSize.w / (screenDimensions(screenDiagonal, viewportSize).width / gridSize)
      : 0;
  const activeHandoutName = handouts.find((entry) => entry.id === activeHandout?.id)?.name;

  return (
    <div className="flex h-full bg-ground text-ink">
      <MapLibraryPanel
        {...panelHandlers}
        loading={loading}
        maps={maps}
        currentMapId={currentMapId}
        selectedMapId={selectedMapId}
        onSelectMap={setSelectedMapId}
        handouts={handouts}
        selectedHandoutId={selectedHandoutId}
        activeHandoutId={activeHandout?.id ?? null}
        onSelectHandout={setSelectedHandoutId}
        hidden={!showLibrary}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <Toolbar
          {...toolbarHandlers}
          hasMap={!!mediaUrl}
          tool={tool}
          onToolChange={changeTool}
          brushSize={brushSize}
          onBrushSizeChange={setBrushSize}
          canUndo={history.canUndo}
          canRedo={history.canRedo}
          onUndo={history.undo}
          onRedo={history.redo}
          effectKind={effectKind}
          canClearEffects={!effects.isEmpty}
          onClearEffects={effects.clear}
          showEffectTools={showEffectTools}
          showLibrary={showLibrary}
          onToggleLibrary={handleToggleLibrary}
          fogLasso={fogLasso}
          onFogLassoChange={setFogLasso}
          onCoverAll={fog.coverAll}
          zoom={zoom}
          fit16by9={fit16by9}
          atTrueScale={atTrueScale}
          trueScaleNeeds={trueScaleNeeds}
          shapesNeed={shapesNeed}
          playerOpen={playerOpen}
          blackout={blackout}
        />

        {(blackout || activeHandout) && (
          <div className="flex h-9 shrink-0 items-center gap-3 border-b border-crimson bg-crimson-deep px-3 text-[13px]">
            <span className="h-2 w-2 rounded-full bg-crimson-bright" aria-hidden="true" />
            <span className="flex-1 text-ink">
              {blackout
                ? 'The player screen is blacked out.'
                : `Players are looking at the handout “${activeHandoutName ?? 'Handout'}”.`}
            </span>
            <Button
              tone="quiet"
              className="h-7"
              onClick={() => (blackout ? setBlackout(false) : setActiveHandout(null))}
            >
              {blackout ? 'Show the map' : 'Hide handout'}
            </Button>
          </div>
        )}

        {calibration && (
          <GridCalibrationBar
            calibration={calibration}
            preview={calibrationPreview}
            hasGrid={!!grid}
            onChange={setCalibration}
            onSave={() => calibrationPreview && void saveGrid(calibrationPreview)}
            onRemove={() => void saveGrid(null)}
            onCancel={() => setCalibration(null)}
          />
        )}

        <MapStage
          mediaUrl={mediaUrl}
          mediaType={mediaType}
          mediaSize={mediaSize}
          rotation={rotation}
          mirrorHorizontal={mirrorHorizontal}
          mirrorVertical={mirrorVertical}
          onMediaLoad={handleMediaLoad}
          onMediaError={handleMediaError}
          fog={fog}
          effects={effects}
          effectKind={effectKind}
          tool={spaceHeld ? 'view' : tool}
          shiftHeld={shiftHeld}
          fogLasso={fogLasso}
          spaceHeld={spaceHeld}
          brushSize={brushSize}
          onBrushResize={resizeBrush}
          pan={pan}
          viewportSize={viewportSize}
          zoom={zoom}
          gridCell={gridCell}
          constrainPan={constrainPan}
          onPanChange={(next) => applyPan(next, frameSize)}
          onZoomWheel={(factor) => setZoom((current) => clampZoom(current * factor))}
          grid={grid}
          gridPreview={calibrationPreview}
          circles={circles}
          selectedCircleId={selectedCircleId}
          circlesInteractive={
            showEffectTools &&
            !calibration &&
            !shiftHeld &&
            (spaceHeld || tool === 'view' || tool === 'shapes')
          }
          onSelectCircle={setSelectedCircleId}
          onCircleDrag={handleCircleDrag}
          onMoveCircle={handleMoveCircle}
          onResizeCircle={handleResizeCircle}
          onSetCircleRadius={handleSetCircleRadius}
          onSetCircleWidth={handleSetCircleWidth}
          onAimCircle={handleAimCircle}
          onDuplicateCircle={handleDuplicateCircle}
          onCopyCircleInPlace={handleCopyCircleInPlace}
          onDeleteCircle={handleDeleteCircle}
          onRecolorCircle={handleRecolorCircle}
          calibrationPoints={calibration?.points ?? null}
          onCalibrationPoint={handleCalibrationPoint}
          viewControls={viewControls}
        />
      </div>

      {dialog === 'setup' && (
        <PlayerSetupDialog
          diagonal={screenDiagonal}
          gridSize={gridSize}
          portraitRotation={portraitRotation}
          viewportSize={viewportSize}
          onSave={handleSavePlayerSetup}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'shortcuts' && <ShortcutsDialog onClose={() => setDialog(null)} />}
      <NotificationHost />
    </div>
  );
}

export default App;

// The DM window. This component owns the library and the loaded map's state
// and wires the pieces together; the fog lives in useFog, the map area in
// MapStage, and the controls in Toolbar and MapLibraryPanel.

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
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
import { MapLibraryPanel, type OrientationChange } from './components/MapLibraryPanel';
import { MapStage, type Tool } from './components/MapStage';
import { BRUSH_STEP, MAX_BRUSH, MIN_BRUSH, Toolbar } from './components/Toolbar';
import { PlayerSetupDialog, ShortcutsDialog, screenDimensions } from './components/Dialogs';
import { useFog } from './hooks/useFog';
import { useEffectLayer } from './hooks/useEffectLayer';
import { clamp, clampZoom, orientedSize, type Size } from './lib/geometry';
import {
  DEFAULT_FEET_PER_CELL,
  MAX_CIRCLES,
  clampRadius,
  gridFromCorners,
  newCircleId,
  toDiscs,
} from './lib/grid';
import { GridCalibrationBar, type Calibration } from './components/GridCalibrationBar';
import { Button } from './ui/controls';
import { NotificationHost, confirmAction, notify } from './ui/notify';

const VIEW_SAVE_DELAY_MS = 400;
/** Radius of a new circle: Spirit Guardians and most auras */
const DEFAULT_CIRCLE_FT = 15;

/** Pan and fog to apply once the map being loaded has finished loading. */
interface PendingRestore {
  mapId: string;
  /** null: never framed, so centre the player frame */
  pan: MapPan | null;
  fog: string | null;
  effects: string | null;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

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
  const [tool, setTool] = useState<Tool>('frame');
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [shiftHeld, setShiftHeld] = useState(false);
  const [brushSize, setBrushSize] = useState(80);
  const fog = useFog();
  const effects = useEffectLayer();
  const [effectKind, setEffectKind] = useState<EffectKind>('fire');
  const [showEffectTools, setShowEffectTools] = useState(true);

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
  const [dialog, setDialog] = useState<'setup' | 'shortcuts' | null>(null);

  // Suppresses view saves while a map is being restored, so the restore can't
  // overwrite what it is loading
  const restoringRef = useRef(false);
  const pendingRestoreRef = useRef<PendingRestore | null>(null);

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

  const cancelViewSave = useCallback(() => {
    if (pendingViewSave.current) window.clearTimeout(pendingViewSave.current.timer);
    pendingViewSave.current = null;
  }, []);

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
      flushViewSave();
      const [url, savedFog, savedEffects] = await Promise.all([
        api?.loadMapMedia(meta.id),
        options.centerFrame ? null : api?.loadMapFog(meta.id),
        options.centerFrame ? null : api?.loadMapEffects(meta.id),
      ]);
      if (!url) {
        notify(`Couldn’t find the file for “${meta.name}” in the library folder.`, 'error');
        return;
      }
      restoringRef.current = true;
      pendingRestoreRef.current = {
        mapId: meta.id,
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
    [api, flushViewSave],
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
      restoringRef.current = false;
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
        setShowEffectTools(snapshot.settings.showEffectTools);
        const last = snapshot.maps.find((entry) => entry.id === snapshot.settings.currentMapId);
        if (last) await loadMap(last);
      }
      setLoading(false);
    })();
  }, [reloadLibrary, loadMap]);

  const reportImport = (result: ImportResult, kind: 'map' | 'handout') => {
    if (result.added > 0) notify(`${plural(result.added, kind)} added`);
    if (result.skipped.length > 0) {
      const what = kind === 'map' ? 'an image or WebM video' : 'an image';
      notify(`Skipped ${result.skipped.join(', ')}: not ${what} Mini VTT can open.`, 'error');
    }
  };

  const handleAddMaps = async () => {
    const result = await api?.importMapsFromDialog();
    if (!result) return;
    reportImport(result, 'map');
    await reloadLibrary();
    if (result.firstMap) await loadMap(result.firstMap, { centerFrame: true });
  };

  const handleDropFiles = async (files: File[], kind: 'map' | 'handout') => {
    if (!api) return;
    const paths = api.getDroppedFilePaths(files).filter(Boolean);
    if (paths.length === 0) return;
    const result = kind === 'map' ? await api.importMaps(paths) : await api.importHandouts(paths);
    reportImport(result, kind);
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

  const handleRemoveMap = async (id: string) => {
    const meta = maps.find((entry) => entry.id === id);
    if (!meta) return;
    const confirmed = await confirmAction({
      title: 'Remove map',
      message: `Remove “${meta.name}” from the library? Its fog and framing are deleted too. The original file isn’t affected.`,
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!confirmed) return;
    if (id === currentMapId) cancelViewSave();
    if (!(await api?.removeMap(id))) {
      notify(`Couldn’t remove “${meta.name}”.`, 'error');
      return;
    }
    const snapshot = await reloadLibrary();
    if (id === selectedMapId) setSelectedMapId(null);
    if (id !== currentMapId) return;
    const next = snapshot?.maps[0];
    if (next) {
      await loadMap(next);
    } else {
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
    }
  };

  // ─── Project files ──────────────────────────────────────────────────────────

  const handleExportProject = async () => {
    // Save the current framing first, so the file has the latest view
    flushViewSave();
    const result = await api?.exportProject();
    if (!result) return;
    if (!result.ok) {
      notify(result.error, 'error');
      return;
    }
    notify(
      `Exported ${plural(result.maps, 'map')} and ${plural(result.handouts, 'handout')} to “${result.fileName}”`,
    );
  };

  const handleImportProject = async () => {
    const result = await api?.importProject();
    if (!result) return;
    if (!result.ok) {
      notify(result.error, 'error');
      return;
    }
    notify(
      `Imported ${plural(result.maps, 'map')} and ${plural(result.handouts, 'handout')} from “${result.fileName}”`,
    );
    if (result.skipped > 0) {
      notify(
        `Skipped ${plural(result.skipped, 'item')} that were damaged or in an unsupported format.`,
        'error',
      );
    }
    const snapshot = await reloadLibrary();
    if (snapshot && result.settingsApplied) {
      setScreenDiagonal(snapshot.settings.playerScreenDiagonal);
      setGridSize(snapshot.settings.gridSize);
    }
    if (!currentMapId && result.firstMap) await loadMap(result.firstMap);
  };

  // ─── Handouts ───────────────────────────────────────────────────────────────

  const handleAddHandouts = async () => {
    const result = await api?.importHandoutsFromDialog();
    if (!result) return;
    reportImport(result, 'handout');
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
    const confirmed = await confirmAction({
      title: 'Remove handout',
      message: `Remove “${handout.name}” from the library? The original file isn’t affected.`,
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!confirmed) return;
    if (!(await api?.removeHandout(id))) {
      notify(`Couldn’t remove “${handout.name}”.`, 'error');
      return;
    }
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
      circles: toDiscs(playerCircles ?? circles, grid),
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
    circles,
    playerCircles,
    grid,
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

  const handleSavePlayerSetup = (diagonal: number | null, grid: number) => {
    setScreenDiagonal(diagonal);
    setGridSize(grid);
    void api?.saveSettings({ playerScreenDiagonal: diagonal, gridSize: grid });
  };

  const handleRevealAll = async () => {
    const confirmed = await confirmAction({
      title: 'Reveal entire map',
      message: 'Players will see the whole map straight away. You can undo this with Ctrl+Z.',
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
    setCalibration(null);
    notify(next ? 'Grid saved for this map' : 'Grid removed from this map');
  };

  // ─── Circle actions ─────────────────────────────────────────────────────────

  /** A point in rotated-map coordinates (like the pan) → map natural pixels. */
  const orientedToMap = (point: Point, media: Size): Point => {
    const oriented = orientedSize(media, rotation);
    let x = point.x - oriented.w / 2;
    let y = point.y - oriented.h / 2;
    if (rotation === 90) [x, y] = [y, -x];
    else if (rotation === 180) [x, y] = [-x, -y];
    else if (rotation === 270) [x, y] = [-y, x];
    if (mirrorHorizontal) x = -x;
    if (mirrorVertical) y = -y;
    return { x: x + media.w / 2, y: y + media.h / 2 };
  };

  const handleAddCircle = () => {
    if (!mediaSize) return;
    if (!grid) {
      notify('Measure the map’s grid first, so circles can be sized in feet.');
      startCalibration();
      return;
    }
    if (circlesRef.current.length >= MAX_CIRCLES) {
      notify(`A map can have at most ${MAX_CIRCLES} circles.`, 'error');
      return;
    }
    // In the middle of what the players see, or of the map
    const center =
      pan && frameSize
        ? orientedToMap({ x: pan.x + frameSize.w / 2, y: pan.y + frameSize.h / 2 }, mediaSize)
        : { x: mediaSize.w / 2, y: mediaSize.h / 2 };
    const circle: AuraCircle = {
      id: newCircleId(),
      ...center,
      radiusFt: DEFAULT_CIRCLE_FT,
      kind: effectKind,
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

  const handleResizeCircle = useCallback(
    (id: string, notches: number, fine: boolean) => {
      const step = fine ? 1 : 5;
      updateCircles((current) =>
        current.map((circle) => {
          if (circle.id !== id) return circle;
          // Grow or shrink to the next multiple of the step, one step per notch
          let radius = circle.radiusFt;
          for (let i = 0; i < Math.abs(notches); i++) {
            radius =
              notches > 0 ? Math.floor(radius / step) * step + step : Math.ceil(radius / step) * step - step;
          }
          return { ...circle, radiusFt: clampRadius(Math.max(step, radius)) };
        }),
      );
    },
    [updateCircles],
  );

  const handleDuplicateCircle = (id: string) => {
    const source = circlesRef.current.find((circle) => circle.id === id);
    if (!source || !grid) return;
    if (circlesRef.current.length >= MAX_CIRCLES) {
      notify(`A map can have at most ${MAX_CIRCLES} circles.`, 'error');
      return;
    }
    const copy = { ...source, id: newCircleId(), x: source.x + grid.cell };
    replaceCircles([...circlesRef.current, copy]);
    setSelectedCircleId(copy.id);
  };

  const handleDeleteCircle = useCallback((id: string) => {
    replaceCircles(circlesRef.current.filter((circle) => circle.id !== id));
    setSelectedCircleId((selected) => (selected === id ? null : selected));
  }, []);

  const handleRecolorCircle = (id: string, kind: EffectKind) =>
    replaceCircles(circlesRef.current.map((circle) => (circle.id === id ? { ...circle, kind } : circle)));

  const handleToggleEffectTools = () => {
    const next = !showEffectTools;
    setShowEffectTools(next);
    if (!next) {
      setSelectedCircleId(null);
      setTool((current) => (current === 'effect' ? 'frame' : current));
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
  });
  shortcutState.current = {
    hasMap: !!mediaUrl,
    history,
    showEffectTools,
    selectedCircleId,
    calibrating: !!calibration,
    deleteCircle: handleDeleteCircle,
  };

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
      if (event.ctrlKey || event.metaKey) {
        if (key === 'z' && !event.shiftKey) currentHistory.undo();
        else if (key === 'y' || (key === 'z' && event.shiftKey)) currentHistory.redo();
        else return;
        event.preventDefault();
        return;
      }
      if (event.altKey) return;
      if (event.key === ' ') {
        event.preventDefault();
        setSpaceHeld(true);
      } else if (key === 'v') setTool('frame');
      else if (key === 'f' && hasMap) setTool('fog');
      else if (key === 'e' && hasMap && current.showEffectTools) setTool('effect');
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
  }, [resizeBrush]);

  // ─── Render ─────────────────────────────────────────────────────────────────

  const gridCell =
    screenDiagonal && viewportSize && frameSize
      ? frameSize.w / (screenDimensions(screenDiagonal, viewportSize).width / gridSize)
      : 0;
  const activeHandoutName = handouts.find((entry) => entry.id === activeHandout?.id)?.name;

  return (
    <div className="flex h-full bg-ground text-ink">
      <MapLibraryPanel
        loading={loading}
        maps={maps}
        currentMapId={currentMapId}
        selectedMapId={selectedMapId}
        onSelectMap={setSelectedMapId}
        onLoadMap={handleLoadMap}
        onReorderMaps={handleReorderMaps}
        onRenameMap={handleRenameMap}
        onRemoveMap={handleRemoveMap}
        onChangeOrientation={handleChangeOrientation}
        onAddMaps={handleAddMaps}
        onDropMaps={(files) => handleDropFiles(files, 'map')}
        handouts={handouts}
        selectedHandoutId={selectedHandoutId}
        activeHandoutId={activeHandout?.id ?? null}
        onSelectHandout={setSelectedHandoutId}
        onToggleHandout={handleToggleHandout}
        onRotateHandout={handleRotateHandout}
        onRemoveHandout={handleRemoveHandout}
        onAddHandouts={handleAddHandouts}
        onDropHandouts={(files) => handleDropFiles(files, 'handout')}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <Toolbar
          hasMap={!!mediaUrl}
          tool={tool}
          onToolChange={setTool}
          brushSize={brushSize}
          onBrushSizeChange={setBrushSize}
          canUndo={history.canUndo}
          canRedo={history.canRedo}
          onUndo={history.undo}
          onRedo={history.redo}
          effectKind={effectKind}
          onEffectKindChange={setEffectKind}
          canClearEffects={!effects.isEmpty}
          onClearEffects={effects.clear}
          onAddCircle={handleAddCircle}
          showEffectTools={showEffectTools}
          onToggleEffectTools={handleToggleEffectTools}
          onCalibrateGrid={startCalibration}
          onRevealAll={handleRevealAll}
          onCoverAll={fog.coverAll}
          zoom={zoom}
          onZoomChange={(next) => setZoom(clampZoom(next))}
          fit16by9={fit16by9}
          onToggleFit16by9={handleToggleFit16by9}
          playerOpen={playerOpen}
          onOpenPlayer={handleOpenPlayer}
          blackout={blackout}
          onToggleBlackout={() => setBlackout((value) => !value)}
          onOpenPlayerSetup={() => setDialog('setup')}
          onOpenShortcuts={() => setDialog('shortcuts')}
          onExportProject={() => void handleExportProject()}
          onImportProject={() => void handleImportProject()}
          onRevealLibraryFolder={() => void api?.revealLibraryFolder()}
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
          tool={spaceHeld ? 'frame' : tool}
          shiftHeld={shiftHeld}
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
            (spaceHeld || tool === 'frame' || tool === 'effect')
          }
          onSelectCircle={setSelectedCircleId}
          onCircleDrag={handleCircleDrag}
          onMoveCircle={handleMoveCircle}
          onResizeCircle={handleResizeCircle}
          onDuplicateCircle={handleDuplicateCircle}
          onDeleteCircle={handleDeleteCircle}
          onRecolorCircle={handleRecolorCircle}
          calibrationPoints={calibration?.points ?? null}
          onCalibrationPoint={handleCalibrationPoint}
        />
      </div>

      {dialog === 'setup' && (
        <PlayerSetupDialog
          diagonal={screenDiagonal}
          gridSize={gridSize}
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

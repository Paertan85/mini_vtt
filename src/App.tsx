// The DM window. This component owns the library and the loaded map's state
// and wires the pieces together; the fog lives in useFog, the map area in
// MapStage, and the controls in Toolbar and MapLibraryPanel.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { HandoutMeta, ImportResult, MapEntryMeta, MapPan, MapView, MediaType } from './types/map';
import { MapLibraryPanel, type OrientationChange } from './components/MapLibraryPanel';
import { MapStage, type Tool } from './components/MapStage';
import { BRUSH_STEP, MAX_BRUSH, MIN_BRUSH, Toolbar } from './components/Toolbar';
import { PlayerSetupDialog, ShortcutsDialog, screenDimensions } from './components/Dialogs';
import { useFog } from './hooks/useFog';
import { clamp, clampZoom, orientedSize, type Size } from './lib/geometry';
import { Button } from './ui/controls';
import { NotificationHost, confirmAction, notify } from './ui/notify';

const VIEW_SAVE_DELAY_MS = 400;

/** Pan and fog to apply once the map being loaded has finished loading. */
interface PendingRestore {
  mapId: string;
  /** null: never framed, so centre the player frame */
  pan: MapPan | null;
  fog: string | null;
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
    const view: MapView = { zoom, pan, rotation, mirrorHorizontal, mirrorVertical };
    if (pendingViewSave.current) window.clearTimeout(pendingViewSave.current.timer);
    const timer = window.setTimeout(() => {
      pendingViewSave.current = null;
      saveView(currentMapId, view);
    }, VIEW_SAVE_DELAY_MS);
    pendingViewSave.current = { id: currentMapId, view, timer };
  }, [currentMapId, zoom, pan, rotation, mirrorHorizontal, mirrorVertical, saveView]);

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
      const [url, savedFog] = await Promise.all([
        api?.loadMapMedia(meta.id),
        options.centerFrame ? null : api?.loadMapFog(meta.id),
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
      };
      setCurrentMapId(meta.id);
      setSelectedMapId(meta.id);
      setMediaType(meta.mediaType);
      setMediaSize(null);
      setZoom(meta.zoom);
      setRotation(meta.rotation);
      setMirrorHorizontal(meta.mirrorHorizontal);
      setMirrorVertical(meta.mirrorVertical);
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
      restoringRef.current = false;
    },
    [api, fog],
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
    });
  }, [api, mediaUrl, mediaType, zoom, rotation, mirrorHorizontal, mirrorVertical, activeHandout, blackout]);

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

  // ─── Keyboard ───────────────────────────────────────────────────────────────

  const resizeBrush = useCallback(
    (direction: 1 | -1) => setBrushSize((size) => clamp(size + direction * BRUSH_STEP, MIN_BRUSH, MAX_BRUSH)),
    [],
  );

  const shortcutState = useRef({ hasMap: false, fog });
  shortcutState.current = { hasMap: !!mediaUrl, fog };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Shift') setShiftHeld(true);
      if (isTypingTarget(event.target) || document.querySelector('[role="dialog"]')) return;
      const { hasMap, fog: currentFog } = shortcutState.current;
      const key = event.key.toLowerCase();
      if (event.ctrlKey || event.metaKey) {
        if (key === 'z' && !event.shiftKey) currentFog.undo();
        else if (key === 'y') currentFog.redo();
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
          canUndo={fog.canUndo}
          canRedo={fog.canRedo}
          onUndo={fog.undo}
          onRedo={fog.redo}
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

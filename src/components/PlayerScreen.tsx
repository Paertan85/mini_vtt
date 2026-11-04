// The player screen: shows the framed part of the map with solid black fog,
// plus handouts and blackout. Everything is driven from the DM window over IPC;
// this window only reports its size back.
//
// Its two buttons (full screen, close handout) fade out when the mouse is idle,
// so players see nothing but the map.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Maximize2, Minimize2, X } from 'lucide-react';
import type { FogStroke, MapState } from '../types/map';
import { drawSnapshot, drawStroke, fillMask, fogMaskSize, loadImage } from '../lib/fog';
import type { Size } from '../lib/geometry';

const PLAYER_FOG_COLOR = '#000000';
const MIN_HANDOUT_ZOOM = 0.1;
const MAX_HANDOUT_ZOOM = 5;
const CONTROLS_IDLE_MS = 2000;

const INITIAL_STATE: MapState = {
  mediaUrl: null,
  mediaType: 'image',
  zoom: 1,
  rotation: 0,
  mirrorHorizontal: false,
  mirrorVertical: false,
  handoutUrl: null,
  handoutRotation: 0,
  blackout: false,
};

export function PlayerScreen() {
  const [state, setState] = useState<MapState>(INITIAL_STATE);
  const [pan, setPan] = useState<{ x: number; y: number } | null>(null);
  const [mediaSize, setMediaSize] = useState<Size | null>(null);
  const [isFullScreen, setIsFullScreen] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [handoutZoom, setHandoutZoom] = useState(1);
  const [handoutPan, setHandoutPan] = useState({ x: 0, y: 0 });

  const mainRef = useRef<HTMLElement>(null);
  const handoutRef = useRef<HTMLDivElement>(null);
  const fogCanvasRef = useRef<HTMLCanvasElement>(null);
  const mediaSizeRef = useRef<Size | null>(null);
  // The latest snapshot for the current map. Kept, not consumed, so it can be
  // re-applied when this window's copy of the map finishes loading: the
  // snapshot often arrives first.
  const latestFogRef = useRef<string | null>(null);
  const currentMediaUrlRef = useRef<string | null>(null);
  // Snapshots decode asynchronously. Each gets a sequence number so a stale one
  // that finishes late is ignored, and strokes that arrive while one decodes
  // are replayed on top of it (IPC is ordered, so they are newer).
  const snapshotSeqRef = useRef(0);
  const strokesDuringDecodeRef = useRef<FogStroke[] | null>(null);

  // ─── Fog ──────────────────────────────────────────────────────────────────

  const fogContext = () => {
    const canvas = fogCanvasRef.current;
    return canvas && canvas.width > 0 ? canvas.getContext('2d') : null;
  };

  const paintStroke = (stroke: FogStroke) => {
    const ctx = fogContext();
    if (ctx && mediaSizeRef.current) drawStroke(ctx, stroke, mediaSizeRef.current, PLAYER_FOG_COLOR);
  };

  const applySnapshot = async (dataUrl: string) => {
    if (!fogContext()) return;
    const seq = ++snapshotSeqRef.current;
    strokesDuringDecodeRef.current = [];
    try {
      const image = await loadImage(dataUrl);
      const ctx = fogContext();
      if (seq !== snapshotSeqRef.current || !ctx) return;
      drawSnapshot(ctx, image, PLAYER_FOG_COLOR);
      const replay = strokesDuringDecodeRef.current ?? [];
      strokesDuringDecodeRef.current = null;
      replay.forEach(paintStroke);
    } catch {
      if (seq === snapshotSeqRef.current) strokesDuringDecodeRef.current = null;
    }
  };

  const receiveSnapshot = (dataUrl: string) => {
    latestFogRef.current = dataUrl;
    void applySnapshot(dataUrl);
  };

  const receiveState = (next: MapState) => {
    // A different map: the stored snapshot belongs to the old one
    if (next.mediaUrl !== currentMediaUrlRef.current) {
      currentMediaUrlRef.current = next.mediaUrl;
      latestFogRef.current = null;
    }
    setState(next);
  };

  // Size the fog for the newly loaded map, fully fogged until a snapshot applies
  const handleMediaLoad = (event: React.SyntheticEvent<HTMLImageElement | HTMLVideoElement>) => {
    const element = event.currentTarget;
    const size =
      element instanceof HTMLVideoElement
        ? { w: element.videoWidth, h: element.videoHeight }
        : { w: element.naturalWidth, h: element.naturalHeight };
    const canvas = fogCanvasRef.current;
    if (!canvas || !size.w || !size.h) return;
    const mask = fogMaskSize(size);
    canvas.width = mask.width;
    canvas.height = mask.height;
    mediaSizeRef.current = size;
    setMediaSize(size);
    const ctx = canvas.getContext('2d');
    if (ctx) fillMask(ctx, PLAYER_FOG_COLOR);
    if (latestFogRef.current) void applySnapshot(latestFogRef.current);
  };

  useEffect(() => {
    setMediaSize(null);
  }, [state.mediaUrl]);

  // ─── Subscriptions (registered before the first viewport report) ──────────

  useEffect(() => {
    const api = window.electronAPI;
    // The state must arrive first, or the snapshot would be dropped as stale
    void (async () => {
      const latest = await api?.requestMapState();
      if (latest) receiveState(latest);
      const fog = await api?.requestFogSnapshot();
      if (fog && !latestFogRef.current) receiveSnapshot(fog);
    })();
    const unsubscribe = [
      api?.onMapState(receiveState),
      api?.onFogStroke((stroke) => {
        paintStroke(stroke);
        strokesDuringDecodeRef.current?.push(stroke);
      }),
      api?.onFogReset(() => {
        snapshotSeqRef.current += 1;
        strokesDuringDecodeRef.current = null;
        latestFogRef.current = null;
        const ctx = fogContext();
        if (ctx) fillMask(ctx, PLAYER_FOG_COLOR);
      }),
      api?.onFogSnapshot((snapshot) => receiveSnapshot(snapshot.dataUrl)),
      api?.onViewportPan((x, y) => setPan({ x, y })),
    ];
    return () => unsubscribe.forEach((stop) => stop?.());
    // Registered once; the handlers only touch refs and state setters
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Report the viewport size so the DM window can draw the frame
  useEffect(() => {
    const element = mainRef.current;
    if (!element) return;
    const report = () => window.electronAPI?.sendViewportSize(element.clientWidth, element.clientHeight);
    report();
    const observer = new ResizeObserver(report);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // ─── Full screen and idle controls ────────────────────────────────────────

  useEffect(() => {
    void window.electronAPI?.isFullScreen().then(setIsFullScreen);
    return window.electronAPI?.onFullScreenChanged(setIsFullScreen);
  }, []);

  useEffect(() => {
    let timer = window.setTimeout(() => setControlsVisible(false), CONTROLS_IDLE_MS);
    const wake = () => {
      setControlsVisible(true);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setControlsVisible(false), CONTROLS_IDLE_MS);
    };
    window.addEventListener('pointermove', wake);
    window.addEventListener('pointerdown', wake);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('pointermove', wake);
      window.removeEventListener('pointerdown', wake);
    };
  }, []);

  const toggleFullScreen = useCallback(() => void window.electronAPI?.toggleFullScreen(), []);

  // ─── Handouts ─────────────────────────────────────────────────────────────

  useEffect(() => {
    setHandoutZoom(1);
    setHandoutPan({ x: 0, y: 0 });
    if (!state.handoutUrl) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        window.electronAPI?.closeHandout();
        return;
      }
      const step = event.shiftKey ? 100 : 40;
      const offsets: Record<string, { x: number; y: number }> = {
        ArrowLeft: { x: step, y: 0 },
        ArrowRight: { x: -step, y: 0 },
        ArrowUp: { x: 0, y: step },
        ArrowDown: { x: 0, y: -step },
      };
      const offset = offsets[event.key];
      if (!offset) return;
      event.preventDefault();
      setHandoutPan((current) => ({ x: current.x + offset.x, y: current.y + offset.y }));
    };
    const overlay = handoutRef.current;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      const factor = event.deltaY < 0 ? 1.1 : 1 / 1.1;
      setHandoutZoom((zoom) => Math.min(MAX_HANDOUT_ZOOM, Math.max(MIN_HANDOUT_ZOOM, zoom * factor)));
    };
    window.addEventListener('keydown', onKeyDown);
    overlay?.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      overlay?.removeEventListener('wheel', onWheel);
    };
  }, [state.handoutUrl]);

  // Pause a video map while it is covered, to save power
  const videoRef = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (state.handoutUrl || state.blackout) video.pause();
    else void video.play().catch(() => undefined);
  }, [state.handoutUrl, state.blackout, state.mediaUrl]);

  // ─── Render ───────────────────────────────────────────────────────────────

  const oriented = mediaSize && (state.rotation % 180 === 0 ? mediaSize : { w: mediaSize.h, h: mediaSize.w });
  const handoutSideways = state.handoutRotation % 180 !== 0;
  const controlClass = `absolute z-30 flex h-9 w-9 items-center justify-center rounded border border-white/15 bg-black/60 text-white/80 transition-opacity duration-300 hover:text-white ${
    controlsVisible ? 'opacity-100' : 'pointer-events-none opacity-0'
  }`;

  return (
    <main
      ref={mainRef}
      className={`relative h-full overflow-hidden bg-black ${controlsVisible ? '' : 'cursor-none'}`}
    >
      {state.mediaUrl && pan ? (
        <div
          className="absolute left-0 top-0"
          style={{
            width: oriented?.w ?? 'max-content',
            height: oriented?.h ?? 'max-content',
            transform: `translate(${-pan.x * state.zoom}px, ${-pan.y * state.zoom}px) scale(${state.zoom})`,
            transformOrigin: 'top left',
          }}
        >
          <div
            className="relative"
            style={{
              width: mediaSize?.w ?? 'max-content',
              height: mediaSize?.h ?? 'max-content',
              left: '50%',
              top: '50%',
              transform:
                `translate(-50%, -50%) rotate(${state.rotation}deg) ` +
                `scaleX(${state.mirrorHorizontal ? -1 : 1}) scaleY(${state.mirrorVertical ? -1 : 1})`,
            }}
          >
            {state.mediaType === 'video' ? (
              <video
                key={state.mediaUrl}
                ref={videoRef}
                src={state.mediaUrl}
                autoPlay
                loop
                muted
                playsInline
                onLoadedMetadata={handleMediaLoad}
                className="block"
                style={mediaSize ? { width: mediaSize.w, height: mediaSize.h } : undefined}
              />
            ) : (
              <img
                key={state.mediaUrl}
                src={state.mediaUrl}
                alt=""
                draggable={false}
                onLoad={handleMediaLoad}
                className="block"
                style={mediaSize ? { width: mediaSize.w, height: mediaSize.h } : undefined}
              />
            )}
            <canvas ref={fogCanvasRef} className="pointer-events-none absolute inset-0 h-full w-full" />
          </div>
        </div>
      ) : (
        <div className="flex h-full items-center justify-center">
          <p className="font-display text-2xl tracking-wider text-[#3b3430]">Mini VTT</p>
        </div>
      )}

      {state.handoutUrl && (
        <div ref={handoutRef} className="absolute inset-0 z-10 flex items-center justify-center bg-black">
          <img
            src={state.handoutUrl}
            alt=""
            draggable={false}
            className="object-contain"
            style={{
              maxWidth: handoutSideways ? '100vh' : '100vw',
              maxHeight: handoutSideways ? '100vw' : '100vh',
              transform:
                `translate3d(${handoutPan.x}px, ${handoutPan.y}px, 0) ` +
                `rotate(${state.handoutRotation}deg) scale(${handoutZoom})`,
            }}
          />
          <button
            onClick={() => window.electronAPI?.closeHandout()}
            title="Close handout (Esc)"
            aria-label="Close handout"
            className={`${controlClass} right-3 top-3`}
          >
            <X className="h-5 w-5" />
          </button>
        </div>
      )}

      {state.blackout && <div className="absolute inset-0 z-20 bg-black" aria-label="Blackout" />}

      <button
        onClick={toggleFullScreen}
        title={isFullScreen ? 'Exit full screen (F11)' : 'Full screen (F11)'}
        aria-label={isFullScreen ? 'Exit full screen' : 'Full screen'}
        className={`${controlClass} bottom-3 right-3`}
      >
        {isFullScreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
      </button>
    </main>
  );
}

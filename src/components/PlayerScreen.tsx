// The player screen: shows the framed part of the map with solid black fog,
// plus handouts and blackout. Everything is driven from the DM window over IPC;
// this window only reports its size back.
//
// Its two buttons (full screen, close handout) fade out when the mouse is idle,
// so players see nothing but the map.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Maximize2, Minimize2, X } from 'lucide-react';
import type { EffectSnapshot, FogSnapshot, MapState, PlayerGrid, RulerState } from '../types/map';
import { mediaUrlOf } from '../lib/media';
import { drawSnapshot, fillMask, fogMaskSize, loadImage } from '../lib/fog';
import { EFFECT_OPACITY, showLayer } from '../lib/effects';
import { DrawnAreas } from './DrawnAreas';
import { RulerGraphic } from './MeasureLayer';
import { clamp, mapToOriented, wheelPixels, type Size } from '../lib/geometry';
import { keyLabel } from '../lib/platform';
import { releaseVideo } from '../lib/video';

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
  areas: [],
  grid: null,
};

export function PlayerScreen() {
  const [state, setState] = useState<MapState>(INITIAL_STATE);
  const [pan, setPan] = useState<{ x: number; y: number } | null>(null);
  const [mediaSize, setMediaSize] = useState<Size | null>(null);
  const [isFullScreen, setIsFullScreen] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  // The DM's ruler, when they show it to players (map pixels)
  const [ruler, setRuler] = useState<RulerState | null>(null);

  const mainRef = useRef<HTMLElement>(null);
  const fogCanvasRef = useRef<HTMLCanvasElement>(null);
  const mediaSizeRef = useRef<Size | null>(null);
  // The latest snapshot for the current map. Kept, not consumed, so it can be
  // re-applied when this window's copy of the map finishes loading: the
  // snapshot often arrives first.
  const latestFogRef = useRef<string | null>(null);
  const currentMediaUrlRef = useRef<string | null>(null);
  // Snapshots decode asynchronously. Each gets a sequence number so a stale one
  // that finishes late is ignored.
  const snapshotSeqRef = useRef(0);
  // Painted effects: the latest layer for the current map (null: none)
  const effectsCanvasRef = useRef<HTMLCanvasElement>(null);
  const latestEffectsRef = useRef<string | null>(null);
  const effectsSeqRef = useRef(0);

  // ─── Fog ──────────────────────────────────────────────────────────────────

  const fogContext = () => {
    const canvas = fogCanvasRef.current;
    return canvas && canvas.width > 0 ? canvas.getContext('2d') : null;
  };

  // The DM's whole stroke arrives as one snapshot, so a room is revealed at once
  const applySnapshot = async (dataUrl: string) => {
    if (!fogContext()) return;
    const seq = ++snapshotSeqRef.current;
    try {
      const image = await loadImage(dataUrl);
      const ctx = fogContext();
      if (seq === snapshotSeqRef.current && ctx) drawSnapshot(ctx, image, PLAYER_FOG_COLOR);
    } catch {
      // A damaged snapshot: keep showing the previous fog
    }
  };

  /**
   * Whether a snapshot is for the map on screen. The main process sends
   * only those, but one may still be on its way when the map changes.
   */
  const isShown = (mapId: string) => mediaUrlOf(mapId) === currentMediaUrlRef.current;

  const receiveSnapshot = ({ mapId, dataUrl }: FogSnapshot) => {
    if (!isShown(mapId)) return;
    latestFogRef.current = dataUrl;
    void applySnapshot(dataUrl);
  };

  // ─── Painted effects (one snapshot per change, drawn under the fog) ──────

  const applyEffects = async () => {
    const canvas = effectsCanvasRef.current;
    if (!canvas) return;
    const seq = ++effectsSeqRef.current;
    const dataUrl = latestEffectsRef.current;
    if (!dataUrl) {
      showLayer(canvas, null);
      return;
    }
    try {
      const image = await loadImage(dataUrl);
      if (seq === effectsSeqRef.current) showLayer(canvas, image);
    } catch {
      // A damaged snapshot: keep showing the previous layer
    }
  };

  const receiveEffects = ({ mapId, dataUrl }: EffectSnapshot) => {
    if (!isShown(mapId)) return;
    latestEffectsRef.current = dataUrl;
    void applyEffects();
  };

  const receiveState = (next: MapState) => {
    // A different map: the stored snapshots belong to the old one
    if (next.mediaUrl !== currentMediaUrlRef.current) {
      currentMediaUrlRef.current = next.mediaUrl;
      latestFogRef.current = null;
      setRuler(null);
      // In the same render as the new map, so its image's load (handleMediaLoad)
      // always comes after: an effect could run after a cached image had loaded
      setMediaSize(null);
      latestEffectsRef.current = null;
      void applyEffects();
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
    void applyEffects();
  };

  // ─── Subscriptions (registered before the first viewport report) ──────────

  useEffect(() => {
    const api = window.electronAPI;
    // Everything as the main process has it, for one map. A part that has
    // already arrived live is newer and wins; the state comes first, so the
    // snapshots are checked against the right map.
    const live = { state: false, pan: false, fog: false, effects: false };
    void (async () => {
      const sync = await api?.requestPlayerSync();
      if (!sync) return;
      if (sync.state && !live.state) receiveState(sync.state);
      if (sync.pan && !live.pan) setPan(sync.pan);
      if (sync.fog && !live.fog) receiveSnapshot(sync.fog);
      if (sync.effects && !live.effects) receiveEffects(sync.effects);
    })();
    const unsubscribe = [
      api?.onMapState((state) => {
        live.state = true;
        receiveState(state);
      }),
      api?.onFogReset(() => {
        live.fog = true;
        snapshotSeqRef.current += 1;
        latestFogRef.current = null;
        const ctx = fogContext();
        if (ctx) fillMask(ctx, PLAYER_FOG_COLOR);
      }),
      api?.onFogSnapshot((snapshot) => {
        live.fog = true;
        receiveSnapshot(snapshot);
      }),
      api?.onEffectsSnapshot((snapshot) => {
        live.effects = true;
        receiveEffects(snapshot);
      }),
      api?.onViewportPan((x, y) => {
        live.pan = true;
        setPan({ x, y });
      }),
      api?.onRuler(setRuler),
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

  // A replaced or unloaded video lets go of its file and decoder straight away
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const setVideo = useCallback((element: HTMLVideoElement | null) => {
    if (!element) releaseVideo(videoRef.current);
    videoRef.current = element;
  }, []);

  // Pause a video map while it is covered, to save power
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (state.handoutUrl || state.blackout) video.pause();
    else void video.play().catch(() => undefined);
  }, [state.handoutUrl, state.blackout, state.mediaUrl]);

  // ─── Render ───────────────────────────────────────────────────────────────

  /** Map natural pixels → this window's pixels */
  const toScreen = (point: { x: number; y: number }) => {
    if (!mediaSize || !pan) return point;
    const at = mapToOriented(point, mediaSize, state);
    return { x: (at.x - pan.x) * state.zoom, y: (at.y - pan.y) * state.zoom };
  };
  const oriented = mediaSize && (state.rotation % 180 === 0 ? mediaSize : { w: mediaSize.h, h: mediaSize.w });
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
                ref={setVideo}
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
            {/* Draw order: map, effects, spell areas, fog, so neither shows through unrevealed areas */}
            <canvas
              ref={effectsCanvasRef}
              // 0×0 until a layer arrives (a bare canvas would allocate 300×150)
              width={0}
              height={0}
              className="pointer-events-none absolute inset-0 h-full w-full"
              style={{ opacity: EFFECT_OPACITY }}
            />
            <DrawnAreas discs={state.areas} media={mediaSize} />
            {state.grid && <MapGridLines grid={state.grid} zoom={state.zoom} />}
            <canvas ref={fogCanvasRef} className="pointer-events-none absolute inset-0 h-full w-full" />
          </div>
        </div>
      ) : (
        <div className="flex h-full items-center justify-center">
          <p className="font-display text-2xl tracking-wider text-[#3b3430]">Mini VTT</p>
        </div>
      )}

      {/* Over the fog, in screen pixels, so it reads the same at any zoom */}
      {ruler && mediaSize && pan && state.mediaUrl && !state.handoutUrl && (
        <div aria-label="Ruler" className="pointer-events-none absolute inset-0">
          <RulerGraphic points={ruler.points.map(toScreen)} feet={ruler.feet} large />
        </div>
      )}

      {state.handoutUrl && (
        <Handout
          // Each handout opens centred at its fitted size
          key={state.handoutUrl}
          url={state.handoutUrl}
          rotation={state.handoutRotation}
          controlsVisible={controlsVisible}
          closeClass={`${controlClass} right-3 top-3`}
        />
      )}

      {state.blackout && <div className="absolute inset-0 z-20 bg-black" aria-label="Blackout" />}

      <button
        onClick={toggleFullScreen}
        title={keyLabel(isFullScreen ? 'Exit full screen (F11)' : 'Full screen (F11)')}
        aria-label={isFullScreen ? 'Exit full screen' : 'Full screen'}
        className={`${controlClass} bottom-3 right-3`}
      >
        {isFullScreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
      </button>
    </main>
  );
}

// ─── Handout ──────────────────────────────────────────────────────────────────

interface HandoutProps {
  url: string;
  /** 0, 90, 180 or 270 */
  rotation: number;
  /** False while the mouse is idle: the pointer is hidden then */
  controlsVisible: boolean;
  closeClass: string;
}

/**
 * A handout over the map. Dragging or the arrow keys move it, the wheel zooms
 * it around the pointer, and Esc closes it. Moving it re-renders only
 * this, not the map beneath.
 */
function Handout({ url, rotation, controlsVisible, closeClass }: HandoutProps) {
  // The zoom, and where the handout's centre sits relative to the screen's
  // centre. One state, so a zoom can move the handout to keep the spot under
  // the pointer where it is.
  const [view, setView] = useState({ zoom: 1, x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const overlayRef = useRef<HTMLDivElement>(null);
  /** The pointer dragging the handout, and where it was last */
  const dragRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);

  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;
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
      setView((current) => ({ ...current, x: current.x + offset.x, y: current.y + offset.y }));
    };
    // With or without Ctrl (a touchpad pinch arrives as Ctrl + wheel)
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      // By how far the wheel turned: about 1.1× a notch, and a touchpad's many
      // small steps add up to the same instead of 1.1× each
      const factor = Math.exp(-wheelPixels(event) * 0.001);
      if (factor === 1) return;
      // The pointer, from the screen's centre, where an unmoved handout's centre is
      const rect = overlay.getBoundingClientRect();
      const px = event.clientX - rect.left - rect.width / 2;
      const py = event.clientY - rect.top - rect.height / 2;
      setView((current) => {
        const zoom = clamp(current.zoom * factor, MIN_HANDOUT_ZOOM, MAX_HANDOUT_ZOOM);
        // Scale the handout's offset from the pointer, so the spot under it stays put
        const scale = zoom / current.zoom;
        return { zoom, x: px - (px - current.x) * scale, y: py - (py - current.y) * scale };
      });
    };
    window.addEventListener('keydown', onKeyDown);
    overlay.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      overlay.removeEventListener('wheel', onWheel);
    };
  }, []);

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    // The left button drags; the close button keeps its click
    if (event.button !== 0 || (event.target as Element).closest('button')) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    setDragging(true);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    // By the step since the last move, so a zoom or arrow key during the drag isn't undone
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    drag.x = event.clientX;
    drag.y = event.clientY;
    setView((current) => ({ ...current, x: current.x + dx, y: current.y + dy }));
  };

  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragging(false);
  };

  const sideways = rotation % 180 !== 0;
  const cursor = !controlsVisible ? '' : dragging ? 'cursor-grabbing' : 'cursor-grab';

  return (
    <div
      ref={overlayRef}
      aria-label="Handout"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      className={`absolute inset-0 z-10 flex touch-none items-center justify-center bg-black ${cursor}`}
    >
      <img
        src={url}
        alt=""
        draggable={false}
        className="object-contain"
        style={{
          maxWidth: sideways ? '100vh' : '100vw',
          maxHeight: sideways ? '100vw' : '100vh',
          transform: `translate3d(${view.x}px, ${view.y}px, 0) rotate(${rotation}deg) scale(${view.zoom})`,
        }}
      />
      <button
        onClick={() => window.electronAPI?.closeHandout()}
        title="Close handout (Esc)"
        aria-label="Close handout"
        className={closeClass}
      >
        <X className="h-5 w-5" />
      </button>
    </div>
  );
}

/**
 * The map's measured grid, in map pixels inside the zoomed and turned map, so
 * it follows the map; lines stay one screen pixel wide at any zoom. An SVG
 * pattern: the browser draws it once, and again only when the view changes.
 */
function MapGridLines({ grid, zoom }: { grid: PlayerGrid; zoom: number }) {
  const { cell, offsetX, offsetY } = grid;
  const width = 1 / zoom;
  return (
    <svg aria-label="Grid" className="pointer-events-none absolute inset-0 h-full w-full">
      <defs>
        <pattern
          id="player-grid"
          patternUnits="userSpaceOnUse"
          x={offsetX}
          y={offsetY}
          width={cell}
          height={cell}
        >
          <path
            d={`M0 ${width / 2}H${cell}M${width / 2} 0V${cell}`}
            stroke="rgb(255 255 255 / 0.35)"
            strokeWidth={width}
          />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill="url(#player-grid)" />
    </svg>
  );
}

// What the players see, at the right of the toolbar: in one place that never
// moves, whatever the tool. The tools' options are the DM's own; these are the
// player screen's, much as a presenter view keeps the audience's controls
// apart from the speaker's. In order: the player screen (open or close it),
// Blackout and Slideshow, then True scale, Fill screen, the zoom lock and the
// player view's zoom.
//
// They sit together in one dark track, each with an icon, so they read apart
// from the tool's options. The toolbar gives them the room its options leave,
// as a size container: with less room, the buttons show their icons only (the
// names stay for screen readers and in the tooltips), Player screen, Blackout
// and Slideshow last. The zoom is always just its percentage, to type in; the
// + and − keys and the mouse wheel step it. Pure CSS, so nothing runs on
// resize.
//
// While players see something other than the map (the kill screen, the
// slideshow, a blackout or a handout), the group turns crimson and says what
// they see and how to go back. In the toolbar, not a banner above the map, so
// the map area keeps its size and the map doesn't jump. With the interface
// hidden (Ctrl+Shift+B) only that message stays, in PlayerStatusBar, so the DM
// still sees that the players don't see the map.

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Expand, Grid3x3, Images, Lock, LockOpen, Monitor, MonitorOff } from 'lucide-react';
import { Button, Divider, inputClass } from '../ui/controls';
import { Popover } from '../ui/Popover';
import { clampZoom, MAX_ZOOM, MIN_ZOOM } from '../lib/geometry';
import { keyLabel } from '../lib/platform';
import type { DmPlayerScreen, DmPlayerView, TrueScaleNeed } from '../hooks/useDmController';

interface PlayerControlsProps {
  playerView: DmPlayerView;
  playerScreen: DmPlayerScreen;
  hasMap: boolean;
  /** Where True scale sends the DM when the player screen's size isn't set */
  openSettings: () => void;
}

/**
 * What players see instead of the map: a short line for the bar, the whole
 * sentence for its tooltip, and the button that brings the map back.
 */
interface PlayerStatus {
  text: string;
  detail: string;
  action?: {
    label: string;
    onClick: () => void;
    /** The bar's own crimson button does the same, so only the bare status line needs it */
    inBar?: false;
  };
}

function playerStatus(playerScreen: DmPlayerScreen): PlayerStatus | null {
  const { killScreen, slideshow, blackout, activeHandoutId } = playerScreen;
  if (killScreen) {
    return {
      text: keyLabel('Players see the kill screen (Ctrl+K hides it)'),
      detail: keyLabel('Players see the kill screen. Ctrl+K hides it.'),
    };
  }
  if (slideshow) {
    const pictures = slideshow.count === 1 ? 'one picture' : `${slideshow.count} pictures`;
    return {
      text: `Players see the slideshow: ${pictures} from “${slideshow.folderName}”`,
      detail: `Players see the slideshow: ${pictures} from “${slideshow.folderName}”. Get the next map ready; they see it when you show the map (Slideshow, or P).`,
      action: { label: 'Show the map', onClick: playerScreen.toggleSlideshow, inBar: false },
    };
  }
  if (blackout) {
    return {
      text: 'Players see black',
      detail: 'The player screen is blacked out. Blackout, or B, shows the map again.',
      action: { label: 'Show the map', onClick: playerScreen.toggleBlackout, inBar: false },
    };
  }
  if (activeHandoutId) {
    const name = playerScreen.activeHandoutName ?? 'Handout';
    return {
      text: `Players see the handout “${name}”`,
      detail: `Players are looking at the handout “${name}”.`,
      action: { label: 'Hide handout', onClick: playerScreen.hideHandout },
    };
  }
  return null;
}

/** The status line, cut short in the toolbar (the tooltip has all of it), and its button. */
function StatusMessage({ status, inBar }: { status: PlayerStatus; inBar: boolean }) {
  const { action } = status;
  return (
    <>
      <span
        role="status"
        className={`min-w-0 truncate px-1 text-[13px] text-ink ${inBar ? 'max-w-64' : ''}`}
        title={status.detail}
      >
        {status.text}
      </span>
      {action && (!inBar || action.inBar !== false) && (
        <Button tone="plain" className="h-7 shrink-0" onClick={action.onClick}>
          {action.label}
        </Button>
      )}
    </>
  );
}

/** What the note by True scale says, and its button, for each thing it needs. */
const TRUE_SCALE_NOTES: Record<TrueScaleNeed, { text: string; action: string }> = {
  setup: {
    text: 'True scale needs the player screen’s size, to work out how big a square is on it.',
    action: 'Open Settings',
  },
  player: {
    text: 'True scale needs the player screen open, to know its size in pixels.',
    action: 'Open player screen',
  },
  grid: {
    text: 'True scale needs this map’s grid, to know how big its squares are. Click two corners of a square and save it, and True scale follows.',
    action: 'Measure grid',
  },
};

// The container widths at which the bar changes (Tailwind needs them written
// out in each class): at 33rem Player screen, Blackout and Slideshow show their
// names; at 42rem the other buttons too; and at 59rem the line saying what
// players see instead of the map is shown too.

/** A button's name: shown where the bar has room, else read out only (the icon shows). */
const Label = ({ children }: { children: string }) => (
  <span className="sr-only @min-[42rem]:not-sr-only">{children}</span>
);

/** The name of Player screen, Blackout or Slideshow, which keep theirs longest. */
const MainLabel = ({ children }: { children: string }) => (
  <span className="sr-only @min-[33rem]:not-sr-only">{children}</span>
);

/** Narrower sides for a button while it shows only its icon */
const COMPACT_PADDING = 'px-2! @min-[42rem]:px-3!';
const MAIN_COMPACT_PADDING = 'px-2! @min-[33rem]:px-3!';

// Memoized: the DM window re-renders on every frame of a drag, and these
// never depend on that
export const PlayerControls = memo(function PlayerControls({
  playerView,
  playerScreen,
  hasMap,
  openSettings,
}: PlayerControlsProps) {
  const { zoom, zoomLocked, trueScaleNeeds } = playerView;
  const status = playerStatus(playerScreen);

  // The note by True scale saying what it still needs
  const trueScaleRef = useRef<HTMLButtonElement>(null);
  const [trueScaleNote, setTrueScaleNote] = useState(false);
  const closeTrueScaleNote = useCallback(() => setTrueScaleNote(false), []);
  useEffect(() => {
    if (!trueScaleNeeds) setTrueScaleNote(false);
  }, [trueScaleNeeds]);

  return (
    <div
      role="group"
      aria-label="Player screen"
      title={status?.detail}
      // An outline, not a border, so the group keeps its size when it turns crimson
      className={`flex h-8 min-w-0 items-center rounded ${
        status ? 'bg-crimson-deep outline outline-crimson' : 'bg-ground'
      }`}
    >
      {/* Only where the toolbar has room for it; the crimson still says
        players don't see the map, and the group's tooltip what they see */}
      {status && (
        <span className="hidden min-w-0 items-center gap-2 pl-1 @min-[59rem]:flex">
          <StatusMessage status={status} inBar />
        </span>
      )}
      <Button
        tone="plain"
        className={MAIN_COMPACT_PADDING}
        onClick={playerScreen.togglePlayer}
        title={
          playerScreen.playerOpen
            ? 'Close the player window. The red dot: the player screen is live.'
            : 'Open the player window'
        }
      >
        <span aria-hidden="true" className="relative">
          <Monitor className="h-4 w-4" />
          {playerScreen.playerOpen && (
            <span className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-crimson-bright ring-2 ring-ground" />
          )}
        </span>
        <MainLabel>Player screen</MainLabel>
        {playerScreen.playerOpen && <span className="sr-only">(live)</span>}
      </Button>
      <Button
        tone={playerScreen.blackout ? 'live' : 'plain'}
        className={MAIN_COMPACT_PADDING}
        aria-pressed={playerScreen.blackout}
        onClick={playerScreen.toggleBlackout}
        title="Blackout (B): hide everything on the player screen."
      >
        <MonitorOff aria-hidden="true" className="h-4 w-4" />
        <MainLabel>Blackout</MainLabel>
      </Button>
      <Button
        tone={playerScreen.slideshow ? 'live' : 'plain'}
        className={MAIN_COMPACT_PADDING}
        aria-pressed={!!playerScreen.slideshow}
        onClick={playerScreen.toggleSlideshow}
        title="Slideshow (P): show the pictures in the slideshow folder in place of the map, while you get the next one ready. Choose the folder in Settings."
      >
        <Images aria-hidden="true" className="h-4 w-4" />
        <MainLabel>Slideshow</MainLabel>
      </Button>
      <Divider />
      <Button
        ref={trueScaleRef}
        className={COMPACT_PADDING}
        tone={playerView.atTrueScale ? 'on' : 'plain'}
        aria-pressed={playerView.atTrueScale}
        aria-haspopup={trueScaleNeeds ? 'dialog' : undefined}
        aria-expanded={trueScaleNeeds ? trueScaleNote : undefined}
        onClick={() => (trueScaleNeeds ? setTrueScaleNote((shown) => !shown) : playerView.trueScale())}
        disabled={!hasMap || zoomLocked}
        title="True scale: zoom the player view so the map’s squares are the grid square size from Settings, for miniatures. A map without a grid gets it measured first."
      >
        <Grid3x3 aria-hidden="true" className="h-4 w-4" />
        <Label>True scale</Label>
      </Button>
      <Button
        className={COMPACT_PADDING}
        tone={playerView.fillScreen ? 'on' : 'plain'}
        aria-pressed={playerView.fillScreen}
        onClick={playerView.toggleFillScreen}
        // Turning it on zooms the player view; turning it off doesn't
        disabled={!hasMap || !playerScreen.playerOpen || (zoomLocked && !playerView.fillScreen)}
        title="Fill screen: zoom the player view so the map fills the player screen with no black edges, and keep the frame on the map. A player window that isn't full screen first takes the shape of its screen."
      >
        <Expand aria-hidden="true" className="h-4 w-4" />
        <Label>Fill screen</Label>
      </Button>
      <Button
        square
        tone={zoomLocked ? 'on' : 'plain'}
        aria-pressed={zoomLocked}
        aria-label="Lock zoom"
        onClick={playerView.toggleZoomLock}
        title={
          zoomLocked
            ? 'Player view zoom is locked: the mouse wheel, the + and − keys and the zoom field leave it alone. Click or press Space to unlock.'
            : 'Lock the player view zoom (Space), so the mouse wheel or the + and − keys can’t change it by accident'
        }
      >
        {zoomLocked ? <Lock className="h-3.5 w-3.5" /> : <LockOpen className="h-3.5 w-3.5" />}
      </Button>
      <ZoomField zoom={zoom} onChange={playerView.setZoom} disabled={!hasMap || zoomLocked} />
      <Popover
        open={trueScaleNote && trueScaleNeeds !== null}
        onClose={closeTrueScaleNote}
        anchorRef={trueScaleRef}
        label="True scale"
      >
        {trueScaleNeeds && (
          <>
            <p>{TRUE_SCALE_NOTES[trueScaleNeeds].text}</p>
            <div className="mt-3 flex justify-end">
              <Button
                tone="active"
                onClick={() => {
                  setTrueScaleNote(false);
                  if (trueScaleNeeds === 'setup') openSettings();
                  else if (trueScaleNeeds === 'player') playerScreen.openPlayer();
                  else playerView.trueScale();
                }}
              >
                {TRUE_SCALE_NOTES[trueScaleNeeds].action}
              </Button>
            </div>
          </>
        )}
      </Popover>
    </div>
  );
});

/** With the interface hidden, a line at the top saying what players see instead of the map, if anything. */
export const PlayerStatusBar = memo(function PlayerStatusBar({
  playerScreen,
}: {
  playerScreen: DmPlayerScreen;
}) {
  const status = playerStatus(playerScreen);
  if (!status) return null;
  return (
    <div
      role="group"
      aria-label="What players see"
      className="flex min-h-12 shrink-0 items-center gap-2 border-b border-crimson bg-crimson-deep px-3 py-2"
    >
      <StatusMessage status={status} inBar={false} />
    </div>
  );
});

/** The player view's zoom, as a percentage: typed in, it applies on Enter or when the field is left. */
function ZoomField({
  zoom,
  onChange,
  disabled,
}: {
  zoom: number;
  onChange: (zoom: number) => void;
  disabled: boolean;
}) {
  const [text, setText] = useState(String(Math.round(zoom * 100)));
  const editingRef = useRef(false);

  useEffect(() => {
    if (!editingRef.current) setText(String(Math.round(zoom * 100)));
  }, [zoom]);

  const commit = () => {
    const parsed = parseFloat(text);
    if (Number.isFinite(parsed) && parsed > 0) onChange(clampZoom(parsed / 100));
    else setText(String(Math.round(zoom * 100)));
  };

  return (
    <span
      className="relative inline-flex"
      title="Player view zoom: type a percentage, or use the + and − keys, the mouse wheel over the player frame in the View tool, or Alt + mouse wheel in 1% steps"
    >
      <input
        type="number"
        aria-label="Zoom percentage"
        min={Math.round(MIN_ZOOM * 100)}
        max={Math.round(MAX_ZOOM * 100)}
        value={text}
        disabled={disabled}
        onChange={(event) => setText(event.target.value)}
        onFocus={(event) => {
          editingRef.current = true;
          event.currentTarget.select();
        }}
        onBlur={() => {
          editingRef.current = false;
          commit();
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
        }}
        className={`${inputClass} w-16 pr-6 text-right disabled:opacity-40`}
      />
      <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[13px] text-muted">
        %
      </span>
    </span>
  );
}

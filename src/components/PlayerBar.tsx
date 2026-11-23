// The bar beneath the map: everything about what the players see, in one place
// that never moves, whatever the tool. The toolbar above the map is for the
// DM's own tools; this one is the player screen's, much as a presenter view
// keeps the audience's controls apart from the speaker's.
//   left    the player screen (open it, or bring it to the front), Blackout
//           and Slideshow
//   middle  while players see something other than the map (the kill screen,
//           the slideshow, a blackout or a handout), what they see and how to
//           go back; the bar turns crimson then. In the bar, not a banner above
//           the map, so the map area keeps its size and the map doesn't jump
//   right   the player view's zoom, its lock, Fill screen and True scale
//
// With the interface hidden (Ctrl+Shift+B) only that message stays, while there
// is one, so the DM still sees that the players don't see the map.

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Lock, LockOpen, Minus, Plus } from 'lucide-react';
import { Button, ButtonGroup, inputClass } from '../ui/controls';
import { Popover } from '../ui/Popover';
import { clampZoom, MAX_ZOOM, MIN_ZOOM, stepZoom } from '../lib/geometry';
import { keyLabel } from '../lib/platform';
import type { DmPlayerScreen, DmPlayerView, TrueScaleNeed } from '../hooks/useDmController';

interface PlayerBarProps {
  playerView: DmPlayerView;
  playerScreen: DmPlayerScreen;
  hasMap: boolean;
  /** Where True scale sends the DM when the player screen's size isn't set */
  openSettings: () => void;
  /** The interface is hidden: show only what players see instead of the map, if anything */
  statusOnly: boolean;
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

/** The status line, cut short where the bar is narrow (the tooltip has all of it), and its button. */
function StatusMessage({ status, inBar }: { status: PlayerStatus; inBar: boolean }) {
  const { action } = status;
  return (
    <>
      <span role="status" className="min-w-0 truncate text-[13px] text-ink" title={status.detail}>
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

// Memoized: the DM window re-renders on every frame of a drag, and the bar
// never depends on that
export const PlayerBar = memo(function PlayerBar({
  playerView,
  playerScreen,
  hasMap,
  openSettings,
  statusOnly,
}: PlayerBarProps) {
  const { zoom, zoomLocked, trueScaleNeeds } = playerView;
  const status = playerStatus(playerScreen);

  // The note by True scale saying what it still needs
  const trueScaleRef = useRef<HTMLButtonElement>(null);
  const [trueScaleNote, setTrueScaleNote] = useState(false);
  const closeTrueScaleNote = useCallback(() => setTrueScaleNote(false), []);
  useEffect(() => {
    if (!trueScaleNeeds) setTrueScaleNote(false);
  }, [trueScaleNeeds]);

  const barClass = `flex min-h-12 shrink-0 items-center gap-2 border-t px-3 py-2 ${
    status ? 'border-crimson bg-crimson-deep' : 'border-line bg-panel'
  }`;

  if (statusOnly) {
    return status ? (
      <div role="group" aria-label="Player screen" className={barClass}>
        <StatusMessage status={status} inBar={false} />
      </div>
    ) : null;
  }

  return (
    <div role="group" aria-label="Player screen" className={`${barClass} flex-wrap`}>
      <Button
        tone="plain"
        onClick={playerScreen.openPlayer}
        title={
          playerScreen.playerOpen
            ? 'Bring the player window to the front. The red dot: the player screen is live.'
            : 'Open the player window'
        }
      >
        <span
          aria-hidden="true"
          className={`h-2 w-2 rounded-full ${playerScreen.playerOpen ? 'bg-crimson-bright' : 'border border-muted'}`}
        />
        {playerScreen.playerOpen ? 'Player screen' : 'Open player screen'}
        {playerScreen.playerOpen && <span className="sr-only">(live)</span>}
      </Button>
      <Button
        tone={playerScreen.blackout ? 'live' : 'plain'}
        aria-pressed={playerScreen.blackout}
        onClick={playerScreen.toggleBlackout}
        title="Blackout (B): hide everything on the player screen."
      >
        Blackout
      </Button>
      <Button
        tone={playerScreen.slideshow ? 'live' : 'plain'}
        aria-pressed={!!playerScreen.slideshow}
        onClick={playerScreen.toggleSlideshow}
        title="Slideshow (P): show the pictures in the slideshow folder in place of the map, while you get the next one ready. Choose the folder in Settings."
      >
        Slideshow
      </Button>

      <div className="flex min-w-0 flex-1 items-center gap-3 px-2">
        {status && <StatusMessage status={status} inBar />}
      </div>

      <ZoomControl zoom={zoom} onChange={playerView.setZoom} disabled={!hasMap || zoomLocked} />
      <Button
        square
        tone={zoomLocked ? 'on' : 'plain'}
        aria-pressed={zoomLocked}
        aria-label="Lock zoom"
        onClick={playerView.toggleZoomLock}
        title={
          zoomLocked
            ? 'Player view zoom is locked: the mouse wheel, the + and − keys and the zoom buttons leave it alone. Click or press Space to unlock.'
            : 'Lock the player view zoom (Space), so the mouse wheel or the + and − keys can’t change it by accident'
        }
      >
        {zoomLocked ? <Lock className="h-3.5 w-3.5" /> : <LockOpen className="h-3.5 w-3.5" />}
      </Button>
      <Button
        tone={playerView.fillScreen ? 'on' : 'plain'}
        aria-pressed={playerView.fillScreen}
        onClick={playerView.toggleFillScreen}
        // Turning it on zooms the player view; turning it off doesn't
        disabled={!hasMap || !playerScreen.playerOpen || (zoomLocked && !playerView.fillScreen)}
        title="Fill screen: zoom the player view so the map fills the player screen with no black edges, and keep the frame on the map. A player window that isn't full screen first takes the shape of its screen."
      >
        Fill screen
      </Button>
      <Button
        ref={trueScaleRef}
        tone={playerView.atTrueScale ? 'on' : 'plain'}
        aria-pressed={playerView.atTrueScale}
        aria-haspopup={trueScaleNeeds ? 'dialog' : undefined}
        aria-expanded={trueScaleNeeds ? trueScaleNote : undefined}
        onClick={() => (trueScaleNeeds ? setTrueScaleNote((shown) => !shown) : playerView.trueScale())}
        disabled={!hasMap || zoomLocked}
        title="True scale: zoom the player view so the map’s squares are the grid square size from Settings, for miniatures. A map without a grid gets it measured first."
      >
        True scale
      </Button>
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

/** Player zoom − [ 100 % ] +  The field accepts a typed percentage on Enter or blur. */
function ZoomControl({
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
    <div
      className="flex items-center gap-2"
      title="Player view zoom: + and − keys, mouse wheel over the player frame in the View tool, or Alt + mouse wheel in 1% steps"
    >
      <span className="text-[13px] text-muted">Player zoom</span>
      <ButtonGroup track label="Player view zoom">
        <Button
          square
          tone="plain"
          onClick={() => onChange(stepZoom(zoom, -1))}
          disabled={disabled}
          aria-label="Zoom out"
        >
          <Minus className="h-3.5 w-3.5" />
        </Button>
        <span className="relative z-10 -ml-px inline-flex">
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
            // Square inside its group: rounded-none! wins over the field's own rounding
            className={`${inputClass} w-16 rounded-none! pr-6 text-right disabled:opacity-40`}
          />
          <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[13px] text-muted">
            %
          </span>
        </span>
        <Button
          square
          tone="plain"
          onClick={() => onChange(stepZoom(zoom, 1))}
          disabled={disabled}
          aria-label="Zoom in"
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </ButtonGroup>
    </div>
  );
}

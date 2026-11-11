// The welcome screen, and the player screen setup and keyboard shortcut dialogs.

import { useState } from 'react';
import { Dialog } from '../ui/Dialog';
import { Button, ButtonGroup, Kbd, inputClass } from '../ui/controls';
import type { Size } from '../lib/geometry';
import { keyLabel } from '../lib/platform';
import { FRAME_COLORS, FRAME_COLOR_STYLES, type FrameColor } from '../lib/frameColors';
import { SHORTCUT_GROUPS, waysOf } from '../lib/shortcuts';

interface PlayerSetupDialogProps {
  diagonal: number | null;
  gridSize: number;
  /** Rotation for new maps and handouts taller than wide: 0, 90 or 270 */
  portraitRotation: number;
  /** Colour of the player view frame in the DM window */
  frameColor: FrameColor;
  viewportSize: Size | null;
  onSave: (
    diagonal: number | null,
    gridSize: number,
    portraitRotation: number,
    frameColor: FrameColor,
  ) => void;
  onClose: () => void;
}

const PORTRAIT_CHOICES = [
  { rotation: 0, label: 'Don’t rotate' },
  { rotation: 90, label: 'Rotate right' },
  { rotation: 270, label: 'Rotate left' },
];

/** Physical width and height of a screen with this diagonal and aspect ratio. */
export function screenDimensions(diagonal: number, viewport: Size) {
  const aspect = viewport.w / viewport.h;
  const norm = Math.sqrt(aspect * aspect + 1);
  return { width: (diagonal * aspect) / norm, height: diagonal / norm };
}

export function PlayerSetupDialog({
  diagonal,
  gridSize,
  portraitRotation,
  frameColor,
  viewportSize,
  onSave,
  onClose,
}: PlayerSetupDialogProps) {
  const [diagonalText, setDiagonalText] = useState(diagonal === null ? '' : String(diagonal));
  const [gridText, setGridText] = useState(String(gridSize));
  const [rotation, setRotation] = useState(portraitRotation);
  const [color, setColor] = useState(frameColor);

  const parsedDiagonal = parseFloat(diagonalText);
  const validDiagonal = Number.isFinite(parsedDiagonal) && parsedDiagonal > 0 ? parsedDiagonal : null;
  const parsedGrid = parseFloat(gridText);
  const validGrid = Number.isFinite(parsedGrid) && parsedGrid > 0 ? parsedGrid : null;
  const dimensions = validDiagonal && viewportSize ? screenDimensions(validDiagonal, viewportSize) : null;

  const save = () => {
    onSave(validDiagonal, validGrid ?? gridSize, rotation, color);
    onClose();
  };

  return (
    <Dialog
      title="Player screen setup"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button tone="active" onClick={save} disabled={diagonalText.trim() !== '' && !validDiagonal}>
            Save
          </Button>
        </>
      }
    >
      <p className="mb-4 text-[13px] leading-relaxed text-muted">
        With the screen size set, the player frame shows a grid that matches the physical screen, so
        miniatures line up with the map, and True scale zooms a map so its own squares are that size. Use any
        unit, as long as both values use the same one.
      </p>
      <div className="grid grid-cols-2 gap-3">
        <label className="flex flex-col gap-1.5 text-[13px] text-ink">
          Screen diagonal
          <input
            type="number"
            min={0}
            step={0.5}
            value={diagonalText}
            placeholder="No grid"
            onChange={(event) => setDiagonalText(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && save()}
            className={inputClass}
          />
        </label>
        <label className="flex flex-col gap-1.5 text-[13px] text-ink">
          Grid square size
          <input
            type="number"
            min={0}
            step={0.25}
            value={gridText}
            onChange={(event) => setGridText(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && save()}
            className={inputClass}
          />
        </label>
      </div>
      <div className="mt-4 rounded-sm border border-line bg-ground px-3 py-2 text-[13px] text-muted">
        {!validDiagonal ? (
          'Enter the diagonal to show a grid.'
        ) : !dimensions ? (
          'Open the player screen to see its size and grid.'
        ) : (
          <span className="tabular-nums">
            Screen {dimensions.width.toFixed(1)} × {dimensions.height.toFixed(1)}
            {validGrid && (
              <>
                {', '}
                {Math.floor(dimensions.width / validGrid)} × {Math.floor(dimensions.height / validGrid)}{' '}
                squares
              </>
            )}
          </span>
        )}
      </div>
      <div className="mt-5">
        <p className="text-[13px] text-ink">New maps and handouts taller than wide</p>
        <p className="mt-1 text-xs leading-relaxed text-muted">
          Turned as they are added, they lie along a landscape player screen: Rotate left points their top at
          the screen’s left edge, Rotate right at its right edge. Square and wide images are never turned.
        </p>
        <div className="mt-2">
          <ButtonGroup label="New maps and handouts taller than wide">
            {PORTRAIT_CHOICES.map((choice) => (
              <Button
                key={choice.rotation}
                tone={rotation === choice.rotation ? 'on' : 'default'}
                aria-pressed={rotation === choice.rotation}
                onClick={() => setRotation(choice.rotation)}
              >
                {choice.label}
              </Button>
            ))}
          </ButtonGroup>
        </div>
      </div>
      <div className="mt-5">
        <p className="text-[13px] text-ink">Player view frame colour</p>
        <p className="mt-1 text-xs leading-relaxed text-muted">
          The frame on this window that shows what the players see. Pick one that stands out on your maps.
        </p>
        <div className="mt-2">
          {/* Equal swatches in one row; the chosen one is ringed (not gold, which is a choice itself) */}
          <div role="group" aria-label="Player view frame colour" className="flex gap-2">
            {FRAME_COLORS.map((choice) => (
              <button
                key={choice}
                type="button"
                aria-label={FRAME_COLOR_STYLES[choice].label}
                title={FRAME_COLOR_STYLES[choice].label}
                aria-pressed={color === choice}
                onClick={() => setColor(choice)}
                className={`h-8 w-8 shrink-0 rounded border border-black/40 ${
                  color === choice
                    ? 'ring-2 ring-ink ring-offset-2 ring-offset-panel'
                    : 'hover:brightness-110'
                }`}
                style={{ backgroundColor: `rgb(${FRAME_COLOR_STYLES[choice].rgb})` }}
              />
            ))}
          </div>
        </div>
      </div>
    </Dialog>
  );
}

// Rows come from lib/shortcuts.ts, which also drives the key handler.

const MOUSE_ACTION = /drag|click|wheel|pinch/i;

/** One way to do something: keys as key caps, mouse actions as words. */
function Way({ way }: { way: string }) {
  const parts = way.split(' + ');
  return (
    <span className="flex items-center gap-1 whitespace-nowrap">
      {parts.map((part, index) => (
        <span key={part} className="flex items-center gap-1">
          {index > 0 && <span className="text-muted">+</span>}
          {MOUSE_ACTION.test(part) ? <span className="text-muted">{part}</span> : <Kbd>{keyLabel(part)}</Kbd>}
        </span>
      ))}
    </span>
  );
}

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog
      title="Keyboard shortcuts"
      onClose={onClose}
      width="w-[24rem] min-[900px]:w-184 min-[1200px]:w-264"
    >
      <div className="gap-x-8 min-[900px]:columns-2 min-[1200px]:columns-3">
        {SHORTCUT_GROUPS.map((group) => (
          <section key={group.title} className="mb-4 break-inside-avoid last:mb-0">
            <h3 className="border-b border-line pb-1 font-display text-[13px] font-semibold tracking-wide text-ink">
              {group.title}
            </h3>
            {group.note && <p className="mt-1 text-xs text-muted">{group.note}</p>}
            <dl className="mt-1.5 flex flex-col gap-0.5 text-[13px]">
              {group.shortcuts.map(([action, ways, note]) => (
                <div key={action} className="flex items-start justify-between gap-3">
                  <dt className="leading-6 text-ink">
                    {action}
                    {note && (
                      <span className="-mt-0.5 block text-xs leading-4 text-muted">{keyLabel(note)}</span>
                    )}
                  </dt>
                  {/* A fixed height and line height, so rows with key caps are as tall as the rest */}
                  <dd className="flex h-6 shrink-0 items-center justify-end gap-x-1.5 leading-4">
                    {ways.flatMap(waysOf).map((way, index) => (
                      <span key={way} className="flex items-center gap-1.5">
                        {index > 0 && <span className="text-muted">or</span>}
                        <Way way={way} />
                      </span>
                    ))}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Dialog>
  );
}

interface WelcomeDialogProps {
  /** Whether it opens on start-up; the checkbox says the opposite */
  showOnStartup: boolean;
  onShowOnStartupChange: (show: boolean) => void;
  onOpenPlayerSetup: () => void;
  onOpenShortcuts: () => void;
  onClose: () => void;
}

const welcomeHeading = 'font-display text-[13px] font-semibold tracking-wide text-ink';
const welcomeList = 'mt-1.5 flex list-disc flex-col gap-1 pl-5 text-[13px] leading-relaxed text-muted';

/** Opens on start-up until turned off, and again from the ? button next to Settings. */
export function WelcomeDialog({
  showOnStartup,
  onShowOnStartupChange,
  onOpenPlayerSetup,
  onOpenShortcuts,
  onClose,
}: WelcomeDialogProps) {
  return (
    <Dialog
      title="Welcome to Mini VTT"
      onClose={onClose}
      width="w-136"
      footer={
        <>
          <label className="mr-auto flex items-center gap-2 text-[13px] text-muted">
            <input
              type="checkbox"
              checked={!showOnStartup}
              onChange={(event) => onShowOnStartupChange(!event.target.checked)}
              className="h-4 w-4 accent-gold"
            />
            Don’t show on start-up
          </label>
          <Button onClick={onOpenShortcuts}>Keyboard shortcuts</Button>
          <Button tone="active" onClick={onClose} data-autofocus>
            Get started
          </Button>
        </>
      }
    >
      <p className="text-[13px] leading-relaxed text-ink">
        Mini VTT shows your maps on a screen at the table: a TV lying flat, a monitor or a projector. This
        window is yours: pick maps, paint fog of war and choose what the players see. The player screen shows
        only that, with unexplored areas in black.
      </p>

      <h3 className={`mt-4 ${welcomeHeading}`}>Ready as soon as you add a map</h3>
      <ul className={welcomeList}>
        <li>
          Click <span className="text-ink">Add maps…</span> in the library, or drop images or WebM videos onto
          it. New maps start without fog; tick <span className="text-ink">Cover new maps in fog</span> in
          Settings to have them start fully fogged.
        </li>
        <li>
          Click <span className="text-ink">Open player screen</span>, drag that window onto the table screen
          and press <Kbd>{keyLabel('F11')}</Kbd> for full screen.
        </li>
        <li>Drag the frame to choose what the players see, and paint with the Fog tool to reveal the map.</li>
      </ul>

      <h3 className={`mt-4 ${welcomeHeading}`}>Some things need setting up first</h3>
      <ul className={welcomeList}>
        <li>
          <span className="text-ink">True scale</span> zooms a map so its squares match your miniatures. It
          needs the screen’s diagonal and your grid square size, set once in{' '}
          <button
            type="button"
            onClick={onOpenPlayerSetup}
            className="text-gold underline decoration-gold/40 underline-offset-2 hover:text-gold-bright"
          >
            Player screen setup
          </button>
          .
        </li>
        <li>
          <span className="text-ink">Spell areas and the Measure tool</span> need each map’s grid: open
          Settings → Measure map grid… and click two corners of a square. Maps whose names give their size,
          such as <span className="text-ink">forest_32x32.jpg</span>, get it as they are added.
        </li>
      </ul>

      <p className="mt-4 text-xs leading-relaxed text-muted">
        The ? button next to Settings brings this back.
      </p>
    </Dialog>
  );
}

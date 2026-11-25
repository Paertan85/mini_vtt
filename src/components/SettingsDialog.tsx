// The Settings dialog: every setting in one place, in sections, as the GNOME,
// Apple and Microsoft guidelines put preferences in a window of their own
// rather than in a menu. Changes apply at once, so there is no Save button;
// the two number fields save on Enter, when left, or when the dialog closes.
// The backdrop is only lightly dimmed, so an opacity change shows on the map.

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Dialog } from '../ui/Dialog';
import { Button, ButtonGroup, Slider, inputClass } from '../ui/controls';
import type { Size } from '../lib/geometry';
import { FRAME_COLORS, FRAME_COLOR_STYLES } from '../lib/frameColors';
import { MOVEMENT_LABELS, MOVEMENT_RULES, MOVEMENT_TITLES } from '../lib/grid';
import { OPACITY_MAX, OPACITY_MIN } from '../lib/settings';
import { SLIDESHOW_SECONDS } from '../lib/slideshow';
import type { DmApp, DmSettings, OpacityLayer } from '../hooks/useDmController';

interface SettingsDialogProps {
  settings: DmSettings;
  /** Choosing and opening the slideshow folder */
  app: DmApp;
  /** The player window's size, to show the screen's size; null while it is closed */
  viewportSize: Size | null;
  onClose: () => void;
}

/** Physical width and height of a screen with this diagonal and aspect ratio. */
export function screenDimensions(diagonal: number, viewport: Size) {
  const aspect = viewport.w / viewport.h;
  const norm = Math.sqrt(aspect * aspect + 1);
  return { width: (diagonal * aspect) / norm, height: diagonal / norm };
}

const PORTRAIT_CHOICES = [
  { rotation: 0, label: 'Don’t rotate' },
  { rotation: 90, label: 'Rotate right' },
  { rotation: 270, label: 'Rotate left' },
];

const OPACITY_SLIDERS: { layer: OpacityLayer; label: string; note: string }[] = [
  { layer: 'markerOpacity', label: 'Markers', note: 'Only you see markers.' },
  { layer: 'effectOpacity', label: 'Painted effects', note: 'On the player screen too.' },
  { layer: 'areaOpacity', label: 'Spell areas', note: 'On the player screen too.' },
];

/** How long the slideshow shows a picture: “20 seconds”, “1 minute”. */
const slideshowTime = (seconds: number) => (seconds === 60 ? '1 minute' : `${seconds} seconds`);

const heading = 'border-b border-line pb-1 font-display text-[13px] font-semibold tracking-wide text-ink';
const note = 'mt-1 text-xs leading-relaxed text-muted';

export function SettingsDialog({ settings, app, viewportSize, onClose }: SettingsDialogProps) {
  return (
    <Dialog title="Settings" onClose={onClose} dim={false} width="w-[26rem] min-[1000px]:w-[56rem]">
      {/* Focus starts on the settings as a whole, not in the first field, which would look as if it wanted typing */}
      <div
        tabIndex={-1}
        data-autofocus
        className="grid gap-x-8 gap-y-6 outline-hidden min-[1000px]:grid-cols-2"
      >
        <PlayerScreenSection settings={settings} viewportSize={viewportSize} />
        <div className="flex flex-col gap-6">
          <section aria-label="Tools">
            <h3 className={heading}>Tools</h3>
            <div className="mt-3 flex flex-col gap-3">
              <Check
                label="Show tool hints"
                note="A line at the bottom of the map says how the current tool works."
                checked={settings.showToolHints}
                onChange={settings.toggleToolHints}
              />
              <Check
                label="Show the Effects and Spells tools"
                note="Turned off, painted effects and spell areas are hidden too."
                checked={settings.showEffectTools}
                onChange={settings.toggleEffectTools}
              />
              <Check
                label="Cover new maps in fog"
                note="Maps you add start fully fogged."
                checked={settings.fogNewMaps}
                onChange={settings.toggleFogNewMaps}
              />
              <div>
                <p className="text-[13px] text-ink">Movement ruler</p>
                <div className="mt-1.5">
                  <ButtonGroup label="Movement ruler">
                    {MOVEMENT_RULES.map((rule) => (
                      <Button
                        key={rule}
                        tone={settings.movementRule === rule ? 'on' : 'default'}
                        aria-pressed={settings.movementRule === rule}
                        onClick={() => settings.setMovementRule(rule)}
                        title={`${MOVEMENT_LABELS[rule]}: ${MOVEMENT_TITLES[rule]}`}
                      >
                        {MOVEMENT_LABELS[rule]}
                      </Button>
                    ))}
                  </ButtonGroup>
                </div>
                <p className={note}>How the Measure tool’s Movement counts diagonal squares.</p>
              </div>
            </div>
          </section>

          <section aria-label="Opacity">
            <h3 className={heading}>Opacity</h3>
            <div className="mt-3 grid grid-cols-[auto_1fr_auto] items-center gap-x-3 gap-y-2 text-[13px]">
              {OPACITY_SLIDERS.map(({ layer, label, note: sliderNote }) => (
                <label key={layer} className="contents" title={sliderNote}>
                  <span className="text-ink">{label}</span>
                  <Slider
                    label={label}
                    value={Math.round(settings[layer] * 100)}
                    min={OPACITY_MIN * 100}
                    max={OPACITY_MAX * 100}
                    step={5}
                    onChange={(value, done) => settings.setOpacity(layer, value / 100, done)}
                    className="w-full"
                  />
                  <span className="w-10 text-right text-xs tabular-nums text-muted">
                    {Math.round(settings[layer] * 100)} %
                  </span>
                </label>
              ))}
            </div>
            <p className={note}>
              How strongly each is filled. Markers only you see; effects and spell areas show on the player
              screen too.
            </p>
          </section>

          <section aria-label="Slideshow">
            <h3 className={heading}>Slideshow</h3>
            <div className="mt-3 flex flex-col gap-3">
              <Check
                label="Show rule hints"
                note="A short rules reminder along the bottom of the slideshow and the blackout, a new one with each picture."
                checked={settings.showRuleHints}
                onChange={settings.toggleRuleHints}
              />
              <div>
                <p className="text-[13px] text-ink">Each picture shows for</p>
                <div className="mt-1.5">
                  <ButtonGroup label="Each picture shows for">
                    {SLIDESHOW_SECONDS.map((seconds) => (
                      <Button
                        key={seconds}
                        tone={settings.slideshowSeconds === seconds ? 'on' : 'default'}
                        aria-pressed={settings.slideshowSeconds === seconds}
                        onClick={() => settings.setSlideshowSeconds(seconds)}
                      >
                        {slideshowTime(seconds)}
                      </Button>
                    ))}
                  </ButtonGroup>
                </div>
              </div>
              <div>
                <p className="text-[13px] text-ink">Pictures</p>
                <div className="mt-1.5 flex gap-2">
                  <Button onClick={app.chooseSlideshowFolder}>Choose folder…</Button>
                  <Button onClick={app.revealSlideshowFolder}>Open folder</Button>
                </div>
                <p className={note}>
                  PNG, JPEG, GIF, WebP or BMP files in the slideshow folder, shown in name order. The folder
                  is read each time the slideshow starts, so pictures added since are in it.
                </p>
              </div>
            </div>
          </section>
        </div>
      </div>
    </Dialog>
  );
}

/** The player screen's size and grid, how new tall images are turned, and the frame's colour. */
function PlayerScreenSection({
  settings,
  viewportSize,
}: {
  settings: DmSettings;
  viewportSize: Size | null;
}) {
  const { screenDiagonal, gridSize } = settings;
  const [diagonalText, setDiagonalText] = useState(screenDiagonal === null ? '' : String(screenDiagonal));
  const [gridText, setGridText] = useState(String(gridSize));

  const parsedDiagonal = parseFloat(diagonalText);
  const validDiagonal = Number.isFinite(parsedDiagonal) && parsedDiagonal > 0 ? parsedDiagonal : null;
  const parsedGrid = parseFloat(gridText);
  const validGrid = Number.isFinite(parsedGrid) && parsedGrid > 0 ? parsedGrid : null;
  const dimensions = validDiagonal && viewportSize ? screenDimensions(validDiagonal, viewportSize) : null;

  // An empty diagonal means no grid; anything else not a number goes back to the saved value
  const commitDiagonal = () => {
    if (diagonalText.trim() === '') {
      if (screenDiagonal !== null) settings.setScreenDiagonal(null);
    } else if (validDiagonal === null) {
      setDiagonalText(screenDiagonal === null ? '' : String(screenDiagonal));
    } else if (validDiagonal !== screenDiagonal) {
      settings.setScreenDiagonal(validDiagonal);
    }
  };
  const commitGrid = () => {
    if (validGrid === null) setGridText(String(gridSize));
    else if (validGrid !== gridSize) settings.setGridSize(validGrid);
  };

  // Closing the dialog while typing keeps what was typed
  const commitRef = useRef(() => {});
  commitRef.current = () => {
    commitDiagonal();
    commitGrid();
  };
  useEffect(() => () => commitRef.current(), []);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') event.currentTarget.blur();
  };

  return (
    <section aria-label="Player screen">
      <h3 className={heading}>Player screen</h3>
      <p className={`${note} mt-2`}>
        With the screen size set, the player frame shows a grid that matches the physical screen, so
        miniatures line up with the map, and True scale zooms a map so its own squares are that size. Use any
        unit, as long as both values use the same one.
      </p>
      <div className="mt-3 grid grid-cols-2 gap-3">
        <label className="flex flex-col gap-1.5 text-[13px] text-ink">
          Screen diagonal
          <input
            type="number"
            min={0}
            step={0.5}
            value={diagonalText}
            placeholder="No grid"
            onChange={(event) => setDiagonalText(event.target.value)}
            onBlur={commitDiagonal}
            onKeyDown={onKeyDown}
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
            onBlur={commitGrid}
            onKeyDown={onKeyDown}
            className={inputClass}
          />
        </label>
      </div>
      <div className="mt-3 rounded-sm border border-line bg-ground px-3 py-2 text-[13px] text-muted">
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

      <div className="mt-4">
        <Check
          label="Show the map’s grid on the player screen"
          note="The grid measured for the map, drawn for the players too."
          checked={settings.showGridToPlayers}
          onChange={settings.toggleGridToPlayers}
        />
      </div>

      <div className="mt-4">
        <p className="text-[13px] text-ink">New maps and handouts taller than wide</p>
        <div className="mt-1.5">
          <ButtonGroup label="New maps and handouts taller than wide">
            {PORTRAIT_CHOICES.map((choice) => (
              <Button
                key={choice.rotation}
                tone={settings.portraitRotation === choice.rotation ? 'on' : 'default'}
                aria-pressed={settings.portraitRotation === choice.rotation}
                onClick={() => settings.setPortraitRotation(choice.rotation)}
              >
                {choice.label}
              </Button>
            ))}
          </ButtonGroup>
        </div>
        <p className={note}>
          Turned as they are added, they lie along a landscape player screen: Rotate left points their top at
          the screen’s left edge, Rotate right at its right edge. Square and wide images are never turned.
        </p>
      </div>

      <div className="mt-4">
        <p className="text-[13px] text-ink">Player view frame colour</p>
        {/* Equal swatches in one row; the chosen one is ringed (not gold, which is a choice itself) */}
        <div role="group" aria-label="Player view frame colour" className="mt-1.5 flex gap-2">
          {FRAME_COLORS.map((choice) => (
            <button
              key={choice}
              type="button"
              aria-label={FRAME_COLOR_STYLES[choice].label}
              title={FRAME_COLOR_STYLES[choice].label}
              aria-pressed={settings.frameColor === choice}
              onClick={() => settings.setFrameColor(choice)}
              className={`h-8 w-8 shrink-0 rounded border border-black/40 ${
                settings.frameColor === choice
                  ? 'ring-2 ring-ink ring-offset-2 ring-offset-panel'
                  : 'hover:brightness-110'
              }`}
              style={{ backgroundColor: `rgb(${FRAME_COLOR_STYLES[choice].rgb})` }}
            />
          ))}
        </div>
        <p className={note}>
          The frame on this window that shows what the players see. Pick one that stands out on your maps.
        </p>
      </div>
    </section>
  );
}

/** A setting that is on or off, with a line saying what it does. */
function Check({
  label,
  note: checkNote,
  checked,
  onChange,
}: {
  label: string;
  note: string;
  checked: boolean;
  onChange: () => void;
}) {
  return (
    <label className="flex items-start gap-2.5 text-[13px] text-ink">
      <input
        type="checkbox"
        aria-label={label}
        checked={checked}
        onChange={onChange}
        className="mt-0.5 h-4 w-4 shrink-0 accent-gold"
      />
      <span>
        {label}
        <span className="block text-xs leading-relaxed text-muted">{checkNote}</span>
      </span>
    </label>
  );
}

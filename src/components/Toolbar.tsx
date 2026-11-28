// The DM window's toolbar, above the map. The tools themselves are in the rail
// beside the map (ToolRail), as in image editors and other VTTs. One bar, so
// the map gets the rest of the window. Three parts:
//   left    always the same: the library panel button, undo and redo
//   middle  the current tool's options (Photoshop's options bar): brush size,
//           the fog's ways of drawing and the whole-map menu, the effect
//           colours and Clear, the spell areas to add, how the Measure tool
//           counts, or the markers' colour, size, letter and Clear
//   right   always the same: what the players see (PlayerControls), and the
//           menu (☰): Settings, the welcome screen, shortcuts, project files
//           and the window, as GNOME's guidelines put them in an app's one
//           primary menu
//
// Always one line where it can be: the options take the room they need, and the
// player controls get the rest, showing icons only when it runs short (a CSS
// container query, so nothing is measured in JavaScript). Only in a very
// narrow window do the options wrap, within their own part.
//
// Buttons are borderless and choices sit in dark tracks, so the bar is grouped
// by spacing (Fluent's command bar). Options and toggles that are on get an
// accent outline (tone "on"). Tooltips read "Name (key): what it does."

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, Menu as MenuIcon, PanelLeftClose, PanelLeftOpen, Redo2, Undo2 } from 'lucide-react';
import { Button, ButtonGroup, Divider, inputClass } from '../ui/controls';
import { Menu } from '../ui/Menu';
import { Popover } from '../ui/Popover';
import { PlayerControls } from './PlayerControls';
import type { FogShape } from './MapStage';
import type { AreaShape, EffectKind } from '../types/map';
import { MOVEMENT_TITLES } from '../lib/grid';
import { AREA_LABELS, AREA_SHAPES, DEFAULT_AREA_FT, MAX_AREAS } from '../lib/areas';
import { EFFECT_KINDS, EFFECT_STYLES } from '../lib/effects';
import {
  MARKER_COLORS,
  MARKER_RADIUS_STEP,
  MARKER_STYLES,
  MAX_MARKER_RADIUS,
  MAX_MARKER_SQUARES,
  MIN_MARKER_RADIUS,
  MIN_MARKER_SQUARES,
  typedMarkerLetter,
} from '../lib/markers';
import { keyLabel } from '../lib/platform';
import {
  BRUSH_STEP,
  MAX_BRUSH,
  MIN_BRUSH,
  type DmApp,
  type DmPlayerScreen,
  type DmPlayerView,
  type DmSettings,
  type DmTools,
} from '../hooks/useDmController';

interface ToolbarProps {
  tools: DmTools;
  /** The settings it shows and changes beside the tools */
  settings: DmSettings;
  /** The commands of the menu (☰) */
  app: DmApp;
  playerView: DmPlayerView;
  playerScreen: DmPlayerScreen;
}

/** The Fog tool's ways of drawing, as the toolbar offers them. */
const FOG_SHAPES: { shape: FogShape; label: string; title: string }[] = [
  {
    shape: 'brush',
    label: 'Brush',
    title: 'Brush: paint fog with a round brush. Left button reveals, right button covers.',
  },
  {
    shape: 'lasso',
    label: 'Lasso',
    title: 'Lasso (L): draw around an area. Left button reveals it all at once, right button covers it.',
  },
  {
    shape: 'rect',
    label: 'Rectangle',
    title:
      'Rectangle (R): drag a rectangle. Left button reveals it, right button covers it; Ctrl snaps it to the grid.',
  },
  {
    shape: 'circle',
    label: 'Circle',
    title:
      'Circle (C): click to reveal a circle sized in feet, such as a torch’s light; right-click covers. The mouse wheel sizes it in 5 ft steps, or drag out from its centre. Ctrl centres it on a square.',
  },
  {
    shape: 'rooms',
    label: 'Rooms',
    title:
      'Rooms: mark out rooms ahead of time, then reveal or cover each with one click. Only you see them; Ctrl snaps to the grid.',
  },
];

// Memoized: the DM window re-renders on every frame of a drag, and the toolbar
// never depends on that
export const Toolbar = memo(function Toolbar({
  tools,
  settings,
  app,
  playerView,
  playerScreen,
}: ToolbarProps) {
  const { hasMap, tool, shapesNeed } = tools;
  const layerName = tool === 'effect' ? 'effects' : tool === 'markers' ? 'marker' : 'fog';

  // The note beneath a shape button, when shapes can't be added yet
  const shapeAnchorRef = useRef<HTMLButtonElement | null>(null);
  const [shapeNote, setShapeNote] = useState<AreaShape | null>(null);
  const closeShapeNote = useCallback(() => setShapeNote(null), []);
  useEffect(() => {
    if (!shapesNeed) setShapeNote(null);
  }, [shapesNeed]);

  return (
    // The library button, undo, redo and the menu keep their place whatever
    // happens; the tool's options and the player controls share the middle
    <div className="flex min-h-12 shrink-0 items-start gap-2 border-b border-line bg-panel px-3 py-2">
      {/* Always here, whatever the tool */}
      <div className="flex h-8 shrink-0 items-center gap-2">
        <Button
          square
          tone="quiet"
          aria-controls="library-panel"
          aria-expanded={settings.showLibrary}
          aria-label={settings.showLibrary ? 'Hide maps and handouts' : 'Show maps and handouts'}
          title={keyLabel(
            settings.showLibrary ? 'Hide maps and handouts (Ctrl+B)' : 'Show maps and handouts (Ctrl+B)',
          )}
          onClick={settings.toggleLibrary}
        >
          {settings.showLibrary ? (
            <PanelLeftClose className="h-4 w-4" />
          ) : (
            <PanelLeftOpen className="h-4 w-4" />
          )}
        </Button>

        <ButtonGroup track label="History">
          <Button
            tone="plain"
            square
            onClick={tools.undo}
            disabled={!tools.canUndo}
            title={keyLabel(`Undo ${layerName} change (Ctrl+Z)`)}
            aria-label="Undo"
          >
            <Undo2 className="h-4 w-4" />
          </Button>
          <Button
            tone="plain"
            square
            onClick={tools.redo}
            disabled={!tools.canRedo}
            title={keyLabel(`Redo ${layerName} change (Ctrl+Y or Ctrl+Shift+Z)`)}
            aria-label="Redo"
          >
            <Redo2 className="h-4 w-4" />
          </Button>
        </ButtonGroup>
        <Divider />
      </div>

      <div className="flex min-w-0 flex-1 items-start gap-2">
        {/* The current tool's options (the tools themselves are in ToolRail). As
        wide as they are; they wrap only when the player controls are down to
        their icons and there still isn't room */}
        <div
          role="group"
          aria-label="Tool options"
          className="flex min-h-8 min-w-0 flex-[0_1_auto] flex-wrap items-center gap-2"
        >
          {/* In the Effects tool, and in the Fog tool whatever its way of drawing,
          so the fog's options don't move when it changes (Shift paints fog with
          the brush from any tool). Elsewhere the wheel with Shift, or [ and ],
          still size it. No number: the brush outline on the map shows the size */}
          {(tool === 'effect' || tool === 'fog') && (
            <label
              className="flex items-center gap-2 pl-1 text-[13px] text-muted"
              title={`Brush size ${tools.brushSize}: mouse wheel in the Fog and Effects tools (or while holding Shift), or [ and ]`}
            >
              Brush
              <input
                type="range"
                min={MIN_BRUSH}
                max={MAX_BRUSH}
                step={BRUSH_STEP}
                value={tools.brushSize}
                onChange={(event) => tools.setBrushSize(Number(event.target.value))}
                aria-label="Brush size"
                className="w-24 accent-accent"
              />
            </label>
          )}

          {tool === 'effect' && (
            <>
              <EffectKindPicker
                kind={tools.effectKind}
                onChange={tools.setEffectKind}
                title={(label) => `Paint ${label}`}
              />
              <Button
                tone="plain"
                onClick={tools.clearEffects}
                disabled={!tools.canClearEffects}
                title={keyLabel('Remove all effects from this map (undo with Ctrl+Z)')}
              >
                Clear
              </Button>
            </>
          )}
          {tool === 'shapes' && (
            <>
              <EffectKindPicker
                kind={tools.effectKind}
                onChange={tools.setEffectKind}
                title={(label) => `Make new spell areas, and the selected one, ${label}`}
              />
              <ButtonGroup track label="Add a spell area">
                {AREA_SHAPES.map((shape) => (
                  <Button
                    tone="plain"
                    key={shape}
                    aria-haspopup={shapesNeed ? 'dialog' : undefined}
                    aria-expanded={shapesNeed ? shapeNote === shape : undefined}
                    onClick={(event) => {
                      if (!shapesNeed) {
                        tools.addArea(shape);
                        return;
                      }
                      shapeAnchorRef.current = event.currentTarget;
                      setShapeNote((open) => (open === shape ? null : shape));
                    }}
                    title={`Add a ${DEFAULT_AREA_FT[shape]} ft ${AREA_LABELS[shape].toLowerCase()} in the middle of the player view. Drag its dot to move it; the mouse wheel over it resizes it, or type the size.`}
                  >
                    {AREA_LABELS[shape]}
                  </Button>
                ))}
              </ButtonGroup>
              <Button
                tone={settings.showAreaSquares ? 'on' : 'plain'}
                aria-pressed={settings.showAreaSquares}
                onClick={settings.toggleAreaSquares}
                title="Affected squares: outline the grid squares each spell area covers, on the player screen too. A square counts when at least half of it is covered. An emanation counts out from its creature's square as movement is, and leaves that square out."
              >
                Affected squares
              </Button>
              <Popover
                open={shapeNote !== null && shapesNeed !== null}
                onClose={closeShapeNote}
                anchorRef={shapeAnchorRef}
                label="Add a spell area"
              >
                {shapeNote && shapesNeed === 'grid' && (
                  <>
                    <p>
                      Spell areas are sized in feet, so this map needs its grid first. Click two corners of a
                      square and save it, and the {AREA_LABELS[shapeNote].toLowerCase()} is added.
                    </p>
                    <div className="mt-3 flex justify-end">
                      <Button
                        tone="active"
                        onClick={() => {
                          setShapeNote(null);
                          tools.addArea(shapeNote);
                        }}
                      >
                        Measure grid
                      </Button>
                    </div>
                  </>
                )}
                {shapesNeed === 'full' && (
                  <p>A map can have at most {MAX_AREAS} spell areas. Delete one to add another.</p>
                )}
              </Popover>
            </>
          )}
          {tool === 'markers' && (
            <>
              <ButtonGroup track label="Marker colour">
                {MARKER_COLORS.map((color) => (
                  <Button
                    key={color}
                    square
                    tone={tools.markerColor === color ? 'on' : 'plain'}
                    aria-pressed={tools.markerColor === color}
                    aria-label={MARKER_STYLES[color].label}
                    onClick={() => tools.setMarkerColor(color)}
                    title={`${MARKER_STYLES[color].label}: make new markers, and the selected one, ${MARKER_STYLES[color].label.toLowerCase()}`}
                  >
                    <span
                      aria-hidden="true"
                      className="h-4 w-4 rounded-full border border-black/40"
                      style={{ backgroundColor: `rgb(${MARKER_STYLES[color].rgb})` }}
                    />
                  </Button>
                ))}
              </ButtonGroup>
              {/* Squares on a map with a grid, else pixels of the map like the fog brush */}
              <label
                className="flex items-center gap-2 pl-1 text-[13px] text-muted"
                title={
                  tools.measureNeedsGrid
                    ? 'Marker size, in pixels of the map like the fog brush, so it zooms with the map. Mouse wheel: over a marker sizes it, elsewhere the next one.'
                    : 'Marker size in squares: 1 Medium or smaller, 2 Large, 3 Huge, 4 Gargantuan. Mouse wheel: over a marker sizes it, elsewhere the next one.'
                }
              >
                Size
                <input
                  type="range"
                  min={tools.measureNeedsGrid ? MIN_MARKER_RADIUS : MIN_MARKER_SQUARES}
                  max={tools.measureNeedsGrid ? MAX_MARKER_RADIUS : MAX_MARKER_SQUARES}
                  step={tools.measureNeedsGrid ? MARKER_RADIUS_STEP : 1}
                  value={tools.markerSize}
                  onChange={(event) => tools.setMarkerSize(Number(event.target.value))}
                  aria-label="Marker size"
                  className="w-24 accent-accent"
                />
                <span className="w-8 text-right tabular-nums text-ink">
                  {tools.measureNeedsGrid ? tools.markerSize : `${tools.markerSize}×${tools.markerSize}`}
                </span>
              </label>
              <label
                className="flex items-center gap-2 pl-1 text-[13px] text-muted"
                title={
                  tools.markerSelected
                    ? 'Letter: type a capital A to Z to show in the selected marker, so you know what it stands for. Empty: no letter.'
                    : 'Letter: a new marker gets the first letter not yet on the map. Select a marker to change its letter.'
                }
              >
                Letter
                <input
                  type="text"
                  aria-label="Marker letter"
                  value={tools.markerLetter}
                  disabled={!tools.markerSelected}
                  onFocus={(event) => event.currentTarget.select()}
                  onChange={(event) => {
                    const letter = typedMarkerLetter(event.target.value);
                    if (letter !== null) tools.setMarkerLetter(letter);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === 'Escape') event.currentTarget.blur();
                  }}
                  autoComplete="off"
                  spellCheck={false}
                  className={`${inputClass} w-9 text-center font-semibold uppercase disabled:opacity-40`}
                />
              </label>
              <Button
                tone="plain"
                onClick={tools.clearMarkers}
                disabled={!tools.canClearMarkers}
                title={keyLabel('Remove all markers from this map (undo with Ctrl+Z)')}
              >
                Clear
              </Button>
            </>
          )}
          {tool === 'measure' &&
            (tools.measureNeedsGrid ? (
              <span className="flex items-center gap-2 text-[13px] text-muted">
                Measuring needs this map’s grid.
                <Button onClick={tools.measureGrid}>Measure grid</Button>
              </span>
            ) : (
              <>
                <ButtonGroup track label="Measure">
                  <Button
                    tone={tools.measureStraight ? 'plain' : 'on'}
                    aria-pressed={!tools.measureStraight}
                    onClick={() => tools.setMeasureStraight(false)}
                    title={`Movement: counted in squares, from the middle of one to the middle of another; ${MOVEMENT_TITLES[settings.movementRule]}. Settings switches how diagonals count.`}
                  >
                    Movement
                  </Button>
                  <Button
                    tone={tools.measureStraight ? 'on' : 'plain'}
                    aria-pressed={tools.measureStraight}
                    onClick={() => tools.setMeasureStraight(true)}
                    title={keyLabel(
                      'Straight line: the distance as the crow flies, not counted in squares. Ctrl snaps the ends to square centres.',
                    )}
                  >
                    Straight line
                  </Button>
                </ButtonGroup>
                <Button
                  tone={settings.showRulerToPlayers ? 'on' : 'plain'}
                  aria-pressed={settings.showRulerToPlayers}
                  onClick={() => settings.setShowRulerToPlayers(!settings.showRulerToPlayers)}
                  title="Show players: the ruler appears on the player screen too, as you drag it."
                >
                  Show players
                </Button>
              </>
            ))}
          {(tool === 'view' || tool === 'fog') && (
            <>
              {tool === 'fog' && (
                <ButtonGroup track label="Fog drawing">
                  {FOG_SHAPES.map(({ shape, label, title }) => (
                    <Button
                      key={shape}
                      tone={tools.fogShape === shape ? 'on' : 'plain'}
                      aria-pressed={tools.fogShape === shape}
                      onClick={() => tools.setFogShape(shape)}
                      title={keyLabel(title)}
                    >
                      {label}
                    </Button>
                  ))}
                </ButtonGroup>
              )}
              {tool === 'fog' && tools.fogShape === 'circle' && tools.measureNeedsGrid && (
                <span className="flex items-center gap-2 text-[13px] text-muted">
                  A circle in feet needs this map’s grid.
                  <Button onClick={tools.measureGrid}>Measure grid</Button>
                </span>
              )}
              <Menu
                items={[
                  { label: 'Reveal entire map', onSelect: tools.revealAll },
                  { label: 'Cover entire map', onSelect: tools.coverAll },
                ]}
                trigger={(trigger) => (
                  <Button
                    {...trigger}
                    tone="plain"
                    disabled={!hasMap}
                    title="Whole map: reveal or cover all of it"
                  >
                    Whole map
                    <ChevronDown className="h-3.5 w-3.5 text-muted" />
                  </Button>
                )}
              />
            </>
          )}
        </div>

        {/* What the players see: at the right, whatever the tool, in the room
          the options leave. A size container, so PlayerControls can tell how
          much room it has; never narrower than its icons-only form */}
        <div className="@container flex h-8 min-w-[17.5rem] flex-[1_0_17.5rem] items-center justify-end">
          <PlayerControls
            playerView={playerView}
            playerScreen={playerScreen}
            hasMap={hasMap}
            openSettings={app.openSettings}
          />
        </div>
      </div>

      <div className="flex h-8 shrink-0 items-center gap-2">
        <Divider />
        <Menu
          align="right"
          items={[
            { label: 'Settings…', onSelect: app.openSettings, hint: keyLabel('Ctrl+,') },
            { label: 'Measure map grid…', onSelect: tools.measureGrid, disabled: !hasMap },
            { label: 'Keyboard shortcuts…', onSelect: app.openShortcuts, hint: '?', separated: true },
            { label: 'Welcome…', onSelect: app.openWelcome },
            { label: 'Export project…', onSelect: app.exportProject, separated: true },
            { label: 'Import project…', onSelect: app.importProject },
            { label: 'Open library folder', onSelect: app.revealLibraryFolder },
            {
              label: 'Full screen',
              onSelect: app.toggleFullScreen,
              hint: keyLabel('F11'),
              separated: true,
            },
            { label: 'Reload', onSelect: app.reload, hint: keyLabel('Ctrl+R') },
            { label: 'Developer tools', onSelect: app.toggleDevTools, hint: keyLabel('Ctrl+Shift+I') },
            { label: 'Quit', onSelect: app.quit, separated: true },
          ]}
          trigger={(trigger) => (
            <Button
              {...trigger}
              square
              tone="quiet"
              aria-label="Menu"
              title="Menu: settings, keyboard shortcuts, the welcome screen, project files and the window"
            >
              <MenuIcon className="h-4 w-4" />
            </Button>
          )}
        />
      </div>
    </div>
  );
});

/** Fire / poison / magic, as colour chips named in their tooltips (poison is hatched, so it isn't told by colour alone). */
function EffectKindPicker({
  kind,
  onChange,
  title,
}: {
  kind: EffectKind;
  onChange: (kind: EffectKind) => void;
  /** The button's tooltip, from the colour's name in lower case */
  title: (label: string) => string;
}) {
  return (
    <ButtonGroup track label="Effect">
      {EFFECT_KINDS.map((option) => (
        <Button
          key={option}
          square
          tone={kind === option ? 'on' : 'plain'}
          aria-pressed={kind === option}
          aria-label={EFFECT_STYLES[option].label}
          onClick={() => onChange(option)}
          title={`${EFFECT_STYLES[option].label}: ${title(EFFECT_STYLES[option].label.toLowerCase())}`}
        >
          <EffectSwatch kind={option} />
        </Button>
      ))}
    </ButtonGroup>
  );
}

/** A small colour chip, hatched like the paint for effects that use a hatch. */
function EffectSwatch({ kind }: { kind: EffectKind }) {
  const { color, hatch } = EFFECT_STYLES[kind];
  return (
    <span
      aria-hidden="true"
      className="h-4 w-4 rounded-xs border border-black/40"
      style={{
        backgroundColor: color,
        backgroundImage: hatch
          ? `repeating-linear-gradient(-45deg, ${hatch} 0 2px, transparent 2px 5px)`
          : undefined,
      }}
    />
  );
}

// The DM window's toolbar, in three groups:
//   left    tools (view / fog / effects / shapes / measure), brush size,
//           undo and redo, and the active tool's options: the fog menu, the
//           effect colours and Clear, the colours and the shapes to add, or
//           how the Measure tool counts diagonals
//   centre  player view zoom and 16:9 fit
//   right   player screen status, blackout, the welcome screen and the settings menu

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import {
  ChevronDown,
  CircleHelp,
  Lock,
  LockOpen,
  Minus,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Redo2,
  Settings,
  Undo2,
} from 'lucide-react';
import { Button, ButtonGroup, Divider, inputClass } from '../ui/controls';
import { Menu } from '../ui/Menu';
import { Popover } from '../ui/Popover';
import { clampZoom, MAX_ZOOM, MIN_ZOOM, stepZoom } from '../lib/geometry';
import type { FogShape } from './MapStage';
import type { AreaShape, EffectKind } from '../types/map';
import { MOVEMENT_LABELS, MOVEMENT_RULES, MOVEMENT_TITLES } from '../lib/grid';
import { AREA_LABELS, AREA_SHAPES, DEFAULT_AREA_FT, MAX_AREAS } from '../lib/areas';
import { EFFECT_KINDS, EFFECT_STYLES } from '../lib/effects';
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
  type TrueScaleNeed,
} from '../hooks/useDmController';

interface ToolbarProps {
  tools: DmTools;
  playerView: DmPlayerView;
  playerScreen: DmPlayerScreen;
  /** The settings it shows and changes, in its menu and beside the tools */
  settings: DmSettings;
  /** The commands of the settings menu and the welcome button */
  app: DmApp;
}

/** The Fog tool's ways of drawing, as the toolbar offers them. */
const FOG_SHAPES: { shape: FogShape; label: string; title: string }[] = [
  { shape: 'brush', label: 'Brush', title: 'Paint fog with a round brush' },
  {
    shape: 'lasso',
    label: 'Lasso',
    title: 'Lasso: draw around an area to reveal it all at once; Right Mouse button covers it (L switches)',
  },
  {
    shape: 'rect',
    label: 'Rectangle',
    title:
      'Rectangle: drag to reveal a rectangle; Right Mouse button covers it. Ctrl snaps it to the grid (R switches)',
  },
  {
    shape: 'rooms',
    label: 'Rooms',
    title:
      'Rooms: drag to mark out a room ahead of time, then reveal or cover it with one click. Only you see the rooms. Ctrl snaps to the grid',
  },
];

/** What the note beneath True scale says, and its button, for each thing it needs. */
const TRUE_SCALE_NOTES: Record<TrueScaleNeed, { text: string; action: string }> = {
  setup: {
    text: 'True scale needs the player screen’s size, to work out how big a square is on it.',
    action: 'Player screen setup…',
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

// Memoized: the DM window re-renders on every frame of a drag, and the toolbar
// never depends on that
export const Toolbar = memo(function Toolbar({
  tools,
  playerView,
  playerScreen,
  settings,
  app,
}: ToolbarProps) {
  const { hasMap, tool, shapesNeed } = tools;
  const { zoom, zoomLocked, trueScaleNeeds } = playerView;
  const layerName = tool === 'effect' ? 'effects' : 'fog';

  // The note beneath True scale saying what it still needs
  const trueScaleRef = useRef<HTMLButtonElement>(null);
  const [trueScaleNote, setTrueScaleNote] = useState(false);
  const closeTrueScaleNote = useCallback(() => setTrueScaleNote(false), []);
  useEffect(() => {
    if (!trueScaleNeeds) setTrueScaleNote(false);
  }, [trueScaleNeeds]);

  // The note beneath a shape button, when shapes can't be added yet
  const shapeAnchorRef = useRef<HTMLButtonElement | null>(null);
  const [shapeNote, setShapeNote] = useState<AreaShape | null>(null);
  const closeShapeNote = useCallback(() => setShapeNote(null), []);
  useEffect(() => {
    if (!shapesNeed) setShapeNote(null);
  }, [shapesNeed]);

  return (
    <div className="flex min-h-12 shrink-0 flex-wrap items-center gap-2 border-b border-line bg-panel px-3 py-2">
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

      {/* Tools and fog */}
      <ButtonGroup label="Tool">
        <Button
          tone={tool === 'view' ? 'active' : 'default'}
          aria-pressed={tool === 'view'}
          onClick={() => tools.setTool('view')}
          title="View: drag the frame to move the player view (V). Hold Alt to move it while painting."
        >
          View
        </Button>
        <Button
          tone={tool === 'fog' ? 'active' : 'default'}
          aria-pressed={tool === 'fog'}
          onClick={() => tools.setTool('fog')}
          disabled={!hasMap}
          title="Paint fog (F): Left Mouse button reveals, Right mouse button covers"
        >
          Fog
        </Button>
        {settings.showEffectTools && (
          <>
            <Button
              tone={tool === 'effect' ? 'active' : 'default'}
              aria-pressed={tool === 'effect'}
              onClick={() => tools.setTool('effect')}
              disabled={!hasMap}
              title="Paint effects such as fire or poison (E): Left Mouse button paints, Right mouse button erases"
            >
              Effects
            </Button>
            <Button
              tone={tool === 'shapes' ? 'active' : 'default'}
              aria-pressed={tool === 'shapes'}
              onClick={() => tools.setTool('shapes')}
              disabled={!hasMap}
              title="Place spell areas sized in feet: circles, squares, cones and lines (S)"
            >
              Shapes
            </Button>
          </>
        )}
        <Button
          tone={tool === 'measure' ? 'active' : 'default'}
          aria-pressed={tool === 'measure'}
          onClick={() => tools.setTool('measure')}
          disabled={!hasMap}
          title="Measure (M): drag on the map to see the distance in feet, or click point by point to measure a path round corners (double-click or Enter finishes it)."
        >
          Measure
        </Button>
      </ButtonGroup>

      <label
        className="flex items-center gap-2 pl-1 text-[13px] text-muted"
        title="Brush size: mouse wheel in the Fog and Effects tools (or while holding Shift), or [ and ]"
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
          className="w-24 accent-gold"
        />
        <span className="w-7 text-right tabular-nums text-ink">{tools.brushSize}</span>
      </label>

      <ButtonGroup label="History">
        <Button
          square
          onClick={tools.undo}
          disabled={!tools.canUndo}
          title={keyLabel(`Undo ${layerName} change (Ctrl+Z)`)}
          aria-label="Undo"
        >
          <Undo2 className="h-4 w-4" />
        </Button>
        <Button
          square
          onClick={tools.redo}
          disabled={!tools.canRedo}
          title={keyLabel(`Redo ${layerName} change (Ctrl+Y or Ctrl+Shift+Z)`)}
          aria-label="Redo"
        >
          <Redo2 className="h-4 w-4" />
        </Button>
      </ButtonGroup>

      {tool === 'effect' && (
        <>
          <EffectKindPicker
            kind={tools.effectKind}
            onChange={tools.setEffectKind}
            title={(label) => `Paint ${label}`}
          />
          <Button
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
            title={(label) => `Make new shapes, and the selected one, ${label}`}
          />
          <ButtonGroup label="Add a shape">
            {AREA_SHAPES.map((shape) => (
              <Button
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
          <Popover
            open={shapeNote !== null && shapesNeed !== null}
            onClose={closeShapeNote}
            anchorRef={shapeAnchorRef}
            label="Add a shape"
          >
            {shapeNote && shapesNeed === 'grid' && (
              <>
                <p>
                  Shapes are sized in feet, so this map needs its grid first. Click two corners of a square
                  and save it, and the {AREA_LABELS[shapeNote].toLowerCase()} is added.
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
              <p>A map can have at most {MAX_AREAS} shapes. Delete one to add another.</p>
            )}
          </Popover>
        </>
      )}
      {tool === 'measure' &&
        (tools.measureNeedsGrid ? (
          <span className="flex items-center gap-2 text-[13px] text-muted">
            Measuring needs this map’s grid.
            <Button tone="active" onClick={tools.measureGrid}>
              Measure grid
            </Button>
          </span>
        ) : (
          <>
            <ButtonGroup label="Measure">
              <Button
                tone={tools.measureStraight ? 'default' : 'active'}
                aria-pressed={!tools.measureStraight}
                onClick={() => tools.setMeasureStraight(false)}
                title={`Movement: counted in squares, from the middle of one to the middle of another; ${MOVEMENT_TITLES[settings.movementRule]}. Settings switch how diagonals count.`}
              >
                Movement
              </Button>
              <Button
                tone={tools.measureStraight ? 'active' : 'default'}
                aria-pressed={tools.measureStraight}
                onClick={() => tools.setMeasureStraight(true)}
                title={keyLabel(
                  'Straight line: the distance as the crow flies, not counted in squares (Ctrl snaps the ends to square centres)',
                )}
              >
                Straight line
              </Button>
            </ButtonGroup>
            <Button
              tone={settings.showRulerToPlayers ? 'active' : 'default'}
              aria-pressed={settings.showRulerToPlayers}
              onClick={() => settings.setShowRulerToPlayers(!settings.showRulerToPlayers)}
              title="Show the ruler on the player screen too, as you drag it"
            >
              Show players
            </Button>
          </>
        ))}
      {(tool === 'view' || tool === 'fog') && (
        <>
          {tool === 'fog' && (
            <ButtonGroup label="Fog drawing">
              {FOG_SHAPES.map(({ shape, label, title }) => (
                <Button
                  key={shape}
                  tone={tools.fogShape === shape ? 'active' : 'default'}
                  aria-pressed={tools.fogShape === shape}
                  onClick={() => tools.setFogShape(shape)}
                  title={keyLabel(title)}
                >
                  {label}
                </Button>
              ))}
            </ButtonGroup>
          )}
          <Menu
            items={[
              { label: 'Reveal entire map', onSelect: tools.revealAll },
              { label: 'Cover entire map', onSelect: tools.coverAll },
            ]}
            trigger={(trigger) => (
              <Button {...trigger} disabled={!hasMap} title="Reveal or cover the whole map">
                Fill
                <ChevronDown className="h-3.5 w-3.5 text-muted" />
              </Button>
            )}
          />
        </>
      )}

      <Divider />

      {/* Player view zoom */}
      <ZoomControl zoom={zoom} onChange={playerView.setZoom} disabled={!hasMap || zoomLocked} />
      <Button
        square
        tone={zoomLocked ? 'active' : 'default'}
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
        tone={playerView.fit16by9 ? 'active' : 'default'}
        aria-pressed={playerView.fit16by9}
        onClick={playerView.toggleFit16by9}
        // Turning it on zooms the player view; turning it off doesn't
        disabled={!hasMap || !playerScreen.playerOpen || (zoomLocked && !playerView.fit16by9)}
        title="Resize the player window to 16:9 and fill it with the map"
      >
        Fit 16:9
      </Button>
      <Button
        ref={trueScaleRef}
        tone={playerView.atTrueScale ? 'active' : 'default'}
        aria-pressed={playerView.atTrueScale}
        aria-haspopup={trueScaleNeeds ? 'dialog' : undefined}
        aria-expanded={trueScaleNeeds ? trueScaleNote : undefined}
        onClick={() => (trueScaleNeeds ? setTrueScaleNote((shown) => !shown) : playerView.trueScale())}
        disabled={!hasMap || zoomLocked}
        title="Zoom the player view so the map’s squares are the grid square size from Player screen setup, for miniatures. A map without a grid gets it measured first."
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
                  if (trueScaleNeeds === 'setup') app.openPlayerSetup();
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

      <div className="flex-1" />

      {/* Player screen */}
      <Button
        onClick={playerScreen.openPlayer}
        title={playerScreen.playerOpen ? 'Bring the player window to the front' : 'Open the player window'}
        className="min-w-38"
      >
        <span
          aria-hidden="true"
          className={`h-2 w-2 rounded-full ${playerScreen.playerOpen ? 'bg-crimson-bright' : 'border border-faint'}`}
        />
        {playerScreen.playerOpen ? 'Player screen live' : 'Open player screen'}
      </Button>
      <Button
        tone={playerScreen.blackout ? 'live' : 'default'}
        aria-pressed={playerScreen.blackout}
        onClick={playerScreen.toggleBlackout}
        title="Hide everything on the player screen (B)"
      >
        Blackout
      </Button>
      <Button
        square
        tone="quiet"
        onClick={app.openWelcome}
        aria-label="Welcome"
        title="Welcome: what Mini VTT is and what needs setting up"
      >
        <CircleHelp className="h-4 w-4" />
      </Button>
      <Menu
        align="right"
        items={[
          { label: 'Player screen setup…', onSelect: app.openPlayerSetup },
          { label: 'Keyboard shortcuts…', onSelect: app.openShortcuts },
          { label: 'Measure map grid…', onSelect: tools.measureGrid, disabled: !hasMap, separated: true },
          {
            label: 'Show grid on player screen',
            onSelect: settings.toggleGridToPlayers,
            checked: settings.showGridToPlayers,
          },
          {
            label: 'Show effect and shape tools',
            onSelect: settings.toggleEffectTools,
            checked: settings.showEffectTools,
          },
          {
            label: 'Cover new maps in fog',
            onSelect: settings.toggleFogNewMaps,
            checked: settings.fogNewMaps,
          },
          ...MOVEMENT_RULES.map((rule, index) => ({
            label: MOVEMENT_LABELS[rule],
            onSelect: () => settings.setMovementRule(rule),
            checked: settings.movementRule === rule,
            separated: index === 0,
          })),
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
          <Button {...trigger} square tone="quiet" aria-label="Settings" title="Settings">
            <Settings className="h-4 w-4" />
          </Button>
        )}
      />
    </div>
  );
});

/** − [ 100 % ] +  The field accepts a typed percentage on Enter or blur. */
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
      <span className="text-[13px] text-muted">Zoom</span>
      <ButtonGroup label="Player view zoom">
        <Button square onClick={() => onChange(stepZoom(zoom, -1))} disabled={disabled} aria-label="Zoom out">
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
        <Button square onClick={() => onChange(stepZoom(zoom, 1))} disabled={disabled} aria-label="Zoom in">
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </ButtonGroup>
    </div>
  );
}

/** Fire / poison / magic, each with its colour chip. */
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
    <ButtonGroup label="Effect">
      {EFFECT_KINDS.map((option) => (
        <Button
          key={option}
          tone={kind === option ? 'active' : 'default'}
          aria-pressed={kind === option}
          onClick={() => onChange(option)}
          title={title(EFFECT_STYLES[option].label.toLowerCase())}
        >
          <EffectSwatch kind={option} />
          {EFFECT_STYLES[option].label}
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
      className="h-3 w-3 rounded-xs border border-black/40"
      style={{
        backgroundColor: color,
        backgroundImage: hatch
          ? `repeating-linear-gradient(-45deg, ${hatch} 0 2px, transparent 2px 5px)`
          : undefined,
      }}
    />
  );
}

// The DM window's toolbar, in three groups:
//   left    tools (view / fog / effects / shapes / measure), brush size,
//           undo and redo, and the active tool's options: the fog menu, the
//           effect colours and Clear, the colours and the shapes to add, or
//           how the Measure tool counts diagonals
//   centre  player view zoom and 16:9 fit
//   right   player screen status, blackout, and the settings menu

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import {
  ChevronDown,
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
import type { Tool } from './MapStage';
import type { AreaShape, EffectKind, MovementRule } from '../types/map';
import { MOVEMENT_LABELS, MOVEMENT_RULES, MOVEMENT_TITLES } from '../lib/grid';
import { AREA_LABELS, AREA_SHAPES, DEFAULT_AREA_FT, MAX_CIRCLES } from '../lib/areas';
import { EFFECT_KINDS, EFFECT_STYLES } from '../lib/effects';
import { keyLabel } from '../lib/platform';

export const MIN_BRUSH = 10;
export const MAX_BRUSH = 600;
export const BRUSH_STEP = 10;

interface ToolbarProps {
  hasMap: boolean;
  tool: Tool;
  onToolChange: (tool: Tool) => void;
  brushSize: number;
  onBrushSizeChange: (size: number) => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  /** The colour painted, and given to new shapes */
  effectKind: EffectKind;
  onEffectKindChange: (kind: EffectKind) => void;
  canClearEffects: boolean;
  onClearEffects: () => void;
  /** Adds a spell area, or starts measuring the grid when the map has none (it follows the save) */
  onAddCircle: (shape: AreaShape) => void;
  /** What adding a shape needs first: the map's grid, or room (a full map); explained beneath the button */
  shapesNeed: ShapesNeed | null;
  /** Whether the Effects and Shapes tools and the spell areas are offered at all */
  showEffectTools: boolean;
  onToggleEffectTools: () => void;
  onCalibrateGrid: () => void;
  /** How the Measure tool's Movement ruler counts diagonals; set in the settings menu */
  movementRule: MovementRule;
  onMovementRuleChange: (rule: MovementRule) => void;
  /** The Measure tool measures a straight line instead of movement */
  measureStraight: boolean;
  onMeasureStraightChange: (straight: boolean) => void;
  /** Whether players see the ruler too */
  showRulerToPlayers: boolean;
  onShowRulerToPlayersChange: (show: boolean) => void;
  /** The loaded map has no grid yet, so distances can't be measured */
  measureNeedsGrid: boolean;
  onRevealAll: () => void;
  onCoverAll: () => void;

  zoom: number;
  onZoomChange: (zoom: number) => void;
  /** The player view zoom is locked against the wheel, the keys and the zoom controls */
  zoomLocked: boolean;
  onToggleZoomLock: () => void;
  fit16by9: boolean;
  onToggleFit16by9: () => void;
  /** Whether the player view is at true scale: the map's squares the size set in Player screen setup */
  atTrueScale: boolean;
  /**
   * What True scale needs first: the screen size, the player screen open (to
   * know its pixels), or the map's grid. A click explains it beneath the button.
   */
  trueScaleNeeds: TrueScaleNeed | null;
  /** Applies true scale, or starts measuring the grid when that is what it needs */
  onTrueScale: () => void;

  playerOpen: boolean;
  onOpenPlayer: () => void;
  blackout: boolean;
  onToggleBlackout: () => void;
  onOpenPlayerSetup: () => void;
  onOpenShortcuts: () => void;
  onExportProject: () => void;
  onImportProject: () => void;
  onRevealLibraryFolder: () => void;
  onToggleFullScreen: () => void;
  onReload: () => void;
  onToggleDevTools: () => void;
  onQuit: () => void;
  fogLasso: boolean;
  onFogLassoChange: (shape: boolean) => void;
  showLibrary: boolean;
  onToggleLibrary: () => void;
}

export type TrueScaleNeed = 'setup' | 'player' | 'grid';
export type ShapesNeed = 'grid' | 'full';

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
export const Toolbar = memo(function Toolbar(props: ToolbarProps) {
  const { hasMap, tool, zoom, zoomLocked, trueScaleNeeds } = props;
  const layerName = tool === 'effect' ? 'effects' : 'fog';

  // The note beneath True scale saying what it still needs
  const trueScaleRef = useRef<HTMLButtonElement>(null);
  const [trueScaleNote, setTrueScaleNote] = useState(false);
  const closeTrueScaleNote = useCallback(() => setTrueScaleNote(false), []);
  useEffect(() => {
    if (!trueScaleNeeds) setTrueScaleNote(false);
  }, [trueScaleNeeds]);

  // The note beneath a shape button, when shapes can't be added yet
  const { shapesNeed } = props;
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
        aria-expanded={props.showLibrary}
        aria-label={props.showLibrary ? 'Hide maps and handouts' : 'Show maps and handouts'}
        title={keyLabel(
          props.showLibrary ? 'Hide maps and handouts (Ctrl+B)' : 'Show maps and handouts (Ctrl+B)',
        )}
        onClick={props.onToggleLibrary}
      >
        {props.showLibrary ? <PanelLeftClose className="h-4 w-4" /> : <PanelLeftOpen className="h-4 w-4" />}
      </Button>

      {/* Tools and fog */}
      <ButtonGroup label="Tool">
        <Button
          tone={tool === 'view' ? 'active' : 'default'}
          aria-pressed={tool === 'view'}
          onClick={() => props.onToolChange('view')}
          title="View: drag the frame to move the player view (V). Hold Alt to move it while painting."
        >
          View
        </Button>
        <Button
          tone={tool === 'fog' ? 'active' : 'default'}
          aria-pressed={tool === 'fog'}
          onClick={() => props.onToolChange('fog')}
          disabled={!hasMap}
          title="Paint fog (F): Left Mouse button reveals, Right mouse button covers"
        >
          Fog
        </Button>
        {props.showEffectTools && (
          <>
            <Button
              tone={tool === 'effect' ? 'active' : 'default'}
              aria-pressed={tool === 'effect'}
              onClick={() => props.onToolChange('effect')}
              disabled={!hasMap}
              title="Paint effects such as fire or poison (E): Left Mouse button paints, Right mouse button erases"
            >
              Effects
            </Button>
            <Button
              tone={tool === 'shapes' ? 'active' : 'default'}
              aria-pressed={tool === 'shapes'}
              onClick={() => props.onToolChange('shapes')}
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
          onClick={() => props.onToolChange('measure')}
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
          value={props.brushSize}
          onChange={(event) => props.onBrushSizeChange(Number(event.target.value))}
          aria-label="Brush size"
          className="w-24 accent-gold"
        />
        <span className="w-7 text-right tabular-nums text-ink">{props.brushSize}</span>
      </label>

      <ButtonGroup label="History">
        <Button
          square
          onClick={props.onUndo}
          disabled={!props.canUndo}
          title={keyLabel(`Undo ${layerName} change (Ctrl+Z)`)}
          aria-label="Undo"
        >
          <Undo2 className="h-4 w-4" />
        </Button>
        <Button
          square
          onClick={props.onRedo}
          disabled={!props.canRedo}
          title={keyLabel(`Redo ${layerName} change (Ctrl+Y or Ctrl+Shift+Z)`)}
          aria-label="Redo"
        >
          <Redo2 className="h-4 w-4" />
        </Button>
      </ButtonGroup>

      {tool === 'effect' && (
        <>
          <EffectKindPicker
            kind={props.effectKind}
            onChange={props.onEffectKindChange}
            title={(label) => `Paint ${label}`}
          />
          <Button
            onClick={props.onClearEffects}
            disabled={!props.canClearEffects}
            title={keyLabel('Remove all effects from this map (undo with Ctrl+Z)')}
          >
            Clear
          </Button>
        </>
      )}
      {tool === 'shapes' && (
        <>
          <EffectKindPicker
            kind={props.effectKind}
            onChange={props.onEffectKindChange}
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
                    props.onAddCircle(shape);
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
                      props.onAddCircle(shapeNote);
                    }}
                  >
                    Measure grid
                  </Button>
                </div>
              </>
            )}
            {shapesNeed === 'full' && (
              <p>A map can have at most {MAX_CIRCLES} shapes. Delete one to add another.</p>
            )}
          </Popover>
        </>
      )}
      {tool === 'measure' &&
        (props.measureNeedsGrid ? (
          <span className="flex items-center gap-2 text-[13px] text-muted">
            Measuring needs this map’s grid.
            <Button tone="active" onClick={props.onCalibrateGrid}>
              Measure grid
            </Button>
          </span>
        ) : (
          <>
            <ButtonGroup label="Measure">
              <Button
                tone={props.measureStraight ? 'default' : 'active'}
                aria-pressed={!props.measureStraight}
                onClick={() => props.onMeasureStraightChange(false)}
                title={`Movement: counted in squares, from the middle of one to the middle of another; ${MOVEMENT_TITLES[props.movementRule]}. Settings switch how diagonals count.`}
              >
                Movement
              </Button>
              <Button
                tone={props.measureStraight ? 'active' : 'default'}
                aria-pressed={props.measureStraight}
                onClick={() => props.onMeasureStraightChange(true)}
                title={keyLabel(
                  'Straight line: the distance as the crow flies, not counted in squares (Ctrl snaps the ends to square centres)',
                )}
              >
                Straight line
              </Button>
            </ButtonGroup>
            <Button
              tone={props.showRulerToPlayers ? 'active' : 'default'}
              aria-pressed={props.showRulerToPlayers}
              onClick={() => props.onShowRulerToPlayersChange(!props.showRulerToPlayers)}
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
              <Button
                tone={props.fogLasso ? 'default' : 'active'}
                aria-pressed={!props.fogLasso}
                onClick={() => props.onFogLassoChange(false)}
                title="Paint fog with a round brush (L switches)"
              >
                Brush
              </Button>
              <Button
                tone={props.fogLasso ? 'active' : 'default'}
                aria-pressed={props.fogLasso}
                onClick={() => props.onFogLassoChange(true)}
                title="Lasso: draw around an area to reveal it all at once; Right Mouse button covers it (L switches)"
              >
                Lasso
              </Button>
            </ButtonGroup>
          )}
          <Menu
            items={[
              { label: 'Reveal entire map', onSelect: props.onRevealAll },
              { label: 'Cover entire map', onSelect: props.onCoverAll },
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
      <ZoomControl zoom={zoom} onChange={props.onZoomChange} disabled={!hasMap || zoomLocked} />
      <Button
        square
        tone={zoomLocked ? 'active' : 'default'}
        aria-pressed={zoomLocked}
        aria-label="Lock zoom"
        onClick={props.onToggleZoomLock}
        title={
          zoomLocked
            ? 'Player view zoom is locked: the mouse wheel, the + and − keys and the zoom buttons leave it alone. Click or press Space to unlock.'
            : 'Lock the player view zoom (Space), so the mouse wheel or the + and − keys can’t change it by accident'
        }
      >
        {zoomLocked ? <Lock className="h-3.5 w-3.5" /> : <LockOpen className="h-3.5 w-3.5" />}
      </Button>
      <Button
        tone={props.fit16by9 ? 'active' : 'default'}
        aria-pressed={props.fit16by9}
        onClick={props.onToggleFit16by9}
        // Turning it on zooms the player view; turning it off doesn't
        disabled={!hasMap || !props.playerOpen || (zoomLocked && !props.fit16by9)}
        title="Resize the player window to 16:9 and fill it with the map"
      >
        Fit 16:9
      </Button>
      <Button
        ref={trueScaleRef}
        tone={props.atTrueScale ? 'active' : 'default'}
        aria-pressed={props.atTrueScale}
        aria-haspopup={trueScaleNeeds ? 'dialog' : undefined}
        aria-expanded={trueScaleNeeds ? trueScaleNote : undefined}
        onClick={() => (trueScaleNeeds ? setTrueScaleNote((shown) => !shown) : props.onTrueScale())}
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
                  if (trueScaleNeeds === 'setup') props.onOpenPlayerSetup();
                  else if (trueScaleNeeds === 'player') props.onOpenPlayer();
                  else props.onTrueScale();
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
        onClick={props.onOpenPlayer}
        title={props.playerOpen ? 'Bring the player window to the front' : 'Open the player window'}
        className="min-w-[9.5rem]"
      >
        <span
          aria-hidden="true"
          className={`h-2 w-2 rounded-full ${props.playerOpen ? 'bg-crimson-bright' : 'border border-faint'}`}
        />
        {props.playerOpen ? 'Player screen live' : 'Open player screen'}
      </Button>
      <Button
        tone={props.blackout ? 'live' : 'default'}
        aria-pressed={props.blackout}
        onClick={props.onToggleBlackout}
        title="Hide everything on the player screen (B)"
      >
        Blackout
      </Button>
      <Menu
        align="right"
        items={[
          { label: 'Player screen setup…', onSelect: props.onOpenPlayerSetup },
          { label: 'Keyboard shortcuts…', onSelect: props.onOpenShortcuts },
          { label: 'Measure map grid…', onSelect: props.onCalibrateGrid, disabled: !hasMap, separated: true },
          {
            label: 'Show effect and shape tools',
            onSelect: props.onToggleEffectTools,
            checked: props.showEffectTools,
          },
          ...MOVEMENT_RULES.map((rule, index) => ({
            label: MOVEMENT_LABELS[rule],
            onSelect: () => props.onMovementRuleChange(rule),
            checked: props.movementRule === rule,
            separated: index === 0,
          })),
          { label: 'Export project…', onSelect: props.onExportProject, separated: true },
          { label: 'Import project…', onSelect: props.onImportProject },
          { label: 'Open library folder', onSelect: props.onRevealLibraryFolder },
          {
            label: 'Full screen',
            onSelect: props.onToggleFullScreen,
            hint: keyLabel('F11'),
            separated: true,
          },
          { label: 'Reload', onSelect: props.onReload, hint: keyLabel('Ctrl+R') },
          { label: 'Developer tools', onSelect: props.onToggleDevTools, hint: keyLabel('Ctrl+Shift+I') },
          { label: 'Quit', onSelect: props.onQuit, separated: true },
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
            className={`${inputClass} w-16 rounded-none pr-6 text-right disabled:opacity-40`}
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
      className="h-3 w-3 rounded-sm border border-black/40"
      style={{
        backgroundColor: color,
        backgroundImage: hatch
          ? `repeating-linear-gradient(-45deg, ${hatch} 0 2px, transparent 2px 5px)`
          : undefined,
      }}
    />
  );
}

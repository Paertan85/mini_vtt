// The DM window's toolbar, in three groups:
//   left    tools (frame / fog / effects), brush size, undo and redo, and
//           the fog menu or, with the Effects tool, its colours and Clear
//   centre  player view zoom and 16:9 fit
//   right   player screen status, blackout, and the settings menu

import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Minus, Plus, Redo2, Settings, Undo2 } from 'lucide-react';
import { Button, ButtonGroup, Divider, inputClass } from '../ui/controls';
import { Menu } from '../ui/Menu';
import { clampZoom, MAX_ZOOM, MIN_ZOOM, stepZoom } from '../lib/geometry';
import type { Tool } from './MapStage';
import type { EffectKind } from '../types/map';
import { EFFECT_KINDS, EFFECT_STYLES } from '../lib/effects';

export const MIN_BRUSH = 10;
export const MAX_BRUSH = 300;
export const BRUSH_STEP = 5;

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
  effectKind: EffectKind;
  onEffectKindChange: (kind: EffectKind) => void;
  canClearEffects: boolean;
  onClearEffects: () => void;
  onRevealAll: () => void;
  onCoverAll: () => void;

  zoom: number;
  onZoomChange: (zoom: number) => void;
  fit16by9: boolean;
  onToggleFit16by9: () => void;

  playerOpen: boolean;
  onOpenPlayer: () => void;
  blackout: boolean;
  onToggleBlackout: () => void;
  onOpenPlayerSetup: () => void;
  onOpenShortcuts: () => void;
  onExportProject: () => void;
  onImportProject: () => void;
  onRevealLibraryFolder: () => void;
}

export function Toolbar(props: ToolbarProps) {
  const { hasMap, tool, zoom } = props;
  const layerName = tool === 'effect' ? 'effects' : 'fog';

  return (
    <div className="flex min-h-12 shrink-0 flex-wrap items-center gap-2 border-b border-line bg-panel px-3 py-2">
      {/* Tools and fog */}
      <ButtonGroup label="Tool">
        <Button
          tone={tool === 'frame' ? 'active' : 'default'}
          aria-pressed={tool === 'frame'}
          onClick={() => props.onToolChange('frame')}
          title="Move the player view (V). Hold Space to move it while painting."
        >
          Frame
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
        <Button
          tone={tool === 'effect' ? 'active' : 'default'}
          aria-pressed={tool === 'effect'}
          onClick={() => props.onToolChange('effect')}
          disabled={!hasMap}
          title="Paint effects such as fire or poison (E): Left Mouse button paints, Right mouse button erases"
        >
          Effects
        </Button>
      </ButtonGroup>

      <label
        className="flex items-center gap-2 pl-1 text-[13px] text-muted"
        title="Brush size: Ctrl + mouse wheel in the Fog and Effects tools"
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
          title={`Undo ${layerName} change (Ctrl+Z)`}
          aria-label="Undo"
        >
          <Undo2 className="h-4 w-4" />
        </Button>
        <Button
          square
          onClick={props.onRedo}
          disabled={!props.canRedo}
          title={`Redo ${layerName} change (Ctrl+Y or Ctrl+Shift+Z)`}
          aria-label="Redo"
        >
          <Redo2 className="h-4 w-4" />
        </Button>
      </ButtonGroup>

      {tool === 'effect' ? (
        <>
          <ButtonGroup label="Effect">
            {EFFECT_KINDS.map((kind) => (
              <Button
                key={kind}
                tone={props.effectKind === kind ? 'active' : 'default'}
                aria-pressed={props.effectKind === kind}
                onClick={() => props.onEffectKindChange(kind)}
                title={`Paint ${EFFECT_STYLES[kind].label.toLowerCase()}`}
              >
                <EffectSwatch kind={kind} />
                {EFFECT_STYLES[kind].label}
              </Button>
            ))}
          </ButtonGroup>
          <Button
            onClick={props.onClearEffects}
            disabled={!props.canClearEffects}
            title="Remove all effects from this map (undo with Ctrl+Z)"
          >
            Clear
          </Button>
        </>
      ) : (
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
      )}

      <Divider />

      {/* Player view zoom */}
      <ZoomControl zoom={zoom} onChange={props.onZoomChange} disabled={!hasMap} />
      <Button
        tone={props.fit16by9 ? 'active' : 'default'}
        aria-pressed={props.fit16by9}
        onClick={props.onToggleFit16by9}
        disabled={!hasMap || !props.playerOpen}
        title="Resize the player window to 16:9 and fill it with the map"
      >
        Fit 16:9
      </Button>

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
          { label: 'Export project…', onSelect: props.onExportProject, separated: true },
          { label: 'Import project…', onSelect: props.onImportProject },
          { label: 'Open library folder', onSelect: props.onRevealLibraryFolder },
        ]}
        trigger={(trigger) => (
          <Button {...trigger} square tone="quiet" aria-label="Settings" title="Settings">
            <Settings className="h-4 w-4" />
          </Button>
        )}
      />
    </div>
  );
}

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
    <div className="flex items-center gap-2" title="Player view zoom (Ctrl + mouse wheel)">
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

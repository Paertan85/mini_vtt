// The player screen setup and keyboard shortcut dialogs.

import { useState } from 'react';
import { Dialog } from '../ui/Dialog';
import { Button, ButtonGroup, Kbd, inputClass } from '../ui/controls';
import type { Size } from '../lib/geometry';
import { keyLabel } from '../lib/platform';

interface PlayerSetupDialogProps {
  diagonal: number | null;
  gridSize: number;
  /** Rotation for new maps and handouts taller than wide: 0, 90 or 270 */
  portraitRotation: number;
  viewportSize: Size | null;
  onSave: (diagonal: number | null, gridSize: number, portraitRotation: number) => void;
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
  viewportSize,
  onSave,
  onClose,
}: PlayerSetupDialogProps) {
  const [diagonalText, setDiagonalText] = useState(diagonal === null ? '' : String(diagonal));
  const [gridText, setGridText] = useState(String(gridSize));
  const [rotation, setRotation] = useState(portraitRotation);

  const parsedDiagonal = parseFloat(diagonalText);
  const validDiagonal = Number.isFinite(parsedDiagonal) && parsedDiagonal > 0 ? parsedDiagonal : null;
  const parsedGrid = parseFloat(gridText);
  const validGrid = Number.isFinite(parsedGrid) && parsedGrid > 0 ? parsedGrid : null;
  const dimensions = validDiagonal && viewportSize ? screenDimensions(validDiagonal, viewportSize) : null;

  const save = () => {
    onSave(validDiagonal, validGrid ?? gridSize, rotation);
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
      <div className="mt-4 rounded border border-line bg-ground px-3 py-2 text-[13px] text-muted">
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
                tone={rotation === choice.rotation ? 'active' : 'default'}
                aria-pressed={rotation === choice.rotation}
                onClick={() => setRotation(choice.rotation)}
              >
                {choice.label}
              </Button>
            ))}
          </ButtonGroup>
        </div>
      </div>
    </Dialog>
  );
}

/**
 * One row: what it does, the ways to do it (shown with "or" between them) and
 * an optional note. In a way, " + " joins a held key to a mouse action; parts
 * naming a mouse action are shown as text, the rest as keys.
 */
type Shortcut = [action: string, ways: string[], note?: string];

interface ShortcutGroup {
  title: string;
  note?: string;
  shortcuts: Shortcut[];
}

// Laid out the way GNOME's guidelines for shortcut windows suggest: a General
// group first, then groups in order of how often they come up at the table, the
// most used shortcuts first in each, 3 to 8 per group and one action per row.
const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: 'General',
    shortcuts: [
      ['View tool', ['V']],
      ['Fog tool', ['F']],
      ['Effects tool', ['E']],
      ['Shapes tool', ['S']],
      ['Blackout the player screen', ['B']],
      ['Undo', ['Ctrl+Z'], 'Fog, or effects in the Effects tool'],
      ['Redo', ['Ctrl+Y', 'Ctrl+Shift+Z']],
      ['Show this list', ['?']],
    ],
  },
  {
    title: 'Fog',
    shortcuts: [
      ['Reveal', ['Drag']],
      ['Cover', ['Right-drag']],
      ['Lasso on or off', ['L'], 'Draw around a room to reveal or cover it all'],
      ['Brush size', ['Wheel', '[ ]']],
      ['Paint fog from any tool', ['Shift + drag']],
    ],
  },
  {
    title: 'Player view',
    shortcuts: [
      ['Move it', ['Drag the frame'], 'View tool'],
      ['Move it from any tool', ['Space + drag']],
      ['Zoom in', ['+']],
      ['Zoom out', ['−']],
      ['Zoom', ['Wheel over the frame'], 'View tool'],
      ['Full screen', ['F11']],
    ],
  },
  {
    title: 'Spell areas',
    shortcuts: [
      ['Move', ['Drag its dot']],
      ['Move and snap to the grid', ['Ctrl + drag']],
      ['Nudge one square', ['Arrow keys'], 'With Shift: 1 ft'],
      ['Resize in 5 ft steps', ['Wheel over it'], 'A line: its width'],
      ['Aim a cone or line', ['Drag its tip']],
      ['Turn a square', ['Drag the edge handle']],
      ['Duplicate', ['Ctrl+D', 'Alt + drag']],
      ['Delete', ['Del']],
    ],
  },
  {
    title: 'Effects',
    shortcuts: [
      ['Paint', ['Drag']],
      ['Erase', ['Right-drag']],
      ['Brush size', ['Wheel', '[ ]']],
    ],
  },
  {
    title: 'Your own view',
    note: 'Players see no change',
    shortcuts: [
      ['Zoom', ['Ctrl + wheel', 'Pinch']],
      ['Zoom in', ['Ctrl+=']],
      ['Zoom out', ['Ctrl+−']],
      ['Fit the map', ['Ctrl+0']],
      ['Pan when zoomed in', ['Space + drag', 'Middle-drag']],
    ],
  },
  {
    title: 'Maps and handouts',
    shortcuts: [
      ['Load a map', ['Double-click', 'Enter']],
      ['Show or hide a handout', ['Double-click']],
      ['Add maps', ['Ctrl+O']],
      ['Hide or show their panel', ['Ctrl+B']],
    ],
  },
  {
    title: 'Handout on the player screen',
    shortcuts: [
      ['Zoom', ['Ctrl + wheel']],
      ['Pan', ['Arrow keys'], 'With Shift: bigger steps'],
      ['Close', ['Esc']],
    ],
  },
];

const MOUSE_ACTION = /drag|click|wheel|pinch/i;

/** One way to do something: keys as key caps, mouse actions as words. */
function Way({ way }: { way: string }) {
  const parts = way.split(' + ');
  return (
    <span className="flex items-center gap-1 whitespace-nowrap">
      {parts.map((part, index) => (
        <span key={part} className="flex items-center gap-1">
          {index > 0 && <span className="text-faint">+</span>}
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
      width="w-[24rem] min-[900px]:w-[46rem] min-[1200px]:w-[66rem]"
    >
      <div className="gap-x-8 min-[900px]:columns-2 min-[1200px]:columns-3">
        {SHORTCUT_GROUPS.map((group) => (
          <section key={group.title} className="mb-4 break-inside-avoid last:mb-0">
            <h3 className="border-b border-line pb-1 font-display text-[13px] font-semibold tracking-wide text-ink">
              {group.title}
            </h3>
            {group.note && <p className="mt-1 text-xs text-faint">{group.note}</p>}
            <dl className="mt-1.5 flex flex-col gap-0.5 text-[13px]">
              {group.shortcuts.map(([action, ways, note]) => (
                <div key={action} className="flex items-start justify-between gap-3">
                  <dt className="leading-6 text-ink">
                    {action}
                    {note && (
                      <span className="-mt-0.5 block text-xs leading-4 text-faint">{keyLabel(note)}</span>
                    )}
                  </dt>
                  {/* A fixed height and line height, so rows with key caps are as tall as the rest */}
                  <dd className="flex h-6 shrink-0 items-center justify-end gap-x-1.5 leading-4">
                    {ways.map((way, index) => (
                      <span key={way} className="flex items-center gap-1.5">
                        {index > 0 && <span className="text-faint">or</span>}
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

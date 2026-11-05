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

const SHORTCUTS: [string, string[]][] = [
  ['View tool: move the player view', ['V']],
  ['Fog tool', ['F']],
  ['Reveal fog / cover fog', ['Left Mouse button', 'Right Mouse button']],
  ['Fog tool: switch between brush and lasso (draw around an area)', ['L']],
  ['Effects tool: paint / erase fire, poison or magic', ['E']],
  ['Shapes tool: place circles, squares, cones and lines', ['S']],
  ['Paint fog with any tool', ['Shift', '+ Mouse button']],
  ['Brush size (Fog and Effects tools, or holding Shift)', ['Mouse wheel', '[ ]']],
  ['Undo / redo (fog, or effects in the Effects tool)', ['Ctrl+Z', 'Ctrl+Y or Ctrl+Shift+Z']],
  ['Zoom your own view (players unaffected)', ['Ctrl or Alt + wheel', 'Pinch']],
  ['Zoom your own view in / out / fit the map', ['Ctrl+=', 'Ctrl+−', 'Ctrl+0']],
  ['Pan your zoomed view', ['Space + drag', 'Middle mouse drag']],
  ['Move the player view while painting (not zoomed)', ['Space + drag']],
  ['Zoom the player view', ['+', '−']],
  ['Zoom the player view (View tool, pointer on the frame)', ['Mouse wheel']],
  ['Resize the selected area by 5 ft, a line’s width (pointer over it)', ['Mouse wheel']],
  ['Aim a cone or line and set its length', ['Drag its tip']],
  ['Turn a square', ['Drag the handle on its edge']],
  ['Move the selected area one square / 1 ft', ['Arrows', 'Shift + arrows']],
  ['Snap a dragged area to the grid', ['Hold Ctrl']],
  ['Copy an area: drag a copy away / duplicate', ['Alt + drag', 'Ctrl+D']],
  ['Delete the selected area / deselect', ['Del', 'Esc']],
  ['Blackout the player screen', ['B']],
  ['Add maps', ['Ctrl+O']],
  ['Hide or show the maps and handouts panel', ['Ctrl+B']],
  ['Load a map', ['Double-click', 'Enter']],
  ['Show or hide a handout', ['Double-click']],
  ['Handout on the player screen: zoom, pan, close', ['Ctrl + Mouse wheel', 'Arrows', 'Esc']],
  ['Full screen (the focused window)', ['F11']],
  ['This list', ['?']],
];

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog title="Keyboard shortcuts" onClose={onClose} width="w-[32rem]">
      <dl className="grid grid-cols-[1fr_auto] gap-x-6 gap-y-2.5 text-[13px]">
        {SHORTCUTS.map(([action, keys]) => (
          <div key={action} className="contents">
            <dt className="text-muted">{action}</dt>
            <dd className="flex justify-end gap-1">
              {keys.map((key) => (
                <Kbd key={key}>{keyLabel(key)}</Kbd>
              ))}
            </dd>
          </div>
        ))}
      </dl>
    </Dialog>
  );
}

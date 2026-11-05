// The player screen setup and keyboard shortcut dialogs.

import { useState } from 'react';
import { Dialog } from '../ui/Dialog';
import { Button, Kbd, inputClass } from '../ui/controls';
import type { Size } from '../lib/geometry';

interface PlayerSetupDialogProps {
  diagonal: number | null;
  gridSize: number;
  viewportSize: Size | null;
  onSave: (diagonal: number | null, gridSize: number) => void;
  onClose: () => void;
}

/** Physical width and height of a screen with this diagonal and aspect ratio. */
export function screenDimensions(diagonal: number, viewport: Size) {
  const aspect = viewport.w / viewport.h;
  const norm = Math.sqrt(aspect * aspect + 1);
  return { width: (diagonal * aspect) / norm, height: diagonal / norm };
}

export function PlayerSetupDialog({
  diagonal,
  gridSize,
  viewportSize,
  onSave,
  onClose,
}: PlayerSetupDialogProps) {
  const [diagonalText, setDiagonalText] = useState(diagonal === null ? '' : String(diagonal));
  const [gridText, setGridText] = useState(String(gridSize));

  const parsedDiagonal = parseFloat(diagonalText);
  const validDiagonal = Number.isFinite(parsedDiagonal) && parsedDiagonal > 0 ? parsedDiagonal : null;
  const parsedGrid = parseFloat(gridText);
  const validGrid = Number.isFinite(parsedGrid) && parsedGrid > 0 ? parsedGrid : null;
  const dimensions = validDiagonal && viewportSize ? screenDimensions(validDiagonal, viewportSize) : null;

  const save = () => {
    onSave(validDiagonal, validGrid ?? gridSize);
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
        miniatures line up with the map. Use any unit, as long as both values use the same one.
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
    </Dialog>
  );
}

const SHORTCUTS: [string, string[]][] = [
  ['Frame tool: move the player view', ['V']],
  ['Fog tool', ['F']],
  ['Reveal fog / cover fog', ['Left Mouse button', 'Right Mouse button']],
  ['Effects tool: paint / erase fire, poison or magic', ['E']],
  ['Paint fog with either tool', ['Shift', '+ Mouse button']],
  ['Move the player view while painting', ['Hold Space']],
  ['Brush size (Fog and Effects tools)', ['Ctrl', '+ Mouse wheel']],
  ['Snap a dragged circle to square centres', ['Hold Alt']],
  ['Resize the selected circle: 5 ft / 1 ft steps', ['Mouse wheel', 'Shift + wheel']],
  ['Delete the selected circle / deselect', ['Del', 'Esc']],
  ['Undo / redo (fog, or effects in the Effects tool)', ['Ctrl+Z', 'Ctrl+Y or Ctrl+Shift+Z']],
  ['Zoom the player view (Frame tool)', ['Ctrl', '+ Mouse wheel']],
  ['Zoom your own view (any tool; players unaffected)', ['Alt', '+ Mouse wheel']],
  ['Pan your zoomed view', ['Middle mouse drag']],
  ['Blackout the player screen', ['B']],
  ['Load a map', ['Double-click']],
  ['Show or hide a handout', ['Double-click']],
  ['Handout on the player screen: zoom, pan, close', ['Ctrl + Mouse wheel', 'Arrows', 'Esc']],
  ['Player screen full screen', ['F11']],
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
                <Kbd key={key}>{key}</Kbd>
              ))}
            </dd>
          </div>
        ))}
      </dl>
    </Dialog>
  );
}

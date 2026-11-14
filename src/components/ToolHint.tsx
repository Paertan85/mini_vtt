// One line at the bottom of the map saying how the current tool works, so the
// mouse buttons and keys aren't only in tooltips (Microsoft's tooltip
// guidelines: important information shouldn't be in a tooltip alone).
// Static text: it changes only when the tool does, and the mouse goes through it.
// Settings → Show tool hints turns it off.

import { memo } from 'react';
import type { FogShape, Tool } from './MapStage';
import { keyLabel } from '../lib/platform';

const FOG_HINTS: Record<FogShape, string> = {
  brush: 'Left button reveals, right button covers. Mouse wheel or [ ] sizes the brush.',
  lasso: 'Draw around an area: left button reveals it, right button covers it.',
  rect: 'Drag a rectangle: left button reveals it, right button covers it. Ctrl snaps it to the grid.',
  circle:
    'Click to reveal a circle, right-click to cover one. Mouse wheel sizes it, or drag out from its centre. Ctrl centres it on a square.',
  rooms:
    'Drag to mark out a room. Click inside a room to reveal it, right-click to cover it. Ctrl snaps to the grid.',
};

const TOOL_HINTS: Record<Exclude<Tool, 'fog'>, string> = {
  view: 'Drag the frame to move the player view, and scroll over it to zoom. Ctrl+drag keeps it on the grid.',
  effect: 'Left button paints, right button erases. Mouse wheel or [ ] sizes the brush.',
  shapes:
    'Add a spell area with the buttons above. Drag its dot to move it; the mouse wheel over it resizes it.',
  measure:
    'Drag, or click point by point for a path. Double-click or Enter finishes; right-click takes back a point.',
  markers:
    'Click to put down a marker only you see. Drag to move it, right-click to remove it; the mouse wheel sizes it.',
};

export const ToolHint = memo(function ToolHint({ tool, fogShape }: { tool: Tool; fogShape: FogShape }) {
  const text = tool === 'fog' ? FOG_HINTS[fogShape] : TOOL_HINTS[tool];
  return (
    <p
      role="note"
      aria-label="How the tool works"
      className="pointer-events-none absolute bottom-3 left-1/2 z-20 max-w-[calc(100%-2rem)] -translate-x-1/2 rounded border border-line bg-panel/90 px-3 py-1 text-center text-xs text-muted"
    >
      {keyLabel(text)}
    </p>
  );
});

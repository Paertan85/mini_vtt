// The DM window's keyboard shortcuts, in one table: the key handler in
// useDmController looks keys up here, and the shortcuts list (Dialogs.tsx) takes its
// key labels from here, so the two can't drift apart.
//
// Not in the table: keys other parts handle themselves (the Measure tool's
// ruler, copying and pasting fog rooms, a handout on the player screen,
// dialogs and text fields) and the window's own keys (F11, Ctrl+R); the list
// names those as text.
//
// Pure data and functions, no DOM access. Keys are written for Windows and
// Linux; the list shows Mac names with keyLabel.

/** Something a shortcut does; useDmController gives each one its handler. */
export type Command =
  | 'cancel'
  | 'deleteArea'
  | 'brushSize'
  | 'undo'
  | 'redo'
  | 'viewZoomIn'
  | 'viewZoomOut'
  | 'viewFit'
  | 'duplicateArea'
  | 'addMaps'
  | 'toggleLibrary'
  | 'toggleInterface'
  | 'nudgeArea'
  | 'loadSelectedMap'
  | 'showShortcuts'
  | 'zoomIn'
  | 'zoomOut'
  | 'toggleZoomLock'
  | 'viewTool'
  | 'fogTool'
  | 'lasso'
  | 'rectangle'
  | 'fogCircle'
  | 'effectsTool'
  | 'shapesTool'
  | 'measureTool'
  | 'markersTool'
  | 'blackout'
  | 'killScreen';

export interface KeyBinding {
  command: Command;
  /** `KeyboardEvent.key`, compared without case */
  key: string;
  /** Ctrl (or Cmd) held; without it, a held Alt also keeps the binding from matching */
  ctrl?: boolean;
  /** Shift must be held (true) or not (false); either when left out */
  shift?: boolean;
  /** Matches with any modifiers held */
  anyModifiers?: boolean;
  /** How the shortcuts list shows it; bindings without one are alternatives it leaves out */
  label?: string;
}

/** In order: the first binding that matches a key press wins. */
export const KEY_BINDINGS: readonly KeyBinding[] = [
  { command: 'cancel', key: 'Escape', anyModifiers: true, label: 'Esc' },
  { command: 'deleteArea', key: 'Delete', anyModifiers: true, label: 'Del' },
  { command: 'deleteArea', key: 'Backspace', anyModifiers: true },
  // Any modifiers: on Nordic keyboards [ and ] are typed with AltGr (Ctrl+Alt)
  { command: 'brushSize', key: '[', anyModifiers: true, label: '[ ]' },
  { command: 'brushSize', key: ']', anyModifiers: true },
  { command: 'undo', key: 'z', ctrl: true, shift: false, label: 'Ctrl+Z' },
  { command: 'redo', key: 'y', ctrl: true, label: 'Ctrl+Y' },
  { command: 'redo', key: 'z', ctrl: true, shift: true, label: 'Ctrl+Shift+Z' },
  // Your own view, like a browser or Photoshop; the player view is untouched
  { command: 'viewZoomIn', key: '=', ctrl: true, label: 'Ctrl+=' },
  { command: 'viewZoomIn', key: '+', ctrl: true },
  { command: 'viewZoomOut', key: '-', ctrl: true, label: 'Ctrl+−' },
  { command: 'viewZoomOut', key: '_', ctrl: true },
  { command: 'viewFit', key: '0', ctrl: true, label: 'Ctrl+0' },
  { command: 'duplicateArea', key: 'd', ctrl: true, label: 'Ctrl+D' },
  { command: 'addMaps', key: 'o', ctrl: true, label: 'Ctrl+O' },
  // The sidebar toggle in editors and file browsers
  { command: 'toggleLibrary', key: 'b', ctrl: true, shift: false, label: 'Ctrl+B' },
  // Everything but the map, for small screens such as the Steam Deck's
  { command: 'toggleInterface', key: 'b', ctrl: true, shift: true, label: 'Ctrl+Shift+B' },
  { command: 'nudgeArea', key: 'ArrowLeft', label: 'Arrow keys' },
  { command: 'nudgeArea', key: 'ArrowRight' },
  { command: 'nudgeArea', key: 'ArrowUp' },
  { command: 'nudgeArea', key: 'ArrowDown' },
  { command: 'loadSelectedMap', key: 'Enter', label: 'Enter' },
  { command: 'showShortcuts', key: '?', label: '?' },
  { command: 'zoomIn', key: '+', label: '+' },
  { command: 'zoomIn', key: '=' },
  { command: 'zoomOut', key: '-', label: '−' },
  { command: 'toggleZoomLock', key: ' ', label: 'Space' },
  { command: 'viewTool', key: 'v', label: 'V' },
  { command: 'fogTool', key: 'f', label: 'F' },
  // L for lasso, as in Photoshop
  { command: 'lasso', key: 'l', label: 'L' },
  { command: 'rectangle', key: 'r', label: 'R' },
  { command: 'fogCircle', key: 'c', label: 'C' },
  { command: 'effectsTool', key: 'e', label: 'E' },
  { command: 'shapesTool', key: 's', label: 'S' },
  { command: 'measureTool', key: 'm', label: 'M' },
  // K for marKers: M is the Measure tool
  { command: 'markersTool', key: 'k', label: 'K' },
  { command: 'blackout', key: 'b', label: 'B' },
  { command: 'killScreen', key: 'k', ctrl: true, label: 'Ctrl+K' },
];

/** The modifier and key fields of a KeyboardEvent. */
export interface KeyPress {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

const matches = (binding: KeyBinding, press: KeyPress) => {
  if (binding.key.toLowerCase() !== press.key.toLowerCase()) return false;
  if (binding.anyModifiers) return true;
  const ctrl = press.ctrlKey || press.metaKey;
  if (ctrl !== !!binding.ctrl) return false;
  if (!ctrl && press.altKey) return false;
  return binding.shift === undefined || binding.shift === press.shiftKey;
};

/** The command a key press asks for, or null. */
export const commandFor = (press: KeyPress): Command | null =>
  KEY_BINDINGS.find((binding) => matches(binding, press))?.command ?? null;

// ─── The shortcuts list ───────────────────────────────────────────────────────

/** One way to do something: words (a mouse action, or a key handled elsewhere), or a command's keys. */
export type Way = string | { keys: Command };

/** One row: what it does, the ways to do it, and an optional note. */
export type Shortcut = [action: string, ways: Way[], note?: string];

export interface ShortcutGroup {
  title: string;
  note?: string;
  shortcuts: Shortcut[];
}

/** The labels a way stands for: a command's keys are one way each. */
export const waysOf = (way: Way): string[] =>
  typeof way === 'string'
    ? [way]
    : KEY_BINDINGS.filter((binding) => binding.command === way.keys && binding.label).map(
        (binding) => binding.label as string,
      );

const keys = (command: Command): Way => ({ keys: command });

// Laid out the way GNOME's guidelines for shortcut windows suggest: a General
// group first, then groups in order of how often they come up at the table, the
// most used shortcuts first in each, 3 to 8 per group and one action per row.
// In a way written as text, " + " joins a held key to a mouse action.
export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: 'General',
    shortcuts: [
      ['View tool', [keys('viewTool')]],
      ['Fog tool', [keys('fogTool')]],
      ['Effects tool', [keys('effectsTool')]],
      ['Spells tool', [keys('shapesTool')]],
      ['Markers tool', [keys('markersTool')]],
      ['Blackout the player screen', [keys('blackout')]],
      ['Show or hide the kill screen', [keys('killScreen')], 'Red words on black, for a kill'],
      ['Hide or show everything but the map', [keys('toggleInterface')], 'For small screens'],
      ['Undo', [keys('undo')], 'Fog; effects or markers in their own tool'],
      ['Redo', [keys('redo')]],
      ['Show this list', [keys('showShortcuts')]],
    ],
  },
  {
    title: 'Fog',
    shortcuts: [
      ['Reveal', ['Drag']],
      ['Cover', ['Right-drag']],
      ['Lasso on or off', [keys('lasso')], 'Draw around a room to reveal or cover it all'],
      [
        'Rectangle on or off',
        [keys('rectangle')],
        'Drag a rectangle to reveal or cover; Ctrl snaps it to the grid',
      ],
      [
        'Circle on or off',
        [keys('fogCircle')],
        'Click to reveal a circle sized in feet; the wheel sizes it in 5 ft steps',
      ],
      ['Brush size', ['Wheel', keys('brushSize')]],
      ['Paint fog from any tool', ['Shift + drag']],
    ],
  },
  {
    title: 'Fog rooms',
    note: 'Fog tool, Rooms; only you see the rooms',
    shortcuts: [
      ['Mark out a room', ['Drag on the map']],
      ['Reveal a room to the players', ['Click inside it']],
      ['Cover it again', ['Right-click inside it']],
      ['Move a room', ['Drag inside it']],
      ['Resize a room', ['Drag an edge or corner']],
      ['Snap to the grid', ['Ctrl + drag']],
      ['Copy a room', ['Ctrl+C'], 'With the mouse pointer over it'],
      ['Paste it at the mouse pointer', ['Ctrl+V'], 'On the grid if the room was'],
    ],
  },
  {
    title: 'Markers',
    note: 'Markers tool; only you see the markers',
    shortcuts: [
      ['Put down a marker', ['Click on the map'], 'On a grid, on the squares it covers'],
      ['Move a marker', ['Drag it']],
      ['Remove a marker', ['Right-click it', keys('deleteArea')], 'Del removes the selected one'],
      ['Resize the selected marker', ['Wheel'], 'Anywhere; a square at a time on a grid'],
      ['Resize another marker', ['Wheel over it']],
      ['Size of the next marker', ['Wheel'], 'With none selected'],
      ['Change its letter', ['Type it in the Letter field'], 'A new marker gets the next free letter'],
      ['Undo a change, such as a marker removed', [keys('undo')]],
      ['Deselect', [keys('cancel')]],
    ],
  },
  {
    title: 'Player view',
    shortcuts: [
      ['Move it', ['Drag the frame'], 'View tool; Ctrl keeps it to the grid'],
      ['Move it from any tool', ['Alt + drag']],
      ['Zoom in', [keys('zoomIn')]],
      ['Zoom out', [keys('zoomOut')]],
      ['Zoom', ['Wheel over the frame'], 'View tool'],
      ['Zoom in 1% steps', ['Alt + wheel'], 'Any tool'],
      ['Lock or unlock the zoom', [keys('toggleZoomLock')]],
      ['Full screen', ['F11', 'Double-click the player screen']],
    ],
  },
  {
    title: 'Spell areas',
    shortcuts: [
      ['Move', ['Drag its dot']],
      ['Move and snap to the grid', ['Ctrl + drag']],
      ['Nudge one square', [keys('nudgeArea')], 'With Shift: 1 ft'],
      ['Resize in 5 ft steps', ['Wheel over it'], 'A line: its width'],
      ['Aim a cone or line', ['Drag its tip']],
      ['Aim in 45° steps', ['Ctrl + drag its tip']],
      ['Turn a square', ['Drag the edge handle']],
      ['Duplicate', [keys('duplicateArea')]],
      ['Delete', [keys('deleteArea')]],
      ['Deselect', [keys('cancel')], 'Also stops measuring the grid'],
    ],
  },
  {
    title: 'Measuring',
    note: 'Players see it only with Show players on',
    shortcuts: [
      ['Measure tool', [keys('measureTool')]],
      ['Measure a distance', ['Drag']],
      ['Measure a path round corners', ['Click each point']],
      ['Finish the path', ['Double-click', 'Enter']],
      ['Take back the last point', ['Right-click']],
      ['Clear the ruler', ['Esc', 'Backspace']],
      ['Snap the points to squares', ['Ctrl + click'], 'Straight line; Movement always snaps'],
    ],
  },
  {
    title: 'Effects',
    shortcuts: [
      ['Paint', ['Drag']],
      ['Erase', ['Right-drag']],
      ['Brush size', ['Wheel', keys('brushSize')]],
    ],
  },
  {
    title: 'Your own view',
    note: 'Players see no change',
    shortcuts: [
      ['Zoom', ['Ctrl + wheel', 'Pinch']],
      ['Zoom in', [keys('viewZoomIn')]],
      ['Zoom out', [keys('viewZoomOut')]],
      ['Fit the map', [keys('viewFit')]],
      ['Pan when zoomed in', ['Middle-drag']],
    ],
  },
  {
    title: 'Maps and handouts',
    shortcuts: [
      ['Load a map', ['Double-click', keys('loadSelectedMap')]],
      ['Show or hide a handout', ['Double-click']],
      ['Add maps', [keys('addMaps')]],
      ['Hide or show their panel', [keys('toggleLibrary')]],
    ],
  },
  {
    title: 'Handout on the player screen',
    shortcuts: [
      ['Move', ['Drag', 'Arrow keys'], 'Arrow keys with Shift: bigger steps'],
      ['Zoom at the pointer', ['Wheel', 'Pinch']],
      ['Close', ['Esc']],
    ],
  },
];

// Where the player window opens. Kept free of Electron, so it is plain data
// handling that tests can run and a Rust port can copy.

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DisplayInfo {
  id: number;
  bounds: Rect;
  workArea: Rect;
}

/** The player window's size when it opens in a window. */
export const PLAYER_WINDOW = { width: 1024, height: 768 };

/**
 * The display the player screen opens on, full screen: the one it was last on
 * in this session, if that is still connected and isn't the DM window's,
 * otherwise the largest display the DM window isn't on (a TV beside a laptop).
 * Null when the DM window's display is the only one: the player window then
 * opens in a window, as on a single screen.
 */
export function pickPlayerDisplay(
  displays: readonly DisplayInfo[],
  dmDisplayId: number | null,
  lastDisplayId: number | null,
): DisplayInfo | null {
  const others = displays.filter((display) => display.id !== dmDisplayId);
  if (others.length === 0) return null;
  const last = others.find((display) => display.id === lastDisplayId);
  if (last) return last;
  const area = (display: DisplayInfo) => display.bounds.width * display.bounds.height;
  return others.reduce((best, display) => (area(display) > area(best) ? display : best));
}

/** The player window's bounds centred in a display's work area, shrunk to fit it. */
export function centredIn(workArea: Rect, size = PLAYER_WINDOW): Rect {
  const width = Math.min(size.width, workArea.width);
  const height = Math.min(size.height, workArea.height);
  return {
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + (workArea.height - height) / 2),
    width,
    height,
  };
}

// The colours the DM can give the player view frame and its grid (Settings →
// Player screen), in the order Settings shows them: white (the default), teal,
// magenta, gold, crimson and sky blue, so one stands out on any map. The
// effect colours are left out, as are the fog's indigo and the interface's
// greys, which would vanish over the fog.

export type FrameColor = 'teal' | 'white' | 'magenta' | 'sky' | 'gold' | 'crimson';

export const FRAME_COLORS: readonly FrameColor[] = ['white', 'teal', 'magenta', 'gold', 'crimson', 'sky'];

export const DEFAULT_FRAME_COLOR: FrameColor = 'white';

/** Label, and the colour as space-separated RGB so it can take an alpha: `rgb(${rgb} / 0.1)` */
export const FRAME_COLOR_STYLES: Record<FrameColor, { label: string; rgb: string }> = {
  // A green teal, well apart from the interface's light blue (the ruler and
  // handles drawn over the map) and from the poison green
  teal: { label: 'Teal', rgb: '34 184 134' },
  white: { label: 'White', rgb: '240 236 226' },
  magenta: { label: 'Magenta', rgb: '222 76 200' },
  sky: { label: 'Sky blue', rgb: '86 166 236' },
  // Crimson is the palette's crimson-bright (src/index.css)
  gold: { label: 'Gold', rgb: '201 162 39' },
  crimson: { label: 'Crimson', rgb: '196 58 63' },
};

export const isFrameColor = (value: unknown): value is FrameColor =>
  FRAME_COLORS.includes(value as FrameColor);

// The colours the DM can give the player view frame (Player screen setup):
// the palette's gold (the default) and crimson, and four of its own for maps
// where those stand out better. Gold also marks the selection, the brush and
// the grid being measured. The effect colours are left out, as are the fog's
// indigo and the stone neutrals, which would vanish over the fog.

export type FrameColor = 'teal' | 'white' | 'magenta' | 'sky' | 'gold' | 'crimson';

export const FRAME_COLORS: readonly FrameColor[] = ['gold', 'crimson', 'teal', 'white', 'magenta', 'sky'];

export const DEFAULT_FRAME_COLOR: FrameColor = 'gold';

/** Label, and the colour as space-separated RGB so it can take an alpha: `rgb(${rgb} / 0.1)` */
export const FRAME_COLOR_STYLES: Record<FrameColor, { label: string; rgb: string }> = {
  teal: { label: 'Teal', rgb: '74 168 160' },
  white: { label: 'White', rgb: '240 236 226' },
  magenta: { label: 'Magenta', rgb: '222 76 200' },
  sky: { label: 'Sky blue', rgb: '86 166 236' },
  // The palette's gold and crimson-bright (src/index.css)
  gold: { label: 'Gold', rgb: '201 162 39' },
  crimson: { label: 'Crimson', rgb: '196 58 63' },
};

export const isFrameColor = (value: unknown): value is FrameColor =>
  FRAME_COLORS.includes(value as FrameColor);

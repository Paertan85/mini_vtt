// The colours the DM can give the player view frame (Player screen setup).
// None is gold or crimson: gold marks the selection, the brush and the grid
// being measured, crimson what players can see change.

export type FrameColor = 'teal' | 'white' | 'magenta' | 'sky';

export const FRAME_COLORS: readonly FrameColor[] = ['teal', 'white', 'magenta', 'sky'];

export const DEFAULT_FRAME_COLOR: FrameColor = 'teal';

/** Label, and the colour as space-separated RGB so it can take an alpha: `rgb(${rgb} / 0.1)` */
export const FRAME_COLOR_STYLES: Record<FrameColor, { label: string; rgb: string }> = {
  teal: { label: 'Teal', rgb: '74 168 160' },
  white: { label: 'White', rgb: '240 236 226' },
  magenta: { label: 'Magenta', rgb: '222 76 200' },
  sky: { label: 'Sky blue', rgb: '86 166 236' },
};

export const isFrameColor = (value: unknown): value is FrameColor =>
  FRAME_COLORS.includes(value as FrameColor);

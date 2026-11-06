// Small geometry helpers shared by the DM window components.

export interface Size {
  w: number;
  h: number;
}

export const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** Width and height after a rotation in 90-degree steps. */
export const orientedSize = (size: Size, rotation: number): Size =>
  rotation % 180 === 0 ? size : { w: size.h, h: size.w };

// ─── Player view zoom ────────────────────────────────────────────────────────

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 5;
export const clampZoom = (zoom: number) => clamp(zoom, MIN_ZOOM, MAX_ZOOM);

/** Wheel delta in pixels, whatever unit the device reports. */
export const wheelPixels = (event: WheelEvent) =>
  (event.deltaY || event.deltaX) * (event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? 800 : 1);

/** Familiar stops for the − and + buttons, like a browser's zoom. */
const ZOOM_STEPS = [0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];

export function stepZoom(zoom: number, direction: 1 | -1): number {
  const next =
    direction > 0
      ? ZOOM_STEPS.find((step) => step > zoom + 0.001)
      : [...ZOOM_STEPS].reverse().find((step) => step < zoom - 0.001);
  return next ?? clampZoom(zoom);
}

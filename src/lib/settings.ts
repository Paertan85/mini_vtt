// The app's settings: one rule per setting, giving its default and how a
// stored or sent value is checked. The main process uses the rules both to
// read index.json and to accept a change from the DM window, and the DM window
// starts from the defaults, so a new setting is added here and nowhere else
// (besides its type in LibrarySettings).
//
// Pure functions with no DOM or Node access, like grid.ts.

import type { LibrarySettings } from '../types/map';
import { DEFAULT_MOVEMENT_RULE, isMovementRule } from './grid';
import { DEFAULT_FRAME_COLOR, isFrameColor } from './frameColors';

/** Ids the library generates; anything else is refused, so no path can escape its folder. */
export const LIBRARY_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The settings the DM sets: everything but the loaded map and the map order. */
export type Preferences = Omit<LibrarySettings, 'currentMapId' | 'mapOrder'>;

/** Settings that a change from the DM window may set. */
export type SettingsPatch = Partial<Omit<LibrarySettings, 'mapOrder'>>;

interface Rule<T> {
  default: T;
  /** The value to keep, or undefined when `value` isn't valid */
  parse: (value: unknown) => T | undefined;
}

/** A positive finite number. Accepts numeric strings, as libraries before 1.1 stored them. */
const positive = (value: unknown): number | undefined => {
  const parsed = typeof value === 'string' ? parseFloat(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
};
const boolean = (value: unknown) => (typeof value === 'boolean' ? value : undefined);

/** Turns a new portrait map or handout can get: none, right or left. */
export const PORTRAIT_ROTATIONS = [0, 90, 270] as const;

const RULES: { [K in keyof SettingsPatch]-?: Rule<LibrarySettings[K]> } = {
  currentMapId: {
    default: null,
    parse: (value) =>
      value === null || (typeof value === 'string' && LIBRARY_ID.test(value)) ? value : undefined,
  },
  // null: no screen size, so no grid in the frame
  playerScreenDiagonal: { default: null, parse: (value) => (value === null ? null : positive(value)) },
  gridSize: { default: 1, parse: positive },
  showEffectTools: { default: true, parse: boolean },
  showLibrary: { default: true, parse: boolean },
  showWelcome: { default: true, parse: boolean },
  // Turned left: how most tables with the screen lying flat play
  portraitRotation: {
    default: 270,
    parse: (value) => (PORTRAIT_ROTATIONS.includes(value as 0) ? (value as number) : undefined),
  },
  diagonalRule: {
    default: DEFAULT_MOVEMENT_RULE,
    parse: (value) => (isMovementRule(value) ? value : undefined),
  },
  showRulerToPlayers: { default: false, parse: boolean },
  lockZoom: { default: false, parse: boolean },
  frameColor: { default: DEFAULT_FRAME_COLOR, parse: (value) => (isFrameColor(value) ? value : undefined) },
};

const KEYS = Object.keys(RULES) as (keyof SettingsPatch)[];

export const DEFAULT_SETTINGS: LibrarySettings = Object.fromEntries(
  KEYS.map((key) => [key, RULES[key].default]),
) as unknown as LibrarySettings;

/**
 * Stored settings, each missing or invalid one replaced by its default.
 * Libraries written before 1.1 named the screen size `playerViewDiagonal`.
 */
export function normalizeSettings(stored: unknown): LibrarySettings {
  const raw = (stored && typeof stored === 'object' ? stored : {}) as Record<string, unknown>;
  const values: Record<string, unknown> = {
    ...raw,
    playerScreenDiagonal: raw.playerScreenDiagonal ?? raw.playerViewDiagonal ?? null,
  };
  const settings = Object.fromEntries(
    KEYS.map((key) => [key, RULES[key].parse(values[key]) ?? RULES[key].default]),
  ) as unknown as LibrarySettings;
  if (Array.isArray(raw.mapOrder)) {
    settings.mapOrder = raw.mapOrder.filter(
      (id): id is string => typeof id === 'string' && LIBRARY_ID.test(id),
    );
  }
  return settings;
}

/**
 * The valid part of a change: unknown keys and invalid values are left out.
 * The map order is not a setting the DM sends; it goes through reorderMaps.
 */
export function cleanSettingsPatch(patch: unknown): SettingsPatch {
  if (!patch || typeof patch !== 'object') return {};
  const values = patch as Record<string, unknown>;
  const clean: Record<string, unknown> = {};
  for (const key of KEYS) {
    if (!(key in values)) continue;
    const parsed = RULES[key].parse(values[key]);
    if (parsed !== undefined) clean[key] = parsed;
  }
  return clean as SettingsPatch;
}

// Fog rooms: rectangles the DM marks out on a map ahead of time, to reveal
// or cover in one click. Only the DM sees them; players see only the fog a
// room changes. Their geometry (drawing, moving, resizing) is lib/rect.ts's.
//
// Pure functions with no DOM access: the main process validates with them
// everything that arrives over IPC or from a project file, and the DM window
// edits rooms and works out their status with them.

import type { FogRoom } from '../types/map';
import type { Rect } from './rect';

export const MAX_ROOMS = 100;
export const MAX_ROOM_NAME = 40;
const ROOM_ID = /^[A-Za-z0-9_-]{1,32}$/;

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

export const newRoomId = () => `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** A room's name as shown: its own, or its number on the map. */
export const roomLabel = (room: FogRoom, index: number) => room.name || `Room ${index + 1}`;

/** A room with these fields and name; no name when it is empty. */
function roomWith(id: string, rect: Rect, name: string | undefined): FogRoom {
  const { x, y, width, height } = rect;
  return name ? { id, x, y, width, height, name } : { id, x, y, width, height };
}

/**
 * Valid rooms only, at most MAX_ROOMS, with unique ids and a positive size.
 * A name is trimmed and cut to MAX_ROOM_NAME characters; an empty one, or
 * one that isn't text, is left out.
 */
export function normalizeRooms(value: unknown): FogRoom[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const rooms: FogRoom[] = [];
  for (const raw of value) {
    if (rooms.length >= MAX_ROOMS) break;
    const { id, x, y, width, height, name } = (raw && typeof raw === 'object' ? raw : {}) as Record<
      string,
      unknown
    >;
    if (typeof id !== 'string' || !ROOM_ID.test(id) || seen.has(id)) continue;
    if (!finite(x) || !finite(y) || !finite(width) || !finite(height) || width <= 0 || height <= 0) continue;
    seen.add(id);
    const cleanName = typeof name === 'string' ? name.trim().slice(0, MAX_ROOM_NAME) : '';
    rooms.push(roomWith(id, { x, y, width, height }, cleanName));
  }
  return rooms;
}

// ─── Editing ──────────────────────────────────────────────────────────────────

/** With a new room; unchanged when the map already has MAX_ROOMS. */
export const addRoom = (rooms: FogRoom[], rect: Rect): FogRoom[] =>
  rooms.length >= MAX_ROOMS ? rooms : [...rooms, roomWith(newRoomId(), rect, undefined)];

/** With one room moved or resized to `rect`. */
export const reshapeRoom = (rooms: FogRoom[], id: string, rect: Rect): FogRoom[] =>
  rooms.map((room) => (room.id === id ? roomWith(id, rect, room.name) : room));

/**
 * With one room renamed. The name is kept as typed, spaces and all, so it
 * can be edited; it is trimmed when it is saved. Empty: back to its number.
 */
export const renameRoom = (rooms: FogRoom[], id: string, name: string): FogRoom[] =>
  rooms.map((room) => (room.id === id ? roomWith(id, room, name.slice(0, MAX_ROOM_NAME)) : room));

export const removeRoom = (rooms: FogRoom[], id: string): FogRoom[] => rooms.filter((room) => room.id !== id);

// ─── Status ───────────────────────────────────────────────────────────────────

/** How much fog a room shows the players: all of it, some, or none. */
export type RoomStatus = 'hidden' | 'partly' | 'open';

export const ROOM_STATUS_LABELS: Record<RoomStatus, string> = {
  hidden: 'Hidden',
  partly: 'Partly open',
  open: 'Open',
};

/** Each room is read at this many points a side, whatever its size. */
export const ROOM_SAMPLES = 16;
/** The share of points that may disagree, so a stray brush edge doesn't make a room partly open. */
const STATUS_TOLERANCE = 0.02;

/**
 * The status of `count` rooms from points read off the fog mask: room k's
 * are the k-th ROOM_SAMPLES-wide square of one row, RGBA as ImageData has
 * them. A point is fog when it is at least half opaque.
 */
export function roomStatuses(
  sample: { data: ArrayLike<number>; width: number },
  count: number,
): RoomStatus[] {
  const statuses: RoomStatus[] = [];
  for (let room = 0; room < count; room++) {
    let fogged = 0;
    for (let row = 0; row < ROOM_SAMPLES; row++) {
      for (let col = 0; col < ROOM_SAMPLES; col++) {
        if (sample.data[(row * sample.width + room * ROOM_SAMPLES + col) * 4 + 3] >= 128) fogged += 1;
      }
    }
    const share = fogged / (ROOM_SAMPLES * ROOM_SAMPLES);
    statuses.push(share <= STATUS_TOLERANCE ? 'open' : share >= 1 - STATUS_TOLERANCE ? 'hidden' : 'partly');
  }
  return statuses;
}

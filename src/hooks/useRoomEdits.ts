// Editing the loaded map's fog rooms. The rooms are part of the loaded map
// (useLoadedMap), so they are replaced whole when another map loads; the
// editing steps are lib/rooms.ts's. App.tsx saves them with the map's view,
// a moment after each change.
//
// The edits keep a fixed identity, so passing them down re-renders nothing.

import { useMemo, useRef } from 'react';
import type { FogRoom } from '../types/map';
import type { Rect } from '../lib/rect';
import { addRoom, MAX_ROOMS, removeRoom, renameRoom, reshapeRoom } from '../lib/rooms';
import { notify } from '../ui/notify';

export interface RoomEdits {
  /** A room marked out; refused, with a message, when the map already has MAX_ROOMS */
  add: (rect: Rect) => void;
  /** Moved or resized */
  reshape: (id: string, rect: Rect) => void;
  /** An empty name gives the room back its number */
  rename: (id: string, name: string) => void;
  /** The fog stays as it is */
  remove: (id: string) => void;
}

export function useRoomEdits(
  rooms: FogRoom[],
  setRooms: (change: (current: FogRoom[]) => FogRoom[]) => void,
): RoomEdits {
  // Read when a room is added, so the edits don't change with the rooms
  const countRef = useRef(rooms.length);
  countRef.current = rooms.length;
  return useMemo(
    () => ({
      add: (rect: Rect) => {
        if (countRef.current >= MAX_ROOMS) {
          notify(`A map can have up to ${MAX_ROOMS} rooms. Delete one to mark out another.`, 'error');
          return;
        }
        setRooms((current) => addRoom(current, rect));
      },
      reshape: (id: string, rect: Rect) => setRooms((current) => reshapeRoom(current, id, rect)),
      rename: (id: string, name: string) => setRooms((current) => renameRoom(current, id, name)),
      remove: (id: string) => setRooms((current) => removeRoom(current, id)),
    }),
    [setRooms],
  );
}

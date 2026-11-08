// Whether each fog room is hidden, partly open or open, read from the fog
// mask. Only while `active` (the Fog tool's Rooms): the mask is read when a
// room is added, moved, resized or removed (not renamed) and after each fog
// change, never on a timer or per frame, and the small canvas it is read
// through is let go as soon as it isn't needed. Each read is one small draw
// per room and one read of ROOM_SAMPLES² points a room, however large the map
// (see sampleMaskRects).

import { useEffect, useRef, useState } from 'react';
import type { FogRoom } from '../types/map';
import type { Size } from '../lib/geometry';
import { sampleMaskRects } from '../lib/fog';
import { ROOM_SAMPLES, roomStatuses, type RoomStatus } from '../lib/rooms';

const NONE: Record<string, RoomStatus> = {};

export function useRoomStatus(
  active: boolean,
  rooms: FogRoom[],
  media: Size,
  maskRef: React.RefObject<HTMLCanvasElement | null>,
  subscribe: (listener: () => void) => () => void,
): Record<string, RoomStatus> {
  const [statuses, setStatuses] = useState(NONE);
  // The latest rooms, read when the mask is; renaming one changes nothing to read
  const roomsRef = useRef(rooms);
  roomsRef.current = rooms;
  const layout = rooms.map(({ id, x, y, width, height }) => `${id}:${x},${y},${width},${height}`).join(';');

  useEffect(() => {
    if (!active || !layout) {
      setStatuses(NONE);
      return;
    }
    const scratch = document.createElement('canvas');
    const measure = () => {
      const current = roomsRef.current;
      const mask = maskRef.current;
      const sample = mask && sampleMaskRects(mask, scratch, current, media, ROOM_SAMPLES);
      if (!sample) return;
      const list = roomStatuses(sample, current.length);
      setStatuses(Object.fromEntries(current.map((room, index) => [room.id, list[index]])));
    };
    measure();
    const unsubscribe = subscribe(measure);
    return () => {
      unsubscribe();
      scratch.width = 0;
      scratch.height = 0;
    };
  }, [active, layout, media, maskRef, subscribe]);

  return statuses;
}

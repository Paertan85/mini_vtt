// Fog rooms in the DM window's Fog tool. Their dashed outlines show in every
// Fog mode; in Rooms they can also be marked out and changed:
//
//   drag on the map           marks out a new room
//   click inside a room       reveals it to the players; right-click covers it
//   drag inside a room        moves it
//   drag an edge or corner    resizes it
//   Ctrl (Cmd on a Mac)       snaps what is dragged to the grid
//   Ctrl+C over a room        copies it; Ctrl+V pastes a copy at the mouse
//                             pointer, on the grid if the room was on it
//   the room's bar            its name, a button that reveals or covers it,
//                             Delete, and whether it is hidden or open
//
// Players never see the rooms, only the fog a click changes. The rooms are
// laid out on the unturned stage surface, so their bars stay upright however
// the map is turned. A drag re-renders only this layer, and changes the room
// (which is then saved) once, when it is dropped.

import React, { useEffect, useRef, useState } from 'react';
import { Eye, EyeOff, Trash2 } from 'lucide-react';
import type { FogMode, FogRoom, MapGrid, Point } from '../types/map';
import type { Orientation, Size } from '../lib/geometry';
import {
  clipToMap,
  edgesOnMap,
  moveRect,
  pasteRect,
  rectFromCorners,
  resizeRect,
  type Edges,
  type Rect,
} from '../lib/rect';
import { MAX_ROOM_NAME, ROOM_STATUS_LABELS, roomLabel, type RoomStatus } from '../lib/rooms';
import { ctrlHeld, isTypingTarget, keyLabel } from '../lib/platform';
import type { RoomEdits } from '../hooks/useRoomEdits';
import { useRoomStatus } from '../hooks/useRoomStatus';
import { notify } from '../ui/notify';

interface FogRoomsLayerProps {
  rooms: FogRoom[];
  media: Size;
  grid: MapGrid | null;
  orientation: Orientation;
  /** Surface pixels per map pixel */
  displayScale: number;
  /** The Fog tool's Rooms: rooms can be marked out and changed, not just seen */
  editable: boolean;
  /** Client coordinates → map natural pixels */
  toMapPoint: (clientX: number, clientY: number) => Point | null;
  /** Map natural pixels → position on the stage surface */
  mapToSurface: (point: Point) => Point;
  /** The fog mask, read for each room's status, and when it changes */
  maskRef: React.RefObject<HTMLCanvasElement>;
  subscribeMask: (listener: () => void) => () => void;
  edits: RoomEdits;
  /** Reveal or cover a room's fog */
  onFill: (room: FogRoom, mode: FogMode) => void;
}

/** Moving less than this (screen px) between press and release is a click, not a drag */
const CLICK_SLOP_PX = 4;
/** A room narrower than this (screen px) is a slip, not a room */
const MIN_ROOM_PX = 4;

/** What the mouse is doing, from press to release. */
type Drag =
  | { kind: 'draw'; pointerId: number; start: Point; rect: Rect | null }
  /** Pressed inside a room: a click (reveal or cover) unless it turns into a move */
  | { kind: 'press'; pointerId: number; id: string; button: number; from: Point; start: Point }
  | { kind: 'move'; pointerId: number; id: string; start: Point; rect: Rect }
  | { kind: 'resize'; pointerId: number; id: string; edges: Edges; rect: Rect };

/** A room's resize handles, by the side or corner of its outline they sit on, on screen. */
const HANDLES: { side: Point; corner: boolean; cursor: string; style: React.CSSProperties }[] = [
  { side: { x: 0, y: -1 }, corner: false, cursor: 'cursor-ns-resize', style: { left: 6, right: 6, top: -5 } },
  {
    side: { x: 0, y: 1 },
    corner: false,
    cursor: 'cursor-ns-resize',
    style: { left: 6, right: 6, bottom: -5 },
  },
  {
    side: { x: -1, y: 0 },
    corner: false,
    cursor: 'cursor-ew-resize',
    style: { top: 6, bottom: 6, left: -5 },
  },
  {
    side: { x: 1, y: 0 },
    corner: false,
    cursor: 'cursor-ew-resize',
    style: { top: 6, bottom: 6, right: -5 },
  },
  { side: { x: -1, y: -1 }, corner: true, cursor: 'cursor-nwse-resize', style: { left: -6, top: -6 } },
  { side: { x: 1, y: -1 }, corner: true, cursor: 'cursor-nesw-resize', style: { right: -6, top: -6 } },
  { side: { x: 1, y: 1 }, corner: true, cursor: 'cursor-nwse-resize', style: { right: -6, bottom: -6 } },
  { side: { x: -1, y: 1 }, corner: true, cursor: 'cursor-nesw-resize', style: { left: -6, bottom: -6 } },
];

const OUTLINE_COLORS: Record<RoomStatus, string> = {
  hidden: 'border-gold/80',
  partly: 'border-gold/50',
  open: 'border-arcane/70',
};
const STATUS_COLORS: Record<RoomStatus, string> = {
  hidden: 'text-muted',
  partly: 'text-gold',
  open: 'text-arcane',
};

const sameRect = (a: Rect, b: Rect) =>
  a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

/** Whether the mouse has moved too far since the press for it to be a click. */
const slipped = (drag: { from: Point }, event: React.PointerEvent) =>
  Math.hypot(event.clientX - drag.from.x, event.clientY - drag.from.y) >= CLICK_SLOP_PX;

export function FogRoomsLayer({
  rooms,
  media,
  grid,
  orientation,
  displayScale,
  editable,
  toMapPoint,
  mapToSurface,
  maskRef,
  subscribeMask,
  edits,
  onFill,
}: FogRoomsLayerProps) {
  const [drag, setDrag] = useState<Drag | null>(null);
  const statuses = useRoomStatus(editable, rooms, media, maskRef, subscribeMask);

  /** A rectangle on the map → its box on the surface, axis-aligned however the map is turned. */
  const boxOf = (rect: Rect): React.CSSProperties => {
    const a = mapToSurface({ x: rect.x, y: rect.y });
    const b = mapToSurface({ x: rect.x + rect.width, y: rect.y + rect.height });
    return {
      left: Math.min(a.x, b.x),
      top: Math.min(a.y, b.y),
      width: Math.abs(b.x - a.x),
      height: Math.abs(b.y - a.y),
    };
  };
  const bigEnough = (rect: Rect) => Math.min(rect.width, rect.height) * displayScale >= MIN_ROOM_PX;
  const roomById = (id: string) => rooms.find((room) => room.id === id);

  // ─── Copy and paste: Ctrl+C over a room, Ctrl+V where a copy should go ────
  //
  // Only in Rooms, and never while a name is typed. Where the mouse is over
  // the map is kept in a ref, so moving it renders nothing; the room under it
  // is looked up when Ctrl+C is pressed. The copy is kept by the edits, so it
  // lasts while another tool is used.

  const pointerRef = useRef<Point | null>(null);
  // The key listener is added once per visit to Rooms, so it reads these here
  const latest = useRef({ rooms, media, grid, toMapPoint, edits });
  latest.current = { rooms, media, grid, toMapPoint, edits };

  useEffect(() => {
    if (!editable) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      if ((key !== 'c' && key !== 'v') || !ctrlHeld(event) || event.altKey || event.shiftKey) return;
      if (event.repeat || isTypingTarget(event.target) || document.querySelector('[role="dialog"]')) return;
      const pointer = pointerRef.current;
      if (!pointer) return;
      const { rooms: current, media: size, grid: mapGrid, toMapPoint: toMap, edits: change } = latest.current;
      if (key === 'c') {
        const over = document.elementFromPoint(pointer.x, pointer.y)?.closest<HTMLElement>('[data-room]');
        const index = current.findIndex((room) => room.id === over?.dataset.room);
        if (index < 0) return;
        change.copy(current[index]);
        notify(
          keyLabel(`${roomLabel(current[index], index)} copied. Ctrl+V pastes it at the mouse pointer.`),
        );
      } else {
        const copied = change.copied();
        const at = toMap(pointer.x, pointer.y);
        if (!copied || !at) return;
        change.add(pasteRect(copied, at, size, mapGrid));
      }
      event.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [editable]);

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!editable || (event.button !== 0 && event.button !== 2)) return;
    const point = toMapPoint(event.clientX, event.clientY);
    if (!point) return;
    // A room's outline or one of its handles; anywhere else marks out a new room
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-room]') : null;
    const room = target?.dataset.room ? roomById(target.dataset.room) : undefined;
    if (!room && event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const { pointerId } = event;
    const side = target?.dataset.side?.split(',').map(Number);
    if (!room) setDrag({ kind: 'draw', pointerId, start: point, rect: null });
    else if (side && event.button === 0) {
      const edges = edgesOnMap({ x: side[0], y: side[1] }, orientation);
      setDrag({ kind: 'resize', pointerId, id: room.id, edges, rect: room });
    } else {
      const from = { x: event.clientX, y: event.clientY };
      setDrag({ kind: 'press', pointerId, id: room.id, button: event.button, from, start: point });
    }
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    pointerRef.current = { x: event.clientX, y: event.clientY };
    if (!drag || drag.pointerId !== event.pointerId) return;
    const point = toMapPoint(event.clientX, event.clientY);
    if (!point) return;
    const snap = ctrlHeld(event) ? grid : null;
    if (drag.kind === 'draw') {
      setDrag({ ...drag, rect: clipToMap(rectFromCorners(drag.start, point, snap), media) });
      return;
    }
    const room = roomById(drag.id);
    if (!room) {
      setDrag(null);
      return;
    }
    if (drag.kind === 'resize') {
      setDrag({ ...drag, rect: resizeRect(room, drag.edges, point, media, snap) });
      return;
    }
    // Only the left button moves a room, and only once the mouse has really moved
    if (drag.kind === 'press' && (drag.button !== 0 || !slipped(drag, event))) return;
    const delta = { x: point.x - drag.start.x, y: point.y - drag.start.y };
    const rect = moveRect(room, delta, media, snap);
    setDrag({ kind: 'move', pointerId: drag.pointerId, id: drag.id, start: drag.start, rect });
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    setDrag(null);
    if (drag.kind === 'draw') {
      if (drag.rect && bigEnough(drag.rect)) edits.add(drag.rect);
      return;
    }
    const room = roomById(drag.id);
    if (!room) return;
    if (drag.kind === 'press') {
      // A click: the left button reveals, the right one covers
      if (!slipped(drag, event)) onFill(room, drag.button === 0 ? 'reveal' : 'cover');
      return;
    }
    if (!sameRect(drag.rect, room) && bigEnough(drag.rect)) edits.reshape(room.id, drag.rect);
  };

  const roomTitle = keyLabel(
    'Click to reveal this room to the players, right-click to cover it. Drag to move it, drag an edge or corner to resize it (Ctrl snaps to the grid). Ctrl+C copies it.',
  );

  return (
    <div
      aria-label={editable ? 'Fog rooms' : undefined}
      className={`absolute inset-0 ${editable ? 'z-30 cursor-crosshair' : 'pointer-events-none z-10'}`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={() => setDrag(null)}
      onPointerLeave={() => (pointerRef.current = null)}
      onContextMenu={(event) => event.preventDefault()}
    >
      {rooms.map((room, index) => {
        const shown =
          drag && (drag.kind === 'move' || drag.kind === 'resize') && drag.id === room.id ? drag.rect : room;
        const status: RoomStatus | undefined = statuses[room.id];
        const label = roomLabel(room, index);
        return (
          <div
            key={room.id}
            data-room={room.id}
            title={editable ? roomTitle : undefined}
            className={`group absolute border-2 border-dashed ${status ? OUTLINE_COLORS[status] : 'border-gold/60'} ${
              editable ? 'cursor-pointer' : ''
            }`}
            style={boxOf(shown)}
          >
            {editable &&
              HANDLES.map(({ side, corner, cursor, style }) => (
                <span
                  key={`${side.x},${side.y}`}
                  aria-hidden="true"
                  data-room={room.id}
                  data-side={`${side.x},${side.y}`}
                  className={`absolute ${cursor} ${
                    corner
                      ? 'h-2.5 w-2.5 border border-gold bg-ground opacity-0 group-hover:opacity-100'
                      : side.x === 0
                        ? 'h-2.5'
                        : 'w-2.5'
                  }`}
                  style={style}
                />
              ))}
            {editable && (
              <RoomBar
                room={room}
                label={label}
                placeholder={`Room ${index + 1}`}
                status={status}
                onRename={(name) => edits.rename(room.id, name)}
                onFill={(mode) => onFill(room, mode)}
                onDelete={() => edits.remove(room.id)}
              />
            )}
          </div>
        );
      })}
      {drag?.kind === 'draw' && drag.rect && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute border-2 border-dashed border-gold bg-gold/10"
          style={boxOf(drag.rect)}
        />
      )}
    </div>
  );
}

/** A room's bar, in its top-left corner on screen: name, reveal or cover, delete, status. */
function RoomBar({
  room,
  label,
  placeholder,
  status,
  onRename,
  onFill,
  onDelete,
}: {
  room: FogRoom;
  label: string;
  placeholder: string;
  status: RoomStatus | undefined;
  onRename: (name: string) => void;
  onFill: (mode: FogMode) => void;
  onDelete: () => void;
}) {
  const open = status === 'open';
  return (
    <div
      role="group"
      aria-label={label}
      // An empty title keeps the room's own tooltip off the bar
      title=""
      className="absolute left-1 top-1 z-10 flex cursor-default items-center gap-0.5 rounded border border-line bg-panel/95 p-0.5 text-[11px] shadow"
      // The bar's controls are not the room: pressing them starts no drag or reveal
      onPointerDown={(event) => event.stopPropagation()}
    >
      <input
        type="text"
        aria-label={`Name of ${label}`}
        placeholder={placeholder}
        value={room.name ?? ''}
        maxLength={MAX_ROOM_NAME}
        spellCheck={false}
        onChange={(event) => onRename(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === 'Escape') event.currentTarget.blur();
        }}
        className="w-24 rounded border border-transparent bg-transparent px-1 py-0.5 text-[12px] text-ink placeholder:text-muted hover:border-line focus:border-gold focus:outline-none"
      />
      <button
        type="button"
        aria-label={`${open ? 'Cover' : 'Reveal'} ${label}`}
        title={
          open
            ? 'Cover the room with fog again (or right-click inside it)'
            : 'Reveal the room to the players (or click inside it)'
        }
        onClick={() => onFill(open ? 'cover' : 'reveal')}
        className="flex h-6 w-6 items-center justify-center rounded text-ink hover:bg-raised hover:text-crimson-text"
      >
        {open ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
      </button>
      <button
        type="button"
        aria-label={`Delete ${label}`}
        title="Delete the room; the fog stays as it is"
        onClick={onDelete}
        className="flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-raised hover:text-crimson-bright"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
      {/* Last, so its changing width never moves the buttons */}
      {status && (
        <span className={`whitespace-nowrap px-1 ${STATUS_COLORS[status]}`}>
          {ROOM_STATUS_LABELS[status]}
        </span>
      )}
    </div>
  );
}

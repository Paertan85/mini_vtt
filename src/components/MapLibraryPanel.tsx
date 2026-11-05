// The library sidebar: maps and handouts in two tabs. Cards show a thumbnail,
// the name and whether players can see it; everything else lives in the card's
// menu, so the list stays calm.

import React, { useEffect, useRef, useState } from 'react';
import { MoreHorizontal } from 'lucide-react';
import type { HandoutMeta, MapEntryMeta } from '../types/map';
import { Button } from '../ui/controls';
import { Menu, type MenuItem } from '../ui/Menu';

export interface OrientationChange {
  rotation?: number;
  mirrorHorizontal?: boolean;
  mirrorVertical?: boolean;
}

interface MapLibraryPanelProps {
  loading: boolean;
  maps: MapEntryMeta[];
  currentMapId: string | null;
  selectedMapId: string | null;
  onSelectMap: (id: string) => void;
  onLoadMap: (id: string) => void;
  onReorderMaps: (ids: string[]) => void;
  onRenameMap: (id: string, name: string) => void;
  onRemoveMap: (id: string) => void;
  onChangeOrientation: (id: string, change: OrientationChange) => void;
  onAddMaps: () => void;
  onDropMaps: (files: File[]) => void;

  handouts: HandoutMeta[];
  selectedHandoutId: string | null;
  activeHandoutId: string | null;
  onSelectHandout: (id: string) => void;
  onToggleHandout: (handout: HandoutMeta) => void;
  onRotateHandout: (id: string) => void;
  onRemoveHandout: (id: string) => void;
  onAddHandouts: () => void;
  onDropHandouts: (files: File[]) => void;
  /** Hidden panels keep their state (such as the open tab) */
  hidden: boolean;
}

type Tab = 'maps' | 'handouts';

export function MapLibraryPanel(props: MapLibraryPanelProps) {
  const [tab, setTab] = useState<Tab>('maps');
  const [filesOver, setFilesOver] = useState(false);
  const isMaps = tab === 'maps';

  const hasFiles = (event: React.DragEvent) => event.dataTransfer.types.includes('Files');

  return (
    <aside
      id="library-panel"
      className={`${props.hidden ? 'hidden' : 'flex'} min-h-0 w-72 shrink-0 flex-col border-r border-line bg-panel`}
    >
      <div className="flex h-12 shrink-0 items-center border-b border-line px-4">
        <h1 className="font-display text-[17px] font-semibold tracking-wider text-ink">Mini VTT</h1>
      </div>

      <div role="tablist" aria-label="Library" className="flex shrink-0 border-b border-line px-2">
        {(['maps', 'handouts'] as const).map((name) => {
          const count = name === 'maps' ? props.maps.length : props.handouts.length;
          const selected = tab === name;
          return (
            <button
              key={name}
              role="tab"
              aria-selected={selected}
              onClick={() => setTab(name)}
              className={`-mb-px flex h-10 items-center gap-1.5 border-b-2 px-3 text-[13px] font-medium transition-colors ${
                selected ? 'border-gold text-ink' : 'border-transparent text-muted hover:text-ink'
              }`}
            >
              {name === 'maps' ? 'Maps' : 'Handouts'}
              <span className="tabular-nums text-faint">{count}</span>
            </button>
          );
        })}
      </div>

      <div
        role="tabpanel"
        className={`min-h-0 flex-1 overflow-y-auto p-2 ${filesOver ? 'bg-gold/5 outline-dashed outline-2 -outline-offset-4 outline-gold' : ''}`}
        onDragOver={(event) => {
          if (!hasFiles(event)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
          setFilesOver(true);
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFilesOver(false);
        }}
        onDrop={(event) => {
          if (!hasFiles(event)) return;
          event.preventDefault();
          setFilesOver(false);
          const files = Array.from(event.dataTransfer.files);
          if (isMaps) props.onDropMaps(files);
          else props.onDropHandouts(files);
        }}
      >
        {isMaps ? <MapList {...props} /> : <HandoutList {...props} />}
      </div>

      <div className="shrink-0 border-t border-line p-2">
        <Button className="w-full" onClick={isMaps ? props.onAddMaps : props.onAddHandouts}>
          {isMaps ? 'Add maps…' : 'Add handouts…'}
        </Button>
      </div>
    </aside>
  );
}

// ─── Maps ─────────────────────────────────────────────────────────────────────

const MAP_DRAG_TYPE = 'application/x-mini-vtt-map';

function MapList(props: MapLibraryPanelProps) {
  const { maps, currentMapId, selectedMapId } = props;
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);

  if (props.loading && maps.length === 0) return <EmptyState title="Loading library…" />;
  if (maps.length === 0) {
    return (
      <EmptyState
        title="No maps yet"
        body="Add images or WebM videos, or drop them here. Each map remembers its fog, zoom and framing."
      />
    );
  }

  const moveMap = (sourceId: string, targetId: string) => {
    const ids = maps.map((entry) => entry.id);
    const from = ids.indexOf(sourceId);
    const to = ids.indexOf(targetId);
    if (from < 0 || to < 0 || from === to) return;
    const [moved] = ids.splice(from, 1);
    ids.splice(to, 0, moved);
    props.onReorderMaps(ids);
  };

  const endDrag = () => {
    setDraggingId(null);
    setDropTargetId(null);
  };

  return (
    <ul className="flex flex-col gap-1" aria-label="Maps">
      {maps.map((map) => {
        const isCurrent = map.id === currentMapId;
        const orient = (change: OrientationChange) => props.onChangeOrientation(map.id, change);
        const menu: MenuItem[] = [
          { label: 'Load', onSelect: () => props.onLoadMap(map.id), disabled: isCurrent },
          { label: 'Rename', onSelect: () => setRenamingId(map.id) },
          {
            label: 'Rotate left',
            separated: true,
            onSelect: () => orient({ rotation: (map.rotation + 270) % 360 }),
          },
          { label: 'Rotate right', onSelect: () => orient({ rotation: (map.rotation + 90) % 360 }) },
          {
            label: 'Mirror left to right',
            checked: map.mirrorHorizontal,
            onSelect: () => orient({ mirrorHorizontal: !map.mirrorHorizontal }),
          },
          {
            label: 'Mirror top to bottom',
            checked: map.mirrorVertical,
            onSelect: () => orient({ mirrorVertical: !map.mirrorVertical }),
          },
          { label: 'Remove…', danger: true, separated: true, onSelect: () => props.onRemoveMap(map.id) },
        ];
        const details = [
          map.mediaType === 'video' ? 'Video' : null,
          map.rotation ? `Rotated ${map.rotation}°` : null,
          map.mirrorHorizontal || map.mirrorVertical ? 'Mirrored' : null,
        ].filter(Boolean);
        return (
          <li
            key={map.id}
            draggable={renamingId !== map.id}
            onDragStart={(event) => {
              event.dataTransfer.effectAllowed = 'move';
              event.dataTransfer.setData(MAP_DRAG_TYPE, map.id);
              setDraggingId(map.id);
            }}
            onDragOver={(event) => {
              if (!draggingId || draggingId === map.id) return;
              event.preventDefault();
              event.stopPropagation();
              setDropTargetId(map.id);
            }}
            onDrop={(event) => {
              const sourceId = event.dataTransfer.getData(MAP_DRAG_TYPE);
              if (!sourceId) return;
              event.preventDefault();
              event.stopPropagation();
              moveMap(sourceId, map.id);
              endDrag();
            }}
            onDragEnd={endDrag}
            className={`${draggingId === map.id ? 'opacity-40' : ''} ${
              dropTargetId === map.id ? 'shadow-[0_-2px_0_0_theme(colors.gold)]' : ''
            }`}
          >
            <Card
              name={map.name}
              selected={map.id === selectedMapId}
              live={isCurrent}
              liveLabel="On player screen"
              details={details.join(', ')}
              thumb={<Thumb id={map.id} kind="map" />}
              renaming={renamingId === map.id}
              onRename={(name) => {
                setRenamingId(null);
                if (name && name !== map.name) props.onRenameMap(map.id, name);
              }}
              onClick={() => props.onSelectMap(map.id)}
              onDoubleClick={() => props.onLoadMap(map.id)}
              menu={menu}
              title={isCurrent ? map.name : `${map.name}: double-click to load`}
            />
          </li>
        );
      })}
    </ul>
  );
}

// ─── Handouts ─────────────────────────────────────────────────────────────────

function HandoutList(props: MapLibraryPanelProps) {
  const { handouts, activeHandoutId, selectedHandoutId } = props;
  if (handouts.length === 0) {
    return (
      <EmptyState
        title="No handouts yet"
        body="Add letters, portraits or clues, or drop images here. Double-click one to show it on the player screen."
      />
    );
  }
  return (
    <ul className="flex flex-col gap-1" aria-label="Handouts">
      {handouts.map((handout) => {
        const isActive = handout.id === activeHandoutId;
        return (
          <li key={handout.id}>
            <Card
              name={handout.name}
              selected={handout.id === selectedHandoutId}
              live={isActive}
              liveLabel="Showing on player screen"
              details={handout.rotation ? `Rotated ${handout.rotation}°` : ''}
              thumb={<Thumb id={handout.id} kind="handout" />}
              onClick={() => props.onSelectHandout(handout.id)}
              onDoubleClick={() => props.onToggleHandout(handout)}
              title={`${handout.name}: double-click to ${isActive ? 'hide' : 'show'}`}
              menu={[
                {
                  label: isActive ? 'Hide from player screen' : 'Show on player screen',
                  onSelect: () => props.onToggleHandout(handout),
                },
                { label: 'Rotate right', onSelect: () => props.onRotateHandout(handout.id) },
                {
                  label: 'Remove…',
                  danger: true,
                  separated: true,
                  onSelect: () => props.onRemoveHandout(handout.id),
                },
              ]}
            />
          </li>
        );
      })}
    </ul>
  );
}

// ─── Shared pieces ────────────────────────────────────────────────────────────

interface CardProps {
  name: string;
  selected: boolean;
  /** Visible to players right now */
  live: boolean;
  liveLabel: string;
  details: string;
  thumb: React.ReactNode;
  menu: MenuItem[];
  title: string;
  renaming?: boolean;
  onRename?: (name: string) => void;
  onClick: () => void;
  onDoubleClick: () => void;
}

function Card(props: CardProps) {
  return (
    <div
      className={`group relative flex items-center gap-2.5 rounded border p-1.5 pr-1 ${
        props.selected ? 'border-gold/70 bg-raised' : 'border-transparent hover:bg-raised'
      }`}
    >
      {props.live && (
        <span
          aria-hidden="true"
          className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-crimson-bright"
        />
      )}
      <button
        type="button"
        onClick={props.onClick}
        onDoubleClick={props.onDoubleClick}
        title={props.title}
        className="flex min-w-0 flex-1 items-center gap-2.5 text-left outline-none"
      >
        {props.thumb}
        <span className="flex min-w-0 flex-1 flex-col">
          {props.renaming ? (
            <RenameField initial={props.name} onDone={(name) => props.onRename?.(name)} />
          ) : (
            <span className="truncate text-[13px] font-medium text-ink">{props.name}</span>
          )}
          {props.live ? (
            <span className="truncate text-xs text-crimson-text">{props.liveLabel}</span>
          ) : (
            props.details && <span className="truncate text-xs text-faint">{props.details}</span>
          )}
        </span>
      </button>
      <Menu
        align="right"
        items={props.menu}
        trigger={(trigger) => (
          <Button
            {...trigger}
            tone="quiet"
            square
            aria-label={`Options for ${props.name}`}
            className={`h-7 w-7 focus:opacity-100 group-hover:opacity-100 ${
              trigger['aria-expanded'] ? 'opacity-100' : 'opacity-0'
            }`}
          >
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        )}
      />
    </div>
  );
}

function RenameField({ initial, onDone }: { initial: string; onDone: (name: string) => void }) {
  const [value, setValue] = useState(initial);
  const doneRef = useRef(false);
  const finish = (name: string) => {
    if (doneRef.current) return;
    doneRef.current = true;
    onDone(name.trim());
  };
  return (
    <input
      autoFocus
      value={value}
      aria-label="Map name"
      onChange={(event) => setValue(event.target.value)}
      onFocus={(event) => event.currentTarget.select()}
      onBlur={() => finish(value)}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === 'Enter') finish(value);
        if (event.key === 'Escape') finish(initial);
      }}
      className="h-6 w-full rounded border border-gold bg-ground px-1 text-[13px] text-ink outline-none"
    />
  );
}

function EmptyState({ title, body }: { title: string; body?: string }) {
  return (
    <div className="px-4 py-10 text-center">
      <p className="text-[13px] font-medium text-ink">{title}</p>
      {body && <p className="mt-1.5 text-xs leading-relaxed text-muted">{body}</p>}
    </div>
  );
}

// Thumbnails are small PNGs, cached for the session and loaded only once their
// card scrolls into view
const thumbCache = new Map<string, string | null>();

/** Drop a removed map's or handout's thumbnail from the cache. */
export const forgetThumb = (id: string) => thumbCache.delete(id);

function Thumb({ id, kind }: { id: string; kind: 'map' | 'handout' }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [url, setUrl] = useState<string | null | undefined>(() => thumbCache.get(id));

  useEffect(() => {
    if (url !== undefined) return;
    const element = ref.current;
    if (!element) return;
    let cancelled = false;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      const api = window.electronAPI;
      const request = kind === 'map' ? api?.loadMapThumb(id) : api?.loadHandoutThumb(id);
      void request?.then((loaded) => {
        thumbCache.set(id, loaded ?? null);
        if (!cancelled) setUrl(loaded ?? null);
      });
    });
    observer.observe(element);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [id, kind, url]);

  return (
    <span ref={ref} className="h-10 w-14 shrink-0 overflow-hidden rounded-sm border border-line bg-ground">
      {url && <img src={url} alt="" draggable={false} className="h-full w-full object-cover" />}
    </span>
  );
}

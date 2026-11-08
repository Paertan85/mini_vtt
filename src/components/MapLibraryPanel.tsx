// The library sidebar: maps and handouts in two tabs. Cards show a thumbnail,
// the name and whether players can see it; everything else lives in the card's
// menu, so the list stays calm.

import React, { memo, useEffect, useRef, useState } from 'react';
import { MoreHorizontal } from 'lucide-react';
import type { HandoutMeta, MapEntryMeta } from '../types/map';
import { Button } from '../ui/controls';
import { Menu, type MenuItem } from '../ui/Menu';
import { gridSquares } from '../lib/grid';
import { drawThumbnail, toDataUrl } from '../lib/thumbnail';

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
  /** Loads the map if need be and starts measuring its grid */
  onMeasureMapGrid: (id: string) => void;
  onReorderMaps: (ids: string[]) => void;
  onRenameMap: (id: string, name: string) => void;
  onRemoveMap: (id: string) => void;
  onChangeOrientation: (id: string, change: OrientationChange) => void;
  onAddMaps: () => void;
  onDropMaps: (files: File[]) => void;

  handouts: HandoutMeta[];
  selectedHandoutId: string | null;
  activeHandoutId: string | null;
  /** Whether the player screen is open; cards are marked Live only then */
  playerOpen: boolean;
  /** Whether the player screen is blacked out; Live turns the Blackout button's red */
  blackout: boolean;
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

// Memoized: the DM window re-renders on every frame of a drag, and the list
// of cards never depends on that
export const MapLibraryPanel = memo(function MapLibraryPanel(props: MapLibraryPanelProps) {
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
});

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
          { label: 'Measure map grid…', onSelect: () => props.onMeasureMapGrid(map.id) },
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
        const details: Detail[] = [
          map.mediaType === 'video' ? 'Video' : null,
          // Red: spell areas, measuring and True scale need it
          map.grid
            ? `Grid ${gridSquares(map.grid, map.width, map.height) ?? 'set'}`
            : { text: 'Grid not set', warn: true as const },
          map.rotation ? `Rotated ${map.rotation}°` : null,
          map.mirrorHorizontal || map.mirrorVertical ? 'Mirrored' : null,
        ].filter((detail) => detail !== null);
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
              dropTargetId === map.id ? 'shadow-[0_-2px_0_0_var(--color-gold)]' : ''
            }`}
          >
            <Card
              name={map.name}
              selected={map.id === selectedMapId}
              live={props.playerOpen && isCurrent}
              blackout={props.blackout}
              details={details}
              thumb={<Thumb id={map.id} kind="map" image={map.mediaType === 'image'} width={map.width} />}
              renaming={renamingId === map.id}
              onRename={(name) => {
                setRenamingId(null);
                if (name && name !== map.name) props.onRenameMap(map.id, name);
              }}
              onClick={() => props.onSelectMap(map.id)}
              onDoubleClick={() => props.onLoadMap(map.id)}
              menu={menu}
              hint={isCurrent ? null : 'Double-click to load'}
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
              live={props.playerOpen && isActive}
              blackout={props.blackout}
              details={handout.rotation ? [`Rotated ${handout.rotation}°`] : []}
              thumb={<Thumb id={handout.id} kind="handout" image width={handout.width} />}
              onClick={() => props.onSelectHandout(handout.id)}
              onDoubleClick={() => props.onToggleHandout(handout)}
              hint={`Double-click to ${isActive ? 'hide' : 'show'}`}
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

/** A short fact under a card's name; a warning one is red. */
type Detail = string | { text: string; warn: true };

interface CardProps {
  name: string;
  selected: boolean;
  /** Visible to players right now: marked Live */
  live: boolean;
  /** The player screen is blacked out, so Live is the Blackout button's red */
  blackout: boolean;
  details: Detail[];
  thumb: React.ReactNode;
  menu: MenuItem[];
  /** What a double-click does, after the details in the tooltip; null when nothing */
  hint: string | null;
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
      <button
        type="button"
        onClick={props.onClick}
        onDoubleClick={props.onDoubleClick}
        // The name shows on the card; the tooltip tells the rest
        aria-label={props.name}
        title={
          [
            props.details.map((detail) => (typeof detail === 'string' ? detail : detail.text)).join(', '),
            props.hint,
          ]
            .filter(Boolean)
            .join(' · ') || undefined
        }
        className="flex min-w-0 flex-1 items-center gap-2.5 text-left outline-hidden"
      >
        {props.thumb}
        <span className="flex min-w-0 flex-1 flex-col">
          {props.renaming ? (
            <RenameField initial={props.name} onDone={(name) => props.onRename?.(name)} />
          ) : (
            <span className="truncate text-[13px] font-medium text-ink">{props.name}</span>
          )}
          {(props.live || props.details.length > 0) && (
            <span className="truncate text-xs text-faint">
              {/* Gold, like the border of the selected card */}
              {props.live && (
                <span className={`font-medium ${props.blackout ? 'text-crimson-bright' : 'text-gold'}`}>
                  Live
                </span>
              )}
              {props.live && props.details.length > 0 && ' · '}
              {props.details.map((detail, index) => (
                <React.Fragment key={index}>
                  {index > 0 && ', '}
                  {typeof detail === 'string' ? (
                    detail
                  ) : (
                    <span className="text-crimson-text">{detail.text}</span>
                  )}
                </React.Fragment>
              ))}
            </span>
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
      className="h-6 w-full rounded-sm border border-gold bg-ground px-1 text-[13px] text-ink outline-hidden"
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

/**
 * Draw a thumbnail the main process couldn't make (GIF, WebP and BMP
 * images), show it, and have it kept for next time.
 */
async function drawAndKeepThumb(id: string, kind: 'map' | 'handout', width: number) {
  const api = window.electronAPI;
  const media = kind === 'map' ? await api?.loadMapMedia(id) : await api?.loadHandoutMedia(id);
  const png = media ? await drawThumbnail(media, width) : null;
  if (!png) return null;
  void api?.saveThumb(id, new Uint8Array(await png.arrayBuffer()));
  return toDataUrl(png);
}

function Thumb({
  id,
  kind,
  image,
  width,
}: {
  id: string;
  kind: 'map' | 'handout';
  /** An image, which can be drawn when it has no thumbnail yet (not a video) */
  image: boolean;
  /** The image's own width, 0 when unknown */
  width: number;
}) {
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
      void request?.then(async (loaded) => {
        const thumb = loaded ?? (image ? await drawAndKeepThumb(id, kind, width) : null);
        thumbCache.set(id, thumb);
        if (!cancelled) setUrl(thumb);
      });
    });
    observer.observe(element);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [id, kind, image, width, url]);

  return (
    <span ref={ref} className="h-10 w-14 shrink-0 overflow-hidden rounded-xs border border-line bg-ground">
      {url && <img src={url} alt="" draggable={false} className="h-full w-full object-cover" />}
    </span>
  );
}

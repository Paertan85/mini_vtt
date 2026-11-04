// The bridge between the sandboxed renderer and the main process. Everything
// the windows can do outside the page goes through window.electronAPI.
//
// Channel names follow one rule: `domain:action`. Request/response calls use
// ipcRenderer.invoke; one-way messages that the main process relays to another
// window keep the same channel name on both legs.

import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type {
  EffectSnapshot,
  FogSnapshot,
  FogStroke,
  ImportResult,
  LibrarySettings,
  LibrarySnapshot,
  MapState,
  MapView,
  ProjectImportSummary,
  ProjectResult,
} from '../src/types/map';

/** Subscribe to a channel; returns an unsubscribe function. */
function subscribe<Args extends unknown[]>(channel: string, callback: (...args: Args) => void) {
  const handler = (_event: Electron.IpcRendererEvent, ...args: unknown[]) => callback(...(args as Args));
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
}

const api = {
  // ─── Library: maps ──────────────────────────────────────────────────────────

  loadLibrary: (): Promise<LibrarySnapshot> => ipcRenderer.invoke('library:load'),
  /** Opens the file dialog and imports every chosen map. */
  importMapsFromDialog: (): Promise<ImportResult | null> =>
    ipcRenderer.invoke('library:importMapsFromDialog'),
  importMaps: (paths: string[]): Promise<ImportResult> => ipcRenderer.invoke('library:importMaps', paths),
  /** Absolute paths of files dropped on the page (needed for importMaps). */
  getDroppedFilePaths: (files: File[]): string[] => files.map((file) => webUtils.getPathForFile(file)),
  loadMapMedia: (id: string): Promise<string | null> => ipcRenderer.invoke('library:loadMapMedia', id),
  loadMapThumb: (id: string): Promise<string | null> => ipcRenderer.invoke('library:loadMapThumb', id),
  loadMapFog: (id: string): Promise<string | null> => ipcRenderer.invoke('library:loadMapFog', id),
  /** The map's painted effect layer, or null when it has none. */
  loadMapEffects: (id: string): Promise<string | null> => ipcRenderer.invoke('library:loadMapEffects', id),
  saveMapView: (id: string, view: MapView): Promise<boolean> =>
    ipcRenderer.invoke('library:saveMapView', id, view),
  renameMap: (id: string, name: string): Promise<boolean> =>
    ipcRenderer.invoke('library:renameMap', id, name),
  removeMap: (id: string): Promise<boolean> => ipcRenderer.invoke('library:removeMap', id),
  reorderMaps: (ids: string[]): Promise<boolean> => ipcRenderer.invoke('library:reorderMaps', ids),
  saveSettings: (patch: Partial<LibrarySettings>): Promise<boolean> =>
    ipcRenderer.invoke('library:saveSettings', patch),
  revealLibraryFolder: (): Promise<boolean> => ipcRenderer.invoke('library:revealFolder'),
  /** Saves the whole library to one .minivtt file chosen in a dialog; null if cancelled. */
  exportProject: (): Promise<ProjectResult<{ maps: number; handouts: number }> | null> =>
    ipcRenderer.invoke('library:exportProject'),
  /** Adds everything in a .minivtt file chosen in a dialog to the library; null if cancelled. */
  importProject: (): Promise<ProjectResult<ProjectImportSummary> | null> =>
    ipcRenderer.invoke('library:importProject'),

  // ─── Library: handouts ──────────────────────────────────────────────────────

  importHandoutsFromDialog: (): Promise<ImportResult | null> =>
    ipcRenderer.invoke('library:importHandoutsFromDialog'),
  importHandouts: (paths: string[]): Promise<ImportResult> =>
    ipcRenderer.invoke('library:importHandouts', paths),
  loadHandoutMedia: (id: string): Promise<string | null> =>
    ipcRenderer.invoke('library:loadHandoutMedia', id),
  loadHandoutThumb: (id: string): Promise<string | null> =>
    ipcRenderer.invoke('library:loadHandoutThumb', id),
  rotateHandout: (id: string, rotation: number): Promise<boolean> =>
    ipcRenderer.invoke('library:rotateHandout', id, rotation),
  removeHandout: (id: string): Promise<boolean> => ipcRenderer.invoke('library:removeHandout', id),

  // ─── Player window ──────────────────────────────────────────────────────────

  /** Opens the player window, or focuses it if it is already open. */
  openPlayerWindow: (): Promise<boolean> => ipcRenderer.invoke('player:open'),
  onPlayerWindowClosed: (callback: () => void) => subscribe('player:closed', callback),
  resizePlayerWindow: (width: number, height: number): Promise<{ width: number; height: number } | null> =>
    ipcRenderer.invoke('player:resize', width, height),
  /** DM window → player window: the full render state. */
  sendMapState: (state: MapState): void => ipcRenderer.send('player:state', state),
  onMapState: (callback: (state: MapState) => void) => subscribe('player:state', callback),
  /** Player window, on start-up: the latest state and fog mask. */
  requestMapState: (): Promise<MapState | null> => ipcRenderer.invoke('player:requestState'),
  requestFogSnapshot: (): Promise<string | null> => ipcRenderer.invoke('player:requestFog'),
  /** Player window → DM window: the handout was dismissed (Esc or its button). */
  closeHandout: (): void => ipcRenderer.send('handout:close'),
  onHandoutClosed: (callback: () => void) => subscribe('handout:close', callback),

  // ─── Fog of war (DM window → player window) ─────────────────────────────────

  sendFogStroke: (stroke: FogStroke): void => ipcRenderer.send('fog:stroke', stroke),
  onFogStroke: (callback: (stroke: FogStroke) => void) => subscribe('fog:stroke', callback),
  /** A different map was loaded: the player clears its fog until a snapshot arrives. */
  sendFogReset: (): void => ipcRenderer.send('fog:reset'),
  onFogReset: (callback: () => void) => subscribe('fog:reset', callback),
  /** A full copy of the mask. The main process also saves it when `persist` is set. */
  sendFogSnapshot: (snapshot: FogSnapshot): void => ipcRenderer.send('fog:snapshot', snapshot),
  onFogSnapshot: (callback: (snapshot: FogSnapshot) => void) => subscribe('fog:snapshot', callback),

  // ─── Painted effects (DM window → player window) ────────────────────────────

  /** The whole effect layer after each change (null: empty). Saved when `persist` is set. */
  sendEffectsSnapshot: (snapshot: EffectSnapshot): void => ipcRenderer.send('effects:snapshot', snapshot),
  onEffectsSnapshot: (callback: (snapshot: EffectSnapshot) => void) =>
    subscribe('effects:snapshot', callback),
  /** Player window, on start-up: the current effect layer. */
  requestEffectsSnapshot: (): Promise<string | null> => ipcRenderer.invoke('player:requestEffects'),

  // ─── Player viewport ────────────────────────────────────────────────────────

  /** Player window → DM window: the viewport size, so the DM can draw the frame. */
  sendViewportSize: (width: number, height: number): void => ipcRenderer.send('viewport:size', width, height),
  onViewportSize: (callback: (width: number, height: number) => void) => subscribe('viewport:size', callback),
  /** DM window → player window: the framed area's top-left corner. */
  sendViewportPan: (x: number, y: number): void => ipcRenderer.send('viewport:pan', x, y),
  onViewportPan: (callback: (x: number, y: number) => void) => subscribe('viewport:pan', callback),

  // ─── Full screen (the calling window) ───────────────────────────────────────

  toggleFullScreen: (): Promise<boolean> => ipcRenderer.invoke('window:toggleFullScreen'),
  isFullScreen: (): Promise<boolean> => ipcRenderer.invoke('window:isFullScreen'),
  onFullScreenChanged: (callback: (isFullScreen: boolean) => void) =>
    subscribe('window:fullScreenChanged', callback),
};

contextBridge.exposeInMainWorld('electronAPI', api);

/** The shape of window.electronAPI, derived from the implementation above. */
export type ElectronAPI = typeof api;

import type { ElectronAPI } from '../../electron/preload';

export type { ElectronAPI };

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}

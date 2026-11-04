import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import electron from 'vite-plugin-electron';
import renderer from 'vite-plugin-electron-renderer';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react(),
    electron([
      {
        entry: 'electron/main.ts',
      },
      {
        entry: 'electron/preload.ts',
        onstart(options) {
          options.reload();
        },
        // Electron cannot load ESM preload scripts (the `electron:` protocol
        // is unsupported by the ESM loader), so build the preload as CommonJS
        // with a .cjs extension.
        vite: {
          build: {
            lib: {
              formats: ['cjs'],
              fileName: () => '[name].cjs',
            },
          },
        },
      },
    ]),
    renderer(),
  ],
});

# Mini VTT Guidelines

## Low-resource design

- Treat efficient operation on low-resource laptops as a core product requirement. Prioritize low CPU, RAM, and GPU usage in every design and implementation decision.
- Prefer event-driven work over polling, recurring timers, or per-frame JavaScript processing. Clean up listeners, timers, observers, and media resources when no longer needed.
- Avoid unnecessary full-resolution copies, canvas readbacks, repeated encoding/decoding, and duplicated media buffers. Keep large map and video data out of React state when a URL or ref is sufficient.
- Use native browser image/video rendering for media playback. Do not process every video frame in JavaScript or add background work that continues when it is not needed.
- Keep caches and retained media bounded; release resources when maps are switched or removed.
- For changes that affect rendering, playback, or memory usage, consider their cost on low-end hardware and validate behavior under realistic constraints.

## Working on the code

- Run `npm run typecheck`, `npm run lint`, `npm test` and `npm run test:app` before finishing a change (prefix the tests with `xvfb-run -a` on headless Linux).
- All changes to `index.json` go through `mutateIndex()` in `electron/library.ts`; never read-modify-write the index directly.
- Map loading in the DM window goes through `loadMap()` in `src/App.tsx`, so every per-map setting is restored in one place. Fog changes go through `useFog`, which sends one snapshot per change; the main process relays and saves it.
- The `ElectronAPI` type is derived from `electron/preload.ts`; add bridge calls there, never in a separate declaration. IPC channels are named `domain:action`, with the same name on both legs of a relay.
- Validate everything that arrives over IPC in the main process; the renderer is sandboxed and has no Node access.

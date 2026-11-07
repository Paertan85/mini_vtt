# Mini VTT Guidelines

## Low-resource design

- Treat efficient operation on low-resource laptops as a core product requirement. Prioritize low CPU, RAM, and GPU usage in every design and implementation decision.
- Prefer event-driven work over polling, recurring timers, or per-frame JavaScript processing. Clean up listeners, timers, observers, and media resources when no longer needed.
- Avoid unnecessary full-resolution copies, canvas readbacks, repeated encoding/decoding, and duplicated media buffers. Keep large map and video data out of React state when a URL or ref is sufficient.
- Use native browser image/video rendering for media playback. Do not process every video frame in JavaScript or add background work that continues when it is not needed.
- Keep caches and retained media bounded; release resources when maps are switched or removed.
- For changes that affect rendering, playback, or memory usage, check that nothing keeps running when the feature is inactive, that listeners, timers, observers and media resources are released on map switch or removal, and that caches stay bounded. Say in the change summary what you checked.
- When the user suggests a change that could noticeably affect performance or resource use (CPU, RAM, GPU, battery), tell them before building it: what it would cost, and a lighter way if there is one. Don't mention it when the effect is very minor, or when the change is just another way of doing the same work.

## Working on the code

- Before finishing a change, run `npm run check` (typecheck, lint, format check, `npm test` and `npm run test:app`). On headless Linux, run `xvfb-run -a npm run check`.
- All changes to `index.json` go through `mutateIndex()` in `electron/libraryStore.ts`; never read-modify-write the index directly.
- A new setting is its field in `LibrarySettings` plus one rule (default and check) in `src/lib/settings.ts`; the main process validates with those rules, and the DM window reads and changes it through `useSettings`.
- Map loading in the DM window goes through `loadMap()` in `src/App.tsx`, so every per-map setting is restored in one place. A new per-map value the DM window keeps goes in `LoadedMap` (`src/hooks/useLoadedMap.ts`), which is replaced whole on load and unload. Fog changes go through `useFog`, which sends one snapshot per change; the main process relays and saves it.
- The `ElectronAPI` type is derived from `electron/preload.ts`; add bridge calls there, never in a separate declaration. IPC channels are named `domain:action`, with the same name on both legs of a relay.
- Validate every IPC payload in the main process before using it: check shape, types and allowed values, and never trust renderer-supplied paths or ids. Reuse the guards in `electron/main.ts` (`isFiniteNumber`, `isMediaUrl`, `isPngDataUrl`) before writing new ones. The renderer is sandboxed and has no Node access.
- Only change the version (the `version` field in `package.json`) when making a release, following "Releasing" in `CONTRIBUTING.md`. Pushing the version tag makes CI draft the GitHub release.
- Before a release, everything except the version change and the tag is pushed to main first, and CI must pass on Windows, macOS and Linux. Only then make the release commit and the tag, so a failing test never lands on a release tag.
- At every release, ask the user to update the screenshots in `docs/screenshots/` first, if anything they show has changed. They take them; don't make or edit screenshots yourself.

## Art

- Never create art, by any means (AI tools, code or by hand): no pictures (icons, illustrations, maps, textures), no sound or music, no video. When a change needs art, ask the user to supply it.
- Drawing the interface is not art: controls, the fog, effects and spell area shapes are fine.
- If a test needs anything that could count as art (an image, a sound, a video), ask the user first. They approve it or supply an alternative themselves.
- Already approved: the plain grey map images and the plain grey BMP handout that `scripts/test-app.mjs` builds, and in `scripts/test-library.mjs` the solid-colour images (one of them a JPEG with an EXIF orientation tag), the half-fogged mask, and the header-only bytes for WebM, WebP, GIF and BMP files. Anything not listed here needs approval first.

## Plans and ideas

- `ROADMAP.md` holds what is planned (**Next**), ideas not decided on (**Ideas**), and what was turned down (**Decided against**, with the reason).
- When the user mentions an idea they don't want yet, add it under **Ideas**. When they decide against something, move it to **Decided against** with their reason.
- Check `ROADMAP.md` before suggesting features. Don't suggest something under **Decided against** again unless its reason no longer holds.
- When planned work or an idea is done, remove it from `ROADMAP.md` and describe it in `CHANGELOG.md` under "Unreleased".

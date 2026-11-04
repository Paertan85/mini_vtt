# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## Unreleased

### Added

- Export and import the whole library as one `.minivtt` project file
  (Settings → Export project… / Import project…), to move a prepared session
  to another computer. Fog, framing, orientation, order and the player screen
  setup travel with it; importing only ever adds to the library.
- A single Fog tool: the left mouse button reveals, the right button covers.
  V and F switch between the Frame and Fog tools; hold Space to move the
  frame while painting.
- Undo and redo for fog changes (Ctrl+Z, Ctrl+Shift+Z).
- Blackout (B) hides everything on the player screen.
- Map rotation and mirroring in each map's menu, also for maps that aren't
  loaded.
- Thumbnails for every map and handout, and separate library tabs.
- Toasts that report imports, skipped files and errors.
- The player screen hides its buttons and cursor when the mouse is idle.

### Changed

- New look: warm stone colours, gold for the active tool, crimson for what
  players can see, a teal player frame and indigo fog on the DM side. IBM
  Plex Sans and Cinzel are bundled, so the app stays fully offline.
- One-row toolbar with a compact zoom control, player screen status and a
  settings menu. "Reveal entire map" asks for confirmation.
- Fog is encoded once per stroke instead of twice, and saved by the main
  process. The brush cursor and frame dragging no longer re-render the
  whole window on every mouse move.
- Settings are stored as numbers; older libraries are migrated on load.

### Fixed

- Zooming the player view now keeps the frame centred; it used to drift.

### Fixed

- Concurrent saves could corrupt `index.json` and wipe the map library. Index
  writes are now serialized, and an unreadable index is backed up instead of
  being replaced with an empty one.
- The saved zoom was lost on restart and after deleting the current map.
- Dragging the player-view frame didn't save the new position.
- Switching back to a map in the same session restored the view from startup
  instead of the latest saved view.
- Fog painted within half a second of switching maps was not saved.
- Default player-view settings could overwrite the saved ones on a slow start.
- Dropping a file outside the library panels replaced the app with the file.
- Clicking "Open Player View" again opened a second player window, and the
  button stayed in the "open" state after the player window was closed.
- The player screen could show a fully fogged map after switching maps, and
  could briefly re-fog areas while a fog snapshot was decoding.
- A map with a missing file no longer disables saving for the session.

### Security

- Re-enabled the renderer sandbox and blocked navigation and pop-up windows.
- Settings, fog data and view state sent from the renderer are validated.

### Changed

- Importing large maps no longer reads the whole file into memory twice.
- Closing the DM window also closes the player screen.
- Moved the project to the repository root; added a README, contributing
  guide, CI workflow and working test suites (`npm test`, `npm run test:app`).

## 1.0.1

- First version published on GitHub.

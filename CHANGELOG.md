# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## Unreleased

### Added

- Aura circles: soft discs sized in feet for auras and spell areas (Effects
  tool, then Circle). Drag the centre dot to move it freely (Alt snaps to
  square centres), scroll over it to resize in 5 ft steps (Shift: 1
  ft), duplicate, recolour or delete. The DM sees the radius; players see
  only the disc, under the fog. Saved per map and in project files.
- Measure map grid (Settings): click two corners of a grid square, or of a
  block of squares, and check the previewed grid. Stored per map, so feet
  match each map's own scale.
- Settings → Show effect tools hides the Effects tool and circles.
- Effects tool (E): paint fire, poison or magic onto a map with soft
  edges; the right button erases, Clear removes them all, and Ctrl+Z undoes
  them separately from fog. Effects are drawn under the fog, saved per map,
  included in project files, and use no memory on maps without them.
  Poison is hatched so it stays distinct from fire for colour-blind players.
- Ctrl+Shift+Z redoes, as well as Ctrl+Y.
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

- Players see fog changes when the DM releases the mouse, not while the brush
  moves, so a room is revealed all at once. A dragged circle likewise appears
  where it is dropped. This also removes the per-move fog messages.
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

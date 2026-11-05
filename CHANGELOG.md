# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## Unreleased

### Added

- Releases build themselves: pushing a version tag tests the app on
  Windows, macOS and Linux and drafts a GitHub release with the installers
  for all three, using the changelog as its notes. CI now tests on Windows
  too.
- Player screen setup can turn new maps and handouts that are taller than
  wide (Rotate right or Rotate left), so they lie along a landscape screen,
  for a DM sitting at one end of a screen on the table. Square and wide
  images are never turned, and nothing already in the library changes.

### Fixed

- WebP, GIF and BMP handouts were refused, and maps in those formats were
  added without a size or a thumbnail. The DM window now draws their
  thumbnails (once; they are kept), as the main process can't decode those
  formats.
- A JPEG stored on its side with an EXIF orientation (as cameras and
  phones save photos) was measured on its side, and its thumbnail was
  sideways.
- Video maps now get their size when added; it used to stay unknown.

## 1.2.0 - 2026-11-05

### Changed

- Controls follow common conventions:
  - Ctrl + mouse wheel (and touchpad pinch) zooms your own view, like Alt +
    wheel; Ctrl+= / Ctrl+− zoom it and Ctrl+0 fits the map. These keys no
    longer zoom the whole app, player screen included.
  - The plain mouse wheel sets the brush size in the Fog and Effects tools
    and while Shift is held; [ and ] do too.
  - The player view zooms with + and −, or the mouse wheel over the player
    frame in the Frame tool.
  - Space + drag pans your zoomed view (it still moves the player frame
    when you are not zoomed in).
  - Circles: Ctrl while dragging snaps to square centres (was Alt), Alt +
    drag leaves a copy, Ctrl+D duplicates, arrow keys nudge one square
    (Shift: 1 ft), and the radius can be typed in the circle's toolbar.
    Shift + wheel no longer sets 1 ft steps.
- The brush goes from 10 to 600 in steps of 10 (was up to 300, in steps of 5).
- On a Mac, Cmd works wherever Ctrl does (zoom with Cmd + wheel, snap with
  Cmd while dragging), and tooltips and the shortcut list name Mac keys.
- Lighter on a laptop: a video map lets go of its file and decoder as soon
  as another map is loaded, dragging an area sends nothing to the player
  screen until it is dropped, and loading a map no longer re-encodes its
  saved fog.
- Smoother: the DM window does about a third of the work it did while the
  player frame or an area is dragged (the library and toolbar no longer
  redraw on every frame), and it no longer freezes for a moment when a fog
  stroke ends; the fog is encoded in the background.
- The installer is smaller: the app ships under 1 MB of code instead of
  33 MB.

### Added

- Linux builds as an AppImage, for desktops and the Steam Deck's desktop
  mode (CI tests on Linux and builds it for version tags and manual runs).
- The DM window opens sized to fit small screens, such as the Steam Deck's.
- CI also tests on macOS, and builds an unsigned .dmg for version tags and
  manual runs.
- Spell areas: besides circles, the Effects tool's **Area** menu places
  squares (cubes), cones and lines/walls, sized in feet. Drag the handle at
  a cone's or line's tip to aim it and set its length (5 ft steps), or the
  handle on a square's edge to turn it; the mouse wheel over a line sets
  its width. Ctrl snaps each shape to the grid the way it is usually
  placed. Existing circles and project files load unchanged.
- Fog shapes: in the Fog tool, switch to Shape (or press L) and draw around
  a room; everything inside is revealed (left button) or covered (right
  button) when you let go. The outline closes itself, and one undo removes
  it.
- ? shows the shortcuts, Enter loads the selected map, Ctrl+O adds maps.
- A button at the left of the toolbar (or Ctrl+B) hides the maps and
  handouts panel to give the map more room. The choice is remembered.
- A video map larger than the computer can decode in hardware (say 5.5K on
  a laptop that handles 4K) gets a note suggesting a size that plays
  smoothly.

### Fixed

- Removing a video map while it was loaded failed on Windows: the map left
  the library, but its file stayed on disk and its card in the panel. Now
  it is removed cleanly. If another program has the file open, the map
  stays as it was and a message says so. Folders left behind by earlier
  versions are deleted at startup.
- In a confirmation dialog, pressing or releasing Shift (as in Shift+Tab to
  reach Cancel) moved the focus back to the main button, such as Remove.
- Pressing Alt with the player window focused showed a menu bar on the
  player screen.
- Picking maps in quick succession could leave the earlier one loaded.

## 1.1.0 - 2026-11-05

### Added

- Zoom the DM view with Alt + mouse wheel in any tool, for example to see
  squares while painting; drag with the middle mouse button to pan. Players
  are unaffected, and the zoom badge fits the map again.
- Settings menu: Full screen, Reload, Developer tools and Quit. The DM
  window's menu bar is gone, so Alt no longer opens it.
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

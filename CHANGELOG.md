# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## Unreleased

### Added

- A lock button next to the player view zoom. While it is locked, the
  mouse wheel over the frame, the + and − keys, the zoom buttons, True
  scale and Fit 16:9 leave the zoom alone, so a stray scroll can't change
  what the players see. Space locks and unlocks it too. While it is
  locked, a padlock shows in the frame's corner. The lock is
  remembered across restarts.

- The player view frame is gold now, and **Player screen setup** can change
  its colour to crimson, teal (the old colour), white, magenta or sky blue,
  so it stands out on your maps. The colours are swatches in one row.

- Holding Ctrl while dragging a cone's or line's tip turns it in 45° steps.
  Without Ctrl it still aims freely.

- New maps take their grid from their file or folder name, the way Mini
  Gridder reads it: `forest_32x32.jpg`, `Airship [27 x 19]/Main Deck.jpg`
  or `Saltmarsh (170x140).jpg` give the squares across and down (either
  order, whichever fits the image), and `Crypt 140ppi.jpg` the pixels per
  square. The name, its folder and up to two folders above it are read.
  A size that is the image's own pixel size, is marked `px`, or doesn't
  fit the image is passed over, so such a map still needs measuring. The
  map library shows each map's grid (`Grid 32 × 24`, or `No grid`), also
  on the map that is on the player screen.

- **Measure** tool (M): drag across the map to see the distance in feet,
  or click point by point to measure a path round corners: double-click
  or Enter finishes it, right-click takes back a point, and Esc or
  Backspace clears it. The ruler stays until the next measurement or another tool.
  On a path, 5/10 diagonals are counted across all its legs. **Movement** counts
  squares, from the middle of one to the middle of another, with diagonals
  alternating 5/10 ft; **Settings → Movement: every square** counts every
  square the same instead, and is remembered. **Straight line** measures as
  the crow flies, and Ctrl snaps its ends to square centres. Only the DM
  sees the ruler until **Show players** puts it on the player screen too,
  large enough to read across the table. A map without a grid offers to
  measure it first.
- A handout on the player screen can be dragged with the mouse to move it,
  and the mouse wheel zooms in on the spot under the pointer. Zooming used
  to need Ctrl and went to the handout's middle.
- **True scale**, next to Fit 16:9, zooms the player view so the map's own
  squares come out at the grid square size from Player screen setup: on a
  43-inch screen set to 1-inch squares, each square of the map is an inch
  across, so miniatures fit it. Without the screen size, or with the
  player screen closed, a click says so right beneath the button, with a
  button that opens Player screen setup or the player screen. On a map
  without a grid it has you measure one first and applies when you save
  it. It is highlighted while the view is at true scale.
- Releases build themselves: pushing a version tag tests the app on
  Windows, macOS and Linux and drafts a GitHub release with the installers
  for all three, using the changelog as its notes. CI now tests on Windows
  too.
- New maps and handouts that are taller than wide are turned left as they
  are added, so they lie along a landscape screen on the table, the way
  most groups play with the DM at one end. Player screen setup can turn
  them right instead, or not at all. Square and wide images are never
  turned, and nothing already in the library changes.
- [docs/project-format.md](docs/project-format.md) explains how to make a
  project file by hand or from another program, with examples, a short
  script and a checklist, and the rules that keep files readable across
  versions and forks. [A JSON Schema](docs/project-manifest.schema.json)
  defines the manifest for tools that check files.
- A project file needs only its maps' or handouts' images: sizes and
  thumbnails left out are taken from the images. A file without player
  screen settings no longer resets the player screen setup of an empty
  library, and a ZIP made from the folder instead of its contents gets a
  message saying how to fix it.

### Changed

- Alt + drag on the player frame moves it from any tool, also when your
  own view is zoomed in. Space + drag did this before (Space now locks the
  zoom); your zoomed view pans with the middle mouse button.
  Alt + drag on a spell area's dot no longer leaves a copy behind; Ctrl+D
  and the Duplicate button still do.
- Alt + mouse wheel zooms the player view in 1% steps, from any tool, for
  fine adjustment; it used to zoom your own view, which is now Ctrl + wheel
  (or a pinch) only.
- A new app icon: a table seen from above, with the screen on it and
  the players around it.
- The keyboard shortcuts list is easier to read: grouped by tool and task
  (General, Fog, Player view, Spell areas and so on), with the most used
  first and one action per line. Keys show as key caps and mouse actions
  as words, with "or" between alternatives. It fits the window without
  scrolling, on a Steam Deck too.
- Messages show right beneath the button you pressed (Save grid, Export
  project, Add maps, Remove and the rest) instead of in the bottom right
  corner. Only those with nothing to point at, such as a keyboard
  shortcut's or a note when a map loads on its own, still use the corner.
  When a shape or True scale needs something first (the map's grid, the
  screen size or the player screen), a note beneath its button says so,
  with a button that does it, and the shape or True scale follows once
  the grid is saved.
- Spell areas have their own Shapes tool (S), with a button for each
  shape. The mouse pointer stays visible while placing them (the Effects
  tool hid it behind the brush), and picking a colour there also recolours
  the selected shape. The Effects tool only paints now, so area dots no
  longer catch brush strokes; areas can still be moved in the View tool.
  The Fog tool's Shape mode is now called Lasso (still L), so the two
  aren't confused.
- The Frame tool is now called View (still V), the name other tabletop
  apps use for what the players see. The teal frame on the map is still
  dragged in it to move the player view.
- Project files are now ordinary ZIP archives, so any unzip tool can open
  them and other programs can read and write them. Files exported by Mini
  VTT 1.1 and 1.2 still import, but those versions can't open the new files.
- Importing a project made by a newer version or a fork keeps everything
  this version understands and says what it left out. A spell area of an
  unknown shape is left out instead of becoming a circle. One of an unknown
  kind is kept and shown in the nearest colour instead of disappearing. A
  file that needs a feature this version lacks is refused, naming it.
- Importing checks each file in the project against its checksum, and stops
  before writing anything if the disk doesn't have room for the project.

### Fixed

- A fog file cut short could show players part of the map they hadn't
  explored. If the app crashed, was closed or lost power while saving a
  map's fog, the file could be left half written, and the next time the map
  loaded, the missing part counted as revealed. Fog and effects are now
  saved in one step (written next to the old file, then put in its place),
  closing waits for a save that is under way, and a fog file that isn't
  complete, on disk or in a project file, is never used: the map starts
  fully fogged and a message says so.
- Reloading the player screen (Ctrl+R on it) left it blank until the DM
  moved or zoomed the player view. It now shows the map straight away.
- Pressing Shift shows the fog brush straight away, where the pointer is,
  instead of on the next mouse move.
- With the DM view zoomed in far, some lines of the teal grid in the
  player frame, and of the gold grid while measuring one, disappeared.
- A video map could fill with garbled blocks, or keep jumping back to its
  start every few seconds, after it had looped or when switching back to
  it; closing and reopening the player screen cleared it. When a window
  asked for the rest of the video from part-way through, it got the file
  from the start instead, and the decoder showed that data in the wrong
  place. Now each window gets exactly the bytes it asks for. Measured on a
  176 MB 5.5K map: it loops every 30 seconds as it should, the player
  window uses less memory, and almost no frames are dropped. (Range
  requests had been turned down before, on measurements of the broken
  behaviour.)
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

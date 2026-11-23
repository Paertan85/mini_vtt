# Roadmap

Where Mini VTT might go next. Nothing here is a promise. **Next** is what is planned, **Ideas** collects thoughts that haven't been decided on, and **Decided against** keeps the reasons something was turned down, so it doesn't have to be argued again. Finished work moves to the [changelog](CHANGELOG.md).

Have an idea? Open an [issue](https://github.com/Paertan85/mini_vtt/issues).

## Next

- **Ping:** briefly mark a spot on the player screen, to draw everyone's eyes to it.
- **Grid from the image size**, as Mini Gridder does: from the map's pixel size, work out the square sizes that fit a whole number of squares both across and down, and step through them (arrow keys or wheel, say) with the grid shown over the map until it lines up. A quicker way to set a grid than measuring, for maps whose names give no grid.
- **Your own text on the player screen:** title cards (“Chapter 3: The Sunken Keep”), “Short rest”, or your own lines for the kill screen, shown the way the kill screen is.

## Ideas

### Maps and areas

- **View bookmarks:** saved framings of the player view for each map (one per room, say) to jump between.
- **DM notes:** pins on the map that only the DM sees.
- **Move the player view when you let go:** a setting in the menu (☰) so that dragging the player frame, or zooming it, changes the player screen only once the mouse is released, the way fog strokes reach the players. The players see one change to the new view instead of the map sliding past, and the DM can look for the right framing first. It also saves work: while the frame is dragged, the player window redraws on every mouse move, a fifth to a third of the CPU the drag uses (measured with `npm run cpu`).
- **Universal VTT import** (`.dd2vtt`, `.uvtt`, from Dungeondraft and others): the map image together with its grid size, so it needs no measuring.
- **Get the next map ready without showing it:** load and frame a map, cover it and reveal its first room in the DM window while the players still see the current one, then show it with one key. Each window would still hold one map, so it costs no more memory than now.
- **Smaller copies of very large maps** (maybe): when a map much larger than the screens can show is added, offer to keep a smaller copy, as the app already suggests for videos too large to play smoothly. A 318-megapixel map uses 3 GB or more while it is shown (see Known limitations in the README), and on the game laptop (integrated graphics, player screen on a 4K TV) dragging the view lags with it, though play with a still view is fine.
- **PDF handouts:** show a page of a PDF as a handout, with Chromium's built-in PDF viewer, which Electron has on every platform. For now, export the page as an image.

### Grid and measuring

- **Metres:** distances in metres (1.5 m squares), as in many translated rulebooks, instead of feet, for the ruler, spell areas and the grid.
- **Hex grids** (not likely to be added unless someone asks for it): for hexcrawls and games played on hexes. Drawing the grid, measuring, snapping and true scale would all need a hex version.

### Platforms

- **Touch on the Steam Deck.** The Linux build runs on a Deck, and touch works, but not well enough to recommend: for now a keyboard and mouse are needed. Find what gets in the way (such as a finger dragged over the map scrolling the page instead of painting) and tune it.
- **DM window on a small screen, such as the Steam Deck's.** Make the most of the map area on a small screen. Ctrl+Shift+B already hides the whole interface; the toolbar at the top still wraps onto two lines on the Deck (1280 × 800), so fit it on one line at that width. Then look for other places the interface takes more room than it needs at that size.
- **A Steam Deck without keyboard and mouse:** controller and trackpad bindings for the tools.
- **Flatpak** for the Steam Deck's Discover store. The AppImage covers the Deck for now.
- **Code-signed builds**, so Windows SmartScreen and macOS Gatekeeper stop warning on first launch. Needs paid certificates (Apple's costs $99 a year).

### Under the hood

- **The brush circle as the system cursor.** In the Fog and Effects tools the brush circle is drawn by the page and follows the mouse, so every mouse move redraws the DM window: just moving the mouse over the map costs about 60% of a core there, against about 30% in the View tool (measured with `npm run cpu`). A cursor image the size of the brush is drawn by the system instead, with no redraw. Chromium takes cursor images up to about 128 px, so larger brushes would keep the drawn circle.
- **Effects on very large maps:** after an effect stroke on the 318-megapixel map, the DM window keeps a whole core busy for about 2 seconds; after a fog stroke on the same map it takes about a tenth of that. Find what the effects layer does after a stroke (the size it works at, or how it is saved and sent) and bring it closer to the fog's cost.
- **VP8 video maps:** a VP8 video map (Obsidian Chamber in the test files) uses about 40% of a core in the player window the whole time it is shown, against about 8% for a VP9 one, likely because VP8 is decoded without the graphics hardware. If so, suggest a VP9 copy when one is added, as the app already suggests a smaller copy of a video too large to decode in hardware.
- **A Content-Security-Policy** for the packaged app, as Electron recommends. The app only ever shows its own files, so this is extra hardening rather than a fix.
- **No hidden menu on Windows and Linux.** The application menu is hidden there, but it is still what makes F11, Ctrl+R and Ctrl+Shift+I (and Ctrl+Q on Linux) work in both windows, and on Windows letting go of Alt used to give it keyboard focus without showing it. Remove it on Windows and Linux (the Mac keeps it: it is the menu bar at the top of the screen, and its Edit menu makes copy and paste work in text fields), handle those keys in each window's own key handler, and drop the Alt workaround in `hideMenuBar` together with the `window:altReleased` message.
- **Only if the app grows much larger** (low priority; with the app close to feature complete, maybe never):
  - Mouse actions in a table like the keys in `src/lib/shortcuts.ts`. Drags, wheel steps and held keys (Shift, Alt, Ctrl) are now written into MapStage, AreaHandles and MeasureLayer. Only needed for user-set mouse bindings or another input method (touch, pen, controller).
  - Shared state through React context or a small store (Zustand, say), if one controller hook still means passing a lot through props. Check the re-render cost on low-resource laptops first.
  - Vitest for `src/lib/` and Playwright for the app test, instead of the custom test scripts, if those become hard to maintain or new contributors join.

## Decided against

- **Showing fog strokes to players while they are painted.** Players see a stroke when the mouse is released, so a room is revealed all at once, and the mask is encoded once per stroke rather than continuously.
- **Areas snapping to the grid by default.** Some spells start in the middle of a square and others anywhere at all, so areas move freely; holding Ctrl snaps them.
- **Tokens, walls, line of sight and dynamic lighting.** The group plays with minis on the table, so the app has no tokens, and without them there is nothing to see from. This includes using the walls in Universal VTT files to reveal what can be seen from a spot.
- **“Explored” fog** (areas the party has left shown dimmed) **and weather overlays** (rain, snow or mist over the map). Explored fog needs a second fog mask for every map, and an overlay a second video playing on top of the map, which costs on a low-end laptop. Not planned for Mini VTT; a fork is welcome to add them.
- **Drawing on the player screen.** The ruler with **Show players**, and Ping (planned), cover pointing things out.
- **Controlling the app from a phone.** It would need a server on the local network, and the app stays offline with nothing running in the background.
- **Music and ambient sound for each map.** Not planned.
- **Moving from Electron to Tauri.** A spike on the game laptop found the same memory and CPU in use (Windows' web view, WebView2, is Chromium too), a much smaller Windows download (2.6 MB against 115 MB) but a larger Linux one, and a slower start. On Linux and the Steam Deck, WebKitGTK would not play video from the app's media protocol and has no canvas blur. Not worth rewriting the main process and the tests in Rust. The numbers, and when to look again, are in [docs/TAURI-DECISION.md](docs/TAURI-DECISION.md).
- **Answering large images whole instead of streaming them**, to lower the memory peak while a very large map loads, as it did in the Tauri spike. Measured in Electron on the game laptop with the 318-megapixel map: the peak was not lower (3.4 GB streamed, 3.6 GB whole), and the main process used about 170 MB more while it held the file. The memory is the GPU's copy of the map and the decode in the player window, which don't depend on how the file arrives. Smaller copies of very large maps (under **Ideas**) would lower both the peak and the memory in use. See [docs/TAURI-DECISION.md](docs/TAURI-DECISION.md).
- **The fog Circle revealing whole squares**, counted 5-10-5 as an emanation is. It reveals a round area, which fits a light's reach.

# Roadmap

Where Mini VTT might go next. Nothing here is a promise. **Next** is what is planned, **Ideas** collects thoughts that haven't been decided on, and **Decided against** keeps the reasons something was turned down, so it doesn't have to be argued again. Finished work moves to the [changelog](CHANGELOG.md).

Have an idea? Open an [issue](https://github.com/Paertan85/mini_vtt/issues).

## Next

- **Upgrade Electron to a supported version** (first priority). The app is on Electron 34. Electron supports only its three newest majors, so 34 no longer gets Chromium security fixes. Step one or two majors at a time, with `npm run check` and CI on all three systems after each. Then catch up React, Vite and Tailwind, which are a major or more behind.
- **Move App.tsx's state and handlers into one hook** (second priority), such as `useDmController()`, returning one object of state and actions. The Toolbar and library panel take that object instead of about 40 separate props. This keeps App.tsx from growing further and makes a new layout or GUI much cheaper later. It can be done step by step, with the app working after each step.
- **No hidden menu on Windows and Linux.** The application menu is hidden there, but it is still what makes F11, Ctrl+R and Ctrl+Shift+I (and Ctrl+Q on Linux) work in both windows, and on Windows letting go of Alt used to give it keyboard focus without showing it. Remove it on Windows and Linux (the Mac keeps it: it is the menu bar at the top of the screen, and its Edit menu makes copy and paste work in text fields), handle those keys in each window's own key handler, and drop the Alt workaround in `hideMenuBar` together with the `window:altReleased` message.
- **Kill screen.** A button the DM presses when a player kills a monster: the player screen goes black and shows a big line of text, such as "Finish Him!", until the DM presses it again. Builds on Blackout.
- **Touch on the Steam Deck.** Try the Linux build on a Deck, then tune it if needed: a finger dragged over the map may scroll the page instead of painting.

## Ideas

### Maps and areas

- **View bookmarks:** saved framings of the player view for each map (one per room, say) to jump between.
- **Ping:** briefly mark a spot on the player screen, to draw everyone's eyes to it.
- **DM notes:** pins on the map that only the DM sees.
- **Grid from the image size**, as Mini Gridder does: from the map's pixel size, work out the square sizes that fit a whole number of squares both across and down, and step through them (arrow keys or wheel, say) with the grid shown over the map until it lines up. A quicker way to set a grid than measuring, for maps whose names give no grid.
- **Universal VTT import** (`.dd2vtt`, `.uvtt`, from Dungeondraft and others): the map image together with its grid size, so it needs no measuring.

### Platforms

- **Code-signed builds**, so Windows SmartScreen and macOS Gatekeeper stop warning on first launch. Needs paid certificates (Apple's costs $99 a year).
- **Flatpak** for the Steam Deck's Discover store. The AppImage covers the Deck for now.
- **A Steam Deck without keyboard and mouse:** controller and trackpad bindings for the tools.

### Under the hood

- **A Content-Security-Policy** for the packaged app, as Electron recommends. The app only ever shows its own files, so this is extra hardening rather than a fix.
- **Only if the app grows much larger** (low priority; with the app close to feature complete, maybe never):
  - Mouse actions in a table like the keys in `src/lib/shortcuts.ts`. Drags, wheel steps and held keys (Shift, Alt, Ctrl) are now written into MapStage, AreaHandles and MeasureLayer. Only needed for user-set mouse bindings or another input method (touch, pen, controller).
  - Shared state through React context or a small store (Zustand, say), if one controller hook still means passing a lot through props. Check the re-render cost on low-resource laptops first.
  - Vitest for `src/lib/` and Playwright for the app test, instead of the custom test scripts, if those become hard to maintain or new contributors join.

## Decided against

- **Showing fog strokes to players while they are painted.** Players see a stroke when the mouse is released, so a room is revealed all at once, and the mask is encoded once per stroke rather than continuously.
- **Areas snapping to the grid by default.** Some spells start in the middle of a square and others anywhere at all, so areas move freely; holding Ctrl snaps them.

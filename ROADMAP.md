# Roadmap

Where Mini VTT might go next. Nothing here is a promise. **Next** is what is planned, **Ideas** collects thoughts that haven't been decided on, and **Decided against** keeps the reasons something was turned down, so it doesn't have to be argued again. Finished work moves to the [changelog](CHANGELOG.md).

Have an idea? Open an [issue](https://github.com/Paertan85/mini_vtt/issues).

## Next

- **Release 1.2.0** with spell areas, fog shapes, the new controls, and the macOS and Linux builds.
- **Touch on the Steam Deck.** Try the Linux build on a Deck, then tune it if needed: a finger dragged over the map may scroll the page instead of painting.

## Ideas

### Maps and areas

- **Cones and lines snap while turning**, for example to 45° steps, the way a square settles onto the grid near a right angle.
- **View bookmarks:** saved framings of the player view for each map (one per room, say) to jump between.
- **Ping:** briefly mark a spot on the player screen, to draw everyone's eyes to it.
- **DM notes:** pins on the map that only the DM sees.
- **Universal VTT import** (`.dd2vtt`, `.uvtt`, from Dungeondraft and others): the map image together with its grid size, so it needs no measuring.

### Platforms

- **Code-signed builds**, so Windows SmartScreen and macOS Gatekeeper stop warning on first launch. Needs paid certificates (Apple's costs $99 a year).
- **Flatpak** for the Steam Deck's Discover store. The AppImage covers the Deck for now.
- **A Steam Deck without keyboard and mouse:** controller and trackpad bindings for the tools.

### Under the hood

- **A Content-Security-Policy** for the packaged app, as Electron recommends. The app only ever shows its own files, so this is extra hardening rather than a fix.

## Decided against

- **Showing fog strokes to players while they are painted.** Players see a stroke when the mouse is released, so a room is revealed all at once, and the mask is encoded once per stroke rather than continuously.
- **Areas snapping to the grid by default.** Some spells start in the middle of a square and others anywhere at all, so areas move freely; holding Ctrl snaps them.
- **Range requests (seeking) for video maps.** Measured with a 169 MB map: looping already works without them, and with them playback read more data and used more memory.

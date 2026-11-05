# Contributing to Mini VTT

Thanks for your interest in improving Mini VTT! Bug reports, ideas and pull
requests are all welcome.

## Reporting bugs and requesting features

Open an [issue](https://github.com/Paertan85/mini_vtt/issues) using one of the
templates. For bugs, the most useful things to include are your operating
system, the app version, the steps to reproduce, and whether the problem is in
the DM window or on the player screen.

For a feature, have a look at [ROADMAP.md](ROADMAP.md) first: it may already be
planned or listed as an idea, or have been decided against, with the reason.

## Development setup

You'll need Node.js 20 or newer.

```bash
npm install
npm run dev
```

## Before opening a pull request

Please make sure these pass:

```bash
npm run typecheck
npm run lint
npm run format:check
npm test
npm run test:app
```

On Linux without a display, prefix the test commands with `xvfb-run -a`.

A few guidelines:

- **Keep it light.** Mini VTT is meant to run well on low-end laptops. Read
  [AGENTS.md](AGENTS.md) for the design rules: event-driven work over polling,
  no per-frame JavaScript, bounded caches, and media kept out of React state.
- **Keep the main process in charge of the disk.** The renderer goes through
  the `window.electronAPI` bridge, whose type is derived from
  `electron/preload.ts`; validate anything that arrives over IPC.
- **Keep the look consistent.** Use the colour tokens in `tailwind.config.js`
  and the controls in `src/ui/`: gold marks the active choice, crimson is only
  for things players can see change.
- **Go through the index queue.** Changes to `index.json` belong in
  `electron/library.ts` and must use `mutateIndex()`, so concurrent saves
  can't overwrite each other.
- **Add a test** for library changes in `scripts/test-library.mjs`, and for
  user-visible behaviour in `scripts/test-app.mjs` where practical.
- **Update the changelog** under "Unreleased" for anything user-facing.

## License

By contributing, you agree that your contributions will be licensed under the
[MIT License](LICENSE).

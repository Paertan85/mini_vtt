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

You'll need Node.js 22 or newer.

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

`npm run check` runs all five in order and stops at the first failure. On
Linux without a display, prefix the test commands with `xvfb-run -a` (or run
`xvfb-run -a npm run check`).

For changes that affect memory, `npm run memory` loads every map and shows
every handout in turn, for several rounds, and prints each process's memory
after each step (garbage collected first). Memory that keeps rising from round
to round is a leak. It uses plain grey test maps, or your own:
`npm run memory -- <folder> --rounds 3 --csv report.csv` (files in a folder
named `Handouts` become handouts). `--no-player` leaves out the player window,
`--fullscreen` puts the DM window full screen on the main display and the
player window full screen on another (a TV), `--cpu` adds the CPU each
process uses over two seconds at every step, and `--switch name=value` tries
a Chromium switch. Your real library is untouched.

A few guidelines:

- **Keep it light.** Mini VTT is meant to run well on low-end laptops. Read
  [AGENTS.md](AGENTS.md) for the design rules: event-driven work over polling,
  no per-frame JavaScript, bounded caches, and media kept out of React state.
- **Keep the main process in charge of the disk.** The renderer goes through
  the `window.electronAPI` bridge, whose type is derived from
  `electron/preload.ts`; validate anything that arrives over IPC.
- **Keep the look consistent.** Use the colour tokens in `src/index.css`
  and the controls in `src/ui/`: gold marks the active choice, crimson is only
  for things players can see change.
- **Go through the index queue.** Changes to `index.json` must use
  `mutateIndex()` from `electron/libraryStore.ts`, so concurrent saves can't
  overwrite each other.
- **Add a test** for library changes in `scripts/test-library.mjs`, and for
  user-visible behaviour in `scripts/test-app.mjs` where practical.
- **Update the changelog** under "Unreleased" for anything user-facing.

## Releasing

The version only changes when a release is made: minor for new features
(1.2.0), patch for a release with fixes only (1.2.1).

1. Update the screenshots in `docs/screenshots/` (shown in the README) if
   anything they show has changed since the last release.
2. Push everything that goes into the release to main first, without the
   version change, and wait for CI to pass on Windows, macOS and Linux. A
   test that fails on one of them is then fixed before there is a tag.
3. In `CHANGELOG.md`, add a heading `## X.Y.Z - YYYY-MM-DD` right under
   "Unreleased", so everything listed so far belongs to the release.
4. Set the version: `npm version X.Y.Z --no-git-tag-version`.
5. Commit as "Release X.Y.Z" and tag it: `git tag -a vX.Y.Z -m "Mini VTT X.Y.Z"`.
6. Push both: `git push --follow-tags`. CI tests the tag on Windows, macOS
   and Linux, builds the installers, and drafts a GitHub release with them,
   using the changelog's section as its notes.
7. On GitHub, open **Releases**, check the draft and click **Publish
   release**.

If a release's build fails or needs redoing, run the **CI** workflow by hand
(Actions → CI → Run workflow) with the tag filled in. It builds that version
again and replaces the draft's files, keeping its text.

## License

By contributing, you agree that your contributions will be licensed under the
[MIT License](LICENSE).

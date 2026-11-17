// CPU report: loads each map and does what a DM does with it (moves the
// mouse, drags the player frame, zooms and pans the DM view, paints fog and
// effects, measures), driving real mouse and key input in the DM window, and
// prints the CPU each process uses during each action. 100 = one core busy,
// so two busy cores read 200.
//
//   npm run cpu -- <folder or files>        your own maps (Handouts folders are left out)
//   npm run cpu -- <folder> --fullscreen --seconds 5
//
// --fullscreen puts the DM window full screen on the main display and the
// player window full screen on another one (the TV), as at the table.
// --seconds sets how long each action lasts (3 by default).
//
// The mouse moves every 16 ms without a pause, so real use costs less in
// total; compare builds and actions with each other rather than reading the
// numbers as what play costs. A run varies by about a fifth from the next:
// look at differences larger than that. An action that had no effect (the
// fog didn't change, the frame didn't move) is marked, so a broken step can't
// pass for a cheap one. Uses a scratch userData directory, so your real
// library is untouched.

import { app, BrowserWindow, screen } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { scratchDir } from './scratch-dir.mjs';

const args = process.argv.slice(process.argv.findIndex((arg) => arg.endsWith('cpu-report.mjs')) + 1);
const option = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const FULLSCREEN = args.includes('--fullscreen');
const ACTION_MS = Number(option('--seconds') ?? 3) * 1000;
const inputs = args.filter((arg, i) => !arg.startsWith('--') && args[i - 1] !== '--seconds');

await import('../dist-electron/main.js'); // must load before `ready` (registers the media protocol)

// Covered windows keep rendering (as in test-app.mjs)
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.on('browser-window-created', (_event, window) => window.webContents.setBackgroundThrottling(false));

const scratch = scratchDir('cpu');
app.setPath('userData', path.join(scratch, 'userData'));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// By extension only, as in memory-report.mjs
const MEDIA = /\.(png|jpe?g|gif|webp|bmp|webm)$/i;

/** The map files to load: every media file in the folders given, and the files given */
function collectMaps() {
  const maps = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.toLowerCase() !== 'handouts') walk(full);
      } else if (MEDIA.test(entry.name)) maps.push(full);
    }
  };
  for (const input of inputs) {
    const full = path.resolve(input);
    if (fs.statSync(full).isDirectory()) walk(full);
    else maps.push(full);
  }
  return maps;
}

app.whenReady().then(async () => {
  try {
    await run();
  } catch (err) {
    console.error(err);
  }
  // The scratch folder is deleted once the app has quit
  for (const window of BrowserWindow.getAllWindows()) window.destroy();
  app.exit(0);
});

async function run() {
  const mapFiles = inputs.length ? collectMaps() : [];
  if (!mapFiles.length) {
    console.log(
      'Give a folder of maps, or map files: npm run cpu -- <folder or files> [--fullscreen] [--seconds 3]',
    );
    return;
  }

  await sleep(500);
  const dm = BrowserWindow.getAllWindows()[0];
  const loaded = (window) =>
    window.webContents.isLoading()
      ? new Promise((resolve) => window.webContents.once('did-finish-load', resolve))
      : Promise.resolve();
  await loaded(dm);
  const js = (code, target = dm) => target.webContents.executeJavaScript(code);
  const waitFor = async (condition, timeoutMs) => {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const value = await condition().catch(() => null);
      if (value || Date.now() > end) return value;
      await sleep(100);
    }
  };
  await waitFor(() => js('!!window.electronAPI'), 10000);

  // ─── CPU ────────────────────────────────────────────────────────────────────

  let roles = new Map();
  /**
   * A meter: each call gives the CPU each process used since the call before,
   * as % of one core, from the CPU seconds it has used. Not percentCPUUsage:
   * that is shared out over all the cores.
   */
  const meter = () => {
    let last = new Map();
    let lastAt = Date.now();
    return () => {
      const now = Date.now();
      const seconds = (now - lastAt) / 1000;
      const next = new Map();
      const used = {};
      for (const metric of app.getAppMetrics()) {
        const cpuSeconds = metric.cpu.cumulativeCPUUsage ?? 0;
        next.set(metric.pid, cpuSeconds);
        if (!last.has(metric.pid)) continue;
        const name = roles.get(metric.pid) ?? metric.type;
        used[name] = (used[name] ?? 0) + (Math.max(0, cpuSeconds - last.get(metric.pid)) / seconds) * 100;
      }
      last = next;
      lastAt = now;
      return used;
    };
  };
  const cpu = meter();
  const show = (label, used, note = '') => {
    const total = Object.values(used).reduce((sum, value) => sum + value, 0);
    const parts = ['DM', 'Player', 'GPU', 'Browser'].map((name) =>
      `${name} ${Math.round(used[name] ?? 0)}`.padEnd(11),
    );
    console.log(
      `${label.padEnd(42)} total ${String(Math.round(total)).padStart(4)}   ${parts.join(' ')}${note}`,
    );
  };
  /** CPU over `action`; `check` says whether it had an effect */
  const measure = async (label, action, check) => {
    cpu();
    await action();
    const used = cpu();
    const worked = check ? await check() : true;
    show(label, used, worked ? '' : '   (no effect: not a valid reading)');
  };

  // ─── Library and windows ────────────────────────────────────────────────────

  console.log(`Importing ${mapFiles.length} maps…`);
  cpu();
  const started = Date.now();
  const imported = await js(`window.electronAPI.importMaps(${JSON.stringify(mapFiles)})`);
  show(`import (${((Date.now() - started) / 1000).toFixed(1)} s)`, cpu());
  if (imported.skipped.length)
    console.log(`Skipped (not a map Mini VTT can open): ${imported.skipped.join(', ')}`);
  await js(`window.electronAPI.saveSettings({ showWelcome: false, currentMapId: null })`);
  dm.webContents.reload();
  await sleep(300);
  await loaded(dm);
  await sleep(1500);
  const library = await js('window.electronAPI.loadLibrary()');

  await js('window.electronAPI.openPlayerWindow()');
  const player = await waitFor(async () => BrowserWindow.getAllWindows().find((w) => w !== dm), 10000);
  await loaded(player);
  await sleep(1500);
  if (FULLSCREEN) {
    const main = screen.getPrimaryDisplay();
    const other = screen.getAllDisplays().find((display) => display.id !== main.id);
    const pixels = (display) =>
      `${Math.round(display.size.width * display.scaleFactor)}×${Math.round(display.size.height * display.scaleFactor)}`;
    if (other) {
      player.setBounds(other.workArea);
      player.setFullScreen(true);
      console.log(`Player window full screen on ${pixels(other)}`);
    } else {
      console.log('Only one display: the player window stays a window');
    }
    dm.setFullScreen(true);
    console.log(`DM window full screen on ${pixels(main)}`);
    await sleep(2000);
  }
  dm.focus();
  dm.webContents.focus();
  roles = new Map([
    [dm.webContents.getOSProcessId(), 'DM'],
    [player.webContents.getOSProcessId(), 'Player'],
  ]);

  // ─── Input ──────────────────────────────────────────────────────────────────

  const send = (event) => dm.webContents.sendInputEvent(event);
  const key = (keyCode, modifiers = []) => {
    send({ type: 'keyDown', keyCode, modifiers });
    if (keyCode.length === 1) send({ type: 'char', keyCode, modifiers });
    send({ type: 'keyUp', keyCode, modifiers });
  };
  const tool = async (letter) => {
    key('Escape');
    key(letter);
    await sleep(300);
  };
  const rectOf = (selector) =>
    js(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null;
      const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
  /** Where the pointer is `ms` into an action that circles around (x, y) */
  const along = (x, y, radius, ms) => {
    const turn = (ms / 1000) * Math.PI;
    return {
      x: Math.round(x + radius * Math.sin(turn)),
      y: Math.round(y + radius * (1 - Math.cos(turn)) * 0.6),
    };
  };
  /** Move the mouse for ACTION_MS, every 16 ms, with `button` held if given */
  const move = async (x, y, radius, button = null, modifiers = []) => {
    const held = button ? [...modifiers, `${button}ButtonDown`] : modifiers;
    send({ type: 'mouseMove', x: Math.round(x), y: Math.round(y), modifiers });
    if (button)
      send({ type: 'mouseDown', x: Math.round(x), y: Math.round(y), button, clickCount: 1, modifiers: held });
    const start = Date.now();
    let at = { x, y };
    while (Date.now() - start < ACTION_MS) {
      at = along(x, y, radius, Date.now() - start);
      send({ type: 'mouseMove', ...at, ...(button ? { button } : {}), modifiers: held });
      await sleep(16);
    }
    if (button) send({ type: 'mouseUp', ...at, button, clickCount: 1, modifiers });
  };
  const wheel = async (x, y, deltaY, modifiers, count) => {
    for (let i = 0; i < count; i++) {
      send({ type: 'mouseWheel', x: Math.round(x), y: Math.round(y), deltaX: 0, deltaY, modifiers });
      await sleep(50);
    }
  };
  const fogImage = () => js(`document.querySelector('[aria-label="Fog of war"]').toDataURL()`);
  const effectImage = () =>
    js(`[...document.querySelectorAll('canvas')].map((c) => c.width + 'x' + c.height).join()`);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  // ─── Each map ───────────────────────────────────────────────────────────────

  for (const map of library.maps) {
    cpu();
    const begin = Date.now();
    await js(
      `[...document.querySelectorAll('[aria-label="Maps"] button')].find((b) => b.getAttribute('aria-label') === ${JSON.stringify(map.name)})
        ?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`,
    );
    const shown = await waitFor(
      () =>
        js(`(() => { const el = [...document.querySelectorAll('img, video')].find((e) => e.getAttribute('src') === 'map-media://${map.id}');
          return el && (el instanceof HTMLVideoElement ? el.readyState >= 2 : el.complete && el.naturalWidth > 0); })()`),
      60000,
    );
    const seconds = ((Date.now() - begin) / 1000).toFixed(1);
    // The decode and the copy to the GPU finish seconds after the load event
    await sleep(8000);
    console.log(`\n${map.name}`);
    if (!shown) {
      console.log("  didn't load: left out");
      continue;
    }
    show(`load (${seconds} s), and 8 s after`, cpu());
    const stage = await rectOf('[aria-label="Fog of war"]');
    const x = stage.x + stage.w / 2;
    const y = stage.y + stage.h / 2;
    const radius = Math.min(stage.w, stage.h) / 5;

    await measure('idle', () => sleep(ACTION_MS));
    await tool('V');
    await measure('mouse moving over the map, View tool', () => move(x, y, radius));

    // The player frame: zoom the players in so the frame can move, then drag it
    for (let i = 0; i < 8; i++) key('=');
    await sleep(1500);
    const frame = await rectOf('[aria-label="Player view"]');
    await measure(
      'drag the player frame',
      () => move(frame.x + frame.w / 2, frame.y + frame.h / 2, Math.min(frame.w, stage.w) / 4, 'left'),
      async () => !same(await rectOf('[aria-label="Player view"]'), frame),
    );
    for (let i = 0; i < 20; i++) key('-');
    await sleep(1000);

    // The DM view: zoom in and out around the middle, then pan zoomed in
    const zoomSteps = Math.max(1, Math.round(ACTION_MS / 100));
    let zoomedRect = null;
    await measure(
      'DM view: Ctrl+wheel zoom in and out',
      async () => {
        await wheel(x, y, 120, ['control'], zoomSteps);
        zoomedRect = await rectOf('[aria-label="Fog of war"]');
        await wheel(x, y, -120, ['control'], zoomSteps);
      },
      async () => !same(zoomedRect, stage),
    );
    await wheel(x, y, 120, ['control'], 15);
    await sleep(1000);
    const zoomed = await rectOf('[aria-label="Fog of war"]');
    await measure(
      'DM view: middle-drag pan, zoomed in',
      () => move(x, y, radius, 'middle'),
      async () => !same(await rectOf('[aria-label="Fog of war"]'), zoomed),
    );
    key('0', ['control']);
    await sleep(1000);

    // Fog: hover with the brush, then cover a stroke (a new map starts
    // uncovered, so revealing would change nothing)
    await tool('F');
    await js(
      `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Brush')?.click()`,
    );
    await sleep(200);
    await measure('mouse moving over the map, Fog brush', () => move(x, y, radius));
    const fogBefore = await fogImage();
    await measure('Fog: paint a stroke (cover)', () => move(x, y, radius, 'right'));
    await measure(
      '  2 s after (to the player screen)',
      () => sleep(2000),
      async () => (await fogImage()) !== fogBefore,
    );

    // Effects: paint, then nothing should keep running
    await tool('E');
    const effectsBefore = await effectImage();
    await measure('Effects: paint a stroke', () => move(x, y, radius, 'left'));
    await measure(
      '  2 s after',
      () => sleep(2000),
      async () => (await effectImage()) !== effectsBefore,
    );
    await measure('  idle with fog and an effect on the map', () => sleep(ACTION_MS));

    await tool('M');
    await measure('Ruler: drag', () => move(x, y, radius, 'left'));
    await tool('V');
  }
}

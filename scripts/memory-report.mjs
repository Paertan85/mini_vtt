// Memory report: loads every map and shows every handout in turn, for several
// rounds, and prints how much memory each process uses after each step. Memory
// that keeps rising from round to round is a leak; a step that jumps far above
// the others is unexpected use.
//
//   npm run memory                          plain grey test maps
//   npm run memory -- <folder>              your own maps and handouts
//   npm run memory -- <folder> --rounds 5 --no-player --csv report.csv
//   npm run memory -- <folder> --fullscreen --cpu
//
// --fullscreen puts the DM window full screen on the main display and the
// player window full screen on another one (the TV), as at the table.
// --cpu adds the CPU used over two seconds after each step (100 = one core).
//
// Image and video files in a folder named "Handouts" (any depth) are imported
// as handouts, the others as maps; other files (notes, scripts) are left out.
// Uses a scratch userData directory, so your real library is untouched.
// Garbage is collected in both windows before each reading, so what is left is
// what the app keeps.

import { app, BrowserWindow, protocol, screen } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { scratchDir } from './scratch-dir.mjs';
import zlib from 'node:zlib';

// ─── Options ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(process.argv.findIndex((arg) => arg.endsWith('memory-report.mjs')) + 1);
const option = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const ROUNDS = Number(option('--rounds') ?? 3);
const WITH_PLAYER = !args.includes('--no-player');
// Both windows full screen, the player window on another display (a TV) if there is one
const FULLSCREEN = args.includes('--fullscreen');
// Also read the CPU each process uses over two seconds at every step
const CPU = args.includes('--cpu');
const CSV = option('--csv');
const valued = new Set(['--rounds', '--csv', '--switch']);
const folder = args.find((arg, i) => !arg.startsWith('--') && !valued.has(args[i - 1]));
// Chromium switches to try, such as --switch force-gpu-mem-discardable-limit-mb=64
args.forEach((arg, i) => {
  if (arg !== '--switch' || !args[i + 1]) return;
  const [name, value] = args[i + 1].split('=');
  app.commandLine.appendSwitch(name, value);
  console.log(`Chromium switch: --${args[i + 1]}`);
});

// Count the media reads per library id, to see each map come from disk again
const reads = {};
const handle = protocol.handle.bind(protocol);
protocol.handle = (scheme, handler) =>
  handle(scheme, (request) => {
    const id = new URL(request.url).hostname;
    reads[id] = (reads[id] ?? 0) + 1;
    return handler(request);
  });
await import('../dist-electron/main.js'); // must load before `ready` (registers the media protocol)

// Covered windows keep rendering (as in test-app.mjs)
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.on('browser-window-created', (_event, window) => window.webContents.setBackgroundThrottling(false));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const MB = (kb) => Math.round(kb / 1024);

// ─── Library ──────────────────────────────────────────────────────────────────

/** A solid grey RGB PNG (as in test-app.mjs). */
function makePng(width, height, value) {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (bytes) => {
    let c = 0xffffffff;
    for (const byte of bytes) c = table[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // RGB
  const rows = Buffer.alloc((width * 3 + 1) * height, value);
  for (let y = 0; y < height; y++) rows[y * (width * 3 + 1)] = 0; // filter: none
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const scratch = scratchDir('memory');
app.setPath('userData', path.join(scratch, 'userData'));

// By extension only: a damaged or misnamed file is still imported, to see how it is handled
const MEDIA = /\.(png|jpe?g|gif|webp|bmp|webm)$/i;

/** Files to import: [maps, handouts] */
function collectFiles() {
  if (!folder) {
    // Three large grey maps: 120 MB each once decoded
    const dir = path.join(scratch, 'maps');
    fs.mkdirSync(dir);
    const maps = ['Grey A', 'Grey B', 'Grey C'].map((name, i) => {
      const file = path.join(dir, `${name}.png`);
      fs.writeFileSync(file, makePng(6000, 5000, 110 + i * 20));
      return file;
    });
    return [maps, []];
  }
  const maps = [];
  const handouts = [];
  const walk = (dir, inHandouts) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, inHandouts || entry.name.toLowerCase() === 'handouts');
      else if (MEDIA.test(entry.name)) (inHandouts ? handouts : maps).push(full);
    }
  };
  walk(path.resolve(folder), false);
  return [maps, handouts];
}

// ─── Readings ─────────────────────────────────────────────────────────────────

const rows = [];

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

  // Import, then reload so the library shows what was added
  const [mapFiles, handoutFiles] = collectFiles();
  console.log(`Importing ${mapFiles.length} maps and ${handoutFiles.length} handouts…`);
  const started = Date.now();
  const imported = await js(`window.electronAPI.importMaps(${JSON.stringify(mapFiles)})`);
  if (handoutFiles.length) await js(`window.electronAPI.importHandouts(${JSON.stringify(handoutFiles)})`);
  if (imported.skipped.length)
    console.log(`Skipped (not a map Mini VTT can open): ${imported.skipped.join(', ')}`);
  console.log(`Imported in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  await js(`window.electronAPI.saveSettings({ showWelcome: false, currentMapId: null })`);
  dm.webContents.reload();
  await sleep(300);
  await loaded(dm);
  await sleep(1500);
  const library = await js('window.electronAPI.loadLibrary()');

  let player = null;
  if (WITH_PLAYER) {
    await js('window.electronAPI.openPlayerWindow()');
    player = await waitFor(async () => BrowserWindow.getAllWindows().find((w) => w !== dm), 10000);
    await loaded(player);
    await sleep(1500);
  }
  const windows = () => [dm, player].filter((w) => w && !w.isDestroyed());

  if (FULLSCREEN) {
    const main = screen.getPrimaryDisplay();
    const other = screen.getAllDisplays().find((display) => display.id !== main.id);
    const pixels = (display) =>
      `${Math.round(display.size.width * display.scaleFactor)}×${Math.round(display.size.height * display.scaleFactor)}`;
    if (player && other) {
      player.setBounds(other.workArea);
      player.setFullScreen(true);
      console.log(`Player window full screen on ${pixels(other)}`);
    } else if (player) {
      console.log('Only one display: the player window stays a window');
    }
    dm.setFullScreen(true);
    console.log(`DM window full screen on ${pixels(main)}`);
    await sleep(2000);
  }

  const attach = (window) => {
    if (!window.webContents.debugger.isAttached()) window.webContents.debugger.attach('1.3');
    return window.webContents.debugger;
  };

  /** Collect garbage in both windows, then read every process. */
  const measure = async (step, extra = {}) => {
    await sleep(1000);
    for (const window of windows()) await attach(window).sendCommand('HeapProfiler.collectGarbage');
    await sleep(1000);
    const roles = new Map(windows().map((w) => [w.webContents.getOSProcessId(), w === dm ? 'DM' : 'Player']));
    const processes = {};
    for (const metric of app.getAppMetrics()) {
      const name = roles.get(metric.pid) ?? metric.type;
      // Windows and macOS report private bytes; Linux only the working set
      const kb = metric.memory.privateBytes ?? metric.memory.workingSetSize;
      processes[name] = (processes[name] ?? 0) + kb;
    }
    const heaps = {};
    const counters = {};
    for (const window of windows()) {
      const role = window === dm ? 'DM' : 'Player';
      const debug = attach(window);
      const heap = await debug.sendCommand('Runtime.getHeapUsage');
      heaps[role] = Math.round(heap.usedSize / 1024 / 1024);
      const dom = await debug.sendCommand('Memory.getDOMCounters');
      counters[role] = { nodes: dom.nodes, listeners: dom.jsEventListeners, documents: dom.documents };
    }
    const total = Object.values(processes).reduce((sum, kb) => sum + kb, 0);
    // Each reading is the use since the one before: start now, read in two seconds
    const cpu = {};
    if (CPU) {
      app.getAppMetrics();
      await sleep(2000);
      for (const metric of app.getAppMetrics()) {
        const name = roles.get(metric.pid) ?? metric.type;
        cpu[`${name} cpu`] = Math.round((cpu[`${name} cpu`] ?? 0) + metric.cpu.percentCPUUsage);
      }
      cpu['total cpu'] = Object.values(cpu).reduce((sum, value) => sum + value, 0);
    }
    const row = {
      step,
      total: MB(total),
      ...Object.fromEntries(Object.entries(processes).map(([name, kb]) => [name, MB(kb)])),
      'DM heap': heaps.DM,
      'Player heap': heaps.Player,
      'DM nodes': counters.DM?.nodes,
      'DM listeners': counters.DM?.listeners,
      'Player nodes': counters.Player?.nodes,
      'Player listeners': counters.Player?.listeners,
      'main heap': Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      ...cpu,
      ...extra,
    };
    rows.push(row);
    const shown = Object.entries(row)
      .filter(([key]) => key !== 'step')
      .map(([key, value]) => `${key}=${value}`)
      .join('  ');
    console.log(`${step.slice(0, 40).padEnd(40)} ${shown}`);
  };

  const tab = (name) =>
    js(
      `[...document.querySelectorAll('[role="tab"]')].find((t) => t.textContent.startsWith(${JSON.stringify(name)}))?.click()`,
    );
  const open = (list, name) =>
    js(
      `[...document.querySelectorAll('[aria-label="${list}"] button')].find((b) => b.getAttribute('aria-label') === ${JSON.stringify(name)})
        ?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`,
    );
  /** Whether the window shows `id`'s media, fully loaded: 'ok', 'error' or null while loading */
  const mediaState = (id, target) =>
    js(
      `(() => { const el = [...document.querySelectorAll('img, video')].find((e) => e.getAttribute('src') === 'map-media://${id}');
        if (!el) return null;
        if (el instanceof HTMLVideoElement) return el.error ? 'error' : el.readyState >= 1 ? 'ok' : null;
        return el.complete ? (el.naturalWidth ? 'ok' : 'error') : null; })()`,
      target,
    );

  await measure('empty library loaded');
  for (let round = 1; round <= ROUNDS; round++) {
    await tab('Maps');
    for (const map of library.maps) {
      const begin = Date.now();
      await open('Maps', map.name);
      const state = await waitFor(() => mediaState(map.id, dm), 60000);
      const seconds = ((Date.now() - begin) / 1000).toFixed(1);
      await measure(`r${round} map: ${map.name}`, {
        load: `${seconds}s${state === 'ok' ? '' : ` (${state ?? 'timed out'})`}`,
        reads: reads[map.id] ?? 0,
      });
    }
    if (player && library.handouts.length) {
      await tab('Handouts');
      for (const handout of library.handouts) {
        await open('Handouts', handout.name);
        const state = await waitFor(() => mediaState(handout.id, player), 30000);
        await measure(`r${round} handout: ${handout.name}`, {
          load: state === 'ok' ? '' : `(${state ?? 'timed out'})`,
          reads: reads[handout.id] ?? 0,
        });
        await js('window.electronAPI.closeHandout()', player);
        await sleep(300);
      }
    }
  }

  summarize();
  if (CSV) writeCsv(CSV);
}

// ─── Summary ──────────────────────────────────────────────────────────────────

function summarize() {
  const steps = rows.filter((row) => /^r\d+ /.test(row.step));
  const byItem = new Map();
  for (const row of steps) {
    const item = row.step.replace(/^r\d+ /, '');
    if (!byItem.has(item)) byItem.set(item, []);
    byItem.get(item).push(row);
  }
  console.log('\nAfter the same step, first round → last round (MB):');
  const growth = [];
  for (const [item, seen] of byItem) {
    const first = seen[0];
    const last = seen[seen.length - 1];
    growth.push(last.total - first.total);
    const parts = ['total', 'Browser', 'GPU', 'DM', 'Player']
      .filter((key) => first[key] !== undefined)
      .map((key) => `${key} ${first[key]}→${last[key]}`);
    console.log(`  ${item.slice(0, 40).padEnd(40)} ${parts.join('  ')}`);
  }
  const average = growth.length ? growth.reduce((a, b) => a + b, 0) / growth.length : 0;
  const peak = steps.reduce((best, row) => (row.total > (best?.total ?? 0) ? row : best), null);
  console.log(`\nAverage growth between first and last round: ${average.toFixed(0)} MB`);
  if (peak) console.log(`Highest total: ${peak.total} MB at "${peak.step}"`);
  if (ROUNDS > 1)
    console.log(
      average < 50
        ? 'No sign of a leak: memory returns to the same level each round.'
        : 'Memory grows from round to round: look at which process grows above.',
    );
}

function writeCsv(file) {
  const keys = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const cell = (value) => (value === undefined ? '' : `"${String(value).replace(/"/g, '""')}"`);
  fs.writeFileSync(
    file,
    [keys.join(','), ...rows.map((row) => keys.map((key) => cell(row[key])).join(','))].join('\n'),
  );
  console.log(`Written: ${path.resolve(file)}`);
}

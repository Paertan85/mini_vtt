// End-to-end smoke test: launches the built app against a seeded library and
// drives the real windows: per-map state across restarts and map switches,
// fog painting with undo and redo, blackout, the map menu, the player window
// and the navigation guards.
//
//   npm run test:app            (Linux CI: xvfb-run -a npm run test:app)
//
// Uses a scratch userData directory, so your real library is untouched.

import { app, BrowserWindow } from 'electron';
import '../dist-electron/main.js'; // must load before `ready` (registers the media protocol)
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const check = (name, pass, detail = '') => {
  results.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

/** A solid grey RGB PNG, built by hand so seeding can run before `ready`. */
function makePng(width, height) {
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
  const rows = Buffer.alloc((width * 3 + 1) * height, 150);
  for (let y = 0; y < height; y++) rows[y * (width * 3 + 1)] = 0; // filter: none
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ─── Seed a library: map A was last used at 250% with a custom pan ───────────

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'minivtt-app-test-'));
app.setPath('userData', userData);
const libraryDir = path.join(userData, 'library');
const readIndex = () => JSON.parse(fs.readFileSync(path.join(libraryDir, 'index.json'), 'utf8'));
const mapEntry = (id, name, zoom, pan) => ({
  id,
  name,
  mediaType: 'image',
  width: 800,
  height: 600,
  zoom,
  pan,
  rotation: 0,
  mirrorHorizontal: false,
  mirrorVertical: false,
  hasFog: false,
  addedAt: Date.now(),
});
for (const id of ['m_alpha', 'm_beta']) {
  fs.mkdirSync(path.join(libraryDir, id), { recursive: true });
  fs.writeFileSync(path.join(libraryDir, id, 'image.png'), makePng(800, 600));
}
fs.writeFileSync(
  path.join(libraryDir, 'index.json'),
  JSON.stringify({
    // Settings in the pre-1.1 format, to check they're migrated
    settings: { currentMapId: 'm_alpha', playerViewDiagonal: '27', gridSize: '1' },
    maps: [
      mapEntry('m_alpha', 'Alpha', 2.5, { x: 50, y: 40 }),
      mapEntry('m_beta', 'Beta', 1, { x: 0, y: 0 }),
    ],
    handouts: [],
  }),
);

// ─── Drive the app ────────────────────────────────────────────────────────────

const fogHash = () => {
  try {
    return crypto
      .createHash('sha1')
      .update(fs.readFileSync(path.join(libraryDir, 'm_alpha', 'fog.png')))
      .digest('hex');
  } catch {
    return null;
  }
};

app.whenReady().then(async () => {
  await sleep(500);
  const main = BrowserWindow.getAllWindows()[0];
  if (main.webContents.isLoading())
    await new Promise((resolve) => main.webContents.once('did-finish-load', resolve));
  await sleep(1500);

  const js = (code, target = main) => target.webContents.executeJavaScript(code);
  const zoomText = () => js(`document.querySelector('[aria-label="Zoom percentage"]').value`);
  const click = (selector) => js(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const clickText = (text) =>
    js(
      `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(text)}).click()`,
    );
  const playerButton = `[...document.querySelectorAll('button')].find((b) => /^(Open|Bring) the player window/.test(b.title))`;
  const press = (key, init = {}) =>
    js(
      `window.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, ...${JSON.stringify(init)} }))`,
    );
  const loadMap = (name) =>
    js(
      `document.querySelector('button[title^="${name}"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`,
    );
  const mouse = (type, x, y, button = 'left') =>
    main.webContents.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), button, clickCount: 1 });
  const centerOf = (selector) =>
    js(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null;
      const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  const drag = async (from, dx, dy, button = 'left') => {
    mouse('mouseDown', from.x, from.y, button);
    for (let i = 1; i <= 5; i++) {
      mouse('mouseMove', from.x + (dx * i) / 5, from.y + (dy * i) / 5, button);
      await sleep(30);
    }
    mouse('mouseUp', from.x + dx, from.y + dy, button);
  };

  try {
    check(
      'sandboxed preload exposes the API',
      (await js('typeof window.electronAPI?.loadLibrary')) === 'function',
    );
    check('saved zoom is restored on startup', (await zoomText()) === '250', `${await zoomText()}%`);
    await sleep(600);
    check('pre-1.1 settings are migrated', readIndex().settings.playerScreenDiagonal === 27);

    await js(`${playerButton}.click()`);
    await sleep(1500);
    await js(`${playerButton}.click()`);
    await sleep(800);
    const player = BrowserWindow.getAllWindows().find((w) => w !== main);
    check('reopening reuses the player window', BrowserWindow.getAllWindows().length === 2);
    check(
      'the status shows the player screen is live',
      (await js(`${playerButton}.textContent`)).includes('live'),
    );

    // Frame tool (default): dragging the frame saves the pan
    const frame = await centerOf('[aria-label="Player view"]');
    check('player frame is shown', !!frame);
    if (frame) {
      await drag(frame, 40, 30);
      await sleep(900);
      const { pan } = readIndex().maps.find((m) => m.id === 'm_alpha');
      check('dragging the frame saves the pan', pan.x !== 50 || pan.y !== 40, JSON.stringify(pan));
    }

    // Fog tool: paint, then undo restores the previous mask (on disk too)
    await sleep(700);
    const fogBefore = fogHash();
    check('a fresh map is saved fully fogged', !!fogBefore);
    await press('f');
    await sleep(100);
    const canvas = await centerOf('canvas[aria-label="Fog of war"]');
    await drag({ x: canvas.x - 60, y: canvas.y }, 120, 0);
    await sleep(900);
    const fogAfter = fogHash();
    check('painting changes the saved fog', fogAfter && fogAfter !== fogBefore);
    check(
      'undo becomes available',
      (await js(`!document.querySelector('[aria-label="Undo"]').disabled`)) === true,
    );
    await press('z', { ctrlKey: true });
    await sleep(900);
    check('undo restores the previous fog', fogHash() === fogBefore);
    await press('z', { ctrlKey: true, shiftKey: true });
    await sleep(900);
    check('redo re-applies the stroke', fogHash() === fogAfter);
    await press('v');

    // Blackout reaches the player screen
    await press('b');
    await sleep(400);
    check(
      'blackout covers the player screen',
      (await js(`!!document.querySelector('[aria-label="Blackout"]')`, player)) === true,
    );
    await press('b');
    await sleep(400);
    check(
      'blackout can be lifted',
      (await js(`!document.querySelector('[aria-label="Blackout"]')`, player)) === true,
    );

    // Zoom out to 150% on Alpha, switch to Beta and back
    for (let i = 0; i < 3; i++) await click('[aria-label="Zoom out"]');
    check('zoom steps down to 150%', (await zoomText()) === '150', `${await zoomText()}%`);
    await loadMap('Beta');
    await sleep(1200);
    check("switching maps applies that map's zoom", (await zoomText()) === '100', `${await zoomText()}%`);
    await loadMap('Alpha');
    await sleep(1200);
    check('switching back restores the latest zoom', (await zoomText()) === '150', `${await zoomText()}%`);
    const diskZoom = readIndex().maps.find((m) => m.id === 'm_alpha').zoom;
    check('the change was flushed to disk on switch', Math.abs(diskZoom - 1.5) < 0.01, String(diskZoom));

    // Orientation lives in the map's menu, and works for maps that aren't loaded
    await click('[aria-label="Options for Beta"]');
    await sleep(200);
    await clickText('Rotate right');
    await sleep(600);
    check(
      'rotating a map from its menu is saved',
      readIndex().maps.find((m) => m.id === 'm_beta').rotation === 90,
    );

    await js(`location.href = 'file:///'`).catch(() => {});
    await sleep(500);
    check(
      'navigating away is blocked',
      main.webContents.getURL().endsWith('index.html'),
      main.webContents.getURL(),
    );

    player.close();
    await sleep(800);
    check(
      'closing the player window resets the status',
      (await js(`${playerButton}.textContent`)).includes('Open'),
    );
  } catch (err) {
    check('test run completed without throwing', false, err?.stack ?? String(err));
  }

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} passed`);
  fs.rmSync(userData, { recursive: true, force: true });
  app.exit(passed === results.length ? 0 : 1);
});

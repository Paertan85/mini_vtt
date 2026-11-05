// End-to-end smoke test: launches the built app against a seeded library and
// drives the real windows: per-map state across restarts and map switches,
// fog painting with undo and redo, blackout, the map menu, the player window
// and the navigation guards.
//
//   npm run test:app            (Linux CI: xvfb-run -a npm run test:app)
//
// Uses a scratch userData directory, so your real library is untouched.

import { app, BrowserWindow, ipcMain, net } from 'electron';
import '../dist-electron/main.js'; // must load before `ready` (registers the media protocol)
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

// Keep animation frames running when other windows cover the test windows
// (Windows otherwise marks them occluded and pauses requestAnimationFrame)
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Player-state messages from the DM window, to see what reaches the player screen
let playerStates = 0;
ipcMain.on('player:state', () => (playerStates += 1));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const check = (name, pass, detail = '') => {
  results.push(pass);
  const line = `${name}${detail ? ` — ${detail}` : ''}`;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${line}`);
  // On GitHub, a failed check is also named in the run's summary
  if (!pass && process.env.GITHUB_ACTIONS) {
    console.log(`::error title=App test failed::${line.replace(/%/g, '%25').replace(/\r?\n/g, '%0A')}`);
  }
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

/** A plain grey 24-bit BMP, which the main process can't decode (so it makes no thumbnail). */
function makeBmp(width, height) {
  const row = Math.ceil((width * 3) / 4) * 4;
  const pixels = Buffer.alloc(row * height, 150);
  const header = Buffer.alloc(54);
  header.write('BM', 0, 'latin1');
  header.writeUInt32LE(54 + pixels.length, 2);
  header.writeUInt32LE(54, 10);
  header.writeUInt32LE(40, 14);
  header.writeInt32LE(width, 18);
  header.writeInt32LE(height, 22);
  header.writeUInt16LE(1, 26);
  header.writeUInt16LE(24, 28);
  header.writeUInt32LE(pixels.length, 34);
  return Buffer.concat([header, pixels]);
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
fs.mkdirSync(path.join(libraryDir, 'handouts', 'h_grey'), { recursive: true });
fs.writeFileSync(path.join(libraryDir, 'handouts', 'h_grey', 'image.bmp'), makeBmp(64, 32));
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
    handouts: [{ id: 'h_grey', name: 'Grey note', width: 64, height: 32, rotation: 0, addedAt: Date.now() }],
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
  // The Shapes tool's buttons, one per shape
  const addArea = (label) => clickText(label);
  const playerButton = `[...document.querySelectorAll('button')].find((b) => /^(Open|Bring) the player window/.test(b.title))`;
  const press = (key, init = {}) =>
    js(
      `window.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, ...${JSON.stringify(init)} }))`,
    );
  const loadMap = (name) =>
    js(
      `document.querySelector('button[title^="${name}"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`,
    );
  // Presses and moves report the held button, as a real drag does (or pointer
  // capture is never taken)
  const mouse = (type, x, y, button = 'left') =>
    main.webContents.sendInputEvent({
      type,
      x: Math.round(x),
      y: Math.round(y),
      button,
      clickCount: 1,
      modifiers: type === 'mouseUp' ? [] : [`${button}ButtonDown`],
    });
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

    // The media protocol answers Range requests with exactly those bytes: a
    // video resumes and loops by asking for the rest of the file from an
    // offset, and the whole file in reply put garbage on the player screen
    const alphaDir = path.join(libraryDir, 'm_alpha');
    const alphaBytes = fs.readFileSync(
      path.join(
        alphaDir,
        fs.readdirSync(alphaDir).find((f) => f.startsWith('image.')),
      ),
    );
    const fetchMedia = async (range) => {
      const response = await net.fetch('map-media://m_alpha', range ? { headers: { Range: range } } : {});
      return {
        status: response.status,
        contentRange: response.headers.get('content-range'),
        bytes: Buffer.from(await response.arrayBuffer()),
      };
    };
    const half = Math.floor(alphaBytes.length / 2);
    const whole = await fetchMedia(null);
    check('the media protocol serves a whole file', whole.status === 200 && whole.bytes.equals(alphaBytes));
    const rest = await fetchMedia(`bytes=${half}-`);
    check(
      'asked for the rest of a file, it sends exactly that',
      rest.status === 206 &&
        rest.contentRange === `bytes ${half}-${alphaBytes.length - 1}/${alphaBytes.length}` &&
        rest.bytes.equals(alphaBytes.subarray(half)),
      `${rest.status} ${rest.contentRange} ${rest.bytes.length} bytes`,
    );
    const middle = await fetchMedia('bytes=10-19');
    check(
      'a bounded range gets just those bytes',
      middle.status === 206 && middle.bytes.equals(alphaBytes.subarray(10, 20)),
    );
    check(
      'a range past the end is refused',
      (await fetchMedia(`bytes=${alphaBytes.length}-`)).status === 416,
    );
    await sleep(600);
    check('pre-1.1 settings are migrated', readIndex().settings.playerScreenDiagonal === 27);

    // True scale before the player screen is open: a note right beneath the
    // button says so, with a button that opens it
    await clickText('True scale');
    await sleep(200);
    const trueScaleNote = await js(`(() => {
      const note = document.querySelector('[role="dialog"][aria-label="True scale"]');
      const button = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'True scale');
      if (!note) return null;
      const n = note.getBoundingClientRect(), b = button.getBoundingClientRect();
      return { below: n.top >= b.bottom && n.top - b.bottom < 12 && n.left < b.right && n.right > b.left, text: note.textContent };
    })()`);
    check(
      'True scale without the player screen shows a note right beneath it',
      !!trueScaleNote?.below && trueScaleNote.text.includes('Open player screen'),
      JSON.stringify(trueScaleNote),
    );
    await press('Escape');
    await sleep(100);
    check(
      'Escape closes the note',
      (await js(`!!document.querySelector('[role="dialog"][aria-label="True scale"]')`)) === false,
    );

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

    // The maps and handouts panel hides with its button and returns with Ctrl+B
    const panelShown = () =>
      js(`getComputedStyle(document.getElementById('library-panel')).display !== 'none'`);
    const mapWidth = () => js(`document.querySelector('main').getBoundingClientRect().width`);
    const widthWithPanel = await mapWidth();
    await js(`document.querySelector('[aria-controls="library-panel"]').click()`);
    await sleep(600);
    check('the panel button hides the maps and handouts', (await panelShown()) === false);
    check(
      'the map gets the room',
      (await mapWidth()) > widthWithPanel,
      `${widthWithPanel} → ${await mapWidth()}`,
    );
    check('hiding the panel is remembered', readIndex().settings.showLibrary === false);
    await press('b', { ctrlKey: true });
    await sleep(600);
    check(
      'Ctrl+B shows the panel again',
      (await panelShown()) === true && readIndex().settings.showLibrary === true,
    );

    // View tool (default): dragging the frame saves the pan
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

    // Players see a stroke only when it ends, so a room is revealed at once
    const playerFog = () => js(`[...document.querySelectorAll('canvas')].at(-1).toDataURL()`, player);
    const playerFogBefore = await playerFog();
    const start = { x: canvas.x - 60, y: canvas.y + 40 };
    mouse('mouseDown', start.x, start.y);
    for (let i = 1; i <= 5; i++) {
      mouse('mouseMove', start.x + i * 24, start.y);
      await sleep(30);
    }
    await sleep(500);
    check('the player screen waits while fog is painted', (await playerFog()) === playerFogBefore);
    mouse('mouseUp', start.x + 120, start.y);
    await sleep(900);
    check('releasing the mouse reveals the stroke to players', (await playerFog()) !== playerFogBefore);
    await press('z', { ctrlKey: true });
    await sleep(900);

    // Lasso (L): draw around an area; its whole inside is revealed on release
    const fogAlphaAt = (fx, fy) =>
      js(`(() => { const c = document.querySelector('canvas[aria-label="Fog of war"]');
        return c.getContext('2d').getImageData(Math.round(c.width * ${fx}), Math.round(c.height * ${fy}), 1, 1).data[3]; })()`);
    await press('l');
    await sleep(200);
    check(
      'L switches the Fog tool to the lasso',
      (await js(
        `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Lasso').getAttribute('aria-pressed')`,
      )) === 'true',
    );
    const area =
      await js(`(() => { const r = document.querySelector('canvas[aria-label="Fog of war"]').getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
    const at = (fx, fy) => ({ x: area.x + area.w * fx, y: area.y + area.h * fy });
    check('the area starts fogged', (await fogAlphaAt(0.75, 0.75)) > 0 && (await fogAlphaAt(0.95, 0.95)) > 0);
    const playerBeforeShape = await playerFog();
    const corners = [at(0.65, 0.65), at(0.85, 0.65), at(0.85, 0.85), at(0.65, 0.85)];
    mouse('mouseDown', corners[0].x, corners[0].y);
    for (const [from, to] of [
      [0, 1],
      [1, 2],
      [2, 3],
    ]) {
      for (let i = 1; i <= 6; i++) {
        const a = corners[from];
        const b = corners[to];
        mouse('mouseMove', a.x + ((b.x - a.x) * i) / 6, a.y + ((b.y - a.y) * i) / 6);
        await sleep(15);
      }
    }
    await sleep(300);
    check(
      'a shape changes nothing while it is drawn',
      (await fogAlphaAt(0.75, 0.75)) > 0 && (await playerFog()) === playerBeforeShape,
    );
    mouse('mouseUp', corners[3].x, corners[3].y);
    await sleep(900);
    check('releasing reveals the whole inside', (await fogAlphaAt(0.75, 0.75)) === 0);
    check('outside the shape stays fogged', (await fogAlphaAt(0.95, 0.95)) > 0);
    check('players see the revealed area', (await playerFog()) !== playerBeforeShape);
    await press('z', { ctrlKey: true });
    await sleep(900);
    check('one undo removes the shape', (await fogAlphaAt(0.75, 0.75)) > 0);
    await press('l');
    await sleep(100);

    // Snapshots are encoded in the background: an undo pressed while the last
    // change is still encoding must undo that change, not the one before
    const fogBeforeCover = fogHash();
    await clickText('Fill');
    await sleep(200);
    await js(`(() => {
      [...document.querySelectorAll('[role="menu"] button')].find((b) => b.textContent.trim() === 'Cover entire map').click();
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true }));
    })()`);
    await sleep(1200);
    check('an undo pressed while a change is encoding undoes that change', fogHash() === fogBeforeCover);
    check(
      'and redo brings it back',
      await (async () => {
        await press('z', { ctrlKey: true, shiftKey: true });
        await sleep(900);
        return (await fogAlphaAt(0.75, 0.75)) > 0 && fogHash() !== fogBeforeCover;
      })(),
    );
    await press('z', { ctrlKey: true });
    await sleep(900);

    // Alt + wheel zooms the DM view only, around the pointer, in any tool
    const fogRect = () =>
      js(`(() => { const r = document.querySelector('canvas[aria-label="Fog of war"]').getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
    const fitRect = await fogRect();
    const pointer = { x: fitRect.x + fitRect.w * 0.3, y: fitRect.y + fitRect.h * 0.6 };
    const playerZoomBefore = await zoomText();
    await js(`document.querySelector('canvas[aria-label="Fog of war"]').dispatchEvent(new WheelEvent('wheel',
      { deltaY: -400, altKey: true, clientX: ${pointer.x}, clientY: ${pointer.y}, bubbles: true, cancelable: true }))`);
    await sleep(300);
    const zoomedRect = await fogRect();
    check('Alt + wheel zooms the DM view', zoomedRect.w > fitRect.w * 1.5, `${fitRect.w} → ${zoomedRect.w}`);
    check(
      'the spot under the pointer stays put',
      Math.abs((pointer.x - zoomedRect.x) / zoomedRect.w - 0.3) < 0.01 &&
        Math.abs((pointer.y - zoomedRect.y) / zoomedRect.h - 0.6) < 0.01,
    );
    check('the player zoom is unchanged', (await zoomText()) === playerZoomBefore);
    await js(
      `[...document.querySelectorAll("button")].find((b) => b.title.startsWith("DM view only")).click()`,
    );
    await sleep(300);
    check('the zoom badge fits the map again', (await fogRect()).w === fitRect.w);

    // Fog tool: Ctrl + wheel (and pinch) zooms the DM view, the plain wheel
    // sets the brush size, [ and ] too, + and − zoom the player view
    const brush = () => js(`Number(document.querySelector('input[type="range"]').value)`);
    const wheelAt = (point, init) =>
      js(`document.querySelector('canvas[aria-label="Fog of war"]').dispatchEvent(new WheelEvent('wheel',
        { clientX: ${point.x}, clientY: ${point.y}, bubbles: true, cancelable: true, ...${JSON.stringify(init)} }))`);
    const brushBefore = await brush();
    await wheelAt(pointer, { deltaY: -400, ctrlKey: true });
    await sleep(300);
    check('Ctrl + wheel zooms the DM view', (await fogRect()).w > fitRect.w * 1.5);
    check('Ctrl + wheel leaves the brush alone', (await brush()) === brushBefore);
    await press('0', { ctrlKey: true });
    await sleep(300);
    check('Ctrl+0 fits the map', (await fogRect()).w === fitRect.w);
    await wheelAt(pointer, { deltaY: -100 });
    await sleep(200);
    check(
      'the plain wheel grows the brush',
      (await brush()) > brushBefore,
      `${brushBefore} → ${await brush()}`,
    );
    await press('[');
    await sleep(200);
    check('[ shrinks the brush', (await brush()) === brushBefore);
    await press('+');
    await sleep(200);
    check('+ zooms the player view', (await zoomText()) !== playerZoomBefore);
    await press('-');
    await sleep(200);
    check('− zooms it back', (await zoomText()) === playerZoomBefore);

    // Space + drag pans a zoomed DM view
    await wheelAt(pointer, { deltaY: -400, ctrlKey: true });
    await sleep(300);
    const zoomedStart = await fogRect();
    await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }))`);
    await sleep(100);
    await drag(pointer, 80, 0);
    await js(`window.dispatchEvent(new KeyboardEvent('keyup', { key: ' ' }))`);
    await sleep(300);
    check('Space + drag pans the zoomed view', Math.abs((await fogRect()).x - zoomedStart.x - 80) < 2);
    await press('0', { ctrlKey: true });
    await sleep(300);

    // View tool: the wheel over the player frame zooms the player view
    await press('v');
    await sleep(100);
    const frameCenter = await centerOf('[aria-label="Player view"]');
    await wheelAt(frameCenter, { deltaY: -100 });
    await sleep(200);
    check('the wheel over the frame zooms the player view', (await zoomText()) !== playerZoomBefore);
    await press('-');
    await sleep(900);
    await press('f');
    await sleep(100);

    // Effects tool: nothing is allocated until the first stroke; painting saves
    // a layer and shows it on the player screen, undo frees it again
    const effectsFile = path.join(libraryDir, 'm_alpha', 'effects.png');
    const dmEffectsWidth = () => js(`document.querySelectorAll('canvas')[0].width`);
    const playerEffectsWidth = () => js(`document.querySelectorAll('canvas')[0].width`, player);
    check(
      'the effect layer starts unallocated',
      (await dmEffectsWidth()) === 0 && !fs.existsSync(effectsFile),
    );
    await press('e');
    await sleep(100);
    await drag({ x: canvas.x - 40, y: canvas.y + 20 }, 80, 0);
    await sleep(900);
    check('painting an effect saves the layer', fs.existsSync(effectsFile));
    check('the player screen shows the effect', (await playerEffectsWidth()) > 0);
    check('effects leave the fog alone', fogHash() === fogAfter);
    await press('z', { ctrlKey: true });
    await sleep(900);
    check(
      'undo in the Effects tool removes the effect',
      !fs.existsSync(effectsFile) && (await dmEffectsWidth()) === 0 && (await playerEffectsWidth()) === 0,
    );
    check('undo in the Effects tool leaves the fog alone', fogHash() === fogAfter);

    // Spell areas have their own tool, which keeps the mouse pointer
    await press('s');
    await sleep(100);
    check(
      'the Shapes tool keeps the mouse pointer over the map',
      (await js(
        `document.querySelector('canvas[aria-label="Fog of war"]').classList.contains('cursor-none')`,
      )) === false,
    );

    // Circles: "Circle" without a grid starts measuring; two clicks and Save
    // store the grid, then a circle can be placed, resized and deleted
    const alpha = () => readIndex().maps.find((m) => m.id === 'm_alpha');
    await addArea('Circle');
    await sleep(200);
    const shapeNote = await js(`(() => {
      const note = document.querySelector('[role="dialog"][aria-label="Add a shape"]');
      const button = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Circle');
      if (!note) return null;
      const n = note.getBoundingClientRect(), b = button.getBoundingClientRect();
      return { below: n.top >= b.bottom && n.top - b.bottom < 12 && n.left < b.right && n.right > b.left, text: note.textContent };
    })()`);
    check(
      'a shape on a map without a grid: a note right beneath its button says so',
      !!shapeNote?.below && shapeNote.text.includes('Measure grid'),
      JSON.stringify(shapeNote),
    );
    await clickText('Measure grid');
    await sleep(300);
    check(
      'its Measure grid button starts measuring',
      (await js(`!!document.querySelector('[aria-label="Grid calibration"]')`)) === true,
    );
    for (const point of [canvas, { x: canvas.x + 60, y: canvas.y + 60 }]) {
      mouse('mouseDown', point.x, point.y);
      mouse('mouseUp', point.x, point.y);
      await sleep(150);
    }
    // Pressed with the mouse, so its message shows right beneath it
    const saveButton = await js(`(() => {
      const r = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Save grid').getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, left: r.left, bottom: r.bottom };
    })()`);
    mouse('mouseDown', saveButton.x, saveButton.y);
    mouse('mouseUp', saveButton.x, saveButton.y);
    await sleep(900);
    check('measuring saves the grid', alpha().grid?.cell > 0, JSON.stringify(alpha().grid));
    const savedToast = await js(`(() => {
      const toast = [...document.querySelectorAll('[role="status"] > div')].find((t) => t.textContent === 'Grid saved for this map');
      if (!toast) return null;
      const r = toast.getBoundingClientRect();
      return { top: r.top, left: r.left, right: r.right };
    })()`);
    check(
      'a message shows right beneath the button that was pressed',
      !!savedToast &&
        Math.abs(savedToast.top - (saveButton.bottom + 6)) < 3 &&
        savedToast.left <= saveButton.left + 1 &&
        savedToast.right > saveButton.left,
      JSON.stringify({ toast: savedToast, button: saveButton }),
    );
    check(
      'saving the grid adds the 15 ft circle that was asked for',
      alpha().circles.length === 1 && alpha().circles[0].radiusFt === 15,
      JSON.stringify(alpha().circles),
    );
    check(
      'the player screen draws the circle',
      (await js(`document.querySelectorAll('svg circle').length`, player)) >= 1,
    );
    await press('e');
    await sleep(200);
    check(
      'the Effects tool only paints: area dots are not in its way',
      (await js(`!!document.querySelector('button[aria-label^="Circle,"]')`)) === false,
    );
    await press('s');
    await sleep(200);
    const circleDot = await centerOf('button[aria-label^="Circle,"]');
    mouse('mouseDown', circleDot.x, circleDot.y);
    mouse('mouseUp', circleDot.x, circleDot.y);
    await sleep(200);
    await clickText('Poison');
    await sleep(900);
    check(
      'a colour picked in the Shapes tool recolours the selected shape',
      alpha().circles[0]?.kind === 'poison',
      JSON.stringify(alpha().circles[0]),
    );
    await js(`(() => {
      const handle = document.querySelector('button[aria-label^="Circle,"]');
      const r = handle.getBoundingClientRect();
      handle.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, clientX: r.x + 8, clientY: r.y + 8, bubbles: true, cancelable: true }));
    })()`);
    await sleep(900);
    check('one wheel notch grows the circle by 5 ft', alpha().circles[0]?.radiusFt === 20);
    check(
      'the DM sees the radius',
      (await js(`document.querySelector('button[aria-label^="Circle,"]').getAttribute('aria-label')`)) ===
        'Circle, 20 ft',
    );
    // Typing a radius, arrow nudges, Ctrl+D and Alt + drag
    await js(`(() => {
      const input = document.querySelector('input[aria-label="Radius in feet"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '17');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await sleep(900);
    check('a typed radius is applied', alpha().circles[0]?.radiusFt === 17);
    const cell = alpha().grid.cell;
    const beforeNudge = alpha().circles[0];
    await press('ArrowRight');
    await sleep(900);
    check(
      'an arrow key moves the circle one square',
      Math.abs(alpha().circles[0].x - beforeNudge.x - cell) < 0.01 && alpha().circles[0].y === beforeNudge.y,
    );
    await press('d', { ctrlKey: true });
    await sleep(900);
    check('Ctrl+D duplicates the circle', alpha().circles.length === 2);
    await press('Delete');
    await sleep(900);
    const altFrom = await centerOf('button[aria-label^="Circle,"]');
    main.webContents.sendInputEvent({
      type: 'mouseDown',
      x: Math.round(altFrom.x),
      y: Math.round(altFrom.y),
      button: 'left',
      clickCount: 1,
      modifiers: ['alt', 'leftButtonDown'],
    });
    for (let i = 1; i <= 4; i++) {
      main.webContents.sendInputEvent({
        type: 'mouseMove',
        x: Math.round(altFrom.x + i * 30),
        y: Math.round(altFrom.y),
        button: 'left',
        modifiers: ['alt', 'leftButtonDown'],
      });
      await sleep(30);
    }
    main.webContents.sendInputEvent({
      type: 'mouseUp',
      x: Math.round(altFrom.x + 120),
      y: Math.round(altFrom.y),
      button: 'left',
      clickCount: 1,
    });
    await sleep(900);
    check(
      'Alt + drag leaves a copy behind',
      alpha().circles.length === 2 && alpha().circles.some((c) => c.x === beforeNudge.x + cell),
      JSON.stringify(alpha().circles),
    );
    await press('Delete');
    await sleep(900);

    // A dragged circle stays put for players until it is dropped
    const playerCircleX = () => js(`document.querySelector('svg circle').getAttribute('cx')`, player);
    const circleXBefore = await playerCircleX();
    const handle = await centerOf('button[aria-label^="Circle,"]');
    mouse('mouseDown', handle.x, handle.y);
    await sleep(100);
    const statesBeforeMoves = playerStates;
    for (let i = 1; i <= 5; i++) {
      mouse('mouseMove', handle.x + i * 30, handle.y);
      await sleep(30);
    }
    await sleep(400);
    check('players don’t see a circle being dragged', (await playerCircleX()) === circleXBefore);
    check(
      'and nothing is sent to the player screen meanwhile',
      playerStates === statesBeforeMoves,
      `${playerStates - statesBeforeMoves} updates`,
    );
    mouse('mouseUp', handle.x + 150, handle.y);
    await sleep(400);
    check('players see the circle where it is dropped', (await playerCircleX()) !== circleXBefore);
    await press('Delete');
    await sleep(900);
    check('Delete removes the selected circle', alpha().circles.length === 0);
    check(
      'the player screen drops it',
      (await js(`document.querySelectorAll('svg circle').length`, player)) === 0,
    );

    // Cones aim and stretch with the handle at their tip; a line's width follows the wheel
    await addArea('Cone');
    await sleep(900);
    const cone = alpha().circles[0];
    check(
      'a 15 ft cone is added, pointing right',
      cone?.shape === 'cone' && cone.radiusFt === 15 && cone.angle === 0,
      JSON.stringify(cone),
    );
    check('players see the cone', (await js(`document.querySelectorAll('svg polygon').length`, player)) >= 1);
    const aimFrom = await centerOf('button[aria-label="Aim the cone"]');
    const coneDot = await centerOf('button[aria-label^="Cone,"]');
    mouse('mouseDown', aimFrom.x, aimFrom.y);
    for (let i = 1; i <= 5; i++) {
      // Swing the tip to straight below the origin, twice as far away
      const t = i / 5;
      mouse(
        'mouseMove',
        aimFrom.x + (coneDot.x - aimFrom.x) * t,
        aimFrom.y + (coneDot.y + 2 * (aimFrom.x - coneDot.x) - aimFrom.y) * t,
      );
      await sleep(30);
    }
    mouse('mouseUp', coneDot.x, coneDot.y + 2 * (aimFrom.x - coneDot.x));
    await sleep(900);
    const aimed = alpha().circles[0];
    check('dragging the tip aims the cone', Math.abs(aimed.angle - 90) < 1, `${aimed.angle}°`);
    check('and sets its length in 5 ft steps', aimed.radiusFt === 30, `${aimed.radiusFt} ft`);
    await press('Delete');
    await sleep(300);
    await addArea('Line');
    await sleep(600);
    const lineDot = await centerOf('button[aria-label^="Line,"]');
    await js(`document.querySelector('canvas[aria-label="Fog of war"]').dispatchEvent(new WheelEvent('wheel',
      { deltaY: -100, clientX: ${lineDot.x + 20}, clientY: ${lineDot.y}, bubbles: true, cancelable: true }))`);
    await sleep(900);
    const line = alpha().circles[0];
    check(
      'the wheel over a line widens it',
      line?.shape === 'line' && line.widthFt === 10 && line.radiusFt === 30,
      JSON.stringify(line),
    );
    check(
      'the DM sees the line size',
      (await js(`document.querySelector('button[aria-label^="Line,"]').getAttribute('aria-label')`)) ===
        'Line, 30 × 10 ft',
    );
    await press('Delete');
    await sleep(600);
    await addArea('Square');
    await sleep(600);
    const turnSquare = async (dx, dy) => {
      const from = await centerOf('button[aria-label="Turn the square"]');
      const centre = await centerOf('button[aria-label^="Square,"]');
      const to = { x: centre.x + dx * (from.x - centre.x), y: centre.y + dy * (from.x - centre.x) };
      mouse('mouseDown', from.x, from.y);
      for (let i = 1; i <= 5; i++) {
        mouse('mouseMove', from.x + ((to.x - from.x) * i) / 5, from.y + ((to.y - from.y) * i) / 5);
        await sleep(30);
      }
      mouse('mouseUp', to.x, to.y);
      await sleep(900);
      return alpha().circles[0];
    };
    const turned = await turnSquare(1, 1);
    check(
      'dragging the handle turns the square, keeping its size',
      turned?.shape === 'square' && Math.abs(turned.angle - 45) < 1 && turned.radiusFt === 10,
      JSON.stringify(turned),
    );
    const settled = await turnSquare(1, 0.05);
    check('near a right angle the square settles onto the grid', settled?.angle === 0, `${settled?.angle}°`);
    await press('Delete');
    await sleep(600);
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
    // True scale: the map's squares come out at the set grid size on the
    // player screen (27 inches diagonal, 1-inch squares here)
    const screen = await js(
      `(() => { const m = document.querySelector('main'); return { w: m.clientWidth, h: m.clientHeight }; })()`,
      player,
    );
    const aspect = screen.w / screen.h;
    const pixelsPerInch = screen.w / ((27 * aspect) / Math.sqrt(aspect * aspect + 1));
    const trueScaleButton = `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'True scale')`;
    check(
      'True scale is ready once the screen size is set',
      (await js(`${trueScaleButton}.disabled`)) === false,
    );
    // Beta has no grid: the note beneath True scale offers to measure it,
    // and true scale follows the save
    await clickText('True scale');
    await sleep(200);
    check(
      'on a map without a grid, the note beneath True scale says so',
      (
        await js(`document.querySelector('[role="dialog"][aria-label="True scale"]')?.textContent ?? ''`)
      ).includes('Measure grid'),
    );
    await clickText('Measure grid');
    await sleep(300);
    check(
      'its Measure grid button starts measuring',
      (await js(`!!document.querySelector('[aria-label="Grid calibration"]')`)) === true,
    );
    const betaCentre = await centerOf('canvas[aria-label="Fog of war"]');
    for (const point of [betaCentre, { x: betaCentre.x + 60, y: betaCentre.y + 60 }]) {
      mouse('mouseDown', point.x, point.y);
      mouse('mouseUp', point.x, point.y);
      await sleep(150);
    }
    await clickText('Save grid');
    await sleep(900);
    const beta = readIndex().maps.find((m) => m.id === 'm_beta');
    check(
      'and zooms to true scale once the grid is saved',
      !!beta.grid && Math.abs(beta.zoom / (pixelsPerInch / beta.grid.cell) - 1) < 1e-6,
      JSON.stringify({ zoom: beta.zoom, grid: beta.grid }),
    );
    await loadMap('Alpha');
    await sleep(1200);
    check('switching back restores the latest zoom', (await zoomText()) === '150', `${await zoomText()}%`);
    const diskZoom = readIndex().maps.find((m) => m.id === 'm_alpha').zoom;
    check('the change was flushed to disk on switch', Math.abs(diskZoom - 1.5) < 0.01, String(diskZoom));

    // True scale on a map with a grid applies straight away
    const trueZoom = pixelsPerInch / readIndex().maps.find((m) => m.id === 'm_alpha').grid.cell;
    await clickText('True scale');
    await sleep(900);
    const scaledZoom = readIndex().maps.find((m) => m.id === 'm_alpha').zoom;
    check(
      'True scale zooms so one map square is one inch on the player screen',
      Math.abs(scaledZoom / trueZoom - 1) < 1e-6,
      `${scaledZoom} for ${trueZoom}`,
    );
    check(
      'and the button shows the view is at true scale',
      (await js(`${trueScaleButton}.getAttribute('aria-pressed')`)) === 'true',
    );

    // Orientation lives in the map's menu, and works for maps that aren't loaded
    await click('[aria-label="Options for Beta"]');
    await sleep(200);
    await clickText('Rotate right');
    await sleep(600);
    check(
      'rotating a map from its menu is saved',
      readIndex().maps.find((m) => m.id === 'm_beta').rotation === 90,
    );

    // A BMP handout has no thumbnail (the main process can't decode BMP): the DM window draws one
    const greyThumb = path.join(libraryDir, 'handouts', 'h_grey', 'thumb.png');
    const tab = (name) =>
      js(
        `[...document.querySelectorAll('[role="tab"]')].find((t) => t.textContent.startsWith('${name}')).click()`,
      );
    check('a BMP handout starts without a thumbnail', !fs.existsSync(greyThumb));
    await tab('Handouts');
    await sleep(1500);
    check(
      'the DM window draws it one, and it is kept',
      fs.existsSync(greyThumb) && (await js(`!!document.querySelector('[aria-label="Handouts"] img')`)),
    );
    await tab('Maps');
    await sleep(300);

    // Player screen setup: new maps and handouts taller than wide can be turned
    await click('[aria-label="Settings"]');
    await sleep(200);
    await clickText('Player screen setup…');
    await sleep(300);
    await clickText('Rotate right');
    await clickText('Save');
    await sleep(600);
    check(
      'player screen setup saves how new portrait maps and handouts are turned',
      readIndex().settings.portraitRotation === 90,
      JSON.stringify(readIndex().settings),
    );

    // In a confirmation dialog, keyboard focus stays where it is moved to
    const focusedText = () => js(`document.activeElement?.textContent.trim() ?? ''`);
    const key = (type, keyCode, modifiers = []) =>
      main.webContents.sendInputEvent({ type, keyCode, modifiers });
    await click('[aria-label="Options for Beta"]');
    await sleep(200);
    await clickText('Remove…');
    await sleep(400);
    check('the remove dialog opens on its Remove button', (await focusedText()) === 'Remove');
    key('keyDown', 'Shift');
    key('keyDown', 'Tab', ['shift']);
    key('keyUp', 'Tab', ['shift']);
    key('keyUp', 'Shift');
    await sleep(300);
    check(
      'Shift+Tab moves the focus to Cancel, and it stays there',
      (await focusedText()) === 'Cancel',
      await focusedText(),
    );
    key('keyDown', 'Escape');
    key('keyUp', 'Escape');
    await sleep(300);
    check('Escape closes the dialog', !(await js(`!!document.querySelector('[role="dialog"]')`)));
    check(
      'without removing anything',
      readIndex().maps.some((m) => m.id === 'm_beta'),
    );

    // Removing the loaded map unloads it in both windows, deletes it and loads the next
    await click('[aria-label="Options for Alpha"]');
    await sleep(200);
    await clickText('Remove…');
    await sleep(300);
    await js(
      `[...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent.trim() === 'Remove').click()`,
    );
    await sleep(2000);
    check(
      'removing the loaded map deletes it',
      !readIndex().maps.some((m) => m.id === 'm_alpha') && !fs.existsSync(path.join(libraryDir, 'm_alpha')),
    );
    check('and loads the next one', readIndex().settings.currentMapId === 'm_beta');

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
  // Best effort: on Windows the GPU process can still hold its cache files here,
  // and a throw at this point would skip app.exit and leave the windows open
  try {
    fs.rmSync(userData, { recursive: true, force: true, maxRetries: 3 });
  } catch (err) {
    console.warn(`Couldn’t remove ${userData}: ${err.code ?? err}`);
  }
  app.exit(passed === results.length ? 0 : 1);
});

// Tests for the on-disk map library (electron/library.ts).
//
// Runs inside Electron because the library uses app.getPath and nativeImage.
// `npm test` bundles library.ts with esbuild first, then runs this file:
//
//   npm test                 (Linux CI: xvfb-run -a npm test)
//
// Each run uses a scratch userData directory, so your real library is untouched.

import { app, nativeImage } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import yauzl from 'yauzl';
import yazl from 'yazl';
import Ajv2020 from 'ajv/dist/2020.js';

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  const line = `${name}${detail ? ` — ${detail}` : ''}`;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${line}`);
  // On GitHub, a failed check is also named in the run's summary
  if (!pass && process.env.GITHUB_ACTIONS) {
    console.log(`::error title=Library test failed::${line.replace(/%/g, '%25').replace(/\r?\n/g, '%0A')}`);
  }
};

const exists = (p) =>
  fs.access(p).then(
    () => true,
    () => false,
  );

/** A solid-colour PNG, or a fog mask that is opaque on the left half. */
function makePng({ width = 64, height = 64, rgb = [0, 0, 0], leftHalfOnly = false } = {}) {
  const raw = Buffer.alloc(4 * width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      raw[i] = rgb[2];
      raw[i + 1] = rgb[1];
      raw[i + 2] = rgb[0]; // BGRA
      raw[i + 3] = leftHalfOnly && x >= width / 2 ? 0 : 255;
    }
  }
  return nativeImage.createFromBitmap(raw, { width, height }).toPNG();
}

app.whenReady().then(async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'minivtt-test-'));
  app.setPath('userData', tmp);
  const lib = await import('../dist-electron/library.test.mjs');
  const gridLib = await import('../dist-electron/grid.test.mjs');
  const videoLib = await import('../dist-electron/video.test.mjs');
  const saveLib = await import('../dist-electron/delayedSave.test.mjs');
  const areasLib = await import('../dist-electron/areas.test.mjs');
  const geometryLib = await import('../dist-electron/geometry.test.mjs');
  const shortcutsLib = await import('../dist-electron/shortcuts.test.mjs');
  const fixtures = path.join(tmp, 'fixtures');
  await fs.mkdir(fixtures, { recursive: true });
  const fixture = async (name, bytes) => {
    const p = path.join(fixtures, name);
    await fs.writeFile(p, bytes);
    return p;
  };

  try {
    // ── Import ───────────────────────────────────────────────────────────────
    const a = await lib.addMap(await fixture('alpha.png', makePng({ rgb: [40, 80, 160] })));
    check('addImage returns an entry', !!a, a ? `id=${a.id}` : 'null');
    check('dimensions are read', a.width === 64 && a.height === 64, `${a.width}x${a.height}`);
    check('name comes from the filename', a.name === 'alpha', a.name);
    check('a thumbnail is generated', await exists(path.join(tmp, 'library', a.id, 'thumb.png')));
    check('defaults: zoom 1, no fog', a.zoom === 1 && a.hasFog === false);

    const b = await lib.addMap(await fixture('beta.png', makePng({ rgb: [30, 110, 60] })));
    check('ids are unique', a.id !== b.id);
    check(
      'rejects files that are not images',
      (await lib.addMap(await fixture('notes.png', 'definitely not an image'))) === null,
    );

    const snap = await lib.loadSnapshot();
    check(
      'snapshot lists both maps, newest first',
      snap.maps.length === 2 && snap.maps[0].id === b.id,
      `got ${snap.maps.length}`,
    );
    // Which map is loaded is the DM window's to say: adding maps leaves it alone
    check('adding maps doesn’t change the current map', snap.settings.currentMapId === null);
    check('image file resolves on disk', !!(await lib.resolveMapMediaPath(a.id)));
    check('thumbnail reloads', !!(await lib.loadMapThumb(a.id))?.startsWith('data:image/png'));

    // ── Fog ──────────────────────────────────────────────────────────────────
    const fogUrl = `data:image/png;base64,${makePng({ rgb: [9, 9, 11], leftHalfOnly: true }).toString('base64')}`;
    check('saveMapFog succeeds', (await lib.saveMapFog(a.id, fogUrl)) === true);
    const fogBack = await lib.loadMapFog(a.id);
    const bitmap = nativeImage.createFromBuffer(Buffer.from(fogBack.split(',')[1], 'base64')).toBitmap();
    let opaqueLeft = 0;
    let clearRight = 0;
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) {
        const alpha = bitmap[(y * 64 + x) * 4 + 3];
        if (x < 32 && alpha === 255) opaqueLeft++;
        if (x >= 32 && alpha === 0) clearRight++;
      }
    }
    check(
      'fog mask round-trips losslessly',
      opaqueLeft === 2048 && clearRight === 2048,
      `${opaqueLeft}/${clearRight}`,
    );
    check('hasFog flag is set', (await lib.loadSnapshot()).maps.find((m) => m.id === a.id).hasFog === true);
    check(
      'saveMapFog rejects data that is not a PNG',
      (await lib.saveMapFog(a.id, 'data:image/png;base64,aGVsbG8=')) === false,
    );

    // A fog file cut short (a crash or power loss while it was written) would
    // show part of the map revealed: it is treated as unreadable instead
    const fogBytes = Buffer.from(fogUrl.split(',')[1], 'base64');
    const fogFile = path.join(tmp, 'library', a.id, 'fog.png');
    check(
      'saveMapFog rejects a PNG cut short',
      (await lib.saveMapFog(
        a.id,
        `data:image/png;base64,${fogBytes.subarray(0, -20).toString('base64')}`,
      )) === false,
    );
    check(
      'saving fog leaves no temporary file behind',
      (await fs.readdir(path.join(tmp, 'library', a.id))).every((name) => !name.endsWith('.tmp')),
    );
    await fs.writeFile(fogFile, fogBytes.subarray(0, Math.floor(fogBytes.length / 2)));
    check('a fog file cut short loads as no fog', (await lib.loadMapFog(a.id)) === null);
    const zeroTail = Buffer.from(fogBytes);
    zeroTail.fill(0, Math.floor(zeroTail.length / 2));
    await fs.writeFile(fogFile, zeroTail);
    check('a fog file ending in zeros loads as no fog', (await lib.loadMapFog(a.id)) === null);
    await lib.saveMapFog(a.id, fogUrl);
    check('a complete fog file loads again', (await lib.loadMapFog(a.id)) === fogUrl);

    // ── Delayed saves ────────────────────────────────────────────────────────
    {
      const writes = [];
      let release;
      let running = 0;
      let overlapped = false;
      const saver = saveLib.delayedMapSave(
        'test',
        async (mapId, value) => {
          running += 1;
          if (running > 1) overlapped = true;
          await new Promise((resolve) => (release = resolve));
          writes.push(`${mapId}:${value}`);
          running -= 1;
          return true;
        },
        20,
      );
      saver.schedule('m1', 'a');
      await new Promise((resolve) => setTimeout(resolve, 60)); // the timer fires: 'a' is being written
      check('a save being written counts as busy', saver.isBusy() === true);
      let flushed = false;
      const flushing = saver.flushFor('m1').then(() => (flushed = true));
      await new Promise((resolve) => setTimeout(resolve, 20));
      check('flushFor waits for a save already being written', flushed === false);
      saver.schedule('m1', 'b');
      void saver.flush();
      release();
      await new Promise((resolve) => setTimeout(resolve, 10));
      release();
      await flushing;
      await saver.flush();
      check('saves are written in order, never two at once', writes.join() === 'm1:a,m1:b' && !overlapped);
      check('and the saver is idle once they are done', saver.isBusy() === false);
    }

    // ── View state ───────────────────────────────────────────────────────────
    await lib.saveMapView(a.id, {
      zoom: 2.5,
      pan: { x: 123, y: 456 },
      rotation: 450,
      mirrorHorizontal: true,
      mirrorVertical: false,
    });
    let aMeta = (await lib.loadSnapshot()).maps.find((m) => m.id === a.id);
    check('zoom and pan persist', aMeta.zoom === 2.5 && aMeta.pan.x === 123 && aMeta.pan.y === 456);
    check('rotation is normalised to 0-359', aMeta.rotation === 90, String(aMeta.rotation));
    check('mirroring persists', aMeta.mirrorHorizontal === true && aMeta.mirrorVertical === false);
    await lib.saveMapView(a.id, {
      zoom: 3,
      pan: null,
      rotation: 0,
      mirrorHorizontal: false,
      mirrorVertical: false,
    });
    aMeta = (await lib.loadSnapshot()).maps.find((m) => m.id === a.id);
    check(
      'a null pan keeps the saved pan',
      aMeta.zoom === 3 && aMeta.pan.x === 123,
      JSON.stringify(aMeta.pan),
    );
    check(
      'rejects a non-finite zoom',
      (await lib.saveMapView(a.id, {
        zoom: NaN,
        pan: null,
        rotation: 0,
        mirrorHorizontal: false,
        mirrorVertical: false,
      })) === false,
    );
    check(
      "other maps' view state is untouched",
      (await lib.loadSnapshot()).maps.find((m) => m.id === b.id).zoom === 1,
    );

    // ── Concurrent writes (regression: saves used to overwrite each other) ──
    await Promise.all([
      lib.saveMapView(a.id, {
        zoom: 4,
        pan: { x: 1, y: 2 },
        rotation: 180,
        mirrorHorizontal: false,
        mirrorVertical: true,
      }),
      lib.saveSettings({ currentMapId: a.id }),
      lib.saveSettings({ playerScreenDiagonal: 32, gridSize: 2 }),
      lib.renameMap(b.id, 'Renamed concurrently'),
      lib.saveMapFog(b.id, fogUrl),
    ]);
    const conc = await lib.loadSnapshot();
    const concA = conc.maps.find((m) => m.id === a.id);
    const concB = conc.maps.find((m) => m.id === b.id);
    check('concurrent: view state kept', concA.zoom === 4 && concA.rotation === 180 && concA.mirrorVertical);
    check(
      'concurrent: both settings patches kept',
      conc.settings.currentMapId === a.id && conc.settings.playerScreenDiagonal === 32,
    );
    check('concurrent: rename kept', concB.name === 'Renamed concurrently', concB.name);
    check('concurrent: fog flag kept', concB.hasFog === true);
    const leftovers = (await fs.readdir(path.join(tmp, 'library'))).filter((f) => f.endsWith('.tmp'));
    check('no temp files left behind', leftovers.length === 0, leftovers.join(', '));

    // ── Settings whitelist ───────────────────────────────────────────────────
    await lib.saveSettings({ gridSize: 5, mapOrder: ['bogus'], somethingElse: 1 });
    const settings = (await lib.loadSnapshot()).settings;
    check('known settings are saved', settings.gridSize === 5);
    check('rejects a non-positive grid size', (await lib.saveSettings({ gridSize: -1 })) === false);
    await lib.saveSettings({ playerScreenDiagonal: null });
    check(
      'the screen diagonal can be cleared',
      (await lib.loadSnapshot()).settings.playerScreenDiagonal === null,
    );
    check('unknown keys and mapOrder are ignored', !('somethingElse' in settings) && !settings.mapOrder);
    check('rejects an unsafe currentMapId', (await lib.saveSettings({ currentMapId: '../evil' })) === false);
    {
      const before = (await lib.loadSnapshot()).settings;
      const saved = await lib.saveSettings({
        playerScreenDiagonal: '43',
        frameColor: 'plaid',
        lockZoom: 'yes',
        mapOrder: ['m_x'],
        somethingElse: 1,
      });
      const after = (await lib.loadSnapshot()).settings;
      check(
        'a settings change keeps only valid values, numbers as numbers',
        saved === true &&
          after.playerScreenDiagonal === 43 &&
          after.frameColor === before.frameColor &&
          after.lockZoom === before.lockZoom &&
          JSON.stringify(after.mapOrder) === JSON.stringify(before.mapOrder) &&
          !('somethingElse' in after),
        JSON.stringify(after),
      );
      check(
        'a change with nothing valid in it is refused',
        (await lib.saveSettings({ portraitRotation: 45, showLibrary: 'no' })) === false,
      );
      await lib.saveSettings({ playerScreenDiagonal: before.playerScreenDiagonal });
    }

    // ── Rename and reorder ───────────────────────────────────────────────────
    check('rename rejects a blank name', (await lib.renameMap(a.id, '   ')) === false);
    check('reorder accepts a full permutation', (await lib.reorderMaps([a.id, b.id])) === true);
    check('reorder is applied', (await lib.loadSnapshot()).maps[0].id === a.id);
    check('reorder rejects a partial list', (await lib.reorderMaps([a.id])) === false);

    // ── Path traversal guards ────────────────────────────────────────────────
    check(
      'traversal id rejected by resolveMapMediaPath',
      (await lib.resolveMapMediaPath('../../evil')) === null,
    );
    check('traversal id rejected by saveMapFog', (await lib.saveMapFog('../evil', fogUrl)) === false);
    check('traversal id rejected by removeMap', (await lib.removeMap('../../evil')) === false);

    // ── Delete ───────────────────────────────────────────────────────────────
    const aDir = path.join(tmp, 'library', a.id);
    check('map folder exists before delete', await exists(path.join(aDir, 'fog.png')));
    check('removeMap succeeds', (await lib.removeMap(a.id)) === true);
    check('map folder is removed', !(await exists(aDir)));
    const afterDelete = await lib.loadSnapshot();
    check('index no longer lists the map', !afterDelete.maps.some((m) => m.id === a.id));
    check('deleted map is pruned from mapOrder', !afterDelete.settings.mapOrder?.includes(a.id));
    check('deleted current map clears currentMapId', afterDelete.settings.currentMapId === null);
    check(
      'a late fog save cannot recreate a deleted map',
      (await lib.saveMapFog(a.id, fogUrl)) === false && !(await exists(aDir)),
    );

    // A folder that can't be set aside (on Windows: its video still open)
    // leaves the map exactly as it was. Something in the way of the rename
    // makes it fail on every platform.
    const stuck = await lib.addMap(await fixture('stuck.png', makePng()));
    const stuckDir = path.join(tmp, 'library', stuck.id);
    const blocker = path.join(tmp, 'library', `.removed-${stuck.id}`);
    await fs.mkdir(path.join(blocker, 'in-the-way'), { recursive: true });
    check('removeMap reports a folder it can’t move', (await lib.removeMap(stuck.id)) === false);
    check(
      'and leaves that map listed, with its files',
      (await lib.loadSnapshot()).maps.some((m) => m.id === stuck.id) &&
        (await exists(path.join(stuckDir, 'image.png'))),
    );
    await fs.rm(blocker, { recursive: true });
    check(
      'it is removed once nothing is in the way',
      (await lib.removeMap(stuck.id)) === true && !(await exists(stuckDir)),
    );

    // ── Leftover folders (cleared at startup) ────────────────────────────────
    const libraryDir = path.join(tmp, 'library');
    const anHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const leftover = async (name, { aged = true } = {}) => {
      const dir = path.join(libraryDir, name);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'image.webm'), 'x');
      if (aged) await fs.utimes(dir, anHourAgo, anHourAgo);
      return dir;
    };
    const setAside = await leftover('.removed-m_gone', { aged: false });
    const unlisted = await leftover('m_unlisted');
    const unlistedHandout = await leftover(path.join('handouts', 'h_unlisted'));
    const importing = await leftover('m_importing', { aged: false });
    const listedDir = path.join(libraryDir, b.id);
    await fs.utimes(listedDir, anHourAgo, anHourAgo);
    await lib.removeLeftovers();
    check('a folder set aside for deletion is deleted', !(await exists(setAside)));
    check(
      'old folders no entry points to are deleted',
      !(await exists(unlisted)) && !(await exists(unlistedHandout)),
    );
    check('a recent one is kept (an import may still be copying)', await exists(importing));
    check('listed maps keep their folders', await exists(path.join(listedDir, 'image.png')));
    await fs.rm(importing, { recursive: true });

    // ── Byte ranges for the media protocol ──────────────────────────────────
    // A video resumes and loops by asking for "the rest from byte N"
    const range = (header, size = 1000) => JSON.stringify(lib.byteRange(header, size));
    check('no Range header: the whole file', range(null) === 'null');
    check('the rest from a byte', range('bytes=400-') === '{"start":400,"end":999}', range('bytes=400-'));
    check('a bounded range', range('bytes=10-19') === '{"start":10,"end":19}');
    check('a range past the end is cut at the end', range('bytes=900-5000') === '{"start":900,"end":999}');
    check(
      'the last bytes',
      range('bytes=-100') === '{"start":900,"end":999}' && range('bytes=-5000') === '{"start":0,"end":999}',
    );
    check(
      'a range starting at or past the end is unsatisfiable',
      range('bytes=1000-') === '"unsatisfiable"' && range('bytes=-0') === '"unsatisfiable"',
    );
    check(
      'anything else is answered with the whole file',
      ['bytes=5-2', 'bytes=0-1,5-6', 'items=0-5', 'bytes=-', 'bytes=99999999999999999999-'].every(
        (header) => range(header) === 'null',
      ),
    );

    // ── Video codecs ─────────────────────────────────────────────────────────
    const webm = (codec) =>
      Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from(`--webm--${codec}--`)]);
    check(
      'the codec is read from a WebM header',
      lib.sniffVideoCodec(webm('V_VP9')) === 'vp9' &&
        lib.sniffVideoCodec(webm('V_AV1')) === 'av1' &&
        lib.sniffVideoCodec(webm('V_VP8')) === 'vp8' &&
        lib.sniffVideoCodec(makePng()) === null,
    );
    const clip = await lib.addMap(await fixture('clip.webm', webm('V_VP9')));
    check(
      'a video map reports its codec',
      clip?.mediaType === 'video' && (await lib.loadVideoCodec(clip.id)) === 'vp9',
    );
    check('an image map has none', (await lib.loadVideoCodec(b.id)) === null);
    await lib.removeMap(clip.id);

    // A WebM header with a frame size: EBML elements with one-byte sizes
    const el = (id, ...children) => {
      const payload = Buffer.concat(children.map((child) => Buffer.from(child)));
      return Buffer.concat([Buffer.from(id), Buffer.from([0x80 | payload.length]), payload]);
    };
    const uint16 = (n) => [n >> 8, n & 0xff];
    const webmOfSize = (width, height, { clusterFirst = false } = {}) => {
      const header = el([0x1a, 0x45, 0xdf, 0xa3], el([0x42, 0x82], 'webm'));
      const info = el([0x15, 0x49, 0xa9, 0x66], el([0x2a, 0xd7, 0xb1], [0x0f, 0x42, 0x40]));
      const video = el([0xe0], el([0xb0], uint16(width)), el([0xba], uint16(height)));
      const tracks = el([0x16, 0x54, 0xae, 0x6b], el([0xae], el([0x83], [1]), el([0x86], 'V_VP9'), video));
      const cluster = el([0x1f, 0x43, 0xb6, 0x75], el([0xe7], [0]));
      // A segment of unknown size, as streamed files have
      const segment = Buffer.from([0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
      return Buffer.concat([
        header,
        segment,
        info,
        ...(clusterFirst ? [cluster, tracks] : [tracks, cluster]),
      ]);
    };
    check(
      'a WebM header gives the video’s size',
      JSON.stringify(lib.readVideoSize(webmOfSize(1512, 2664))) ===
        JSON.stringify({ width: 1512, height: 2664 }),
      JSON.stringify(lib.readVideoSize(webmOfSize(1512, 2664))),
    );
    check(
      'but not from past the start of the video data, or from cut-off bytes',
      lib.readVideoSize(webmOfSize(1512, 2664, { clusterFirst: true })) === null &&
        lib.readVideoSize(webmOfSize(1512, 2664).subarray(0, 40)) === null,
    );

    // ── Turning new portrait maps and handouts ───────────────────────────────
    check(
      'new portrait images are turned left by default',
      (await lib.loadSnapshot()).settings.portraitRotation === 270,
    );
    check('only quarter turns are taken', (await lib.saveSettings({ portraitRotation: 45 })) === false);
    await lib.saveSettings({ portraitRotation: 90 });
    const tallMap = await lib.addMap(await fixture('tall.png', makePng({ width: 40, height: 80 })));
    const wideMap = await lib.addMap(await fixture('wide.png', makePng({ width: 80, height: 40 })));
    const squareMap = await lib.addMap(await fixture('square.png', makePng({ width: 64, height: 64 })));
    check('a map taller than wide is turned as it is added', tallMap.rotation === 90);
    check('wide and square maps are not', wideMap.rotation === 0 && squareMap.rotation === 0);
    check(
      'the turn is saved with the map',
      (await lib.loadSnapshot()).maps.find((m) => m.id === tallMap.id)?.rotation === 90,
    );
    const tallVideo = await lib.addMap(await fixture('tall.webm', webmOfSize(1512, 2664)));
    check(
      'a video map gets its size from its header, and is turned too',
      tallVideo.mediaType === 'video' &&
        tallVideo.width === 1512 &&
        tallVideo.height === 2664 &&
        tallVideo.rotation === 90,
      JSON.stringify(tallVideo),
    );
    const tallHandout = await lib.addHandout(
      await fixture('tall-letter.png', makePng({ width: 30, height: 90 })),
    );
    const wideHandout = await lib.addHandout(
      await fixture('wide-letter.png', makePng({ width: 90, height: 30 })),
    );
    check('handouts too', tallHandout.rotation === 90 && wideHandout.rotation === 0);

    // EXIF orientation: a JPEG stored on its side but shown upright
    const exifSegment = (orientation, little = true) => {
      const tiff = Buffer.alloc(26);
      const u16 = (value, at) => (little ? tiff.writeUInt16LE(value, at) : tiff.writeUInt16BE(value, at));
      const u32 = (value, at) => (little ? tiff.writeUInt32LE(value, at) : tiff.writeUInt32BE(value, at));
      tiff.write(little ? 'II' : 'MM', 0, 'latin1');
      u16(42, 2);
      u32(8, 4); // the first directory follows the header
      u16(1, 8); // one entry: Orientation, a short
      u16(0x0112, 10);
      u16(3, 12);
      u32(1, 14);
      u16(orientation, 18);
      const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
      const marker = Buffer.from([0xff, 0xe1, 0, 0]);
      marker.writeUInt16BE(payload.length + 2, 2);
      return Buffer.concat([marker, payload]);
    };
    const jpegStart = (orientation, little) =>
      Buffer.concat([
        Buffer.from([0xff, 0xd8]),
        exifSegment(orientation, little),
        Buffer.from([0xff, 0xda, 0, 2]),
      ]);
    check(
      'the EXIF orientation is read, in either byte order',
      lib.readJpegOrientation(jpegStart(8, true)) === 8 &&
        lib.readJpegOrientation(jpegStart(6, false)) === 6 &&
        lib.readJpegOrientation(Buffer.from([0xff, 0xd8, 0xff, 0xda, 0, 2])) === 1,
    );
    const turns = [2, 3, 4, 5, 6, 7, 8].every((orientation) => {
      // Every stored pixel is used exactly once, whatever the orientation
      const [w, h] = [4, 2];
      const [outW, outH] = orientation >= 5 ? [h, w] : [w, h];
      const used = new Set();
      for (let y = 0; y < outH; y++)
        for (let x = 0; x < outW; x++) {
          const from = lib.orientedSource(orientation, x, y, w, h);
          used.add(`${from.x},${from.y}`);
        }
      return used.size === w * h;
    });
    const at = (orientation, x, y) => JSON.stringify(lib.orientedSource(orientation, x, y, 4, 2));
    check(
      'turning a thumbnail upright takes the right pixels',
      turns &&
        at(6, 0, 0) === '{"x":0,"y":1}' && // turned right: the stored bottom-left becomes the top-left
        at(8, 0, 0) === '{"x":3,"y":0}' && // turned left: the stored top-right does
        at(3, 0, 0) === '{"x":3,"y":1}',
    );
    const sideways = withExif(nativeImage.createFromBuffer(makePng({ width: 80, height: 40 })).toJPEG(90), 8);
    function withExif(jpeg, orientation) {
      return Buffer.concat([jpeg.subarray(0, 2), exifSegment(orientation), jpeg.subarray(2)]);
    }
    const exifMap = await lib.addMap(await fixture('sideways.jpg', sideways));
    const exifThumb = nativeImage.createFromDataURL(await lib.loadMapThumb(exifMap.id)).getSize();
    check(
      'a JPEG stored on its side counts as shown: taller than wide, so turned',
      exifMap.width === 40 && exifMap.height === 80 && exifMap.rotation === 90,
      JSON.stringify({ width: exifMap.width, height: exifMap.height, rotation: exifMap.rotation }),
    );
    check(
      'and its thumbnail is upright',
      exifThumb.width === 40 && exifThumb.height === 80,
      JSON.stringify(exifThumb),
    );

    // GIF, WebP and BMP: sizes from their headers (this process can't decode them)
    const riff = (chunk, body) =>
      Buffer.concat([
        Buffer.from('RIFF'),
        Buffer.alloc(4),
        Buffer.from('WEBP'),
        Buffer.from(chunk),
        Buffer.alloc(4),
        body,
      ]);
    const vp8 = (w, h) => {
      const frame = Buffer.from([0, 0, 0, 0x9d, 0x01, 0x2a, 0, 0, 0, 0]);
      frame.writeUInt16LE(w, 6);
      frame.writeUInt16LE(h, 8);
      return riff('VP8 ', frame);
    };
    const vp8l = (w, h) => {
      const body = Buffer.alloc(5);
      body[0] = 0x2f;
      body.writeUInt32LE(((w - 1) | ((h - 1) << 14)) >>> 0, 1);
      return riff('VP8L', body);
    };
    const vp8x = (w, h) => {
      const body = Buffer.alloc(10);
      body.writeUIntLE(w - 1, 4, 3);
      body.writeUIntLE(h - 1, 7, 3);
      return riff('VP8X', body);
    };
    const gif = Buffer.from([...Buffer.from('GIF89a'), 30, 0, 90, 0]);
    const bmp = (w, h) => {
      const header = Buffer.alloc(26);
      header.write('BM', 0, 'latin1');
      header.writeUInt32LE(40, 14);
      header.writeInt32LE(w, 18);
      header.writeInt32LE(h, 22);
      return header;
    };
    const sizeOf = (bytes, ext) => JSON.stringify(lib.readImageSize(bytes, ext));
    check(
      'GIF, WebP and BMP sizes come from their headers',
      sizeOf(vp8(1000, 1455), 'webp') === '{"width":1000,"height":1455}' &&
        sizeOf(vp8l(1000, 1455), 'webp') === '{"width":1000,"height":1455}' &&
        sizeOf(vp8x(1000, 1455), 'webp') === '{"width":1000,"height":1455}' &&
        sizeOf(gif, 'gif') === '{"width":30,"height":90}' &&
        sizeOf(bmp(30, -90), 'bmp') === '{"width":30,"height":90}' &&
        lib.readImageSize(Buffer.from('GIF8'), 'gif') === null,
      [
        sizeOf(vp8(1000, 1455), 'webp'),
        sizeOf(vp8l(1000, 1455), 'webp'),
        sizeOf(vp8x(1000, 1455), 'webp'),
      ].join(' '),
    );
    const webpHandout = await lib.addHandout(await fixture('note.webp', vp8x(1000, 1455)));
    check(
      'a WebP handout is taken (it used to be refused) and turned',
      webpHandout?.width === 1000 && webpHandout.height === 1455 && webpHandout.rotation === 90,
      JSON.stringify(webpHandout),
    );

    // Thumbnails the DM window draws for images this process can't decode
    const drawnThumb = makePng({ width: 24, height: 35 });
    check(
      'a thumbnail drawn in the DM window is kept for an entry without one',
      (await lib.saveThumb(webpHandout.id, drawnThumb)) === true &&
        !!(await lib.loadHandoutThumb(webpHandout.id))?.startsWith('data:image/png'),
    );
    check('but never replaces one', (await lib.saveThumb(webpHandout.id, drawnThumb)) === false);
    check(
      'only small PNGs, for entries in the library, are taken',
      (await lib.saveThumb('h_unknown', drawnThumb)) === false &&
        (await lib.saveThumb('../evil', drawnThumb)) === false &&
        (await lib.saveThumb(tallVideo.id, Buffer.from('not a png'))) === false &&
        (await lib.saveThumb(tallVideo.id, 'text')) === false &&
        (await lib.saveThumb(tallVideo.id, makePng({ width: 5000, height: 4 }))) === false,
    );

    await lib.saveSettings({ portraitRotation: 270 });
    const leftMap = await lib.addMap(await fixture('tall2.png', makePng({ width: 40, height: 80 })));
    check('or turned the other way', leftMap.rotation === 270);
    for (const entry of [tallMap, wideMap, squareMap, tallVideo, exifMap, leftMap])
      await lib.removeMap(entry.id);
    for (const entry of [tallHandout, wideHandout, webpHandout]) await lib.removeHandout(entry.id);
    await lib.saveSettings({ portraitRotation: 0 });

    // ── Handouts ─────────────────────────────────────────────────────────────
    const handout = await lib.addHandout(await fixture('letter.png', makePng({ width: 300, height: 100 })));
    check('addHandout returns metadata', !!handout && handout.id.startsWith('h_'));
    check('handout image resolves', !!(await lib.resolveHandoutPath(handout.id)));
    check('handout thumbnail is generated', !!(await lib.loadHandoutThumb(handout.id)));
    await lib.rotateHandout(handout.id, -90);
    check('handout rotation is normalised', (await lib.loadSnapshot()).handouts[0].rotation === 270);
    check('removeHandout succeeds', (await lib.removeHandout(handout.id)) === true);
    check('handout is gone', (await lib.resolveHandoutPath(handout.id)) === null);

    // ── Project files ────────────────────────────────────────────────────────
    // Library now holds map b (renamed, with fog). Add a second map, a handout,
    // view state and settings, then export, empty the library and import.
    const c = await lib.addMap(await fixture('gamma.png', makePng({ width: 80, height: 40 })));
    await lib.reorderMaps([b.id, c.id]);
    await lib.saveMapView(b.id, {
      zoom: 1.75,
      pan: { x: 10, y: 20 },
      rotation: 270,
      mirrorHorizontal: true,
      mirrorVertical: false,
    });
    const letter = await lib.addHandout(await fixture('letter2.png', makePng({ width: 120, height: 60 })));
    await lib.rotateHandout(letter.id, 90);
    await lib.saveSettings({ playerScreenDiagonal: 43, gridSize: 2.5, portraitRotation: 270 });
    // ── Grid calibration and circles ─────────────────────────────────────────
    const measured = gridLib.gridFromCorners({ x: 110, y: 60 }, { x: 410, y: 360 }, 3, 5);
    check(
      'a grid is measured from two diagonal corners',
      measured?.cell === 100 && measured.offsetX === 10 && measured.offsetY === 60,
      JSON.stringify(measured),
    );
    check(
      'a grid is measured from corners along one line',
      gridLib.gridFromCorners({ x: 0, y: 5 }, { x: 250, y: 8 }, 5, 5)?.cell === 50,
    );
    check(
      'snapping lands on the centre of the square',
      JSON.stringify(gridLib.snapToCell({ x: 130, y: 99 }, measured)) === JSON.stringify({ x: 160, y: 110 }),
    );
    check('feet convert to pixels', gridLib.feetToPixels(15, measured) === 300);
    check('a zero-size grid is rejected', gridLib.normalizeGrid({ cell: 0, feetPerCell: 5 }) === null);

    // ── Grid size from file and folder names (the same cases as Mini Gridder) ─
    const cellOf = (names, w, h) => gridLib.cellFromNames(names, w, h);
    check('a folder name gives the grid', cellOf(['forest_map', 'forest_32x32', 'maps'], 3200, 3200) === 100);
    check(
      'the file name wins over its folder',
      cellOf(['forest_map_20x15', 'forest_32x32'], 2000, 1500) === 100,
    );
    check(
      'spaced, bracketed and glued sizes are read',
      cellOf(['Main Deck', 'Airship [27 x 19]'], 12000, 8444) === 12000 / 27 &&
        cellOf(['Mansion_Attic (40 x 40)'], 4000, 4000) === 100 &&
        cellOf(['TreeTrapGrid_Small60x60'], 4725, 4725) === 78.75 &&
        cellOf(['map 20×15'], 2000, 1500) === 100 &&
        cellOf(['map 22.5x15'], 2250, 1500) === 100,
    );
    check('a size given down × across is read', cellOf(['Saltmarsh (170x140)  (Free)'], 9800, 11900) === 70);
    check(
      "the image's own pixel size and px-marked sizes are skipped",
      cellOf(['Courier-Exterior-Grid-Lights-140ppi-30x34-4200x4760'], 4200, 4760) === 140 &&
        cellOf(['Floor 1', 'images', 'Ravenloft [4k] [90x68 sq][44x33][80x60] [6144x4608px]'], 6144, 4608) ===
          6144 / 80,
    );
    check(
      'squares win over PPI, which is used without them',
      cellOf(['ButterskullRanchBasementGrid_300PPI8x12'], 2400, 3600) === 300 &&
        cellOf(['ClanHQ2FloorGrid300PPI', 'ClanHQ MP'], 10500, 8700) === 300,
    );
    check(
      'a size that fits neither way, or no size, gives no grid',
      cellOf(['Winters Feast - Lit - Grid 5x7'], 3072, 4096) === null &&
        cellOf(['Grid 1 Jungle Encounter'], 2000, 2000) === null &&
        cellOf(['forest_70px'], 2000, 2000) === null &&
        cellOf(['v1.2x3'], 2000, 2000) === null &&
        cellOf(['thumb', 'pack_300x300'], 1080, 1080) === null &&
        cellOf(['forest_32x32'], 0, 0) === null,
    );
    check(
      'names are searched three folders up only',
      cellOf(['map', 'c', 'b', 'a_20x20'], 2000, 2000) === 100 &&
        cellOf(['map', 'd', 'c', 'b', 'a_20x20'], 2000, 2000) === null,
    );
    const sizedDir = path.join(fixtures, 'cellar_4x2');
    await fs.mkdir(sizedDir, { recursive: true });
    await fs.writeFile(path.join(sizedDir, 'cellar.png'), makePng({ width: 80, height: 40 }));
    const sized = await lib.addMap(path.join(sizedDir, 'cellar.png'));
    check(
      'a map gets its grid from its folder name as it is added',
      sized?.grid?.cell === 20 && sized.grid.offsetX === 0 && sized.grid.feetPerCell === 5,
      JSON.stringify(sized?.grid),
    );
    check(
      'and keeps it in the library',
      (await lib.loadSnapshot()).maps.find((m) => m.id === sized.id)?.grid?.cell === 20,
    );
    check('a map without a size in its names has no grid', c.grid === null);
    await lib.removeMap(sized.id);
    await lib.saveSettings({ currentMapId: c.id });

    // Measuring: squares counted from the start square to the end square
    const along = (rule, to) => gridLib.measureFeet({ x: 160, y: 110 }, to, measured, rule);
    check(
      'three squares diagonally: 5/10 diagonals 20 ft, every square 15 ft',
      along('alternate', { x: 460, y: 410 }) === 20 && along('uniform', { x: 460, y: 410 }) === 15,
    );
    check(
      'four across and two down: 5/10 diagonals 25 ft, every square 20 ft',
      along('alternate', { x: 560, y: 310 }) === 25 && along('uniform', { x: 560, y: 310 }) === 20,
    );
    check('anywhere in the end square counts the same', along('alternate', { x: 499, y: 360 }) === 20);
    check('a straight line is the distance as the crow flies', along('straight', { x: 460, y: 510 }) === 25);
    const zigzag = [
      { x: 160, y: 110 },
      { x: 260, y: 210 },
      { x: 360, y: 110 },
    ];
    check(
      'a path counts 5/10 diagonals across its legs: 5 + 10 ft',
      gridLib.measurePathFeet(zigzag, measured, 'alternate') === 15 &&
        gridLib.measurePathFeet(zigzag, measured, 'uniform') === 10,
    );
    check(
      'a path round a corner adds its legs',
      gridLib.measurePathFeet(
        [
          { x: 160, y: 110 },
          { x: 460, y: 110 },
          { x: 460, y: 410 },
        ],
        measured,
        'alternate',
      ) === 30 && gridLib.measurePathFeet(zigzag, measured, 'straight') === 14,
    );
    check(
      'movement is a setting, counting 5/10 diagonals until changed',
      (await lib.loadSnapshot()).settings.diagonalRule === 'alternate' &&
        (await lib.saveSettings({ diagonalRule: 'straight' })) === false &&
        (await lib.saveSettings({ diagonalRule: 'uniform' })) === true &&
        (await lib.loadSnapshot()).settings.diagonalRule === 'uniform',
    );
    check(
      'players see the ruler only once it is shown to them',
      (await lib.loadSnapshot()).settings.showRulerToPlayers === false &&
        (await lib.saveSettings({ showRulerToPlayers: 'yes' })) === false &&
        (await lib.saveSettings({ showRulerToPlayers: true })) === true &&
        (await lib.loadSnapshot()).settings.showRulerToPlayers === true,
    );
    check(
      'the player view zoom is unlocked until locked',
      (await lib.loadSnapshot()).settings.lockZoom === false &&
        (await lib.saveSettings({ lockZoom: 1 })) === false &&
        (await lib.saveSettings({ lockZoom: true })) === true &&
        (await lib.loadSnapshot()).settings.lockZoom === true,
    );
    check(
      'the player view frame is gold until another listed colour is chosen',
      (await lib.loadSnapshot()).settings.frameColor === 'gold' &&
        (await lib.saveSettings({ frameColor: 'indigo' })) === false &&
        (await lib.saveSettings({ frameColor: 'sky' })) === true &&
        (await lib.loadSnapshot()).settings.frameColor === 'sky',
    );

    // Area templates: old circles load unchanged, shapes have the D&D outlines
    const discs = areasLib.normalizeDrawnAreas([
      { x: 1, y: 2, radius: 30, kind: 'fire', shape: 'cone', angle: 90, width: 10 },
      { x: 1, y: 2, radius: -5, kind: 'fire', shape: 'circle', angle: 0, width: 0 },
      { x: 1, y: 2, radius: 5, kind: 'acid', shape: 'circle', angle: 0, width: 0 },
      { x: 'a', y: 2, radius: 5, kind: 'fire', shape: 'circle', angle: 0, width: 0 },
    ]);
    check(
      'templates for the player screen are validated',
      discs.length === 1 && discs[0].shape === 'cone' && areasLib.normalizeDrawnAreas('nope').length === 0,
      JSON.stringify(discs),
    );

    // Video maps too large for this computer's hardware decoder
    const decodesUpTo = (edge) => async (_codec, size) => Math.max(size.w, size.h) <= edge;
    check(
      'a video decoded in hardware needs no advice',
      (await videoLib.smallerVideoSize('vp9', { w: 5550, h: 3150 }, decodesUpTo(8192))) === null,
    );
    const advice = await videoLib.smallerVideoSize('vp9', { w: 5550, h: 3150 }, decodesUpTo(4096));
    check(
      'too large for the decoder: the largest common size it handles',
      advice?.w === 3840 && advice?.h === 2180,
      JSON.stringify(advice),
    );
    const noDecoder = await videoLib.smallerVideoSize('vp8', { w: 5550, h: 3150 }, async () => false);
    check(
      'no hardware decoder at all: Full HD',
      noDecoder?.w === 1920 && noDecoder?.h === 1090,
      JSON.stringify(noDecoder),
    );
    let asked = false;
    const small = await videoLib.smallerVideoSize('vp8', { w: 1920, h: 1080 }, async () => {
      asked = true;
      return false;
    });
    check('Full HD videos are never questioned', small === null && !asked);

    const [old, cone] = areasLib.normalizeAreas([
      { id: 'old', x: 1, y: 2, radiusFt: 15, kind: 'fire' },
      { id: 'cone', x: 0, y: 0, radiusFt: 15, kind: 'magic', shape: 'cone', angle: -90, widthFt: 0.2 },
    ]);
    check(
      'templates saved before shapes are circles',
      old.shape === 'circle' && old.angle === 0 && old.widthFt === 5,
      JSON.stringify(old),
    );
    check('angles are wrapped into 0..360', cone.shape === 'cone' && cone.angle === 270);
    // Areas from a newer version or a fork
    const area = (id, extra) => ({ id, x: 0, y: 0, radiusFt: 5, kind: 'fire', ...extra });
    const report = { leftOut: 0, restyled: 0 };
    const foreign = areasLib.normalizeAreas(
      [
        area('moon', { shape: 'halfmoon' }),
        area('ice', { kind: 'ice', color: '#9be7ff' }),
        area('acid', { kind: 'acid', color: '#7fff00' }),
        area('spark', { kind: 'lightning', color: '#ffd400' }),
        area('plain', { kind: 'shadow' }),
        area('kept', { shape: 'cone' }),
      ],
      report,
    );
    check(
      'an area of an unknown shape is left out, not guessed',
      !foreign.some((c) => c.id === 'moon') && report.leftOut === 1,
      JSON.stringify(report),
    );
    check(
      'an area of an unknown kind is kept in the nearest colour',
      foreign.find((c) => c.id === 'ice')?.kind === 'magic' &&
        foreign.find((c) => c.id === 'acid')?.kind === 'poison' &&
        foreign.find((c) => c.id === 'spark')?.kind === 'fire' &&
        report.restyled === 4,
      JSON.stringify(foreign.map((c) => c.kind)),
    );
    check(
      'an unknown kind without a colour is shown as magic',
      foreign.find((c) => c.id === 'plain')?.kind === 'magic',
    );
    check(
      'known areas next to unknown ones are kept',
      foreign.find((c) => c.id === 'kept')?.shape === 'cone',
    );
    const crowded = { leftOut: 0, restyled: 0 };
    const capped = areasLib.normalizeAreas(
      Array.from({ length: 60 }, (_, i) => area(`a${i}`)),
      crowded,
    );
    check(
      'areas over the limit are counted as left out',
      capped.length === 50 && crowded.leftOut === 10,
      JSON.stringify(crowded),
    );
    const disc = (shape, extra = {}) => ({
      x: 0,
      y: 0,
      radius: 10,
      kind: 'fire',
      shape,
      angle: 0,
      width: 2,
      ...extra,
    });
    check(
      'a cone is as wide at its end as it is long',
      JSON.stringify(areasLib.areaOutline(disc('cone'))) ===
        JSON.stringify([
          { x: 0, y: 0 },
          { x: 10, y: 5 },
          { x: 10, y: -5 },
        ]),
      JSON.stringify(areasLib.areaOutline(disc('cone'))),
    );
    check(
      'a line is centred on its direction',
      JSON.stringify(areasLib.areaOutline(disc('line'))) ===
        JSON.stringify([
          { x: 0, y: 1 },
          { x: 10, y: 1 },
          { x: 10, y: -1 },
          { x: 0, y: -1 },
        ]),
    );
    {
      // A 10 px square turned 45 degrees: corners on the axes, about the centre
      const turned = areasLib.areaOutline(disc('square', { angle: 45 }));
      const round = (points) =>
        points.map(({ x, y }) => [Math.round(x * 100) / 100, Math.round(y * 100) / 100]);
      const axisAligned = round(areasLib.areaOutline(disc('square')));
      const r = Math.round(Math.SQRT1_2 * 10 * 100) / 100;
      check(
        'a square turns about its centre',
        JSON.stringify(axisAligned) ===
          JSON.stringify([
            [-5, -5],
            [5, -5],
            [5, 5],
            [-5, 5],
          ]) &&
          JSON.stringify(round(turned)) ===
            JSON.stringify([
              [0, -r],
              [r, 0],
              [0, r],
              [-r, 0],
            ]),
        JSON.stringify(round(turned)),
      );
      check(
        "a square's handle is the middle of its front edge",
        JSON.stringify(areasLib.areaHandle(disc('square'))) === JSON.stringify({ x: 5, y: 0 }),
      );
    }
    check(
      'points inside a cone are found, outside are not',
      areasLib.areaContains(disc('cone'), { x: 8, y: 3 }, 0) &&
        !areasLib.areaContains(disc('cone'), { x: 2, y: 3 }, 0),
    );
    const square = (radiusFt) => ({
      id: 's',
      x: 0,
      y: 0,
      radiusFt,
      kind: 'fire',
      shape: 'square',
      angle: 0,
      widthFt: 5,
    });
    check(
      'a 10 ft square snaps to a grid corner, a 15 ft one to a square centre',
      JSON.stringify(areasLib.snapArea({ x: 130, y: 99 }, square(10), measured)) ===
        JSON.stringify({ x: 110, y: 60 }) &&
        JSON.stringify(areasLib.snapArea({ x: 130, y: 99 }, square(15), measured)) ===
          JSON.stringify({ x: 160, y: 110 }),
      JSON.stringify(areasLib.snapArea({ x: 130, y: 99 }, square(10), measured)),
    );

    // Editing steps (the DM window's wheel, aim handle and new shapes)
    {
      check(
        'the wheel steps sizes to the next 5 ft, and never below 5 ft',
        areasLib.stepSize(12, 1) === 15 &&
          areasLib.stepSize(15, 2) === 25 &&
          areasLib.stepSize(12, -1) === 10 &&
          areasLib.stepSize(5, -3) === 5 &&
          areasLib.stepSize(498, 1) === areasLib.MAX_RADIUS_FT,
      );
      const line = { ...square(30), shape: 'line', widthFt: 5 };
      check(
        'the wheel over a line changes its width, over anything else its size',
        areasLib.resizeArea(line, 1).widthFt === 10 &&
          areasLib.resizeArea(line, 1).radiusFt === 30 &&
          areasLib.resizeArea(square(10), 1).radiusFt === 15,
      );
      const cone = { ...square(15), shape: 'cone', x: 0, y: 0 };
      const cell = measured.cell / measured.feetPerCell; // pixels per foot
      const aimed = areasLib.aimArea(cone, { x: 0, y: 23 * cell }, measured, false);
      const snapped = areasLib.aimArea(cone, { x: 20 * cell, y: 8 * cell }, measured, true);
      check(
        'aiming points a cone at the handle, its length in 5 ft steps; Ctrl keeps to 45°',
        aimed.angle === 90 && aimed.radiusFt === 25 && snapped.angle === 0,
        JSON.stringify({ aimed: [aimed.angle, aimed.radiusFt], snapped: snapped.angle }),
      );
      check(
        'a square near a right angle settles onto the grid, and keeps its size',
        areasLib.aimArea(square(10), { x: 100, y: 4 }, measured, false).angle === 0 &&
          Math.round(areasLib.aimArea(square(10), { x: 100, y: 50 }, measured, false).angle) === 27 &&
          areasLib.aimArea(square(10), { x: 300, y: 0 }, measured, false).radiusFt === 10,
      );
      const added = areasLib.newArea('line', { x: 5, y: 6 }, 'magic', { x: 0, y: -1 });
      check(
        'a new area takes its default size and points along the direction given',
        added.radiusFt === areasLib.DEFAULT_AREA_FT.line &&
          added.angle === 270 &&
          added.x === 5 &&
          added.kind === 'magic',
        JSON.stringify(added),
      );
    }

    // Keyboard shortcuts: one table for the key handler and the shortcuts list
    {
      const press = (key, modifiers = {}) =>
        shortcutsLib.commandFor({
          key,
          ctrlKey: false,
          metaKey: false,
          altKey: false,
          shiftKey: false,
          ...modifiers,
        });
      check(
        'keys find their commands, with and without modifiers',
        press('z', { ctrlKey: true }) === 'undo' &&
          press('Z', { ctrlKey: true, shiftKey: true }) === 'redo' &&
          press('y', { metaKey: true }) === 'redo' &&
          press('b') === 'blackout' &&
          press('b', { ctrlKey: true }) === 'toggleLibrary' &&
          press('V', { shiftKey: true }) === 'viewTool' &&
          press('?', { shiftKey: true }) === 'showShortcuts' &&
          press('ArrowUp', { shiftKey: true }) === 'nudgeArea',
      );
      check(
        'AltGr still sizes the brush, but Alt keeps plain keys from acting',
        press(']', { ctrlKey: true, altKey: true }) === 'brushSize' &&
          press('v', { altKey: true }) === null &&
          press('q') === null,
      );
      const listed = new Set(
        shortcutsLib.SHORTCUT_GROUPS.flatMap((group) =>
          group.shortcuts.flatMap(([, ways]) =>
            ways.filter((way) => typeof way !== 'string').map((way) => way.keys),
          ),
        ),
      );
      const labelled = new Set(
        shortcutsLib.KEY_BINDINGS.filter((binding) => binding.label).map((binding) => binding.command),
      );
      const commands = new Set(shortcutsLib.KEY_BINDINGS.map((binding) => binding.command));
      check(
        'the shortcuts list shows every command, each with its keys',
        [...commands].every((command) => listed.has(command) && labelled.has(command)) &&
          [...listed].every((command) => commands.has(command)),
        [...commands].filter((command) => !listed.has(command) || !labelled.has(command)).join(', '),
      );
    }

    // Rotation and mirroring: each way round undoes the other, for every orientation
    {
      let roundTrips = true;
      for (const rotation of [0, 90, 180, 270]) {
        for (const mirrorHorizontal of [false, true]) {
          for (const mirrorVertical of [false, true]) {
            const orientation = { rotation, mirrorHorizontal, mirrorVertical };
            const media = { w: 400, h: 300 };
            const point = { x: 37, y: 251 };
            const back = geometryLib.orientedToMap(
              geometryLib.mapToOriented(point, media, orientation),
              media,
              orientation,
            );
            const direction = geometryLib.screenToMapDirection(
              geometryLib.mapToScreenDirection({ x: 3, y: -7 }, orientation),
              orientation,
            );
            if (Math.abs(back.x - point.x) > 1e-9 || Math.abs(back.y - point.y) > 1e-9) roundTrips = false;
            if (direction.x !== 3 || direction.y !== -7) roundTrips = false;
          }
        }
      }
      const turned = geometryLib.mapToOriented(
        { x: 0, y: 0 },
        { w: 400, h: 300 },
        {
          rotation: 90,
          mirrorHorizontal: false,
          mirrorVertical: false,
        },
      );
      check(
        'map and screen coordinates convert both ways in every orientation',
        roundTrips && turned.x === 300 && turned.y === 0,
        JSON.stringify(turned),
      );
    }

    check('a new map has no grid or circles', c.grid === null && c.circles.length === 0);
    check('saveMapGrid stores the grid', (await lib.saveMapGrid(c.id, measured)) === true);
    check(
      'saveMapGrid rejects an invalid grid',
      (await lib.saveMapGrid(c.id, { cell: -4, offsetX: 0, offsetY: 0, feetPerCell: 5 })) === false,
    );
    const goodCircle = { id: 'c1', x: 160, y: 110, radiusFt: 15, kind: 'magic' };
    await lib.saveMapView(c.id, {
      zoom: 1,
      pan: null,
      rotation: 0,
      mirrorHorizontal: false,
      mirrorVertical: false,
      circles: [
        goodCircle,
        { id: 'c1', x: 1, y: 1, radiusFt: 5, kind: 'fire' }, // duplicate id
        { id: '../x', x: 1, y: 1, radiusFt: 5, kind: 'fire' }, // unsafe id
        { id: 'c2', x: 1, y: 1, radiusFt: 5, kind: 'lava' }, // unknown kind: kept as magic
        { id: 'c3', x: 1, y: 1, radiusFt: 9999, kind: 'poison' }, // clamped
      ],
    });
    const calibrated = (await lib.loadSnapshot()).maps.find((m) => m.id === c.id);
    check('the grid persists', calibrated.grid?.cell === 100, JSON.stringify(calibrated.grid));
    check(
      'circles persist, invalid ones are dropped and radii clamped',
      calibrated.circles.length === 3 &&
        calibrated.circles[0].id === 'c1' &&
        calibrated.circles[1].kind === 'magic' &&
        calibrated.circles[2].radiusFt === areasLib.MAX_RADIUS_FT,
      JSON.stringify(calibrated.circles),
    );
    check(
      'effect tools are shown by default and can be hidden',
      (await lib.loadSnapshot()).settings.showEffectTools === true &&
        (await lib.saveSettings({ showEffectTools: false })) === true &&
        (await lib.loadSnapshot()).settings.showEffectTools === false,
    );
    await lib.saveSettings({ showEffectTools: true });
    check(
      'the library panel is shown by default and can be hidden',
      (await lib.loadSnapshot()).settings.showLibrary === true &&
        (await lib.saveSettings({ showLibrary: false })) === true &&
        (await lib.loadSnapshot()).settings.showLibrary === false,
    );
    await lib.saveSettings({ showLibrary: true });

    // Effects: optional per-map layer, saved as PNG, removed again with null
    const effectsUrl = `data:image/png;base64,${makePng({ width: 32, height: 32, rgb: [255, 100, 20] }).toString('base64')}`;
    check('a map starts without effects', (await lib.loadMapEffects(c.id)) === null);
    check('saveMapEffects stores a PNG', (await lib.saveMapEffects(c.id, effectsUrl)) === true);
    check('effects reload losslessly', (await lib.loadMapEffects(c.id)) === effectsUrl);
    check(
      'saveMapEffects rejects data that is not a PNG',
      (await lib.saveMapEffects(c.id, 'data:image/png;base64,aGVsbG8=')) === false,
    );
    check(
      'saveMapEffects rejects a traversal id',
      (await lib.saveMapEffects('../evil', effectsUrl)) === false,
    );
    check(
      'saveMapEffects ignores a deleted map',
      (await lib.saveMapEffects(a.id, effectsUrl)) === false && !(await exists(aDir)),
    );
    await lib.saveMapEffects(b.id, effectsUrl);
    await lib.saveMapEffects(b.id, null);
    check(
      'saving null removes the effects file',
      !(await exists(path.join(tmp, 'library', b.id, 'effects.png'))),
    );

    const projectPath = path.join(fixtures, 'campaign.minivtt');
    const exported = await lib.exportProject(projectPath);
    check(
      'export counts maps and handouts',
      exported.maps === 2 && exported.handouts === 1,
      JSON.stringify(exported),
    );
    check('export leaves no temp file', !(await fs.readdir(fixtures)).some((f) => f.endsWith('.tmp')));

    // The export is an ordinary ZIP, so any unzip tool can open it
    const unzip = async (file) => {
      const zip = await yauzl.openPromise(file, { autoClose: false });
      const files = new Map();
      try {
        for await (const entry of zip.eachEntry()) {
          const chunks = [];
          for await (const chunk of await zip.openReadStreamPromise(entry)) chunks.push(chunk);
          files.set(entry.fileName, { method: entry.compressionMethod, bytes: Buffer.concat(chunks) });
        }
      } finally {
        zip.close();
      }
      return files;
    };
    const archive = await unzip(projectPath);
    const written = JSON.parse(archive.get('manifest.json')?.bytes.toString('utf8') ?? '{}');
    const schema = JSON.parse(
      await fs.readFile(new URL('../docs/project-manifest.schema.json', import.meta.url), 'utf8'),
    );
    const fitsSchema = new Ajv2020({ allErrors: true }).compile(schema);
    const schemaErrors = (manifest) => (fitsSchema(manifest) ? '' : JSON.stringify(fitsSchema.errors));
    const exportErrors = schemaErrors(written);
    check('the exported manifest fits the published schema', exportErrors === '', exportErrors);
    check('the project file is a ZIP with the manifest first', [...archive.keys()][0] === 'manifest.json');
    check(
      'files are stored uncompressed',
      [...archive.values()].every((file) => file.method === 0),
    );
    check(
      'the manifest names its format, version and maker',
      written.format === 'mini-vtt-project' && written.version === 2 && /^Mini VTT /.test(written.generator),
      JSON.stringify({ format: written.format, version: written.version, generator: written.generator }),
    );
    check(
      'every file the manifest names is in the archive',
      [...written.maps, ...written.handouts]
        .flatMap((record) => [record.media, record.thumb, record.fog, record.effects])
        .filter(Boolean)
        .every((name) => archive.has(name)),
    );
    check(
      'areas carry their colour for versions without their kind',
      written.maps.some((map) => map.circles.length > 0) &&
        written.maps.every((map) => map.circles.every((circle) => /^#[0-9a-f]{6}$/.test(circle.color))),
    );

    await lib.removeMap(b.id);
    await lib.removeMap(c.id);
    await lib.removeHandout(letter.id);
    await lib.saveSettings({ playerScreenDiagonal: null, gridSize: 1, portraitRotation: 0 });

    const imported = await lib.importProject(projectPath);
    check(
      'import adds every map and handout',
      imported.maps === 2 && imported.handouts === 1 && imported.skipped === 0,
      JSON.stringify(imported),
    );
    const afterImport = await lib.loadSnapshot();
    const [first, second] = afterImport.maps;
    check('map order is kept', first?.name === 'Renamed concurrently' && second?.name === 'gamma');
    check(
      'view state is kept',
      first.zoom === 1.75 &&
        first.pan.x === 10 &&
        first.pan.y === 20 &&
        first.rotation === 270 &&
        first.mirrorHorizontal,
    );
    check('imported maps get fresh ids', first.id !== b.id && second.id !== c.id);
    const importedFog = await lib.loadMapFog(first.id);
    check('fog is kept', first.hasFog && importedFog === fogUrl && !second.hasFog);
    check(
      'effects travel with the project',
      (await lib.loadMapEffects(second.id)) === effectsUrl && (await lib.loadMapEffects(first.id)) === null,
    );
    check(
      'grid and circles travel with the project',
      second.grid?.cell === 100 && second.circles.length === 3 && first.grid === null,
      JSON.stringify({ grid: second.grid, circles: second.circles.length }),
    );
    check('map media resolves', !!(await lib.resolveMapMediaPath(second.id)));
    check('map thumbnail is kept', !!(await lib.loadMapThumb(second.id)));
    const importedHandout = afterImport.handouts[0];
    check('handout is kept', importedHandout?.name === 'letter2' && importedHandout.rotation === 90);
    check('handout media resolves', !!(await lib.resolveHandoutPath(importedHandout.id)));
    check(
      'an empty library takes the player screen settings',
      imported.settingsApplied &&
        afterImport.settings.playerScreenDiagonal === 43 &&
        afterImport.settings.gridSize === 2.5 &&
        afterImport.settings.portraitRotation === 270,
      JSON.stringify(afterImport.settings),
    );
    check('first imported map becomes current', afterImport.settings.currentMapId === first.id);

    await lib.saveSettings({ playerScreenDiagonal: 32 });
    const again = await lib.importProject(projectPath);
    const afterAgain = await lib.loadSnapshot();
    check('importing again adds copies', afterAgain.maps.length === 4 && afterAgain.handouts.length === 2);
    check(
      'a non-empty library keeps its own settings',
      !again.settingsApplied && afterAgain.settings.playerScreenDiagonal === 32,
    );
    check(
      'new imports go on top, existing order follows',
      afterAgain.maps[0].id === again.firstMap.id && afterAgain.maps[2].id === first.id,
    );
    check('the current map is not changed', afterAgain.settings.currentMapId === first.id);

    // Damaged or hostile files
    const rejects = async (name, bytes) => {
      const before = (await fs.readdir(path.join(tmp, 'library'))).length;
      let message = '';
      try {
        await lib.importProject(await fixture(name, bytes));
      } catch (err) {
        message = err instanceof lib.ProjectError ? err.message : `unexpected: ${err}`;
      }
      const after = (await fs.readdir(path.join(tmp, 'library'))).length;
      return {
        rejected: message !== '' && !message.startsWith('unexpected'),
        cleanedUp: before === after,
        message,
      };
    };
    const projectBytes = await fs.readFile(projectPath);
    const notProject = await rejects('notes.minivtt', 'just some text, not a project');
    check('rejects a file that is not a project', notProject.rejected, notProject.message);
    const truncated = await rejects('truncated.minivtt', projectBytes.subarray(0, 40));
    check('rejects a truncated header', truncated.rejected, truncated.message);
    const hostileManifest = Buffer.from(
      JSON.stringify({
        format: 'mini-vtt-project',
        version: 1,
        maps: [
          { name: '../escape', media: { offset: 0, size: 999999 } },
          { name: 'negative', media: { offset: -5, size: 4 } },
        ],
        handouts: [{ name: 'not an image', media: { offset: 0, size: 4 } }],
      }),
    );
    const hostileHeader = Buffer.alloc(12);
    Buffer.from('MVTTPRJ1').copy(hostileHeader);
    hostileHeader.writeUInt32LE(hostileManifest.length, 8);
    const hostile = await rejects(
      'hostile.minivtt',
      Buffer.concat([hostileHeader, hostileManifest, Buffer.from('nope')]),
    );
    check('rejects out-of-range blobs and non-image data', hostile.rejected, hostile.message);
    check('a rejected import leaves no folders behind', hostile.cleanedUp && notProject.cleanedUp);
    const newer = Buffer.from(
      JSON.stringify({ format: 'mini-vtt-project', version: 99, maps: [], handouts: [] }),
    );
    const newerHeader = Buffer.from(hostileHeader);
    newerHeader.writeUInt32LE(newer.length, 8);
    const fromNewer = await rejects('newer.minivtt', Buffer.concat([newerHeader, newer]));
    check(
      'rejects a project from a newer version',
      fromNewer.rejected && /newer/.test(fromNewer.message),
      fromNewer.message,
    );
    check('rejected imports do not change the library', (await lib.loadSnapshot()).maps.length === 4);

    // ── Project files from 1.1 and 1.2 ──────────────────────────────────────
    const mapPng = makePng({ rgb: [120, 120, 120] });
    const halfFog = makePng({ rgb: [9, 9, 11], leftHalfOnly: true });
    const legacyManifest = Buffer.from(
      JSON.stringify({
        format: 'mini-vtt-project',
        version: 1,
        exportedAt: 0,
        settings: {},
        maps: [
          {
            name: 'old map',
            mediaType: 'image',
            width: 64,
            height: 64,
            zoom: 2,
            pan: { x: 3, y: 4 },
            rotation: 90,
            mirrorHorizontal: false,
            mirrorVertical: false,
            circles: [{ id: 'c1', x: 5, y: 5, radiusFt: 15, kind: 'poison' }],
            media: { offset: 0, size: mapPng.length },
            fog: { offset: mapPng.length, size: halfFog.length },
          },
        ],
        handouts: [],
      }),
    );
    const legacyHeader = Buffer.alloc(12);
    Buffer.from('MVTTPRJ1').copy(legacyHeader);
    legacyHeader.writeUInt32LE(legacyManifest.length, 8);
    const fromLegacy = await lib.importProject(
      await fixture('old.minivtt', Buffer.concat([legacyHeader, legacyManifest, mapPng, halfFog])),
    );
    const oldMap = (await lib.loadSnapshot()).maps.find((map) => map.id === fromLegacy.firstMap?.id);
    check(
      'a project file from 1.1 or 1.2 still imports',
      fromLegacy.maps === 1 &&
        oldMap?.hasFog &&
        oldMap.zoom === 2 &&
        oldMap.rotation === 90 &&
        oldMap.circles[0]?.shape === 'circle' &&
        oldMap.circles[0]?.kind === 'poison',
      JSON.stringify(fromLegacy),
    );

    // ── Files from newer versions and forks ─────────────────────────────────
    const makeZip = async (files, options = {}) => {
      const zip = new yazl.ZipFile();
      for (const [name, content] of Object.entries(files)) {
        const bytes = Buffer.isBuffer(content)
          ? content
          : Buffer.from(typeof content === 'string' ? content : JSON.stringify(content));
        zip.addBuffer(bytes, name, { compress: false, ...options });
      }
      zip.end();
      const chunks = [];
      for await (const chunk of zip.outputStream) chunks.push(chunk);
      return Buffer.concat(chunks);
    };
    const forkManifest = {
      format: 'mini-vtt-project',
      version: 2,
      generator: 'Mini VTT Halfmoon 2.0',
      somethingNew: { anything: true },
      extensions: { halfmoon: { theme: 'dusk' } },
      settings: {},
      maps: [
        {
          name: 'From a fork',
          media: 'maps/1/media.png',
          fog: 'maps/1/fog.vec',
          grid: { cell: 64, offsetX: 0, offsetY: 0, feetPerCell: 5 },
          circles: [
            { id: 'a', x: 1, y: 1, radiusFt: 10, kind: 'fire', shape: 'circle', color: '#ff6a1a' },
            { id: 'b', x: 1, y: 1, radiusFt: 10, kind: 'fire', shape: 'halfmoon' },
            { id: 'c', x: 1, y: 1, radiusFt: 10, kind: 'ice', shape: 'square', color: '#9be7ff' },
          ],
          notes: 'a field this version has never heard of',
          extensions: { halfmoon: { pinned: true } },
        },
        { name: 'Unsupported media', media: 'maps/2/media.mp4' },
        { name: 'Missing media', media: 'maps/3/media.png' },
      ],
      handouts: [],
    };
    // Deflated, as another program's ZIP library may write it
    const fromFork = await lib.importProject(
      await fixture(
        'fork.minivtt',
        await makeZip(
          {
            'manifest.json': forkManifest,
            'maps/1/media.png': mapPng,
            'maps/1/fog.vec': 'fog in a form this version does not know',
            'maps/2/media.mp4': 'not a map Mini VTT can show',
            'halfmoon/settings.json': '{}',
          },
          { compress: true },
        ),
      ),
    );
    const forkMap = (await lib.loadSnapshot()).maps.find((map) => map.id === fromFork.firstMap?.id);
    check(
      'a fork’s file imports what this version understands',
      fromFork.maps === 1 && forkMap?.name === 'From a fork' && forkMap.grid?.cell === 64,
      JSON.stringify(fromFork),
    );
    check(
      'what it doesn’t understand is counted for the DM',
      fromFork.skipped === 2 &&
        fromFork.areasLeftOut === 1 &&
        fromFork.areasRestyled === 1 &&
        fromFork.fogLeftOut === 1 &&
        fromFork.effectsLeftOut === 0,
      JSON.stringify(fromFork),
    );
    check(
      'unknown areas: the half moon is left out, the ice area shown as magic',
      JSON.stringify(forkMap?.circles.map((c) => [c.id, c.kind, c.shape])) ===
        JSON.stringify([
          ['a', 'fire', 'circle'],
          ['c', 'magic', 'square'],
        ]),
      JSON.stringify(forkMap?.circles),
    );
    check('fog that can’t be read leaves the map fully fogged', forkMap?.hasFog === false);
    const cutFog = await lib.importProject(
      await fixture(
        'cut-fog.minivtt',
        await makeZip({
          'manifest.json': {
            ...forkManifest,
            maps: [{ name: 'Cut fog', media: 'maps/1/media.png', fog: 'maps/1/fog.png' }],
          },
          'maps/1/media.png': mapPng,
          'maps/1/fog.png': fogBytes.subarray(0, Math.floor(fogBytes.length / 2)),
        }),
      ),
    );
    check(
      'a fog mask cut short in a project file is left out, never half revealed',
      cutFog.fogLeftOut === 1 && cutFog.firstMap?.hasFog === false,
      JSON.stringify(cutFog),
    );

    const needsFeature = await rejects(
      'needs-feature.minivtt',
      await makeZip({
        'manifest.json': { ...forkManifest, requires: ['halfmoon-arcs'] },
        'maps/1/media.png': mapPng,
      }),
    );
    check(
      'a file requiring a feature this version lacks is refused, naming it and its maker',
      needsFeature.rejected &&
        needsFeature.message.includes('halfmoon-arcs') &&
        needsFeature.message.includes('Mini VTT Halfmoon 2.0'),
      needsFeature.message,
    );
    const newerZip = await rejects(
      'newer-format.minivtt',
      await makeZip({ 'manifest.json': { ...forkManifest, version: 3 }, 'maps/1/media.png': mapPng }),
    );
    check(
      'a ZIP project of a newer format version is refused',
      newerZip.rejected && /newer/.test(newerZip.message),
      newerZip.message,
    );
    const plainZip = await rejects('photos.minivtt', await makeZip({ 'photo.png': mapPng }));
    check(
      'a ZIP without a manifest is not a project',
      plainZip.rejected && plainZip.message.includes('isn’t a Mini VTT project'),
      plainZip.message,
    );
    const zippedFolder = await rejects(
      'zipped-folder.minivtt',
      await makeZip({ 'session/manifest.json': forkManifest, 'session/maps/1/media.png': mapPng }),
    );
    check(
      'a manifest inside a folder gets a message saying how to fix it',
      zippedFolder.rejected && zippedFolder.message.includes('inside a folder'),
      zippedFolder.message,
    );

    // A file damaged inside the archive is caught by its CRC-32
    const otherPng = makePng({ rgb: [200, 60, 60] });
    const bitrot = await makeZip({
      'manifest.json': {
        ...forkManifest,
        maps: [
          { name: 'intact', media: 'maps/1/media.png' },
          { name: 'damaged', media: 'maps/2/media.png' },
        ],
      },
      'maps/1/media.png': mapPng,
      'maps/2/media.png': otherPng,
    });
    bitrot[bitrot.indexOf(otherPng) + Math.floor(otherPng.length / 2)] ^= 0xff;
    const fromBitrot = await lib.importProject(await fixture('bitrot.minivtt', bitrot));
    check(
      'a damaged file inside the ZIP fails its checksum and is skipped',
      fromBitrot.maps === 1 && fromBitrot.skipped === 1 && fromBitrot.firstMap?.name === 'intact',
      JSON.stringify(fromBitrot),
    );

    // yazl won't write a name that climbs out of the archive, so patch one in
    const climbing = Buffer.from(
      (
        await makeZip({
          'manifest.json': { ...forkManifest, maps: [{ name: 'x', media: '../evil.png' }] },
          'aa/evil.png': mapPng,
        })
      )
        .toString('latin1')
        .replaceAll('aa/evil.png', '../evil.png'),
      'latin1',
    );
    const escape = await rejects('climbing.minivtt', climbing);
    check(
      'a ZIP with a name outside the archive is refused and writes nothing',
      escape.rejected && escape.cleanedUp && !(await exists(path.join(tmp, 'evil.png'))),
      escape.message,
    );

    // A file claiming to unpack to more than the disk holds is refused up front
    const huge = await makeZip(
      { 'manifest.json': forkManifest, 'maps/1/media.png': mapPng },
      { compress: true, forceZip64Format: true },
    );
    const CENTRAL_HEADER = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
    let claimed = false;
    for (let at = huge.indexOf(CENTRAL_HEADER); at !== -1; at = huge.indexOf(CENTRAL_HEADER, at + 4)) {
      const nameLength = huge.readUInt16LE(at + 28);
      if (huge.toString('latin1', at + 46, at + 46 + nameLength) !== 'maps/1/media.png') continue;
      const extraEnd = at + 46 + nameLength + huge.readUInt16LE(at + 30);
      for (let field = at + 46 + nameLength; field < extraEnd; field += 4 + huge.readUInt16LE(field + 2)) {
        // The ZIP64 field's first value is the uncompressed size
        if (huge.readUInt16LE(field) === 0x0001) {
          huge.writeBigUInt64LE(2n ** 50n, field + 4);
          claimed = true;
        }
      }
    }
    const tooBig = await rejects('huge.minivtt', huge);
    check(
      'a project bigger than the free disk space is refused before writing',
      claimed && tooBig.rejected && /disk space/.test(tooBig.message) && tooBig.cleanedUp,
      tooBig.message,
    );

    // ── The examples in docs/project-format.md ──────────────────────────────
    const formatDoc = await fs.readFile(new URL('../docs/project-format.md', import.meta.url), 'utf8');
    const examples = [...formatDoc.matchAll(/```json\r?\n([\s\S]*?)\r?\n\s*```/g)]
      .map(([, json]) => {
        try {
          return JSON.parse(json);
        } catch {
          return null; // a fragment, not a whole manifest
        }
      })
      .filter((example) => example?.format === 'mini-vtt-project');
    check('the format document has its two example manifests', examples.length === 2, `${examples.length}`);
    // Into an empty library whose player screen is set up already
    for (const map of (await lib.loadSnapshot()).maps) await lib.removeMap(map.id);
    for (const handout of (await lib.loadSnapshot()).handouts) await lib.removeHandout(handout.id);
    await lib.saveSettings({ playerScreenDiagonal: 32, gridSize: 1.25 });
    const effectsPng = makePng({ rgb: [255, 106, 26] });
    for (const [index, example] of examples.entries()) {
      const label = index === 0 ? 'the minimal example' : 'the complete example';
      const errors = schemaErrors(example);
      check(`${label} fits the schema`, errors === '', errors);
      // Every file it names, filled with the approved test images
      const files = { 'manifest.json': example };
      for (const record of [...(example.maps ?? []), ...(example.handouts ?? [])]) {
        files[record.media] = mapPng;
        if (record.thumb) files[record.thumb] = mapPng;
        if (record.fog) files[record.fog] = halfFog;
        if (record.effects) files[record.effects] = effectsPng;
      }
      const result = await lib.importProject(await fixture(`example-${index}.minivtt`, await makeZip(files)));
      const leftOut =
        result.skipped +
        result.areasLeftOut +
        result.areasRestyled +
        result.fogLeftOut +
        result.effectsLeftOut;
      check(
        `${label} imports with nothing left out`,
        leftOut === 0 &&
          result.maps === (example.maps?.length ?? 0) &&
          result.handouts === (example.handouts?.length ?? 0),
        JSON.stringify({ ...result, firstMap: undefined }),
      );
      if (index === 0) {
        const { settings, maps } = await lib.loadSnapshot();
        check(
          'a file without settings leaves the player screen setup alone',
          !result.settingsApplied && settings.playerScreenDiagonal === 32 && settings.gridSize === 1.25,
          JSON.stringify(settings),
        );
        check(
          'a size the file leaves out is measured from the image',
          maps[0]?.width === 64 && maps[0]?.height === 64 && !!(await lib.loadMapThumb(maps[0].id)),
          JSON.stringify(maps[0]),
        );
      }
    }
    const withMap = (map) => ({ format: 'mini-vtt-project', version: 2, maps: [map] });
    const withArea = (area) => withMap({ media: 'map.png', circles: [area] });
    const mistakes = {
      'version as a string': { ...withMap({ media: 'map.png' }), version: '2' },
      'no maps or handouts': { format: 'mini-vtt-project', version: 2 },
      'a map without media': withMap({ name: 'Crypt' }),
      'a path that climbs out': withMap({ media: 'maps/../../map.png' }),
      'a path from the root': withMap({ media: '/maps/map.png' }),
      'backslashes in a path': withMap({ media: 'maps\\1\\media.png' }),
      'an area sized in pixels': withArea({ id: 'a', x: 0, y: 0, radiusFt: 3000, kind: 'fire' }),
      'an area without an id': withArea({ x: 0, y: 0, radiusFt: 15, kind: 'fire' }),
      'an unknown shape': withArea({ id: 'a', x: 0, y: 0, radiusFt: 15, kind: 'fire', shape: 'halfmoon' }),
      'a rotation off the right angles': withMap({ media: 'map.png', rotation: 45 }),
    };
    const missed = Object.keys(mistakes).filter((name) => fitsSchema(mistakes[name]));
    check('the schema catches the usual mistakes', missed.length === 0, missed.join(', '));

    // ── Settings from libraries written before 1.1 ──────────────────────────
    const indexPath = path.join(tmp, 'library', 'index.json');
    const stored = JSON.parse(await fs.readFile(indexPath, 'utf8'));
    stored.settings = { currentMapId: null, playerViewDiagonal: '27', gridSize: '1.5' };
    await fs.writeFile(indexPath, JSON.stringify(stored));
    const migrated = (await lib.loadSnapshot()).settings;
    check(
      'old string settings are migrated to numbers',
      migrated.playerScreenDiagonal === 27 && migrated.gridSize === 1.5 && migrated.portraitRotation === 270,
      JSON.stringify(migrated),
    );

    // ── Corrupt index recovery ───────────────────────────────────────────────
    await fs.writeFile(path.join(tmp, 'library', 'index.json'), '{ this is not json');
    const keptDir = await leftover('m_unlisted_again');
    await lib.removeLeftovers();
    check('with a damaged index, unlisted folders are left alone', await exists(keptDir));
    const recovered = await lib.loadSnapshot();
    check(
      'recovers from a corrupt index',
      recovered.maps.length === 0 && recovered.settings.currentMapId === null,
    );
    const backups = (await fs.readdir(path.join(tmp, 'library'))).filter((f) =>
      f.startsWith('index.json.corrupt-'),
    );
    check('the corrupt index is backed up, not discarded', backups.length === 1, backups.join(', '));
  } catch (err) {
    check('test run completed without throwing', false, err?.stack ?? String(err));
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  // Best effort, so a locked file can never keep the process (and Electron) alive
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 3 }).catch((err) => {
    console.warn(`Couldn’t remove ${tmp}: ${err.code ?? err}`);
  });
  app.exit(failed.length ? 1 : 0);
});

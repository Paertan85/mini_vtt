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

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
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
    check('addImage returns an entry', !!a, a ? `id=${a.entry.id}` : 'null');
    check(
      'dimensions are read',
      a.entry.width === 64 && a.entry.height === 64,
      `${a.entry.width}x${a.entry.height}`,
    );
    check('name comes from the filename', a.entry.name === 'alpha', a.entry.name);
    check('media is served via map-media://', a.mediaUrl === `map-media://${a.entry.id}`, a.mediaUrl);
    check('a thumbnail is generated', a.thumbDataUrl.startsWith('data:image/png;base64,'));
    check('defaults: zoom 1, no fog', a.entry.zoom === 1 && a.entry.hasFog === false);

    const b = await lib.addMap(await fixture('beta.png', makePng({ rgb: [30, 110, 60] })));
    check('ids are unique', a.entry.id !== b.entry.id);
    check(
      'rejects files that are not images',
      (await lib.addMap(await fixture('notes.png', 'definitely not an image'))) === null,
    );

    const snap = await lib.loadSnapshot();
    check(
      'snapshot lists both maps, newest first',
      snap.maps.length === 2 && snap.maps[0].id === b.entry.id,
      `got ${snap.maps.length}`,
    );
    check('last import becomes the current map', snap.settings.currentMapId === b.entry.id);
    check('image file resolves on disk', !!(await lib.resolveMapMediaPath(a.entry.id)));
    check('thumbnail reloads', !!(await lib.loadMapThumb(a.entry.id))?.startsWith('data:image/png'));

    // ── Fog ──────────────────────────────────────────────────────────────────
    const fogUrl = `data:image/png;base64,${makePng({ rgb: [9, 9, 11], leftHalfOnly: true }).toString('base64')}`;
    check('saveMapFog succeeds', (await lib.saveMapFog(a.entry.id, fogUrl)) === true);
    const fogBack = await lib.loadMapFog(a.entry.id);
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
    check(
      'hasFog flag is set',
      (await lib.loadSnapshot()).maps.find((m) => m.id === a.entry.id).hasFog === true,
    );
    check(
      'saveMapFog rejects data that is not a PNG',
      (await lib.saveMapFog(a.entry.id, 'data:image/png;base64,aGVsbG8=')) === false,
    );

    // ── View state ───────────────────────────────────────────────────────────
    await lib.saveMapView(a.entry.id, {
      zoom: 2.5,
      pan: { x: 123, y: 456 },
      rotation: 450,
      mirrorHorizontal: true,
      mirrorVertical: false,
    });
    let aMeta = (await lib.loadSnapshot()).maps.find((m) => m.id === a.entry.id);
    check('zoom and pan persist', aMeta.zoom === 2.5 && aMeta.pan.x === 123 && aMeta.pan.y === 456);
    check('rotation is normalised to 0-359', aMeta.rotation === 90, String(aMeta.rotation));
    check('mirroring persists', aMeta.mirrorHorizontal === true && aMeta.mirrorVertical === false);
    await lib.saveMapView(a.entry.id, {
      zoom: 3,
      pan: null,
      rotation: 0,
      mirrorHorizontal: false,
      mirrorVertical: false,
    });
    aMeta = (await lib.loadSnapshot()).maps.find((m) => m.id === a.entry.id);
    check(
      'a null pan keeps the saved pan',
      aMeta.zoom === 3 && aMeta.pan.x === 123,
      JSON.stringify(aMeta.pan),
    );
    check(
      'rejects a non-finite zoom',
      (await lib.saveMapView(a.entry.id, {
        zoom: NaN,
        pan: null,
        rotation: 0,
        mirrorHorizontal: false,
        mirrorVertical: false,
      })) === false,
    );
    check(
      "other maps' view state is untouched",
      (await lib.loadSnapshot()).maps.find((m) => m.id === b.entry.id).zoom === 1,
    );

    // ── Concurrent writes (regression: saves used to overwrite each other) ──
    await Promise.all([
      lib.saveMapView(a.entry.id, {
        zoom: 4,
        pan: { x: 1, y: 2 },
        rotation: 180,
        mirrorHorizontal: false,
        mirrorVertical: true,
      }),
      lib.saveSettings({ currentMapId: a.entry.id }),
      lib.saveSettings({ playerScreenDiagonal: 32, gridSize: 2 }),
      lib.renameMap(b.entry.id, 'Renamed concurrently'),
      lib.saveMapFog(b.entry.id, fogUrl),
    ]);
    const conc = await lib.loadSnapshot();
    const concA = conc.maps.find((m) => m.id === a.entry.id);
    const concB = conc.maps.find((m) => m.id === b.entry.id);
    check('concurrent: view state kept', concA.zoom === 4 && concA.rotation === 180 && concA.mirrorVertical);
    check(
      'concurrent: both settings patches kept',
      conc.settings.currentMapId === a.entry.id && conc.settings.playerScreenDiagonal === 32,
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

    // ── Rename and reorder ───────────────────────────────────────────────────
    check('rename rejects a blank name', (await lib.renameMap(a.entry.id, '   ')) === false);
    check('reorder accepts a full permutation', (await lib.reorderMaps([a.entry.id, b.entry.id])) === true);
    check('reorder is applied', (await lib.loadSnapshot()).maps[0].id === a.entry.id);
    check('reorder rejects a partial list', (await lib.reorderMaps([a.entry.id])) === false);

    // ── Path traversal guards ────────────────────────────────────────────────
    check(
      'traversal id rejected by resolveMapMediaPath',
      (await lib.resolveMapMediaPath('../../evil')) === null,
    );
    check('traversal id rejected by saveMapFog', (await lib.saveMapFog('../evil', fogUrl)) === false);
    check('traversal id rejected by removeMap', (await lib.removeMap('../../evil')) === false);

    // ── Delete ───────────────────────────────────────────────────────────────
    const aDir = path.join(tmp, 'library', a.entry.id);
    check('map folder exists before delete', await exists(path.join(aDir, 'fog.png')));
    check('removeMap succeeds', (await lib.removeMap(a.entry.id)) === true);
    check('map folder is removed', !(await exists(aDir)));
    const afterDelete = await lib.loadSnapshot();
    check('index no longer lists the map', !afterDelete.maps.some((m) => m.id === a.entry.id));
    check('deleted map is pruned from mapOrder', !afterDelete.settings.mapOrder?.includes(a.entry.id));
    check('deleted current map clears currentMapId', afterDelete.settings.currentMapId === null);
    check(
      'a late fog save cannot recreate a deleted map',
      (await lib.saveMapFog(a.entry.id, fogUrl)) === false && !(await exists(aDir)),
    );

    // ── Handouts ─────────────────────────────────────────────────────────────
    const handout = await lib.addHandout(await fixture('letter.png', makePng({ width: 300, height: 100 })));
    check('addHandout returns metadata', !!handout && handout.id.startsWith('h_'));
    check('handout image resolves', !!(await lib.resolveHandoutPath(handout.id)));
    check('handout thumbnail is generated', !!(await lib.loadHandoutThumb(handout.id)));
    await lib.rotateHandout(handout.id, -90);
    check('handout rotation is normalised', (await lib.loadSnapshot()).handouts[0].rotation === 270);
    check('removeHandout succeeds', (await lib.removeHandout(handout.id)) === true);
    check('handout is gone', (await lib.resolveHandoutPath(handout.id)) === null);

    // ── Settings from libraries written before 1.1 ──────────────────────────
    const indexPath = path.join(tmp, 'library', 'index.json');
    const stored = JSON.parse(await fs.readFile(indexPath, 'utf8'));
    stored.settings = { currentMapId: null, playerViewDiagonal: '27', gridSize: '1.5' };
    await fs.writeFile(indexPath, JSON.stringify(stored));
    const migrated = (await lib.loadSnapshot()).settings;
    check(
      'old string settings are migrated to numbers',
      migrated.playerScreenDiagonal === 27 && migrated.gridSize === 1.5,
      JSON.stringify(migrated),
    );

    // ── Corrupt index recovery ───────────────────────────────────────────────
    await fs.writeFile(path.join(tmp, 'library', 'index.json'), '{ this is not json');
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
  await fs.rm(tmp, { recursive: true, force: true });
  app.exit(failed.length ? 1 : 0);
});

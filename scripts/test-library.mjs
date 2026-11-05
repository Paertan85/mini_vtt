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
  const gridLib = await import('../dist-electron/grid.test.mjs');
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

    // ── Project files ────────────────────────────────────────────────────────
    // Library now holds map b (renamed, with fog). Add a second map, a handout,
    // view state and settings, then export, empty the library and import.
    const c = await lib.addMap(await fixture('gamma.png', makePng({ width: 80, height: 40 })));
    await lib.reorderMaps([b.entry.id, c.entry.id]);
    await lib.saveMapView(b.entry.id, {
      zoom: 1.75,
      pan: { x: 10, y: 20 },
      rotation: 270,
      mirrorHorizontal: true,
      mirrorVertical: false,
    });
    const letter = await lib.addHandout(await fixture('letter2.png', makePng({ width: 120, height: 60 })));
    await lib.rotateHandout(letter.id, 90);
    await lib.saveSettings({ playerScreenDiagonal: 43, gridSize: 2.5 });
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

    // Area templates: old circles load unchanged, shapes have the D&D outlines
    const [old, cone] = gridLib.normalizeCircles([
      { id: 'old', x: 1, y: 2, radiusFt: 15, kind: 'fire' },
      { id: 'cone', x: 0, y: 0, radiusFt: 15, kind: 'magic', shape: 'cone', angle: -90, widthFt: 0.2 },
    ]);
    check(
      'templates saved before shapes are circles',
      old.shape === 'circle' && old.angle === 0 && old.widthFt === 5,
      JSON.stringify(old),
    );
    check('angles are wrapped into 0..360', cone.shape === 'cone' && cone.angle === 270);
    check(
      'an unknown shape falls back to a circle',
      gridLib.normalizeCircles([{ id: 'x', x: 0, y: 0, radiusFt: 5, kind: 'fire', shape: 'star' }])[0]
        .shape === 'circle',
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
      JSON.stringify(gridLib.areaOutline(disc('cone'))) ===
        JSON.stringify([
          { x: 0, y: 0 },
          { x: 10, y: 5 },
          { x: 10, y: -5 },
        ]),
      JSON.stringify(gridLib.areaOutline(disc('cone'))),
    );
    check(
      'a line is centred on its direction',
      JSON.stringify(gridLib.areaOutline(disc('line'))) ===
        JSON.stringify([
          { x: 0, y: 1 },
          { x: 10, y: 1 },
          { x: 10, y: -1 },
          { x: 0, y: -1 },
        ]),
    );
    {
      // A 10 px square turned 45 degrees: corners on the axes, about the centre
      const turned = gridLib.areaOutline(disc('square', { angle: 45 }));
      const round = (points) =>
        points.map(({ x, y }) => [Math.round(x * 100) / 100, Math.round(y * 100) / 100]);
      const axisAligned = round(gridLib.areaOutline(disc('square')));
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
        JSON.stringify(gridLib.areaHandle(disc('square'))) === JSON.stringify({ x: 5, y: 0 }),
      );
    }
    check(
      'points inside a cone are found, outside are not',
      gridLib.areaContains(disc('cone'), { x: 8, y: 3 }, 0) &&
        !gridLib.areaContains(disc('cone'), { x: 2, y: 3 }, 0),
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
      JSON.stringify(gridLib.snapArea({ x: 130, y: 99 }, square(10), measured)) ===
        JSON.stringify({ x: 110, y: 60 }) &&
        JSON.stringify(gridLib.snapArea({ x: 130, y: 99 }, square(15), measured)) ===
          JSON.stringify({ x: 160, y: 110 }),
      JSON.stringify(gridLib.snapArea({ x: 130, y: 99 }, square(10), measured)),
    );

    check('a new map has no grid or circles', c.entry.grid === null && c.entry.circles.length === 0);
    check('saveMapGrid stores the grid', (await lib.saveMapGrid(c.entry.id, measured)) === true);
    check(
      'saveMapGrid rejects an invalid grid',
      (await lib.saveMapGrid(c.entry.id, { cell: -4, offsetX: 0, offsetY: 0, feetPerCell: 5 })) === false,
    );
    const goodCircle = { id: 'c1', x: 160, y: 110, radiusFt: 15, kind: 'magic' };
    await lib.saveMapView(c.entry.id, {
      zoom: 1,
      pan: null,
      rotation: 0,
      mirrorHorizontal: false,
      mirrorVertical: false,
      circles: [
        goodCircle,
        { id: 'c1', x: 1, y: 1, radiusFt: 5, kind: 'fire' }, // duplicate id
        { id: '../x', x: 1, y: 1, radiusFt: 5, kind: 'fire' }, // unsafe id
        { id: 'c2', x: 1, y: 1, radiusFt: 5, kind: 'lava' }, // unknown kind
        { id: 'c3', x: 1, y: 1, radiusFt: 9999, kind: 'poison' }, // clamped
      ],
    });
    const calibrated = (await lib.loadSnapshot()).maps.find((m) => m.id === c.entry.id);
    check('the grid persists', calibrated.grid?.cell === 100, JSON.stringify(calibrated.grid));
    check(
      'circles persist, invalid ones are dropped and radii clamped',
      calibrated.circles.length === 2 &&
        calibrated.circles[0].id === 'c1' &&
        calibrated.circles[1].radiusFt === gridLib.MAX_RADIUS_FT,
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
    check('a map starts without effects', (await lib.loadMapEffects(c.entry.id)) === null);
    check('saveMapEffects stores a PNG', (await lib.saveMapEffects(c.entry.id, effectsUrl)) === true);
    check('effects reload losslessly', (await lib.loadMapEffects(c.entry.id)) === effectsUrl);
    check(
      'saveMapEffects rejects data that is not a PNG',
      (await lib.saveMapEffects(c.entry.id, 'data:image/png;base64,aGVsbG8=')) === false,
    );
    check(
      'saveMapEffects rejects a traversal id',
      (await lib.saveMapEffects('../evil', effectsUrl)) === false,
    );
    check(
      'saveMapEffects ignores a deleted map',
      (await lib.saveMapEffects(a.entry.id, effectsUrl)) === false && !(await exists(aDir)),
    );
    await lib.saveMapEffects(b.entry.id, effectsUrl);
    await lib.saveMapEffects(b.entry.id, null);
    check(
      'saving null removes the effects file',
      !(await exists(path.join(tmp, 'library', b.entry.id, 'effects.png'))),
    );

    const projectPath = path.join(fixtures, 'campaign.minivtt');
    const exported = await lib.exportProject(projectPath);
    check(
      'export counts maps and handouts',
      exported.maps === 2 && exported.handouts === 1,
      JSON.stringify(exported),
    );
    check('export leaves no temp file', !(await fs.readdir(fixtures)).some((f) => f.endsWith('.tmp')));

    await lib.removeMap(b.entry.id);
    await lib.removeMap(c.entry.id);
    await lib.removeHandout(letter.id);
    await lib.saveSettings({ playerScreenDiagonal: null, gridSize: 1 });

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
    check('imported maps get fresh ids', first.id !== b.entry.id && second.id !== c.entry.id);
    const importedFog = await lib.loadMapFog(first.id);
    check('fog is kept', first.hasFog && importedFog === fogUrl && !second.hasFog);
    check(
      'effects travel with the project',
      (await lib.loadMapEffects(second.id)) === effectsUrl && (await lib.loadMapEffects(first.id)) === null,
    );
    check(
      'grid and circles travel with the project',
      second.grid?.cell === 100 && second.circles.length === 2 && first.grid === null,
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
        afterImport.settings.gridSize === 2.5,
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
  // Best effort, so a locked file can never keep the process (and Electron) alive
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 3 }).catch((err) => {
    console.warn(`Couldn’t remove ${tmp}: ${err.code ?? err}`);
  });
  app.exit(failed.length ? 1 : 0);
});

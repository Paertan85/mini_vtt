// electron-builder afterPack hook: embed the app icon into the packaged exe.
//
// Why this exists: build.win.signAndEditExecutable is false (the winCodeSign
// package that provides electron-builder's own rcedit needs symlink privileges
// to extract, which fails on Windows without Developer Mode). That flag also
// disables icon embedding, so win-unpacked/<app>.exe keeps the default Electron
// atom -- which is the exe that gets installed, so Start Menu, taskbar and
// Alt-Tab would all show Electron's logo.
//
// The NSIS installer and the portable target get their icon from the NSIS side
// and are unaffected. This hook fixes the one binary that isn't.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const projectDir = __dirname ? path.resolve(__dirname, '..') : process.cwd();
const LOCAL_TOOL = path.join(projectDir, 'build', 'tools', 'rcedit-x64.exe');
const CACHE = path.join(
  process.env.LOCALAPPDATA || path.join(process.env.HOME, '.cache'),
  'electron-builder',
  'Cache',
  'winCodeSign',
);

function findSevenZip() {
  const candidates = [
    path.join(projectDir, 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe'),
    path.join(projectDir, 'node_modules', '7zip-bin', 'win', 'x64', '7za'),
  ];
  return candidates.find((p) => fs.existsSync(p));
}

// Look for an already-extracted rcedit in electron-builder's cache.
function findCachedRcedit() {
  if (!fs.existsSync(CACHE)) return null;
  const hits = fs
    .readdirSync(CACHE, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(CACHE, d.name, 'rcedit-x64.exe'))
    .filter((p) => fs.existsSync(p));
  return hits[0] || null;
}

// Extract just rcedit from the cached winCodeSign archive, skipping darwin\
// (its .dylib entries are symlinks that Windows cannot create without
// Developer Mode, and they are useless for a Windows build anyway).
function extractRceditFromCache() {
  if (!fs.existsSync(CACHE)) return null;
  const sevenZip = findSevenZip();
  if (!sevenZip) return null;
  const archive = fs.readdirSync(CACHE).find((f) => f.endsWith('.7z'));
  if (!archive) return null;

  const dest = path.join(CACHE, 'rcedit-only');
  fs.mkdirSync(dest, { recursive: true });
  const r = spawnSync(sevenZip, ['x', `-o${dest}`, '-x!darwin\\*', '-y', path.join(CACHE, archive)], {
    encoding: 'utf8',
  });
  const out = path.join(dest, 'rcedit-x64.exe');
  return r.status === 0 && fs.existsSync(out) ? out : null;
}

function resolveRcedit() {
  if (fs.existsSync(LOCAL_TOOL)) return LOCAL_TOOL;
  return findCachedRcedit() || extractRceditFromCache();
}

module.exports = async function patchIcon(ctx) {
  const iconPath = path.join(projectDir, 'build', 'icon.ico');
  if (!fs.existsSync(iconPath)) {
    console.log('  • no build/icon.ico, skipping icon patch');
    return;
  }

  const productName = ctx.packager.appInfo.productFilename;
  const exePath = path.join(ctx.appOutDir, `${productName}.exe`);
  if (!fs.existsSync(exePath)) {
    console.log(`  • ${productName}.exe not found in appOutDir, skipping icon patch`);
    return;
  }

  const rcedit = resolveRcedit();
  if (!rcedit) {
    console.log('  • rcedit-x64.exe unavailable - app exe keeps the default Electron icon.');
    console.log('    Enable Windows Developer Mode (Settings > System > For developers),');
    console.log('    or place rcedit-x64.exe at build/tools/, then rebuild.');
    return;
  }

  const r = spawnSync(rcedit, [exePath, '--set-icon', iconPath], { encoding: 'utf8' });
  if (r.status === 0) {
    console.log(`  • set icon on ${path.basename(exePath)}`);
  } else {
    console.log(`  • rcedit failed for ${path.basename(exePath)}: ${(r.stderr || r.stdout || '').trim()}`);
  }
};

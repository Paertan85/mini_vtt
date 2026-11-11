// Scratch folders for the Electron test and report scripts, in the system's
// temp folder. The app's own processes keep files in them open until it has
// quit (on Windows that blocks deleting them), so each folder is deleted by a
// small helper process that waits for this one to end. A run that was killed
// before its helper could finish is swept up by a later run.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Every scratch folder starts with this; the app itself never uses the temp folder */
const PREFIX = 'minivtt-';
/** Older than this, a scratch folder is left over (no run takes this long) */
const STALE_MS = 60 * 60 * 1000;

/**
 * The helper: wait for the process to end, however long it runs (a memory
 * report takes minutes), then delete the folder, retrying for a few seconds
 * while the app's last processes let go of its files.
 */
const HELPER = `
const fs = require('node:fs');
const [pid, dir] = process.argv.slice(1);
const alive = () => { try { process.kill(Number(pid), 0); return true; } catch { return false; } };
const wait = () => {
  if (alive()) return setTimeout(wait, 250);
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); } catch {}
};
wait();
`;

/** Deletes scratch folders left over from earlier runs. */
function sweep() {
  const tmp = os.tmpdir();
  let names = [];
  try {
    names = fs.readdirSync(tmp).filter((name) => name.startsWith(PREFIX));
  } catch {
    return;
  }
  for (const name of names) {
    const dir = path.join(tmp, name);
    try {
      if (Date.now() - fs.statSync(dir).mtimeMs < STALE_MS) continue;
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Still in use, or already gone: a later run tries again
    }
  }
}

/**
 * A new scratch folder named `minivtt-<name>-…`, deleted once this process
 * has ended. Leftovers from earlier runs are deleted first.
 */
export function scratchDir(name) {
  sweep();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${PREFIX}${name}-`));
  // Electron's own binary, run as plain Node
  const helper = spawn(process.execPath, ['-e', HELPER, String(process.pid), dir], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  helper.unref();
  return dir;
}

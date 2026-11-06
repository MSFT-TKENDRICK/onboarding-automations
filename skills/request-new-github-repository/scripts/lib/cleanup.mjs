// A browser may hold its profile briefly after closing. Only the exact profile created by this run is removed.
import { existsSync, readlinkSync, rmSync } from 'node:fs';
import { setPriority } from 'node:os';
import { join, basename } from 'node:path';
import { pathToFileURL } from 'node:url';

export const PREFIX = 'startright-skill-';

export function profileInUse(dir) {
  if (process.platform === 'win32') {
    const lock = join(dir, 'lockfile');
    if (!existsSync(lock)) return false;
    try { rmSync(lock); return false; } catch { return true; }
  }
  try {
    const pid = Number(readlinkSync(join(dir, 'SingletonLock')).split('-').pop());
    if (!pid) return true;
    try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
  } catch { return false; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function removeWhenFree(dir, { timeoutMs = 120000, intervalMs = 1000 } = {}) {
  if (!basename(dir).startsWith(PREFIX)) throw new Error(`refusing to delete ${dir}`);
  const until = Date.now() + timeoutMs;
  while (existsSync(dir) && Date.now() < until) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { await sleep(intervalMs); }
  }
  return !existsSync(dir);
}

// node cleanup.mjs profileDir
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  try { setPriority(19); } catch {}
  if (args.length !== 1 || args[0].startsWith('--')) throw new Error('Expected exactly one throwaway profile directory.');
  if (!await removeWhenFree(args[0])) {
    console.error(`Could not remove the temporary browser profile: ${args[0]}`);
    process.exitCode = 1;
  }
}

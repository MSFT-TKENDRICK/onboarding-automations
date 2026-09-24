// Out-of-process profile cleanup, never on the CLI's critical path. A killed browser may hold its files for
// several seconds (EDR/AV on managed Windows machines), and harnesses may kill all descendants when the CLI
// exits (Windows job objects). So: at launch a low-priority sweeper removes earlier runs' profiles that are
// provably unused while this run works; at close a best-effort helper retries removing this run's profile.
import { existsSync, readdirSync, readlinkSync, rmSync, statSync } from 'node:fs';
import { tmpdir, setPriority } from 'node:os';
import { join, basename } from 'node:path';
import { pathToFileURL } from 'node:url';

export const PREFIX = 'mcaps-skill-';

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

export function sweepStaleProfiles({ root = tmpdir(), maxAgeMs = 60 * 60 * 1000, limit = 10 } = {}) {
  let removed = 0;
  for (const name of readdirSync(root)) {
    if (!name.startsWith(PREFIX) || removed >= limit) continue;
    const dir = join(root, name);
    try {
      if (Date.now() - statSync(dir).mtimeMs > maxAgeMs && !profileInUse(dir)) { rmSync(dir, { recursive: true, force: true }); removed++; }
    } catch {}
  }
  return removed;
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

// node cleanup.mjs [--sweep] [profileDir]
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  try { setPriority(19); } catch {}
  const dir = args.find((a) => !a.startsWith('--'));
  if (args.includes('--sweep')) { try { sweepStaleProfiles({ maxAgeMs: 2 * 60 * 1000, limit: 25 }); } catch {} }
  if (dir) await removeWhenFree(dir).catch(() => {});
}

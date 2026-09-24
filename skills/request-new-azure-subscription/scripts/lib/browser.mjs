// Locate and launch a Chromium browser (Edge preferred for Windows SSO), driven over --remote-debugging-pipe.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { connectPipe } from './cdp.mjs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PREFIX, profileInUse } from './cleanup.mjs';

const CANDIDATES = {
  win32: [
    join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft\\Edge\\Application\\msedge.exe'),
    join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Microsoft\\Edge\\Application\\msedge.exe'),
    join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
    join(process.env.LOCALAPPDATA ?? '', 'Google\\Chrome\\Application\\chrome.exe'),
  ],
  darwin: [
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ],
  linux: ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'],
};

export function findBrowser(explicit = process.env.MCAPS_BROWSER) {
  if (explicit) {
    if (!existsSync(explicit)) throw new Error(`Browser not found at ${explicit}`);
    return explicit;
  }
  const hit = (CANDIDATES[process.platform] ?? CANDIDATES.linux).find((p) => p && existsSync(p));
  if (!hit) throw new Error('No Edge/Chrome found. Install Microsoft Edge or set MCAPS_BROWSER to a Chromium executable.');
  return hit;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Force-kill the whole process tree without waiting: on managed Windows machines process teardown can take
// several seconds after termination is requested, and nothing we need lives in the throwaway profile.
function killTree(proc) {
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, detached: true }).unref();
    else proc.kill('SIGKILL');
  } catch {}
  proc.unref();
}

const CLEANER = fileURLToPath(new URL('./cleanup.mjs', import.meta.url));

// Delete the profile off the critical path: a detached helper retries until the browser has released it
// and also sweeps stale profiles from earlier runs.
function cleanupDetached(...args) {
  try { spawn(process.execPath, [CLEANER, ...args], { stdio: 'ignore', windowsHide: true, detached: true }).unref(); } catch {}
}

// profileDir: optional persistent profile (cookie + HTTP cache reuse across runs). Falls back to a throwaway
// profile when it is locked by another (or a still-exiting) browser, so runs never block on each other.
export async function launchBrowser(opts = {}) {
  try { return await launchOnce(opts); } catch (e) {
    // Lost a race for the persistent profile (the second browser hands off to the first and exits).
    if (!e.persistent) throw e;
    opts.log?.(`persistent profile launch failed (${e.message}); retrying with a throwaway profile`);
    return launchOnce({ ...opts, profileDir: undefined });
  }
}

// Live browsers, killed on SIGINT/SIGTERM so an interrupted run never leaves a signed-in browser behind.
const live = new Set();
export function killAllBrowsers() { for (const b of live) { b.cdp.close(); killTree(b.proc); } live.clear(); }

async function launchOnce({ browserPath = findBrowser(), headless = true, extraArgs = [], timeoutMs = 45000, profileDir, log = () => {} } = {}) {
  let persistent = false;
  let userDataDir;
  if (profileDir) {
    mkdirSync(profileDir, { recursive: true, mode: 0o700 });
    if (profileInUse(profileDir)) log(`profile in use, using a throwaway profile: ${profileDir}`);
    else { persistent = true; userDataDir = profileDir; }
  }
  userDataDir ??= mkdtempSync(join(tmpdir(), PREFIX));
  const args = [
    // CDP over fds 3/4 instead of a TCP port: no other local process can attach to the signed-in browser,
    // there is no DevToolsActivePort file to poll, and Chromium shuts down when this process's pipe closes.
    `--user-data-dir=${userDataDir}`, '--remote-debugging-pipe', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-background-networking', '--disable-sync', '--disable-component-update',
    '--disable-default-apps', '--mute-audio', '--window-size=1280,2000', '--hide-crash-restore-bubble',
    // Noise reduction (chrome-launcher defaults): fewer background targets/processes competing with the task.
    '--disable-component-extensions-with-background-pages', '--disable-client-side-phishing-detection', '--disable-domain-reliability',
    '--disable-hang-monitor', '--no-pings', '--metrics-recording-only', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    '--disable-features=Translate,OptimizationHints,MediaRouter,DialMediaRouteProvider,CalculateNativeWinOcclusion,AutofillServerCommunication,CertificateTransparencyComponentUpdater,msEdgeShoppingUI,msEdgeCollections,EdgeSidebar',
    ...(headless ? ['--headless=new'] : []),
    ...(process.platform === 'linux' && process.getuid?.() === 0 ? ['--no-sandbox'] : []),
    ...extraArgs, 'about:blank',
  ];
  const proc = spawn(browserPath, args, { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'], detached: false, windowsHide: true });
  let exited = false;
  let spawnError = null;
  proc.on('exit', () => { exited = true; live.delete(handle); });
  proc.on('error', (e) => { exited = true; spawnError = e; });
  cleanupDetached('--sweep');
  const cdp = connectPipe(proc.stdio[3], proc.stdio[4]);
  const handle = {
    proc, cdp, userDataDir, persistent,
    get exited() { return exited; },
    // Throwaway profile: kill immediately. Persistent profile: the caller has asked the browser to close
    // gracefully (flushes the lazily-committed cookie store); wait briefly for the profile lock, then kill.
    async close({ graceMs = persistent ? 3000 : 0 } = {}) {
      const until = Date.now() + graceMs;
      while (!exited && Date.now() < until && profileInUse(userDataDir)) await sleep(25);
      cdp.close();
      if (!exited) killTree(proc);
      live.delete(handle);
      if (!persistent) cleanupDetached(userDataDir);
    },
  };
  live.add(handle);
  try {
    // The first reply proves the browser is up. A browser that lost the profile to another instance hands off
    // and exits, which closes the pipe and rejects this call.
    await cdp.send('Browser.getVersion', {}, undefined, { timeoutMs });
  } catch (e) {
    cdp.close();
    killTree(proc);
    live.delete(handle);
    if (!persistent) cleanupDetached(userDataDir);
    const err = new Error(spawnError ? `Browser failed to start: ${spawnError.message}` : exited || /closed/.test(e.message) ? `Browser exited during startup: ${browserPath}` : `Browser did not answer CDP in time: ${e.message}`);
    err.persistent = persistent;
    throw err;
  }
  return handle;
}

// Real-browser launch contract: CDP over a pipe (no TCP DevTools endpoint) and no orphaned signed-in browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { findBrowser, launchBrowser } from '../../skills/request-new-github-repository/scripts/lib/browser.mjs';

let skip = false;
try { findBrowser(); } catch { skip = 'no Chromium-family browser found'; }
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('launch uses a pipe: no DevToolsActivePort file, CDP answers', { skip, timeout: 120000 }, async () => {
  const b = await launchBrowser();
  try {
    assert.equal(existsSync(join(b.userDataDir, 'DevToolsActivePort')), false);
    const v = await b.cdp.send('Browser.getVersion');
    assert.match(v.product, /(Chrome|Edg|Chromium)/i);
  } finally { await b.close(); }
});

test('the browser exits when the controlling process is killed', { skip, timeout: 180000 }, async () => {
  const lib = new URL('../../skills/request-new-github-repository/scripts/lib/browser.mjs', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    const { launchBrowser } = await import(${JSON.stringify(lib)});
    const b = await launchBrowser();
    process.stdout.write(JSON.stringify({ pid: b.proc.pid }) + '\\n');
    setInterval(() => {}, 1000);`], { stdio: ['ignore', 'pipe', 'inherit'] });
  const line = await new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (d) => { out += d; if (out.includes('\n')) resolve(out.split('\n')[0]); });
    child.on('exit', (c) => reject(new Error(`child exited early (${c})`)));
  });
  const { pid } = JSON.parse(line);
  assert.ok(alive(pid));
  child.kill('SIGKILL'); // no cleanup code runs: only the closed pipe tells the browser to quit
  const until = Date.now() + 150000;
  while (alive(pid) && Date.now() < until) await sleep(250);
  assert.equal(alive(pid), false, 'browser outlived its controller');
});

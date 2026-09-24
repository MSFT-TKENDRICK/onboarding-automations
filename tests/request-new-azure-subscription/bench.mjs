// Benchmark: node tests/request-new-azure-subscription/bench.mjs [runs=5]
// Runs `plan` against the mock portal with a warm persistent profile and with throwaway profiles and prints
// median phase timings (ms). Live numbers are recorded in skills/request-new-azure-subscription/references/BENCHMARKS.md.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMockPortal, DEFAULTS } from './fixtures/mock-portal.mjs';
import { run } from '../../skills/request-new-azure-subscription/scripts/mcaps-subscription.mjs';
import { profileInUse } from '../../skills/request-new-azure-subscription/scripts/lib/cleanup.mjs';

const runs = Number(process.argv[2] ?? 5);
const median = (xs) => { const s = xs.filter((x) => x != null).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
const m = await startMockPortal({ users: structuredClone(DEFAULTS.users) });
const home = mkdtempSync(join(tmpdir(), 'mcaps-bench-'));
const env = { ...process.env, MCAPS_PORTAL_URL: m.formUrl, MCAPS_SKILL_HOME: home };
const args = ['plan', '--title', 'Bench', '--purpose', 'Hybrid', '--type', 'internal', '--owner', 'testuser@contoso.com', '--allowance', '500', '--timezone', 'Pacific'];

async function series(label, extra) {
  const rows = [];
  for (let i = 0; i < runs; i++) {
    for (let j = 0; j < 100 && profileInUse(join(home, 'profile')); j++) await new Promise((r) => setTimeout(r, 100));
    const t = performance.now();
    const r = await run([...args, ...extra], { env });
    if (r.out.status !== 'ready') throw new Error(`${label}: ${JSON.stringify(r.out)}`);
    rows.push({ wall: Math.round(performance.now() - t), ...r.out.phases, fill: r.out.timings.total, profile: r.out.profile });
  }
  const keys = ['wall', 'browserLaunched', 'pageReady', 'signInClicked', 'formReady', 'formQuiet', 'fill'];
  console.log(`${label.padEnd(12)} ${keys.map((k) => `${k}=${median(rows.map((x) => x[k])) ?? '-'}`).join(' ')} profiles=${[...new Set(rows.map((x) => x.profile))].join('/')}`);
}

try {
  await run([...args], { env }); // warm the persistent profile
  await series('persistent', []);
  await series('ephemeral', ['--ephemeral']);
} finally {
  await m.close();
  try { rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 }); } catch {}
}

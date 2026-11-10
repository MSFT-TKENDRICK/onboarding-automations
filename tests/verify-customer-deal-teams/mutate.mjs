import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const sourcePath = new URL('../../skills/verify-customer-deal-teams/scripts/plan.mjs', import.meta.url);
const testsPath = new URL('./plan.test.mjs', import.meta.url);
const source = await readFile(sourcePath, 'utf8');
const tests = await readFile(testsPath, 'utf8');
const mutations = [
  ['identity', "&& guid(identity.userId, 'user') === userId", '&& true'],
  ['tenant', "guid(identity.tenantId, 'tenant') === tenantId", 'true'],
  ['complete reads', 'value.complete === true', 'true'],
  ['fresh evidence', 'at <= now && now - at <= MAX_AGE_MS', 'true'],
  ['assignment user', "guid(row.userId, 'assignment user') === userId", 'true'],
  ['active assignment', 'row.active === true, \'inactive assignment', 'true, \'inactive assignment'],
  ['effective assignment', 'start < end && start <= now && now < end', 'true'],
  ['exact account', 'assigned.has(accountId)', 'true'],
  ['open opportunity', "row.state === 'open'", 'true'],
  ['membership user', "guid(row.userId, 'membership user') === userId", 'true'],
  ['existing membership', 'if (members.has(opportunity.id))', 'if (false)'],
  ['explicit pending approval', "status: 'pending-approval'", "status: 'approved'"],
];
const root = await mkdtemp(join(tmpdir(), 'deal-team-mutations-'));
let killed = 0;
let failed = false;
try {
  const mutant = join(root, 'plan.mjs');
  const testFile = join(root, 'plan.test.mjs');
  await writeFile(testFile, tests.replaceAll(
    '../../skills/verify-customer-deal-teams/scripts/plan.mjs', pathToFileURL(mutant).href));
  await writeFile(mutant, source);
  const baseline = spawnSync(process.execPath, ['--test', testFile], {
    encoding: 'utf8', timeout: 60000,
  });
  if (baseline.status !== 0) throw new Error(`mutation baseline failed:\n${baseline.stdout}\n${baseline.stderr}`);
  for (const [name, before, after] of mutations) {
    if (source.split(before).length !== 2) throw new Error(`${name}: ambiguous/missing mutation anchor`);
    await writeFile(mutant, source.replace(before, after));
    const syntax = spawnSync(process.execPath, ['--check', mutant], { encoding: 'utf8', timeout: 10000 });
    if (syntax.status !== 0) throw new Error(`${name}: invalid mutant`);
    const run = spawnSync(process.execPath, ['--test', testFile], { encoding: 'utf8', timeout: 60000 });
    if (run.error || ![0, 1].includes(run.status)) throw new Error(`${name}: test infrastructure failure`);
    if (run.status === 1 && /ERR_ASSERTION/.test(run.stdout)) {
      killed++;
      console.log(`killed: ${name}`);
    } else {
      failed = true;
      console.log(`survived or not assertion-killed: ${name}`);
    }
  }
  console.log(JSON.stringify({ selected: mutations.length, killed, survived: mutations.length - killed }));
} finally {
  await rm(root, { recursive: true, force: true });
}
process.exitCode = failed ? 1 : 0;

#!/usr/bin/env node

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { mutationGateFailed } from './quality-lib.mjs';

const thresholdIndex = process.argv.indexOf('--threshold');
const threshold = thresholdIndex === -1 ? 70 : Number(process.argv[thresholdIndex + 1]);
if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) throw new Error('Mutation threshold must be 0-100.');

const PROPERTY = ['tests/quality/property.test.mjs'];
const CONTRACT = ['tests/quality/contracts.test.mjs'];
const MSX_NO_SSO = [
  '--test-name-pattern=^readiness mode does not start the server without an exact cached SSO identity$',
  'tests/check-msx-access/msx-access.test.mjs',
];
const MSX_MISMATCH = [
  '--test-name-pattern=^never contacts Dataverse using a token for a different SSO identity$',
  'tests/check-msx-access/msx-access.test.mjs',
];
const MSX_FAILURE = [
  '--test-name-pattern=^handles non-Error server failures without leaking arbitrary values$',
  'tests/check-msx-access/msx-access.test.mjs',
];
const READINESS_FAILURE = [
  '--test-name-pattern=^handles non-Error integration failures and continues other readiness checks$',
  'tests/new-hire-readiness/readiness.test.mjs',
];
const GATES = ['tests/quality/gates.test.mjs'];
const SYSTEMONE = ['tests/request-new-azure-subscription/systemone.test.mjs'];
const REQUEST_LIST = ['tests/request-new-azure-subscription/request-list.test.mjs'];
const BOTH = [...PROPERTY, ...CONTRACT];
const mutants = [
  ['github summarize error precedence', 'skills/check-github-access/scripts/github-access.mjs',
    "c.status === 'error'", "c.status === 'pass'", PROPERTY],
  ['github inaccessible repository fails closed', 'skills/check-github-access/scripts/github-access.mjs',
    "inaccessible ? 'action' : 'unknown'", "inaccessible ? 'pass' : 'unknown'", CONTRACT],
  ['github missing permissions stay unknown', 'skills/check-github-access/scripts/github-access.mjs',
    "allowed === null ? 'unknown' : allowed ? 'pass' : 'action'", "allowed === null ? 'pass' : allowed ? 'pass' : 'action'", PROPERTY],
  ['azure identity requires a true match', 'skills/check-msx-access/scripts/azure-probe.mjs',
    'if (match !== true)', 'if (match === true)', CONTRACT],
  ['azure WhoAmI pass is not downgraded', 'skills/check-msx-access/scripts/azure-probe.mjs',
    "who.ok ? 'pass' : who.code === 'forbidden' ? 'action' : 'unknown'", "who.ok ? 'unknown' : who.code === 'forbidden' ? 'action' : 'unknown'", CONTRACT],
  ['msx rejects wrong JSON-RPC versions', 'skills/check-msx-access/scripts/msx-access.mjs',
    "message.jsonrpc !== '2.0'", "message.jsonrpc === '2.0'", CONTRACT],
  ['msx does not probe profiles without a readiness identity', 'skills/check-msx-access/scripts/msx-access.mjs',
    'defaultEndpoint && (!requireIdentity || ssoUserId)', 'defaultEndpoint', MSX_NO_SSO],
  ['msx mismatched identity stays unknown', 'skills/check-msx-access/scripts/azure-probe.mjs',
    "      checks.push(check('msx.identity', 'unknown',",
    "      checks.push(check('msx.identity', 'action',", MSX_MISMATCH],
  ['msx rejects untrusted error codes', 'skills/check-msx-access/scripts/msx-access.mjs',
    'SAFE_ERROR_CODES.has(error.code)', 'true', MSX_FAILURE],
  ['msx rejects untrusted timeout text', 'skills/check-msx-access/scripts/msx-access.mjs',
    'TIMEOUT_REASONS.has(message)', "message.startsWith('MSX server timed out during ')", MSX_FAILURE],
  ['crap coverage excludes nested function ranges', 'scripts/quality-lib.mjs',
    'if (excluded.some((range) => range.start <= left && range.end >= right)) continue;',
    'if (false) continue;', GATES],
  ['crap coverage matches exact method ranges', 'scripts/quality-lib.mjs',
    'const range = method ? { start: parent.start, end: node.end } : node;',
    'const range = node;', GATES],
  ['test runner rejects unmatched selectors', 'scripts/run-tests.mjs',
    'if (!globSync(selector).length) throw new Error',
    'if (false) throw new Error', GATES],
  ['readiness rejects wrong schema versions', 'skills/new-hire-readiness/scripts/new-hire-readiness.mjs',
    'result?.schemaVersion !== 1', 'result?.schemaVersion === 1', CONTRACT],
  ['readiness error has highest precedence', 'skills/new-hire-readiness/scripts/new-hire-readiness.mjs',
    "c.status === 'error'", "c.status === 'pass'", PROPERTY],
  ['readiness rejects untrusted error codes', 'skills/new-hire-readiness/scripts/new-hire-readiness.mjs',
    'SAFE_ERROR_CODES.has(error.code)', 'true', READINESS_FAILURE],
  ['azure intent requires confidence threshold', 'skills/request-new-azure-subscription/scripts/lib/intent.mjs',
    'answer.p >= COMMIT_P', 'answer.p < COMMIT_P', PROPERTY],
  ['azure intent requires margin threshold', 'skills/request-new-azure-subscription/scripts/lib/intent.mjs',
    'answer.margin >= COMMIT_MARGIN', 'answer.margin < COMMIT_MARGIN', PROPERTY],
  ['azure intent rejects probability above one', 'skills/request-new-azure-subscription/scripts/lib/intent.mjs',
    'answer.p > 1', 'false', PROPERTY],
  ['azure intent rejects margin above probability', 'skills/request-new-azure-subscription/scripts/lib/intent.mjs',
    'if (answer.margin > answer.p)', 'if (false)', PROPERTY],
  ['system one rejects non-finite confidence', 'skills/request-new-azure-subscription/scripts/lib/systemone.mjs',
    '!Number.isFinite(ans.confidence)', 'false', SYSTEMONE],
  ['request history rejects missing or malformed lists', 'skills/request-new-azure-subscription/scripts/lib/page.mjs',
    "if (!data || typeof data !== 'object' || !Array.isArray(data.value)) return failed('request_list_invalid_response');",
    "if (!data || typeof data !== 'object' || !Array.isArray(data.value)) return { ok: true, rows: [], complete: true };", REQUEST_LIST],
  ['request history rejects malformed records', 'skills/request-new-azure-subscription/scripts/lib/page.mjs',
    "if (malformed) return incomplete('request_list_invalid_record');",
    "if (false) return incomplete('request_list_invalid_record');", REQUEST_LIST],
  ['request history refuses cross-origin continuations', 'skills/request-new-azure-subscription/scripts/lib/page.mjs',
    'next.origin !== initial.origin', 'false', REQUEST_LIST],
  ['duplicate checks require complete history', 'skills/request-new-azure-subscription/scripts/lib/portal.mjs',
    'recent.complete !== true', 'false', REQUEST_LIST],
  ['submission reconciliation requires complete history', 'skills/request-new-azure-subscription/scripts/lib/portal.mjs',
    'result.complete !== true', 'false', PROPERTY],
  ['submitted case must match response evidence', 'skills/request-new-azure-subscription/scripts/lib/portal.mjs',
    'page.caseIds[0] !== found.caseId', 'false', REQUEST_LIST],
  ['submitted case requires a successful response', 'skills/request-new-azure-subscription/scripts/lib/portal.mjs',
    'commit.status < 200 || commit.status >= 400', 'false', REQUEST_LIST],
  ['submitted case must occur in the POST response', 'skills/request-new-azure-subscription/scripts/lib/portal.mjs',
    'commit.responseCaseIds[0] !== found.caseId', 'false', REQUEST_LIST],
  ['submitted case requires a confirmation page', 'skills/request-new-azure-subscription/scripts/lib/portal.mjs',
    'page.confirmation !== true', 'false', REQUEST_LIST],
  ['a new case prevents a rejection conclusion', 'skills/request-new-azure-subscription/scripts/lib/portal.mjs',
    '!found && !ambiguous && lastOk', '!ambiguous && lastOk', REQUEST_LIST],
  ['repository creation only succeeds on 201', 'skills/request-new-github-repository/scripts/lib/contract.mjs',
    'if (status === 201)', 'if (status !== 201)', CONTRACT],
  ['repository throttling remains retryable', 'skills/request-new-github-repository/scripts/lib/contract.mjs',
    '[429, 503].includes(status)', '[429].includes(status)', PROPERTY],
  ['production classification remains blocked', 'skills/request-new-github-repository/scripts/lib/policy.mjs',
    'if (BLOCKED_CLASS.has(v) || /production|tcb|hvt/.test(v))', 'if (false)', PROPERTY],
];

const sourceRoot = process.cwd();
const workRoot = mkdtempSync(join(tmpdir(), 'onboarding-mutation-'));
const copyRoot = join(workRoot, 'repo');

function runTests(label, tests = BOTH) {
  const isolatedTemp = join(workRoot, `temp-${label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`);
  mkdirSync(isolatedTemp, { recursive: true });
  return spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...tests], {
    cwd: copyRoot,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, TEMP: isolatedTemp, TMP: isolatedTemp, TMPDIR: isolatedTemp },
  });
}
function classifyRun(run) {
  if (run.error?.code === 'ETIMEDOUT') return { outcome: 'timeout', reason: 'test timeout' };
  if (run.error) return { outcome: 'infrastructure_error', reason: `${run.error.code ?? 'spawn_error'}: ${run.error.message}` };
  if (typeof run.status !== 'number') return { outcome: 'infrastructure_error', reason: `terminated by ${run.signal ?? 'unknown signal'}` };
  return { outcome: run.status === 0 ? 'survived' : 'killed' };
}

const results = [];
try {
  cpSync(sourceRoot, copyRoot, {
    recursive: true,
    filter: (source) => {
      const path = relative(sourceRoot, source);
      return !path.startsWith('.git') && !path.startsWith('node_modules') && !path.startsWith('quality-reports');
    },
  });
  const selections = [...new Map([BOTH, ...mutants.map((entry) => entry[4])]
    .map((tests) => [JSON.stringify(tests), tests])).values()];
  for (const [index, tests] of selections.entries()) {
    const baseline = runTests(`baseline-${index}`, tests);
    const baselineResult = classifyRun(baseline);
    if (baselineResult.outcome !== 'survived') {
      throw new Error(`Mutation baseline failed for ${tests.join(' ')} (${baselineResult.outcome}: ${baselineResult.reason ?? `exit ${baseline.status}`}).`);
    }
  }

  for (const [name, file, before, after, tests] of mutants) {
    process.stderr.write(`mutating: ${name}\n`);
    const path = join(copyRoot, file);
    const original = readFileSync(path, 'utf8');
    const occurrences = original.split(before).length - 1;
    if (occurrences !== 1) {
      results.push({ name, file, outcome: 'invalid', reason: `expected one mutation point, found ${occurrences}` });
      continue;
    }
    writeFileSync(path, original.replace(before, after));
    const syntax = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    if (syntax.status !== 0) {
      results.push({ name, file, outcome: 'invalid', reason: 'mutant did not parse' });
      writeFileSync(path, original);
      continue;
    }
    const run = runTests(name, tests);
    const classified = classifyRun(run);
    results.push({
      name,
      file,
      ...classified,
    });
    writeFileSync(path, original);
  }
} finally {
  try { rmSync(workRoot, { recursive: true, force: true, maxRetries: 30, retryDelay: 1000 }); } catch (error) {
    console.error(`Could not remove isolated mutation temp root ${workRoot}: ${error.message}`);
    process.exitCode = 1;
  }
}

const scored = results.filter((item) => ['killed', 'survived'].includes(item.outcome));
const killed = scored.filter((item) => item.outcome === 'killed').length;
const survived = scored.filter((item) => item.outcome === 'survived').length;
const invalid = results.filter((item) => item.outcome === 'invalid').length;
const timeouts = results.filter((item) => item.outcome === 'timeout').length;
const infrastructureErrors = results.filter((item) => item.outcome === 'infrastructure_error').length;
const noCoverage = null;
const score = scored.length ? (killed / scored.length) * 100 : 0;
const byFile = Object.values(results.reduce((map, item) => {
  const row = map[item.file] ??= { file: item.file, killed: 0, survived: 0, invalid: 0, timeout: 0, infrastructure_error: 0 };
  row[item.outcome]++;
  return map;
}, {})).map((row) => ({
  ...row,
  score: row.killed + row.survived ? Number((100 * row.killed / (row.killed + row.survived)).toFixed(2)) : null,
}));
const report = { threshold, score: Number(score.toFixed(2)), killed, survived, noCoverage,
  noCoverageReason: 'not measured by the targeted source-replacement runner', invalid, timeouts, infrastructureErrors, byFile, mutants: results };
mkdirSync(join(sourceRoot, 'quality-reports'), { recursive: true });
writeFileSync(join(sourceRoot, 'quality-reports', 'mutation.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
if (mutationGateFailed({ score, threshold, invalid, timeouts, infrastructureErrors })) process.exitCode = 1;

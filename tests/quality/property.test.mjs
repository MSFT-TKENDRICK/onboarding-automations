import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs as parseGithubArgs, diagnose as diagnoseGithub, summarize } from '../../skills/check-github-access/scripts/github-access.mjs';
import { parseArgs as parseMsxArgs, safeReason } from '../../skills/check-msx-access/scripts/msx-access.mjs';
import { matchesSsoUser } from '../../skills/check-msx-access/scripts/azure-probe.mjs';
import { diagnose as diagnoseReadiness, parseArgs as parseReadinessArgs } from '../../skills/new-hire-readiness/scripts/new-hire-readiness.mjs';
import { decideIntent } from '../../skills/request-new-azure-subscription/scripts/lib/intent.mjs';
import { matchOption, normalize } from '../../skills/request-new-azure-subscription/scripts/lib/match.mjs';
import { classify, parseRole, validateRepo } from '../../skills/request-new-github-repository/scripts/lib/policy.mjs';
import { classifyCreate, checkResponse } from '../../skills/request-new-github-repository/scripts/lib/contract.mjs';
import { classifyReconciliation, reconcileRequestList } from '../../skills/request-new-azure-subscription/scripts/lib/portal.mjs';

const SEED = 0x5eedc0de;
function random(seed = SEED) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}
const pick = (rng, values) => values[Math.floor(rng() * values.length)];
const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-. /:\r\n';
function text(rng, max = 80) {
  return Array.from({ length: Math.floor(rng() * max) }, () => chars[Math.floor(rng() * chars.length)]).join('');
}
function assertStructured(result) {
  assert.equal(result.schemaVersion, 1);
  assert.ok(['ready', 'action', 'unknown', 'error'].includes(result.status));
  assert.ok(Array.isArray(result.checks) && result.checks.length > 0);
  for (const check of result.checks) {
    assert.equal(typeof check.id, 'string');
    assert.ok(['pass', 'action', 'unknown', 'error'].includes(check.status));
    assert.equal(typeof check.message, 'string');
  }
}
function assertParserResult(value) {
  assert.ok(value !== null && typeof value === 'object');
  if (value.timeoutMs !== undefined) assert.ok(value.timeoutMs >= 1000 && value.timeoutMs <= 300000);
}

test('property seed: CLI parsers either return bounded options or throw synchronously', () => {
  const rng = random();
  const parsers = [
    (args) => parseGithubArgs(['check', ...args]),
    (args) => parseMsxArgs(['check', ...args]),
    (args) => parseReadinessArgs(['check', ...args]),
  ];
  const flags = ['--account', '--org', '--repo', '--role', '--root', '--server', '--profile', '--sso-user-id', '--timeout-ms', '--unknown'];
  for (let run = 0; run < 500; run++) {
    const args = [];
    for (let i = 0; i < Math.floor(rng() * 8); i++) {
      args.push(pick(rng, flags));
      if (rng() > 0.2) args.push(text(rng, 50) || 'x');
    }
    for (const parse of parsers) {
      let value;
      try {
        value = parse(args);
      } catch (error) {
        assert.ok(error instanceof Error);
        assert.ok(error.message.length > 0);
        continue;
      }
      assertParserResult(value);
    }
  }
  assert.throws(() => assertParserResult(null), assert.AssertionError);
  assert.throws(() => assertParserResult({ timeoutMs: 999 }), assert.AssertionError);
});

test('property seed: identity matching never accepts malformed, wrong-tenant, or wrong-object-id tokens', () => {
  const rng = random(SEED + 1);
  const expected = '11111111-2222-3333-4444-555555555555';
  const tenant = '72f988bf-86f1-41af-91ab-2d7cd011db47';
  const token = (oid, tid) => `x.${Buffer.from(JSON.stringify({ oid, tid })).toString('base64url')}.y`;
  for (let run = 0; run < 300; run++) {
    const oid = rng() > 0.5 ? expected : 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const tid = rng() > 0.5 ? tenant : 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    assert.equal(matchesSsoUser(token(oid, tid), expected), oid === expected && tid === tenant);
    assert.equal(matchesSsoUser(text(rng, 200), expected), null);
  }
});

test('property seed: timeout and intent decisions fail closed at every boundary', () => {
  const rng = random(SEED + 2);
  for (let run = 0; run < 500; run++) {
    const p = rng() * 1.2;
    const margin = rng() * 1.2;
    const answer = { ok: rng() > 0.1, choice: rng() > 0.1 ? 'o1' : pick(rng, ['none', 'missing']), p, margin };
    const result = decideIntent(answer, { o1: 'approved-value' });
    const expected = answer.ok === true && answer.choice === 'o1'
      && Number.isFinite(p) && p >= 0.9 && p <= 1
      && Number.isFinite(margin) && margin >= 0.3 && margin <= 1 && margin <= p;
    assert.equal(result.commit, expected);
    if (!expected) assert.equal(result.value, undefined);
  }
  for (const [p, margin] of [[NaN, 0.4], [Infinity, 0.4], ['0.95', 0.4], [0.95, NaN],
    [0.95, Infinity], [0.95, '0.4'], [1.01, 0.4], [0.95, 1.01], [0.95, 0.96]]) {
    assert.equal(decideIntent({ ok: true, choice: 'o1', p, margin }, { o1: 'approved-value' }).commit, false);
  }
});

test('property seed: option matching is normalization-stable and never invents an option', () => {
  const rng = random(SEED + 3);
  for (let run = 0; run < 300; run++) {
    const wanted = text(rng, 30) || 'alpha';
    const decorated = ` \t${wanted.replace(/ /g, '\u00a0')} \n`;
    assert.equal(normalize(wanted), normalize(decorated));
    const options = [{ label: wanted, value: 'known' }, { label: 'other', value: 'other' }];
    const result = matchOption(options, decorated);
    if (result?.value !== undefined) assert.ok(['known', 'other'].includes(result.value));
  }
});

test('property seed: repository policy and provider outcomes never turn unknown input into success', () => {
  assert.equal(classify('production').kind, 'blocked');
  assert.equal(classify('tcb').kind, 'blocked');
  assert.equal(classify('hvt').kind, 'blocked');
  assert.equal(classify('non-production').kind, 'nonproduction');
  assert.deepEqual(classifyCreate(503, {}), { outcome: 'rejected', reason: 'unavailable', retryable: true });
  const rng = random(SEED + 4);
  for (let run = 0; run < 400; run++) {
    const value = text(rng, 40);
    const classification = classify(value);
    assert.ok(['missing', 'nonproduction', 'blocked', 'invalid'].includes(classification.kind));
    if (classification.kind === 'nonproduction') assert.ok(/non.?prod/i.test(value));
    const role = parseRole(value);
    if (role !== null) assert.ok(['read', 'triage', 'write', 'maintain'].includes(role));
    const errors = validateRepo({ org: value, name: text(rng, 120), description: text(rng, 400), visibility: pick(rng, ['internal', 'private', value]) });
    assert.ok(Array.isArray(errors));
    const status = Math.floor(rng() * 600);
    const outcome = classifyCreate(status, {});
    if (outcome.outcome === 'success') assert.equal(status, 201);
    if (status !== 201 && ![400, 401, 403, 409, 429, 503].includes(status)) assert.notEqual(outcome.outcome, 'success');
  }
});

test('property seed: external response drift never validates as a known successful contract', () => {
  const rng = random(SEED + 5);
  for (let run = 0; run < 300; run++) {
    const body = { organization: text(rng), name: text(rng), webUrl: text(rng), id: text(rng) };
    const status = pick(rng, [200, 201, 202, 400, 403, 429, 500, 503]);
    const result = checkResponse('create', status, body);
    if (result.ok) {
      assert.equal(status, 201);
      assert.match(body.webUrl, /^https?:\/\//i);
    }
  }
});

test('property seed: check failures and hostile errors produce structured non-throwing results without secrets', async () => {
  assert.equal(summarize([{ status: 'error' }, { status: 'unknown' }]), 'error');
  assert.equal(summarize([{ status: 'action' }, { status: 'unknown' }]), 'action');
  assert.equal(summarize([{ status: 'unknown' }, { status: 'pass' }]), 'unknown');
  const missingPermissions = diagnoseGithub({ account: 'alex_microsoft', repos: ['example/project'], role: 'write', run: (args) =>
    args[0] === 'auth' ? { ok: true, text: 'fixture-token' } : args.at(-1) === 'user'
      ? { ok: true, text: JSON.stringify({ login: 'alex_microsoft' }) }
      : { ok: true, text: JSON.stringify({ full_name: 'example/project' }) } });
  assert.equal(missingPermissions.checks.find((item) => item.id === 'github.repository.example/project').status, 'unknown');

  const rng = random(SEED + 6);
  const tokenShapes = [
    'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    'github_pat_abcdefghijklmnopqrstuvwxyz0123456789',
    'x.eyJvaWQiOiJzZWNyZXQifQ.y',
  ];
  for (let run = 0; run < 120; run++) {
    const secret = pick(rng, tokenShapes);
    const github = diagnoseGithub({ account: 'alex_microsoft',
      run: () => ({ ok: false, code: pick(rng, ['ETIMEDOUT', 'http_429', 'http_5xx', 'command_failed']) }) });
    assertStructured(github);
    assert.notEqual(github.status, 'ready');
    assert.ok(!JSON.stringify(github).includes(secret));
    assert.ok(!safeReason(new Error(secret)).includes(secret));

    const loaders = {
      github: async () => ({ diagnose: async () => { throw Object.assign(new Error(secret), { code: 'network_error' }); } }),
      msx: async () => ({ diagnose: async () => ({ schemaVersion: 1, kind: 'msx',
        checks: [{ id: 'msx.connection', status: 'unknown', message: 'Unavailable.' }] }) }),
    };
    const readiness = await diagnoseReadiness({}, loaders);
    assertStructured(readiness);
    assert.notEqual(readiness.status, 'ready');
    assert.ok(!JSON.stringify(readiness).includes(secret));
  }
});

test('property seed: readiness composition follows error > action > unknown > ready', async () => {
  const rng = random(SEED + 7);
  const statuses = ['pass', 'action', 'unknown', 'error'];
  const priority = { pass: 0, unknown: 1, action: 2, error: 3 };
  for (let run = 0; run < 200; run++) {
    const githubStatus = pick(rng, statuses);
    const msxStatus = pick(rng, statuses);
    const result = await diagnoseReadiness({}, {
      github: async () => ({ diagnose: async () => ({ schemaVersion: 1, kind: 'github',
        checks: [{ id: 'github.generated', status: githubStatus, message: 'Generated.' }] }) }),
      msx: async () => ({ diagnose: async () => ({ schemaVersion: 1, kind: 'msx',
        checks: [{ id: 'msx.generated', status: msxStatus, message: 'Generated.' }] }) }),
    });
    assertStructured(result);
    const maximum = Math.max(priority[githubStatus], priority[msxStatus], priority.unknown);
    assert.equal(result.status, Object.keys(priority).find((key) => priority[key] === maximum).replace('pass', 'ready'));
  }
});

test('property seed: incomplete request histories never establish submission outcome', () => {
  const rng = random(SEED + 8);
  const since = Date.parse('2026-01-01T00:00:00.000Z');
  for (let run = 0; run < 300; run++) {
    const count = Math.floor(rng() * 5);
    const rows = Array.from({ length: count }, (_, index) => ({
      caseId: `REQ-${String(index).padStart(6, '0')}-2026`,
      name: `REQ-${String(index).padStart(6, '0')}-2026 - IT lab`,
      createdOn: '2026-01-02T00:00:00.000Z',
    }));
    const options = { title: 'IT lab', since };
    const partial = reconcileRequestList({ ok: true, complete: false, rows }, options);
    assert.equal(partial.ok, false);
    assert.equal(partial.found, undefined);
    const complete = reconcileRequestList({ ok: true, complete: true, rows }, options);
    assert.equal(complete.ok, true);
    assert.equal(Boolean(complete.found), count === 1);
    assert.equal(Boolean(complete.ambiguous), count > 1);
  }
});

test('property seed: submission success needs the same case in every independent evidence source', () => {
  const rng = random(SEED + 9);
  const origin = 'https://portal.example.test';
  const found = { caseId: 'REQ-123456-2026' };
  for (let run = 0; run < 500; run++) {
    const sameOrigin = rng() > 0.2;
    const confirmed = rng() > 0.2;
    const noForm = rng() > 0.2;
    const pageMatches = rng() > 0.2;
    const responseMatches = rng() > 0.2;
    const goodStatus = rng() > 0.2;
    const noError = rng() > 0.2;
    const page = {
      url: `${sameOrigin ? origin : 'https://other.example.test'}/confirmation`,
      confirmation: confirmed,
      hasForm: !noForm,
      caseIds: [pageMatches ? found.caseId : 'REQ-999999-2026'],
    };
    const commit = {
      status: goodStatus ? 302 : 500,
      responseCaseIds: [responseMatches ? found.caseId : 'REQ-999999-2026'],
      ...(noError ? {} : { error: 'unavailable' }),
    };
    const result = classifyReconciliation({ found, ambiguous: null, lastOk: true, page, commit, origin });
    const expected = sameOrigin && confirmed && noForm && pageMatches && responseMatches && goodStatus && noError;
    assert.equal(result, expected ? 'success' : 'unknown');
  }
});

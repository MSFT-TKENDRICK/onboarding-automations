import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { diagnose, parseArgs } from '../../skills/new-hire-readiness/scripts/new-hire-readiness.mjs';

function loader(kind, checks, received) {
  return async () => ({ diagnose: async (options) => {
    received[kind] = options;
    return { schemaVersion: 1, kind, checks };
  } });
}

test('composes checks and preserves unverified onboarding areas', async () => {
  const received = {};
  const ssoUserId = '11111111-2222-3333-4444-555555555555';
  const result = await diagnose({ account: 'alex_microsoft', repos: ['org/repo'], role: 'read', root: '/checkout', ssoUserId, timeoutMs: 120000 }, {
    github: loader('github', [{ id: 'github.auth', status: 'pass', message: 'Authenticated.' }], received),
    msx: loader('msx', [{ id: 'msx.auth', status: 'pass', message: 'Authenticated.' }], received),
  });
  assert.equal(result.status, 'unknown');
  assert.deepEqual(received.github.repos, ['org/repo']);
  assert.equal(received.msx.root, '/checkout');
  assert.equal(received.msx.ssoUserId, ssoUserId);
  assert.equal(received.msx.timeoutMs, 120000);
  assert.equal(received.msx.requireIdentity, true);
  assert.equal(result.checks.find((c) => c.id === 'onboarding.training').status, 'unknown');
  assert.equal(result.checks.find((c) => c.id === 'azure.subscription').status, 'unknown');
  assert.match(result.checks.find((c) => c.id === 'azure.subscription').message, /Whether an Azure subscription is needed/);
  assert.match(result.checks.find((c) => c.id === 'azure.subscription').next, /separately from MS Sales/);
});

test('reports a missing skill without hiding the other results', async () => {
  const received = {};
  const result = await diagnose({}, {
    github: async () => { throw new Error('missing'); },
    msx: loader('msx', [{ id: 'msx.auth', status: 'pass', message: 'Authenticated.' }], received),
  });

  assert.equal(result.status, 'error');
  assert.equal(result.checks.find((c) => c.id === 'github.integration').status, 'error');
  assert.equal(result.checks.find((c) => c.id === 'msx.auth').status, 'pass');
});

test('handles non-Error integration failures and continues other readiness checks', async () => {
  const secret = 'private.token.value';
  for (const thrown of [null, { code: secret }]) {
    const result = await diagnose({}, {
      github: async () => ({ diagnose: async () => { throw thrown; } }),
      msx: loader('msx', [{ id: 'msx.auth', status: 'pass', message: 'Cached identity.' }], {}),
    });
    assert.equal(result.checks.find((c) => c.id === 'github.integration').code, 'check_failed');
    assert.equal(result.checks.find((c) => c.id === 'msx.auth').status, 'pass');
    assert.ok(!JSON.stringify(result).includes(secret));
  }
});

test('preserves the matched MSX profile for downstream tooling', async () => {
  const result = await diagnose({}, {
    github: loader('github', [{ id: 'github.auth', status: 'pass', message: 'Authenticated.' }], {}),
    msx: loader('msx', [{ id: 'msx.profile', status: 'pass', message: 'Matched.',
      matchedProfile: 'verified-profile' }], {}),
  });
  assert.equal(result.checks.find((c) => c.id === 'msx.profile').matchedProfile, 'verified-profile');
});

test('fails closed on an incompatible integration response', async () => {
  const result = await diagnose({}, {
    github: async () => ({ diagnose: () => ({ schemaVersion: 2, kind: 'github', checks: [] }) }),
    msx: loader('msx', [{ id: 'msx.auth', status: 'action', message: 'Sign-in required.' }], {}),
  });
  assert.equal(result.status, 'error');
  assert.equal(result.checks.find((c) => c.id === 'github.integration').status, 'error');
});

test('rejects empty or incomplete integrated check results', async () => {
  for (const checks of [[], [{ id: 'github.auth', status: 'pass' }],
    [{ id: 'msx.auth', status: 'pass', message: 'Wrong namespace.' }]]) {
    const result = await diagnose({}, {
      github: loader('github', checks, {}),
      msx: loader('msx', [{ id: 'msx.auth', status: 'pass', message: 'Authenticated.' }], {}),
    });
    assert.equal(result.checks.find((c) => c.id === 'github.integration').status, 'error');
  }
});

test('parses repeated repositories and rejects malformed flags', () => {
  assert.throws(() => parseArgs([]), /--org ORG/);
  assert.deepEqual(parseArgs(['check', '--repo', 'a/b', '--repo', 'c/d']).repos, ['a/b', 'c/d']);
  assert.throws(() => parseArgs(['check', '--root']), /missing/);
  assert.throws(() => parseArgs(['check', '--account', 'a', '--account', 'b']), /only be supplied once/);
  assert.equal(parseArgs(['check', '--timeout-ms', '120000']).timeoutMs, 120000);
  assert.equal(parseArgs(['check', '--sso-user-id', '11111111-2222-3333-4444-555555555555']).ssoUserId,
    '11111111-2222-3333-4444-555555555555');
  assert.throws(() => parseArgs(['check', '--sso-user-id', 'not-an-object-id']), /object ID/);
  assert.throws(() => parseArgs(['check', '--timeout-ms', '300001']), /1000 to 300000/);
});

test('the CLI emits a single structured error for invalid arguments', () => {
  const cli = fileURLToPath(new URL('../../skills/new-hire-readiness/scripts/new-hire-readiness.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [cli, 'check', '--unexpected'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  const output = JSON.parse(result.stdout);
  assert.equal(output.kind, 'new-hire-readiness');
  assert.equal(output.checks[0].id, 'readiness.arguments');
});

test('requires exact cached identity matching without stopping other readiness checks', async () => {
  const received = {};
  const result = await diagnose({ account: 'alex_microsoft' }, {
    github: loader('github', [{ id: 'github.authentication', status: 'pass', message: 'Exact cached account.' }], received),
    msx: loader('msx', [{ id: 'msx.profile', status: 'unknown',
      message: 'No exact cached corporate identity match.' }], received),
  });
  assert.equal(received.msx.requireIdentity, true);
  assert.equal(result.status, 'unknown');
  assert.equal(result.checks.find((check) => check.id === 'github.authentication').status, 'pass');
  assert.equal(result.checks.find((check) => check.id === 'msx.profile').status, 'unknown');
  assert.doesNotMatch(JSON.stringify(result), /az login|gh auth login|start sign-in|interactive sign-in/i);
});

test('skill instructions omit account input when an authorized identity is unavailable', () => {
  const skill = readFileSync(fileURLToPath(new URL('../../skills/new-hire-readiness/SKILL.md', import.meta.url)), 'utf8');
  assert.match(skill, /Omit `--account` when an authorized exact GitHub identity is unavailable/);
  assert.doesNotMatch(skill, /Ask which GitHub account/i);
});

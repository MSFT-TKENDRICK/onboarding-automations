import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnose, parseArgs, planRequest } from '../../skills/check-github-access/scripts/github-access.mjs';

function fakeGh(routes, calls = []) {
  return (args, env) => {
    calls.push({ args, env });
    const value = routes[args.join(' ')];
    if (value === undefined) throw new Error(`Unexpected command: ${args.join(' ')}`);
    return value;
  };
}
const json = (value) => ({ ok: true, text: JSON.stringify(value) });

test('checks selected EMU account and requested repository role without leaking token', () => {
  const calls = [];
  const result = diagnose({
    account: 'alex_microsoft', repos: ['gim-home/project'], role: 'write',
    run: fakeGh({
      'auth token --hostname github.com --user alex_microsoft': { ok: true, text: 'secret-token\n' },
      'api --hostname github.com user': json({ login: 'alex_microsoft' }),
      'api --hostname github.com repos/gim-home/project': json({ full_name: 'gim-home/project', permissions: { pull: true, push: true } }),
    }, calls), env: { GH_HOST: 'enterprise.example.com' },
  });
  assert.equal(result.checks.find((c) => c.id === 'github.repository.gim-home/project').status, 'pass');
  assert.equal(result.checks.find((c) => c.id === 'github.emu').status, 'unknown');
  assert.equal(result.status, 'unknown');
  assert.equal(calls[1].env.GH_TOKEN, 'secret-token');
  assert.equal(calls[1].env.GH_HOST, 'github.com');
  assert.ok(!JSON.stringify(result).includes('secret-token'));
});

test('does not continue when the selected account and actual credentials differ', () => {
  const result = diagnose({ account: 'alex_microsoft', repos: ['gim-home/project'], env: {}, run: fakeGh({
    'auth token --hostname github.com --user alex_microsoft': { ok: true, text: 'token' },
    'api --hostname github.com user': json({ login: 'someone-else' }),
  }) });
  assert.equal(result.status, 'error');
  assert.equal(result.checks.length, 1);
});

test('distinguishes a missing GitHub CLI or timeout from a missing account', () => {
  for (const [code, status] of [['ENOENT', 'error'], ['ETIMEDOUT', 'unknown']]) {
    const result = diagnose({ account: 'alex_microsoft', run: () => ({ ok: false, code }) });
    assert.equal(result.checks[0].status, status);
    assert.equal(result.checks[0].code, code);
  }
});

test('treats a 404 as ambiguous and does not claim the repository is absent', () => {
  const result = diagnose({ repos: ['gim-home/project'], run: fakeGh({
    'api --hostname github.com user': json({ login: 'alex_microsoft' }),
    'api --hostname github.com repos/gim-home/project': { ok: false, code: 'http_404' },
  }) });
  const repo = result.checks.find((c) => c.id === 'github.repository.gim-home/project');
  assert.equal(repo.status, 'action');
  assert.match(repo.message, /cannot be distinguished/);
});

test('does not claim write permission when permissions are missing', () => {
  const result = diagnose({ repos: ['gim-home/project'], role: 'write', run: fakeGh({
    'api --hostname github.com user': json({ login: 'alex_microsoft' }),
    'api --hostname github.com repos/gim-home/project': json({ full_name: 'gim-home/project' }),
  }) });
  assert.equal(result.checks.find((c) => c.id === 'github.repository.gim-home/project').status, 'unknown');
});

test('recognizes insufficient permission without inferring managed status from the login', () => {
  const result = diagnose({ repos: ['owner/project'], role: 'write', run: fakeGh({
    'api --hostname github.com user': json({ login: 'alex' }),
    'api --hostname github.com repos/owner/project': json({ full_name: 'owner/project', permissions: { pull: true } }),
  }) });
  assert.equal(result.checks.find((c) => c.id === 'github.emu').status, 'unknown');
  assert.equal(result.checks.find((c) => c.id === 'github.repository.owner/project').status, 'action');
});

test('reports active, pending and unverifiable organization membership', () => {
  const result = diagnose({ orgs: ['active-org', 'pending-org', 'unknown-org'], run: fakeGh({
    'api --hostname github.com user': json({ login: 'alex_microsoft' }),
    'api --hostname github.com user/memberships/orgs/active-org': json({ state: 'active' }),
    'api --hostname github.com user/memberships/orgs/pending-org': json({ state: 'pending' }),
    'api --hostname github.com user/memberships/orgs/unknown-org': { ok: false, code: 'http_404' },
  }) });
  assert.equal(result.checks.find((c) => c.id === 'github.organization.active-org').status, 'pass');
  assert.equal(result.checks.find((c) => c.id === 'github.organization.pending-org').status, 'action');
  assert.equal(result.checks.find((c) => c.id === 'github.organization.unknown-org').status, 'unknown');
});

test('does not claim repository access from malformed or mismatched responses', () => {
  for (const response of [
    { permissions: { pull: true, push: true } },
    { full_name: 'different/project', permissions: { pull: true, push: true } },
    { full_name: 'gim-home/project', permissions: { pull: true, push: 'false' } },
  ]) {
    const result = diagnose({ repos: ['gim-home/project'], role: 'write', run: fakeGh({
      'api --hostname github.com user': json({ login: 'alex_microsoft' }),
      'api --hostname github.com repos/gim-home/project': json(response),
    }) });
    assert.equal(result.checks.find((c) => c.id === 'github.repository.gim-home/project').status, 'unknown');
  }
});

test('does not accept an invalid authenticated account response', () => {
  const result = diagnose({ run: fakeGh({ 'api --hostname github.com user': json({ login: '' }) }) });
  assert.equal(result.checks[0].status, 'unknown');
  assert.equal(result.checks[0].code, 'invalid_response');
});

test('prepares an explicit request without submitting or inventing a recipient', () => {
  const result = planRequest({ account: 'alex_microsoft', repo: 'org/repo', role: 'read',
    recipient: 'owner@example.com', reason: 'Required for onboarding' });
  assert.equal(result.submitted, false);
  assert.equal(result.request.recipient, 'owner@example.com');
  assert.match(result.message.subject, /read access to org\/repo/);
  assert.match(result.message.body, /alex_microsoft/);
  assert.throws(() => planRequest({ account: 'alex_microsoft', repo: 'org/repo', role: 'read' }), /recipient/);
  assert.throws(() => planRequest({ account: 'alex_microsoft', repo: 'org/repo', role: 'read',
    recipient: 'owner@example.com', reason: '   ' }), /justification/);
});

test('rejects invalid arguments before running commands', () => {
  assert.throws(() => parseArgs(['check', '--repo']), /missing/);
  assert.throws(() => diagnose({ repos: ['../unsafe'] }), /owner\/name/);
  assert.throws(() => diagnose({ role: 'admin' }), /Role/);
});

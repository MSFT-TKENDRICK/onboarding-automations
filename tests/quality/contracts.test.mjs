import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { diagnose as diagnoseGithub } from '../../skills/check-github-access/scripts/github-access.mjs';
import { probeAzure, probeWhoAmI } from '../../skills/check-msx-access/scripts/azure-probe.mjs';
import { parseRpcMessage } from '../../skills/check-msx-access/scripts/msx-access.mjs';
import { diagnose as diagnoseReadiness } from '../../skills/new-hire-readiness/scripts/new-hire-readiness.mjs';
import { checkResponse, classifyCreate } from '../../skills/request-new-github-repository/scripts/lib/contract.mjs';
import { decideIntent } from '../../skills/request-new-azure-subscription/scripts/lib/intent.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(here, 'fixtures', 'external-boundaries.json'), 'utf8'));
const json = (value) => ({ ok: true, text: JSON.stringify(value) });

test('GitHub REST/gh consumer contract replays success, denial, absence, throttling, and server failure', () => {
  const success = diagnoseGithub({ account: 'alex_microsoft', repos: ['example/project'], role: 'triage', run: (args) => {
    if (args[0] === 'auth') return { ok: true, text: 'fixture-token' };
    if (args.at(-1) === 'user') return json(fixture.github.user);
    if (args.at(-1) === 'repos/example/project') return json(fixture.github.repository);
    throw new Error(`unexpected fixture request ${args.join(' ')}`);
  } });
  assert.equal(success.checks.find((item) => item.id === 'github.repository.example/project').status, 'pass');
  for (const boundary of fixture.github.errors) {
    const result = diagnoseGithub({ account: 'alex_microsoft', repos: ['example/project'], run: (args) =>
      args[0] === 'auth' ? { ok: true, text: 'fixture-token' }
        : args.at(-1) === 'user' ? json(fixture.github.user) : { ok: false, code: boundary.code } });
    assert.equal(result.checks.find((item) => item.id === 'github.repository.example/project').status, boundary.expected);
    assert.notEqual(result.status, 'ready');
  }
});

test('Azure CLI and Dataverse WhoAmI contracts require tenant, token, fixed endpoint, and valid JSON identity', async () => {
  const calls = [];
  const token = `x.${Buffer.from(JSON.stringify({
    oid: fixture.azure.objectId,
    tid: fixture.azure.tenant,
  })).toString('base64url')}.y`;
  const checks = await probeAzure({
    profile: 'fixture profile',
    ssoUserId: fixture.azure.objectId,
    run: (args) => {
      calls.push(args);
      return json({ tenant: fixture.azure.tenant, accessToken: token });
    },
    whoAmI: async () => ({ ok: true }),
    env: {},
  });
  assert.ok(calls[0].includes('--tenant'));
  assert.ok(calls[0].includes('--resource'));
  assert.ok(!calls[0].includes('--subscription'));
  assert.equal(checks.find((item) => item.id === 'msx.dataverse').status, 'pass');

  let request;
  const who = await probeWhoAmI(token, { fetchImpl: async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify(fixture.azure.whoAmI), { status: 200 });
  } });
  assert.deepEqual(who, { ok: true });
  assert.equal(request.url, 'https://microsoftsales.crm.dynamics.com/api/data/v9.2/WhoAmI');
  assert.equal(request.options.redirect, 'error');
  assert.ok(!request.url.includes(token));
});

test('MSX MCP contract validates JSON-RPC envelopes and read-only tool metadata', () => {
  const initialized = parseRpcMessage(JSON.stringify({ jsonrpc: '2.0', id: 1, result: fixture.msx.initialize }));
  const tools = parseRpcMessage(JSON.stringify({ jsonrpc: '2.0', id: 2, result: { tools: [fixture.msx.tool] } }));
  const result = parseRpcMessage(JSON.stringify({ jsonrpc: '2.0', id: 3, result: fixture.msx.result }));
  assert.equal(initialized.result.protocolVersion, '2025-03-26');
  assert.equal(tools.result.tools[0].annotations.readOnlyHint, true);
  assert.equal(tools.result.tools[0].annotations.destructiveHint, false);
  assert.match(result.result.content[0].text, /All checks passed/);
  for (const drift of ['null', '[]', '{"id":1}', '{"jsonrpc":"1.0","id":1}']) {
    assert.throws(() => parseRpcMessage(drift), /invalid protocol data/);
  }
});

test('new-hire readiness consumes only schema-versioned namespaced sub-check contracts', async () => {
  const loader = (kind, checks) => async () => ({ diagnose: async () => ({ schemaVersion: 1, kind, checks }) });
  const result = await diagnoseReadiness({}, {
    github: loader('github', [{ id: 'github.authentication', status: 'pass', message: 'Working.' }]),
    msx: loader('msx', [{ id: 'msx.connection', status: 'unknown', message: 'Not established.' }]),
  });
  assert.equal(result.kind, 'new-hire-readiness');
  assert.equal(result.status, 'unknown');
  for (const check of result.checks) {
    for (const field of fixture.readiness.requiredCheckFields) assert.ok(field in check);
    assert.ok(fixture.readiness.statuses.includes(check.status));
  }
  const drift = await diagnoseReadiness({}, {
    github: loader('github', [{ id: 'wrong.namespace', status: 'pass', message: 'Wrong.' }]),
    msx: loader('msx', [{ id: 'msx.connection', status: 'pass', message: 'Working.' }]),
  });
  assert.equal(drift.checks.find((item) => item.id === 'github.integration').status, 'error');
});

test('StartRight provider fixtures and Azure intent contract fail closed on ambiguous outcomes', () => {
  assert.equal(checkResponse('create', 201, fixture.startright.created).ok, true);
  assert.equal(checkResponse('create', 429, fixture.startright.rateLimited).ok, true);
  assert.deepEqual(classifyCreate(429, fixture.startright.rateLimited),
    { outcome: 'rejected', reason: 'rate_limited', retryable: true });
  assert.deepEqual(classifyCreate(502, {}), { outcome: 'unknown' });
  assert.deepEqual(decideIntent({ ok: true, choice: 'o1', p: 0.899, margin: 1 }, { o1: 'value' }),
    { commit: false, reason: 'low_confidence', p: 0.899 });
  assert.deepEqual(decideIntent({ ok: false }, { o1: 'value' }), { commit: false, reason: 'no_answer' });
});

test('contract documentation names every replayed boundary and output schema', () => {
  const docs = [
    readFileSync(join(here, '..', '..', 'skills', 'check-github-access', 'references', 'CLI.md'), 'utf8'),
    readFileSync(join(here, '..', '..', 'skills', 'check-msx-access', 'references', 'CLI.md'), 'utf8'),
    readFileSync(join(here, '..', '..', 'skills', 'new-hire-readiness', 'references', 'CLI.md'), 'utf8'),
  ].join('\n');
  for (const term of ['schemaVersion: 1', 'github.com', 'Azure CLI', 'WhoAmI', 'msx_auth_status', 'new-hire-readiness']) {
    assert.match(docs, new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
  }
  assert.match(docs, /--sso-user-id ID/);
  assert.match(docs, /does not inspect, choose, or authenticate another account/i);
});

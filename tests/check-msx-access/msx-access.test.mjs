import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { diagnose, parseArgs, parseRpcMessage, probeServer } from '../../skills/check-msx-access/scripts/msx-access.mjs';
import { probeAzure, probeWhoAmI } from '../../skills/check-msx-access/scripts/azure-probe.mjs';

const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'server.mjs');
const noAzure = () => [];
const testEnv = { ...process.env, DATAVERSE_URL: '', MSFTD_MCAPS_IQ_AZURE_CONFIG_DIR: '' };
const tenant = '72f988bf-86f1-41af-91ab-2d7cd011db47';
const privateToken = 'private.token.value';
const ssoUserId = '11111111-2222-3333-4444-555555555555';
const tokenResponse = (overrides = {}) => ({ ok: true, text: JSON.stringify({
  tenant, accessToken: privateToken, ...overrides,
}) });
const userToken = (oid = ssoUserId, tid = tenant) =>
  `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ oid, tid })).toString('base64url')}.signature`;
function checkout(t) {
  const root = mkdtempSync(join(tmpdir(), 'msx-onboarding-'));
  mkdirSync(join(root, '.azure'));
  writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: {
    msx: { type: 'stdio', command: 'node', args: ['server.js'] },
  } }));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('validates JSON-RPC envelopes before processing them', () => {
  for (const line of ['not json', 'null', '[]', '{"id":1,"result":{}}']) {
    assert.throws(() => parseRpcMessage(line), /invalid protocol data/);
  }
  assert.deepEqual(parseRpcMessage('{"jsonrpc":"2.0","id":1,"result":{}}'),
    { jsonrpc: '2.0', id: 1, result: {} });
});

test('requires a valid stdio server configuration instead of any msx entry', async (t) => {
  const root = checkout(t);
  const server = join(root, 'missing.mjs');
  for (const msx of [{}, { command: '' }, { command: 'node', args: [1] }, { type: 'http', command: 'node' },
    { command: 'node', env: { KEY: 1 } }, { command: 'node', envFile: '' }]) {
    writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { msx } }));
    const result = await diagnose({ root, server, azureProbe: noAzure, env: testEnv });
    assert.equal(result.checks.find((c) => c.id === 'msx.checkout').status, 'action');
  }
});

test('discovers and invokes only the read-only diagnostic without leaking its identity', async (t) => {
  const root = checkout(t);
  const result = await diagnose({ root, server: fixture, azureProbe: noAzure, env: { ...testEnv, FAKE_MSX_MODE: 'pass' } });
  assert.equal(result.checks.find((c) => c.id === 'msx.connection').status, 'pass');
  assert.equal(result.status, 'unknown');
  assert.ok(!JSON.stringify(result).includes('private'));
});

test('does not infer sign-in from the server default-account diagnostic', async (t) => {
  const root = checkout(t);
  const result = await diagnose({ root, server: fixture, azureProbe: noAzure, env: { ...testEnv, FAKE_MSX_MODE: 'action' } });
  assert.equal(result.checks.find((c) => c.id === 'msx.connection').status, 'unknown');
  assert.equal(result.checks.find((c) => c.id === 'msx.connection').code, 'default_account_unverified');
});

test('preserves disagreement when the direct tenant-scoped check succeeds', async (t) => {
  const root = checkout(t);
  const result = await diagnose({ root, server: fixture,
    azureProbe: async () => [{ id: 'msx.azure', status: 'pass', message: 'Token available.' }],
    env: { ...testEnv, FAKE_MSX_MODE: 'action' },
  });
  const connection = result.checks.find((c) => c.id === 'msx.connection');
  assert.equal(connection.status, 'unknown');
  assert.match(connection.message, /disagrees/);
  assert.doesNotMatch(JSON.stringify(result), /not signed in/i);
});

test('does not trust an upstream installation timeout over a working Azure CLI', async (t) => {
  const root = checkout(t);
  const result = await diagnose({ root, server: fixture,
    azureProbe: async () => [{ id: 'msx.azure', status: 'pass', message: 'Token available.' }],
    env: { ...testEnv, FAKE_MSX_MODE: 'not-installed' },
  });
  const connection = result.checks.find((c) => c.id === 'msx.connection');
  assert.equal(connection.status, 'unknown');
  assert.equal(connection.code, 'diagnostic_unverified');
});

test('does not infer tenant or token failure from the server default account', async (t) => {
  const root = checkout(t);
  for (const mode of ['wrong-tenant', 'token-unavailable']) {
    const result = await diagnose({ root, server: fixture, azureProbe: noAzure, env: { ...testEnv, FAKE_MSX_MODE: mode } });
    const connection = result.checks.find((c) => c.id === 'msx.connection');
    assert.equal(connection.status, 'unknown');
    assert.equal(connection.code, 'default_account_unverified');
  }
});

test('does not report server access denial when the direct connection succeeded', async (t) => {
  const root = checkout(t);
  const result = await diagnose({ root, server: fixture, env: { ...testEnv, FAKE_MSX_MODE: 'forbidden' },
    azureProbe: async () => [
      { id: 'msx.azure', status: 'pass', message: 'Token available.' },
      { id: 'msx.dataverse', status: 'pass', message: 'Connected.' },
    ],
  });
  assert.equal(result.checks.find((c) => c.id === 'msx.connection').status, 'unknown');
  assert.equal(result.checks.find((c) => c.id === 'msx.connection').code, 'diagnostic_unverified');
});

test('treats a changed diagnostic format as unknown', async (t) => {
  const root = checkout(t);
  const result = await diagnose({ root, server: fixture, azureProbe: noAzure, env: { ...testEnv, FAKE_MSX_MODE: 'changed' } });
  assert.equal(result.checks.find((c) => c.id === 'msx.connection').status, 'unknown');
});

test('does not pass a diagnostic with conflicting success and failure markers', async (t) => {
  const root = checkout(t);
  const result = await diagnose({ root, server: fixture, azureProbe: noAzure, env: { ...testEnv, FAKE_MSX_MODE: 'conflicting' } });
  assert.equal(result.checks.find((c) => c.id === 'msx.connection').status, 'unknown');
});

test('does not confuse an invalid token with a valid token', async (t) => {
  const root = checkout(t);
  const result = await diagnose({ root, server: fixture, azureProbe: noAzure, env: { ...testEnv, FAKE_MSX_MODE: 'invalid-token' } });
  assert.equal(result.checks.find((c) => c.id === 'msx.connection').status, 'unknown');
});

test('reports missing diagnostic tool and does not call it', async (t) => {
  const root = checkout(t);
  const result = await diagnose({ root, server: fixture, azureProbe: noAzure, env: { ...testEnv, FAKE_MSX_MODE: 'missing' } });
  assert.equal(result.checks.find((c) => c.id === 'msx.server').status, 'action');
});

test('discovers the diagnostic on a later MCP tool page', async (t) => {
  const root = checkout(t);
  const result = await diagnose({ root, server: fixture, azureProbe: noAzure, env: { ...testEnv, FAKE_MSX_MODE: 'pagination' } });
  assert.equal(result.checks.find((c) => c.id === 'msx.connection').status, 'pass');
});

test('treats a diagnostic tool error as unknown', async (t) => {
  const root = checkout(t);
  const result = await diagnose({ root, server: fixture, azureProbe: noAzure, env: { ...testEnv, FAKE_MSX_MODE: 'tool-error' } });
  assert.equal(result.checks.find((c) => c.id === 'msx.connection').status, 'unknown');
});

test('does not invoke a diagnostic lacking safe tool annotations', async (t) => {
  const root = checkout(t);
  for (const mode of ['unannotated', 'missing-destructive', 'destructive']) {
    const result = await diagnose({ root, server: fixture, azureProbe: noAzure, env: { ...testEnv, FAKE_MSX_MODE: mode } });
    const server = result.checks.find((c) => c.id === 'msx.server');
    assert.equal(server.status, 'unknown');
    assert.match(server.message, /not invoked/);
    assert.equal(result.checks.some((c) => c.id === 'msx.connection'), false);
  }
});

test('reports invalid MCP protocol data and repeated cursors without claiming success', async (t) => {
  const root = checkout(t);
  for (const mode of ['invalid-protocol', 'null-response', 'invalid-envelope', 'cursor-loop']) {
    const result = await diagnose({ root, server: fixture, azureProbe: noAzure, env: { ...testEnv, FAKE_MSX_MODE: mode } });
    assert.equal(result.checks.find((c) => c.id === 'msx.server').status, 'unknown');
  }
});

test('does not start a server when the selected profile is missing', async (t) => {
  const root = checkout(t);
  const result = await diagnose({ root, server: fixture, profile: join(root, 'missing'), env: testEnv,
    probe: () => { throw new Error('must not start'); } });
  assert.equal(result.checks.find((c) => c.id === 'msx.profile').status, 'action');
  assert.equal(result.checks.find((c) => c.id === 'msx.server').status, 'unknown');
});

test('does not treat a file as an Azure profile directory', async (t) => {
  const root = checkout(t);
  const profile = join(root, 'profile-file');
  writeFileSync(profile, '');
  const result = await diagnose({ root, server: fixture, profile, env: testEnv,
    probe: () => { throw new Error('must not start'); } });
  assert.equal(result.checks.find((c) => c.id === 'msx.profile').status, 'action');
  assert.equal(result.checks.find((c) => c.id === 'msx.server').status, 'unknown');
});

test('does not probe an unverified Dataverse endpoint from the environment', async (t) => {
  const root = checkout(t);
  const result = await diagnose({ root, server: fixture,
    env: { ...testEnv, DATAVERSE_URL: 'https://example.invalid' },
    azureProbe: () => { throw new Error('must not run'); },
    probe: () => { throw new Error('must not start'); },
  });
  assert.equal(result.checks.find((c) => c.id === 'msx.endpoint').status, 'unknown');
  assert.equal(result.checks.find((c) => c.id === 'msx.server').status, 'unknown');
  assert.ok(!JSON.stringify(result).includes('example.invalid'));
});

test('rejects invalid arguments', () => {
  assert.throws(() => parseArgs(['check', '--profile']), /missing/);
  assert.throws(() => parseArgs(['check', '--login']), /Invalid/);
  assert.throws(() => parseArgs(['check', '--timeout-ms', '999']), /1000 to 300000/);
  assert.throws(() => parseArgs(['check', '--timeout-ms', '5000x']), /1000 to 300000/);
  assert.throws(() => parseArgs(['check', '--sso-user-id', 'not-an-object-id']), /object ID/);
  assert.equal(parseArgs(['check', '--sso-user-id', ssoUserId]).ssoUserId, ssoUserId);
  assert.equal(parseArgs(['check', '--timeout-ms', '120000']).timeoutMs, 120000);
});

test('tries existing profiles until a verified corporate SSO identity is found', async (t) => {
  const root = checkout(t);
  const home = join(root, 'home');
  const matched = join(home, '.azure');
  mkdirSync(matched, { recursive: true });
  const attempts = [];
  const budgets = [];
  let serverProfile;
  const result = await diagnose({ root, home, server: fixture, ssoUserId,
    env: { ...testEnv, AZURE_CONFIG_DIR: '' },
    azureProbe: async ({ profile, ssoUserId: expected, timeoutMs }) => {
      attempts.push(profile);
      budgets.push(timeoutMs);
      assert.equal(expected, ssoUserId);
      return profile === matched
        ? [{ id: 'msx.identity', status: 'pass' }, { id: 'msx.dataverse', status: 'pass' }]
        : [{ id: 'msx.identity', status: 'action', code: 'identity_mismatch' }];
    },
    probe: async ({ profile }) => {
      serverProfile = profile;
      return { toolFound: true, readOnly: true, outcome: 'pass' };
    },
  });
  assert.deepEqual(attempts, [join(root, '.azure'), matched]);
  assert.ok(budgets[0] > 0 && budgets[0] <= 90000);
  assert.equal(result.checks.find((c) => c.id === 'msx.profile').matchedProfile, matched);
  assert.equal(serverProfile, matched);
  assert.equal(result.checks.find((c) => c.id === 'msx.identity').status, 'pass');
  assert.ok(!JSON.stringify(result).includes(ssoUserId));
});

test('respects an explicit profile and does not start the server for a mismatched identity', async (t) => {
  const root = checkout(t);
  const profile = join(root, '.azure');
  const home = join(root, 'home');
  mkdirSync(join(home, '.azure'), { recursive: true });
  const attempts = [];
  const result = await diagnose({ root, home, profile, server: fixture, ssoUserId, env: testEnv,
    azureProbe: async ({ profile: candidate }) => {
      attempts.push(candidate);
      return [{ id: 'msx.identity', status: 'action', code: 'identity_mismatch' }];
    },
    probe: () => { throw new Error('must not start'); },
  });
  assert.deepEqual(attempts, [profile]);
  assert.equal(result.checks.find((c) => c.id === 'msx.profile').matchedProfile, undefined);
  assert.equal(result.checks.find((c) => c.id === 'msx.server').status, 'unknown');
  assert.equal(result.checks.find((c) => c.id === 'msx.sso-selection').status, 'unknown');
});

test('does not try other profiles without a trusted SSO identity', async (t) => {
  const root = checkout(t);
  const home = join(root, 'home');
  mkdirSync(join(home, '.azure'), { recursive: true });
  const attempts = [];
  await diagnose({ root, home, server: fixture, env: testEnv,
    azureProbe: async ({ profile }) => { attempts.push(profile); return []; },
    probe: async () => ({ toolFound: true, readOnly: true, outcome: 'pass' }),
  });
  assert.deepEqual(attempts, [join(root, '.azure')]);
});

test('passes the default or requested diagnostic timeout to the server probe', async (t) => {
  const root = checkout(t);
  for (const [timeoutMs, expected] of [[undefined, 180000], [120000, 120000]]) {
    let actual;
    await diagnose({ root, server: fixture, timeoutMs, azureProbe: noAzure, env: testEnv, probe: async (options) => {
      actual = options.timeoutMs;
      return { toolFound: true, readOnly: true, outcome: 'pass' };
    } });
    assert.equal(actual, expected);
  }
});

test('offers a bounded timeout adjustment when the server is slow', async (t) => {
  const root = checkout(t);
  const result = await diagnose({ root, server: fixture, azureProbe: noAzure, env: testEnv, probe: async () => {
    throw new Error('MSX server timed out during initialization.');
  } });
  assert.match(result.checks.find((c) => c.id === 'msx.server').next, /--timeout-ms/);
});

test('bounds a nonresponding MCP server', async (t) => {
  const root = checkout(t);
  const server = join(root, 'hang.mjs');
  writeFileSync(server, 'process.stdin.resume(); setInterval(() => {}, 1000);');
  await assert.rejects(probeServer({ server, cwd: root, profile: join(root, '.azure'), timeoutMs: 200 }), /timed out/);
});

test('checks a tenant-scoped token and WhoAmI without selecting a subscription', async () => {
  const calls = [];
  let receivedToken;
  const checks = await probeAzure({ profile: 'profile', timeoutMs: 120000, env: {}, run: (args, profile, env, timeoutMs) => {
    calls.push({ args, profile, timeoutMs });
    return tokenResponse();
  }, whoAmI: async (value) => { receivedToken = value; return { ok: true }; } });
  assert.equal(checks.find((c) => c.id === 'msx.azure').status, 'pass');
  assert.equal(checks.find((c) => c.id === 'msx.dataverse').status, 'pass');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args.slice(0, 4), ['account', 'get-access-token', '--tenant', tenant]);
  assert.equal(calls[0].timeoutMs, 120000);
  assert.ok(!calls[0].args.includes('--subscription'));
  assert.ok(!calls[0].args.includes(privateToken));
  assert.equal(receivedToken, privateToken);
  assert.ok(!JSON.stringify(checks).includes(privateToken));
});

test('does not send a token returned for the wrong tenant', async () => {
  const checks = await probeAzure({ profile: 'profile', env: {},
    run: () => tokenResponse({ tenant: '11111111-2222-3333-4444-555555555555' }),
    whoAmI: () => { throw new Error('must not send'); },
  });
  assert.equal(checks[0].status, 'unknown');
  assert.equal(checks[0].code, 'invalid_response');
});

test('never contacts Dataverse using a token for a different SSO identity', async () => {
  const checks = await probeAzure({ profile: 'profile', ssoUserId, env: {},
    run: () => tokenResponse({ accessToken: userToken('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee') }),
    whoAmI: () => { throw new Error('must not send'); },
  });
  assert.equal(checks.find((c) => c.id === 'msx.identity').status, 'action');
  assert.equal(checks.find((c) => c.id === 'msx.identity').code, 'identity_mismatch');
  assert.equal(checks.some((c) => c.id === 'msx.dataverse'), false);
  assert.ok(!JSON.stringify(checks).includes(ssoUserId));
});

test('requires a valid Dataverse response before trusting a matching SSO token', async () => {
  for (const [who, expected] of [[{ ok: true }, 'pass'], [{ ok: false, code: 'forbidden' }, 'unknown']]) {
    const checks = await probeAzure({ profile: 'profile', ssoUserId, env: {},
      run: () => tokenResponse({ accessToken: userToken() }), whoAmI: async () => who,
    });
    assert.equal(checks.find((c) => c.id === 'msx.identity').status, expected);
    assert.ok(!JSON.stringify(checks).includes(userToken()));
  }
});

test('does not contact Dataverse if a token identity is malformed or opaque', async () => {
  for (const accessToken of [privateToken, userToken('not-a-guid'), userToken(ssoUserId, 'not-a-guid')]) {
    const checks = await probeAzure({ profile: 'profile', ssoUserId, env: {},
      run: () => tokenResponse({ accessToken }), whoAmI: () => { throw new Error('must not send'); },
    });
    assert.equal(checks.find((c) => c.id === 'msx.identity').status, 'unknown');
    assert.equal(checks.find((c) => c.id === 'msx.identity').code, 'identity_unverified');
  }
});

test('the direct Azure probe also refuses a nondefault endpoint', async () => {
  const checks = await probeAzure({ profile: 'profile', env: { DATAVERSE_URL: 'https://example.invalid' },
    run: () => { throw new Error('must not run'); } });
  assert.equal(checks[0].status, 'unknown');
});

test('reports an unavailable tenant-scoped token without requesting a subscription', async () => {
  const calls = [];
  const checks = await probeAzure({ profile: 'profile', env: {}, run: (args) => {
    calls.push(args);
    return { ok: false, code: 'not_signed_in' };
  }, whoAmI: () => { throw new Error('must not send'); } });
  assert.equal(checks[0].status, 'action');
  assert.match(checks[0].next, /do not require Azure CLI or a subscription/);
  assert.equal(calls.length, 1);
  assert.ok(!calls[0].includes('--subscription'));
});

test('reports an ambiguous Dataverse failure without claiming access was denied', async () => {
  const checks = await probeAzure({ profile: 'profile', env: {}, run: () => tokenResponse(),
    whoAmI: async () => ({ ok: false, code: 'request_failed' }),
  });
  assert.equal(checks.find((c) => c.id === 'msx.dataverse').status, 'unknown');
});

test('does not claim a token or connection for malformed Azure CLI output', async () => {
  for (const result of [{ ok: true, text: 'None' }, tokenResponse({ tenant: 'None' }),
    tokenResponse({ accessToken: 'invalid\nvalue' }), tokenResponse({ accessToken: '' })]) {
    const checks = await probeAzure({ profile: 'profile', env: {}, run: () => result,
      whoAmI: () => { throw new Error('must not send'); },
    });
    assert.equal(checks[0].status, 'unknown');
    assert.equal(checks[0].code, 'invalid_response');
  }
});

test('sends the token only in a header to the fixed Dataverse endpoint and rejects redirects', async () => {
  let request;
  const who = await probeWhoAmI(privateToken, { fetchImpl: async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ UserId: '11111111-2222-3333-4444-555555555555' }), { status: 200 });
  } });
  assert.deepEqual(who, { ok: true });
  assert.equal(request.url, 'https://microsoftsales.crm.dynamics.com/api/data/v9.2/WhoAmI');
  assert.equal(request.options.method, 'GET');
  assert.equal(request.options.redirect, 'error');
  assert.equal(request.options.headers.Authorization, `Bearer ${privateToken}`);
  assert.ok(!request.url.includes(privateToken));
  assert.ok(!JSON.stringify(who).includes(privateToken));
});

test('surfaces forbidden, malformed, redirected and network responses without leaking the token', async () => {
  const results = [
    new Response(null, { status: 403 }),
    new Response('{"UserId":"None"}', { status: 200 }),
    new Response('not json', { status: 200 }),
    new Response('x'.repeat(65537), { status: 200 }),
    new Response(null, { status: 302, headers: { Location: 'https://example.invalid' } }),
  ];
  assert.deepEqual(await probeWhoAmI(privateToken, { fetchImpl: async () => results.shift() }),
    { ok: false, code: 'forbidden' });
  assert.deepEqual(await probeWhoAmI(privateToken, { fetchImpl: async () => results.shift() }),
    { ok: false, code: 'invalid_response' });
  assert.deepEqual(await probeWhoAmI(privateToken, { fetchImpl: async () => results.shift() }),
    { ok: false, code: 'invalid_response' });
  assert.deepEqual(await probeWhoAmI(privateToken, { fetchImpl: async () => results.shift() }),
    { ok: false, code: 'invalid_response' });
  assert.deepEqual(await probeWhoAmI(privateToken, { fetchImpl: async () => results.shift() }),
    { ok: false, code: 'http_error' });
  const failure = await probeWhoAmI(privateToken, { fetchImpl: async () => { throw new Error(privateToken); } });
  assert.deepEqual(failure, { ok: false, code: 'request_failed' });
  assert.ok(!JSON.stringify(failure).includes(privateToken));
});

test('bounds an unresponsive Dataverse request', async () => {
  const result = await probeWhoAmI(privateToken, { timeoutMs: 10, fetchImpl: async (_url, { signal }) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }) });
  assert.deepEqual(result, { ok: false, code: 'timeout' });
});

test('reports a Dataverse denial separately from token availability', async () => {
  const checks = await probeAzure({ profile: 'profile', env: {}, run: () => tokenResponse(),
    whoAmI: async () => ({ ok: false, code: 'forbidden' }),
  });
  assert.equal(checks.find((c) => c.id === 'msx.azure').status, 'pass');
  assert.equal(checks.find((c) => c.id === 'msx.dataverse').status, 'action');
});

test('does not treat an invalid WhoAmI identifier as a successful connection', async () => {
  const who = await probeWhoAmI(privateToken, { fetchImpl: async () => new Response('{"UserId":"None"}', { status: 200 }) });
  assert.equal(who.ok, false);
  assert.equal(who.code, 'invalid_response');
});

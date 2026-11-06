import { spawnSync } from 'node:child_process';

const TENANT = '72f988bf-86f1-41af-91ab-2d7cd011db47';
const DATAVERSE = 'https://microsoftsales.crm.dynamics.com';
const GUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const BEARER_TOKEN = /^[a-z0-9._~+/-]+=*$/i;

export function usesDefaultDataverse(env) {
  return !env.DATAVERSE_URL || env.DATAVERSE_URL.replace(/\/+$/, '').toLowerCase() === DATAVERSE;
}

export function runAz(args, profile, env = process.env, timeoutMs = 90000) {
  const windows = process.platform === 'win32';
  const executable = windows ? env.ComSpec || 'cmd.exe' : 'az';
  const command = windows ? ['/d', '/s', '/c', 'az.cmd', ...args] : args;
  const result = spawnSync(executable, command, {
    encoding: 'utf8',
    env: { ...env, AZURE_CONFIG_DIR: profile },
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) return { ok: false, code: result.error.code ?? 'command_failed' };
  if (result.status !== 0) {
    const stderr = result.stderr ?? '';
    const code = /not recognized as an internal or external command|command not found/i.test(stderr) ? 'not_installed'
      : /please run ['"]?az login|not logged in/i.test(stderr) ? 'not_signed_in'
        : /\b403\b|forbidden/i.test(stderr) ? 'forbidden' : 'command_failed';
    return { ok: false, code };
  }
  return { ok: true, text: result.stdout.trim() };
}

function check(id, status, message, next, details = {}) {
  return { id, status, message, ...(next ? { next } : {}), ...details };
}

export function matchesSsoUser(token, ssoUserId) {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[1].length > 16384) return null;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (!GUID.test(claims?.oid ?? '') || !GUID.test(claims?.tid ?? '')) return null;
    return claims.tid.toLowerCase() === TENANT && claims.oid.toLowerCase() === ssoUserId.toLowerCase();
  } catch {
    return null;
  }
}

export async function probeWhoAmI(token, { fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${DATAVERSE}/api/data/v9.2/WhoAmI`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      redirect: 'error',
      signal: controller.signal,
    });
    if (!response.ok) {
      return { ok: false, code: response.status === 403 ? 'forbidden' : 'http_error' };
    }
    if (!response.body) return { ok: false, code: 'invalid_response' };
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > 65536) return { ok: false, code: 'invalid_response' };
      chunks.push(chunk);
    }
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return { ok: false, code: 'invalid_response' };
    }
    return typeof body?.UserId === 'string' && GUID.test(body.UserId)
      ? { ok: true } : { ok: false, code: 'invalid_response' };
  } catch {
    return { ok: false, code: controller.signal.aborted ? 'timeout' : 'request_failed' };
  } finally {
    clearTimeout(timer);
  }
}

export async function probeAzure({ profile, ssoUserId, timeoutMs = 90000, env = process.env, run = runAz, whoAmI = probeWhoAmI }) {
  const checks = [];
  if (!usesDefaultDataverse(env)) {
    return [check('msx.azure', 'unknown', 'A nondefault Dataverse endpoint is configured and was not probed.',
      'Verify the intended endpoint in the configured MCP host.')];
  }
  const started = Date.now();
  const tokenResult = run(['account', 'get-access-token', '--tenant', TENANT, '--resource', DATAVERSE,
    '--query', '{accessToken:accessToken,tenant:tenant}', '-o', 'json'], profile, env, timeoutMs);
  if (!tokenResult.ok) {
    checks.push(check('msx.azure', 'unknown',
      'The cached MSX tooling profile could not be verified with a tenant-scoped Dataverse token.',
      'Verify cached tooling state outside this readiness run. MS Sales access requests do not require Azure CLI or a subscription.',
      { code: tokenResult.code }));
    return checks;
  }
  let token;
  try {
    token = JSON.parse(tokenResult.text);
  } catch {
    token = null;
  }
  if (typeof token?.accessToken !== 'string' || !BEARER_TOKEN.test(token.accessToken)
    || typeof token.tenant !== 'string' || token.tenant.toLowerCase() !== TENANT) {
    checks.push(check('msx.azure', 'unknown', 'The tenant-scoped Dataverse token could not be verified.',
      'Inspect the tooling profile and retry.', { code: 'invalid_response' }));
    return checks;
  }
  checks.push(check('msx.azure', 'pass', 'The tooling profile obtained a Dataverse token for the Microsoft tenant; no Azure subscription is required.'));
  if (ssoUserId) {
    const match = matchesSsoUser(token.accessToken, ssoUserId);
    if (match !== true) {
      checks.push(check('msx.identity', 'unknown',
        match === false ? 'The tooling profile does not match the current corporate SSO identity.'
          : 'The tooling profile identity could not be compared with corporate SSO.',
        'Readiness uses only a profile verified against the current corporate SSO identity.',
        { code: match === false ? 'identity_mismatch' : 'identity_unverified' }));
      return checks;
    }
  } else {
    checks.push(check('msx.identity', 'unknown', 'The tooling profile was not compared with the current corporate SSO identity.',
      'Use the signed-in Microsoft 365 identity to verify the tooling profile.'));
  }
  const remaining = timeoutMs - (Date.now() - started);
  const who = remaining > 0
    ? await whoAmI(token.accessToken, { timeoutMs: Math.min(15000, remaining) })
    : { ok: false, code: 'timeout' };
  if (ssoUserId) {
    checks.push(check('msx.identity', who.ok ? 'pass' : 'unknown',
      who.ok ? 'The verified Dataverse connection matches the current corporate SSO identity.'
        : 'A matching token was found, but the Dataverse connection could not verify it.',
      who.ok ? null : 'Check the tenant-scoped Dataverse result before using this profile.',
      who.ok ? {} : { code: 'identity_unverified' }));
  }
  checks.push(check('msx.dataverse', who.ok ? 'pass' : who.code === 'forbidden' ? 'action' : 'unknown',
  who.ok ? 'Dataverse WhoAmI succeeded for the selected tooling profile.'
    : who.code === 'forbidden' ? 'Dataverse denied the connection.'
      : 'Dataverse connectivity could not be verified.',
  who.ok ? null : 'Check VPN, the selected identity, and the required MSX access.',
  !who.ok ? { code: who.code } : {}));
  return checks;
}

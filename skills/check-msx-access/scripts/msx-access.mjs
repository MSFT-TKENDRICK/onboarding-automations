#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeAzure, usesDefaultDataverse } from './azure-probe.mjs';

const EUA_URL = 'https://euaaccessportal.microsoft.com/request/access/MSSales';
const ACCESS_MANAGER_URL = 'https://eng.ms/docs/experiences-devices/business-and-industry-copilot/bic-cxp/sales-platform/sales-platform-ux/msx-platform/docs/accessmanageronboarding';
const DEFAULT_SERVER = join(homedir(), '.copilot', 'mcaps-iq', 'msx-mcp', 'node_modules',
  '@mcaps-microsoft', 'msx-mcp', 'dist', 'servers', 'msx.js');
const DEFAULT_TIMEOUT_MS = 180000;
const GUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const SAFE_ERROR_CODES = new Set(['EACCES', 'ECONNREFUSED', 'ECONNRESET', 'ENOENT', 'ENOTDIR',
  'ENOTFOUND', 'EPERM', 'EPIPE', 'ETIMEDOUT', 'ERR_MODULE_NOT_FOUND']);
const TIMEOUT_REASONS = new Set(['initialization', 'tool discovery', 'authentication check']
  .map((phase) => `MSX server timed out during ${phase}.`));
const DIAGNOSTIC_ACTIONS = [
  { pattern: /Azure CLI:.*Not signed in/i, code: 'not_signed_in',
    message: 'The server reported that the selected Azure profile is not signed in.',
    next: 'Verify cached tooling state outside this readiness run; it does not start sign-in.' },
  { pattern: /Azure CLI:.*Wrong tenant/i, code: 'wrong_tenant',
    message: 'The server reported a different Azure tenant.',
    next: 'Verify the cached profile outside this readiness run; it does not select another account or tenant.' },
  { pattern: /Azure CLI:.*Not installed/i, code: 'not_installed',
    message: 'The server reported that Azure CLI is not installed.',
    next: 'Check Azure CLI installation and PATH using your organization’s approved process.' },
  { pattern: /Azure CLI:.*Blocked by Conditional Access/i, code: 'conditional_access',
    message: 'The server reported an Azure Conditional Access block.',
    next: 'Contact your organization’s support team; do not bypass the policy.' },
  { pattern: /Dataverse token:.*Cannot acquire/i, code: 'token_unavailable',
    message: 'The server reported that it could not acquire a Dataverse token.',
    next: 'Inspect the Azure CLI profile and the server diagnostic.' },
  { pattern: /Access:.*Forbidden/i, code: 'forbidden',
    message: 'The server reported that Dataverse access was forbidden.',
    next: 'Verify the identity and required access through the approved process.' },
  { pattern: /Network:.*Cannot reach/i, code: 'network_unreachable',
    message: 'The server reported that it could not reach Dataverse.',
    next: 'Check the corporate network or VPN, then retry.' },
];

export function safeReason(error) {
  const message = typeof error?.message === 'string' ? error.message : '';
  if (TIMEOUT_REASONS.has(message)) return message;
  return 'MSX server diagnostic failed.';
}

function check(id, status, message, next, details = {}) {
  return { id, status, message, ...(next ? { next } : {}), ...details };
}

function summarize(checks) {
  if (checks.some((c) => c.status === 'error')) return 'error';
  if (checks.some((c) => c.status === 'action')) return 'action';
  if (checks.some((c) => c.status === 'unknown')) return 'unknown';
  return 'ready';
}

function fileExists(path) {
  try { return statSync(path).isFile(); } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
    throw error;
  }
}

function directoryExists(path) {
  try { return statSync(path).isDirectory(); } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
    throw error;
  }
}

function safeCode(error, fallback) {
  return typeof error?.code === 'string' && SAFE_ERROR_CODES.has(error.code) ? error.code : fallback;
}

function validServerConfiguration(server) {
  return server !== null && typeof server === 'object' && !Array.isArray(server)
    && (server.type === undefined || server.type === 'stdio')
    && typeof server.command === 'string' && server.command.trim().length > 0
    && (server.args === undefined
      || (Array.isArray(server.args) && server.args.every((arg) => typeof arg === 'string')))
    && (server.env === undefined || (server.env !== null && typeof server.env === 'object'
      && !Array.isArray(server.env) && Object.values(server.env).every((value) => typeof value === 'string')))
    && (server.envFile === undefined || (typeof server.envFile === 'string' && server.envFile.trim().length > 0));
}

export function parseRpcMessage(line) {
  let message;
  try { message = JSON.parse(line); } catch { throw new Error('MSX server returned invalid protocol data.'); }
  if (message === null || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0') {
    throw new Error('MSX server returned invalid protocol data.');
  }
  return message;
}

export async function probeServer({ server, cwd, profile, timeoutMs = DEFAULT_TIMEOUT_MS, env = process.env }) {
  const child = spawn(process.execPath, [server], {
    cwd,
    env: { ...env, AZURE_CONFIG_DIR: profile },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const closed = new Promise((resolvePromise) => child.once('close', resolvePromise));
  let buffer = '';
  let sequence = 0;
  let phase = 'initialization';
  let failure;
  const pending = new Map();
  const fail = (error) => {
    if (failure) return;
    failure = error;
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  };
  const timer = setTimeout(() => fail(new Error('MSX server timed out.')), timeoutMs);
  child.on('error', () => fail(new Error('MSX server could not start.')));
  child.on('exit', () => fail(new Error('MSX server exited before the diagnostic completed.')));
  child.stdin.on('error', () => fail(new Error('MSX server connection closed.')));
  child.stderr.resume();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    if (buffer.length > 1024 * 1024) return fail(new Error('MSX server response exceeded the size limit.'));
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try { message = parseRpcMessage(line); } catch (error) { fail(error); return; }
      const request = pending.get(message.id);
      if (!request) continue;
      pending.delete(message.id);
      if (message.error) request.reject(new Error('MSX server rejected a diagnostic request.'));
      else request.resolve(message.result);
    }
  });
  const send = (method, params) => new Promise((resolvePromise, reject) => {
    if (failure) return reject(failure);
    const id = ++sequence;
    pending.set(id, { resolve: resolvePromise, reject });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  try {
    await send('initialize', { protocolVersion: '2025-03-26', capabilities: {},
      clientInfo: { name: 'onboarding-msx-check', version: '1.0.0' } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    phase = 'tool discovery';
    const seen = new Set();
    let cursor;
    let authTool;
    do {
      const page = await send('tools/list', cursor ? { cursor } : {});
      if (!Array.isArray(page?.tools)) throw new Error('MSX server returned an invalid tool list.');
      authTool ||= page.tools.find((tool) => tool?.name === 'msx_auth_status');
      cursor = page.nextCursor;
      if (cursor && (typeof cursor !== 'string' || seen.has(cursor) || seen.size >= 20)) {
        throw new Error('MSX server returned an invalid tool cursor.');
      }
      if (cursor) seen.add(cursor);
    } while (cursor && !authTool);
    if (!authTool) return { toolFound: false };
    if (authTool.annotations?.readOnlyHint !== true || authTool.annotations?.destructiveHint !== false) {
      return { toolFound: true, readOnly: false };
    }
    phase = 'authentication check';
    const result = await send('tools/call', { name: 'msx_auth_status', arguments: {} });
    if (result?.isError || !Array.isArray(result?.content)) return { toolFound: true, readOnly: true, outcome: 'unknown' };
    const text = result.content.filter((part) => part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text).join('\n');
    const passed = /\*\*All checks passed!?\*\*/i.test(text) && /\*\*Azure CLI:\*\*\s+Signed in\b/i.test(text)
      && /\*\*Dataverse token:\*\*\s+Valid\b/i.test(text) && /\*\*Dataverse:\*\*\s+Connected\b/i.test(text);
    const action = DIAGNOSTIC_ACTIONS.find(({ pattern }) => pattern.test(text));
    return { toolFound: true, readOnly: true, outcome: passed && action ? 'unknown' : passed ? 'pass' : action ? 'action' : 'unknown',
      ...(action && !passed ? { code: action.code } : {}) };
  } catch (error) {
    if (error.message === 'MSX server timed out.') throw new Error(`MSX server timed out during ${phase}.`);
    throw error;
  } finally {
    clearTimeout(timer);
    child.stdin.end();
    let forceKill;
    if (child.exitCode === null && child.signalCode === null && !child.killed) {
      child.kill();
      forceKill = setTimeout(() => child.kill('SIGKILL'), 1000);
    }
    await closed;
    clearTimeout(forceKill);
  }
}

export async function diagnose({ root, server = DEFAULT_SERVER, profile, ssoUserId, timeoutMs = DEFAULT_TIMEOUT_MS,
  env = process.env, home = homedir(), probe = probeServer, azureProbe = probeAzure, requireIdentity = false } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300000) {
    throw new Error('--timeout-ms must be an integer from 1000 to 300000.');
  }
  if (ssoUserId !== undefined && (typeof ssoUserId !== 'string' || !GUID.test(ssoUserId))) {
    throw new Error('--sso-user-id must be a Microsoft 365 user object ID.');
  }
  const checks = [];
  const defaultEndpoint = usesDefaultDataverse(env);
  if (!defaultEndpoint) {
    checks.push(check('msx.endpoint', 'unknown', 'A nondefault Dataverse endpoint is configured and was not probed.',
      'Verify the intended endpoint in the configured MCP host.'));
  }
  root ||= env.MSFTD_MCAPS_IQ_ROOT || env.MCAPS_IQ_ROOT;
  if (root) root = resolve(root);
  if (!root) {
    checks.push(check('msx.checkout', 'unknown', 'An MCAPS-IQ checkout was not supplied.',
      'Provide --root or set MSFTD_MCAPS_IQ_ROOT.'));
  } else {
    const configPath = join(root, '.mcp.json');
    try {
      const config = JSON.parse(readFileSync(configPath, 'utf8'));
      checks.push(validServerConfiguration(config?.mcpServers?.msx)
        ? check('msx.checkout', 'pass', 'The checkout has a structurally valid stdio MCP entry named msx.')
        : check('msx.checkout', 'action', 'The checkout does not have a valid stdio MCP entry named msx.',
          'Follow the current MCAPS-IQ setup instructions.'));
    } catch (error) {
      const missing = error.code === 'ENOENT' || error.code === 'ENOTDIR';
      checks.push(check('msx.checkout', missing ? 'action' : 'error',
        missing ? 'The MCAPS-IQ configuration was not found.' : 'The MCAPS-IQ configuration could not be read.',
        'Check the checkout path and its .mcp.json file.'));
    }
  }

  const explicitProfile = profile || env.MSFTD_MCAPS_IQ_AZURE_CONFIG_DIR;
  profile = resolve(explicitProfile
    || (root ? join(root, '.azure') : env.AZURE_CONFIG_DIR || join(home, '.azure-msx')));
  const candidates = [profile];
  if (ssoUserId && !explicitProfile && defaultEndpoint) {
    for (const candidate of [env.AZURE_CONFIG_DIR, join(home, '.azure'), join(home, '.azure-msx')]) {
      if (!candidate) continue;
      const path = resolve(candidate);
      if (!candidates.some((existing) => process.platform === 'win32'
        ? existing.toLowerCase() === path.toLowerCase() : existing === path)) candidates.push(path);
    }
  }
  let selectedChecks;
  let fallback;
  let matchedProfile = false;
  if (defaultEndpoint && (!requireIdentity || ssoUserId)) {
    const deadline = Date.now() + timeoutMs;
    const existing = [];
    for (const candidate of candidates) {
      try {
        if (directoryExists(candidate)) existing.push(candidate);
      } catch {
        if (!fallback) fallback = { profile: candidate, checks: [check('msx.identity', 'unknown',
          'A cached tooling profile could not be inspected.',
          'Readiness continued to other cached profiles.', { code: 'profile_unavailable' })] };
      }
    }
    for (let index = 0; index < existing.length; index++) {
      const candidate = existing[index];
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const candidateBudget = Math.max(1, Math.floor(remaining / (existing.length - index)));
      let candidateChecks;
      try {
        candidateChecks = await azureProbe({ profile: candidate, ssoUserId, timeoutMs: candidateBudget, env });
      } catch {
        candidateChecks = [check('msx.identity', 'unknown', 'A cached tooling profile probe failed.',
          'Readiness continued to other cached profiles.', { code: 'probe_failed' })];
      }
      const identity = candidateChecks.find((item) => item.id === 'msx.identity');
      const dataverse = candidateChecks.find((item) => item.id === 'msx.dataverse');
      const current = { profile: candidate, checks: candidateChecks };
      if (!fallback || (identity?.code === 'identity_unverified' && dataverse)) fallback = current;
      if (!ssoUserId || (identity?.status === 'pass' && dataverse?.status === 'pass')) {
        profile = candidate;
        selectedChecks = candidateChecks;
        matchedProfile = Boolean(ssoUserId);
        break;
      }
    }
  }
  if (!selectedChecks && fallback) {
    profile = fallback.profile;
    selectedChecks = fallback.checks;
  }
  let profileDirectory = false;
  try { profileDirectory = directoryExists(profile); } catch {}
  if (!profileDirectory) {
    checks.push(check('msx.profile', requireIdentity ? 'unknown' : 'action',
      requireIdentity
        ? 'No matching already-authenticated tooling profile directory was available.'
        : 'The selected Azure CLI profile is not an existing directory.',
      requireIdentity
        ? 'Readiness continues without tooling identity verification; it does not create or authenticate a profile.'
        : 'Set up the intended tooling profile outside this diagnostic. MS Sales access requests do not require Azure CLI or a subscription.'));
  } else {
    checks.push(check('msx.profile', matchedProfile || !requireIdentity ? 'pass' : 'unknown', matchedProfile
      ? 'An existing tooling profile matched corporate SSO for this diagnostic.'
      : requireIdentity ? 'A tooling profile exists, but no exact corporate SSO identity match was verified.'
        : 'The tooling profile exists.',
    matchedProfile || !requireIdentity ? null : 'A future readiness check can automatically match cached profiles when an authorized corporate SSO identity is available; it does not start sign-in or choose an account.',
    matchedProfile ? { matchedProfile: profile } : {}));
    if (selectedChecks) checks.push(...selectedChecks);
  }
  if (ssoUserId && !matchedProfile && defaultEndpoint) {
    checks.push(check('msx.sso-selection', 'unknown', 'No tooling profile was verified to match corporate SSO.',
      'Verify cached corporate SSO state outside this readiness run; do not select an unrelated account or subscription.'));
  }
  if (!fileExists(server)) {
    checks.push(check('msx.server', 'unknown', 'An installed MSX MCP server was not found.',
      'Provide --server with the installed server entry point; this check does not install software.'));
  } else if (!profileDirectory) {
    checks.push(check('msx.server', 'unknown', 'The server was not started because the selected profile is not an existing directory.',
      'Readiness continues without the server diagnostic; it does not create or authenticate a profile.'));
  } else if (!defaultEndpoint) {
    checks.push(check('msx.server', 'unknown', 'The server was not started with an unverified Dataverse endpoint.',
      'Verify the intended endpoint in the configured MCP host.'));
  } else if (ssoUserId && !matchedProfile) {
    checks.push(check('msx.server', 'unknown', 'The server was not started because the tooling identity was not verified against corporate SSO.',
      'Resolve the tenant-scoped identity and connection checks before using the server.'));
  } else if (requireIdentity && !ssoUserId) {
    checks.push(check('msx.server', 'unknown', 'The server was not started because no exact corporate SSO identity was available for profile matching.',
      'A future readiness check can automatically match cached profiles when an authorized corporate SSO identity is available; it does not start sign-in.'));
  } else {
    try {
      const result = await probe({ server: resolve(server), cwd: root || undefined, profile, timeoutMs, env });
      if (!result.toolFound) {
        checks.push(check('msx.server', 'action', 'The server does not expose msx_auth_status.',
          'Check the installed MSX MCP version and configuration.'));
      } else if (!result.readOnly) {
        checks.push(check('msx.server', 'unknown', 'The server did not mark msx_auth_status as read-only; it was not invoked.',
          'Check the installed MSX MCP version and its tool annotations.'));
      } else {
        checks.push(check('msx.server', 'pass', 'The server exposes the read-only msx_auth_status tool.'));
        const action = DIAGNOSTIC_ACTIONS.find(({ code }) => code === result.code);
        const directAzure = checks.find((item) => item.id === 'msx.azure');
        const directToken = directAzure?.status === 'pass';
        const directConnection = checks.find((item) => item.id === 'msx.dataverse')?.status === 'pass';
        const defaultAccountFailure = ['not_signed_in', 'wrong_tenant', 'token_unavailable'].includes(result.code);
        const unconfirmedInstallation = result.code === 'not_installed' && directAzure?.code !== 'not_installed';
        const disagreement = result.outcome === 'action'
          && ((directToken && ['not_installed', 'conditional_access'].includes(result.code))
            || (directConnection && ['forbidden', 'network_unreachable'].includes(result.code)));
        if (defaultAccountFailure || unconfirmedInstallation || disagreement) {
          checks.push(check('msx.connection', 'unknown',
            directToken
              ? 'The server diagnostic disagrees with the tenant-scoped tooling check.'
              : 'The server diagnostic could not independently establish the tooling problem.',
            'Use the tenant-scoped tooling check; requesting MS Sales access does not require an Azure subscription.',
            { code: defaultAccountFailure ? 'default_account_unverified' : 'diagnostic_unverified' }));
        } else {
          checks.push(check('msx.connection', result.outcome,
            result.outcome === 'pass' ? 'MSX sign-in, token, and Dataverse connection passed the server diagnostic.'
              : result.outcome === 'action' ? action?.message || 'The server reported an authentication or access problem.'
                : 'The server diagnostic did not establish a healthy MSX connection.',
            result.outcome === 'pass' ? null : action?.next || 'Review the noninteractive tenant-scoped diagnostic; requesting MS Sales access does not require an Azure subscription.',
            action ? { code: action.code } : {}));
        }
      }
    } catch (error) {
      const reason = safeReason(error);
      checks.push(check('msx.server', 'unknown', 'The installed MSX server could not complete its diagnostic.',
        reason.startsWith('MSX server timed out')
          ? 'If startup is slow, retry with a longer --timeout-ms (up to 300000); otherwise inspect the server in the MCP host.'
          : 'Inspect the server in the MCP host and retry.', { reason, code: safeCode(error, 'diagnostic_failed') }));
    }
  }
  checks.push(check('msx.sales-access', 'unknown', 'MS Sales User Account - Basic entitlement was not independently verified.',
    `Review the current request and approval status in ${EUA_URL}.`));
  checks.push(check('msx.role', 'unknown', 'The required Dynamics 365 role and business scope were not verified.',
    `Review the applicable role in MSX Access Manager: ${ACCESS_MANAGER_URL}`));
  return { schemaVersion: 1, kind: 'msx', status: summarize(checks), checks };
}

export function parseArgs(args) {
  if (args[0] !== 'check') throw new Error('Usage: msx-access.mjs check [--root PATH] [--server PATH] [--profile PATH] [--sso-user-id ID] [--timeout-ms MS]');
  const options = {};
  for (let i = 1; i < args.length; i++) {
    const flag = args[i];
    if (!['--root', '--server', '--profile', '--sso-user-id', '--timeout-ms'].includes(flag) || !args[i + 1] || args[i + 1].startsWith('--')) {
      throw new Error(`Invalid or missing value for ${flag}.`);
    }
    const key = flag === '--timeout-ms' ? 'timeoutMs' : flag === '--sso-user-id' ? 'ssoUserId' : flag.slice(2);
    if (options[key]) throw new Error(`${flag} can only be supplied once.`);
    const value = args[++i];
    if (key === 'timeoutMs') {
      if (!/^\d+$/.test(value) || Number(value) < 1000 || Number(value) > 300000) {
        throw new Error('--timeout-ms must be an integer from 1000 to 300000.');
      }
      options[key] = Number(value);
    } else if (key === 'ssoUserId') {
      if (!GUID.test(value)) throw new Error('--sso-user-id must be a Microsoft 365 user object ID.');
      options[key] = value;
    } else {
      options[key] = value;
    }
  }
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await diagnose(parseArgs(process.argv.slice(2)));
    console.log(JSON.stringify(result));
    process.exitCode = result.status === 'ready' ? 0 : result.status === 'error' ? 1 : 2;
  } catch (error) {
    console.log(JSON.stringify({ schemaVersion: 1, kind: 'msx', status: 'error', checks: [
      check('msx.error', 'error', error.message),
    ] }));
    process.exitCode = 1;
  }
}

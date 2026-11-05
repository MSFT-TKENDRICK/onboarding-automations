#!/usr/bin/env node

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const VALID_STATUS = new Set(['pass', 'action', 'unknown', 'error']);
const defaultLoaders = {
  github: () => import('../../check-github-access/scripts/github-access.mjs'),
  msx: () => import('../../check-msx-access/scripts/msx-access.mjs'),
};

function check(id, status, message, next, details = {}) {
  return { id, status, message, ...(next ? { next } : {}), ...details };
}

async function runPart(kind, options, loader) {
  let module;
  try {
    module = await loader();
  } catch (error) {
    return [check(`${kind}.integration`, 'error', `The ${kind} check could not be loaded.`,
      `Ensure the ${kind} skill is installed and retry.`, { code: error.code ?? 'load_failed' })];
  }
  try {
    const result = await module.diagnose(options);
    if (result?.schemaVersion !== 1 || result.kind !== kind || !Array.isArray(result.checks)
      || result.checks.length === 0 || result.checks.some((c) => typeof c?.id !== 'string'
        || !c.id.startsWith(`${kind}.`) || !VALID_STATUS.has(c.status)
        || typeof c.message !== 'string' || !c.message.trim())) {
      return [check(`${kind}.integration`, 'error', 'The check returned an incompatible result.',
        `Update the ${kind} check and the readiness check together.`)];
    }
    return result.checks;
  } catch (error) {
    return [check(`${kind}.integration`, 'error', `The ${kind} check failed: ${error.message}`,
      'Correct the reported problem and retry.', { code: error.code ?? 'check_failed' })];
  }
}

export async function diagnose(options = {}, loaders = defaultLoaders) {
  const { account, orgs = [], repos = [], role, root, server, profile, ssoUserId, timeoutMs } = options;
  const [github, msx] = await Promise.all([
    runPart('github', { account, orgs, repos, role }, loaders.github),
    runPart('msx', { root, server, profile, ssoUserId, timeoutMs }, loaders.msx),
  ]);
  const checks = [
    ...github,
    ...msx,
    check('azure.subscription', 'unknown', 'Whether an Azure subscription is needed has not been verified.',
      'Confirm the role requirements and, if needed, verify the requested subscription separately from MS Sales access.'),
    check('demo.environment', 'unknown', 'Required demo environment readiness has not been verified.',
      'Confirm the applicable demo environment and its provisioning status.'),
    check('onboarding.training', 'unknown', 'Role-specific required training has not been verified.',
      'Confirm current requirements and completion with the official training source.'),
    check('onboarding.assignment', 'unknown', 'Account and pod assignments have not been verified.',
      'Confirm assignments with the manager and the current source of record.'),
  ];
  const status = checks.some((c) => c.status === 'error') ? 'error'
    : checks.some((c) => c.status === 'action') ? 'action'
      : checks.some((c) => c.status === 'unknown') ? 'unknown' : 'ready';
  return { schemaVersion: 1, kind: 'new-hire-readiness', status, checks };
}

export function parseArgs(args) {
  if (args[0] !== 'check') throw new Error('Usage: new-hire-readiness.mjs check [--account LOGIN] [--org ORG]... [--repo OWNER/NAME]... [--role ROLE] [--root PATH] [--server PATH] [--profile PATH] [--sso-user-id ID] [--timeout-ms MS]');
  const options = { orgs: [], repos: [] };
  for (let i = 1; i < args.length; i++) {
    const flag = args[i];
    if (!['--account', '--org', '--repo', '--role', '--root', '--server', '--profile', '--sso-user-id', '--timeout-ms'].includes(flag)
      || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Invalid or missing value for ${flag}.`);
    const value = args[++i];
    const key = flag === '--timeout-ms' ? 'timeoutMs' : flag === '--sso-user-id' ? 'ssoUserId' : flag.slice(2);
    if (key === 'repo') options.repos.push(value);
    else if (key === 'org') options.orgs.push(value);
    else {
      if (options[key]) throw new Error(`${flag} can only be supplied once.`);
      if (key === 'timeoutMs') {
        if (!/^\d+$/.test(value) || Number(value) < 1000 || Number(value) > 300000) {
          throw new Error('--timeout-ms must be an integer from 1000 to 300000.');
        }
        options[key] = Number(value);
      } else if (key === 'ssoUserId') {
        if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value)) {
          throw new Error('--sso-user-id must be a Microsoft 365 user object ID.');
        }
        options[key] = value;
      } else {
        options[key] = value;
      }
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
    console.log(JSON.stringify({ schemaVersion: 1, kind: 'new-hire-readiness', status: 'error',
      checks: [check('readiness.arguments', 'error', error.message)] }));
    process.exitCode = 1;
  }
}

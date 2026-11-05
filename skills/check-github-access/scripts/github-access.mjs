#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const REPO = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const ACCOUNT = /^[A-Za-z0-9](?:[A-Za-z0-9_-]*[A-Za-z0-9])?$/;
const ORG = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const ROLES = ['read', 'triage', 'write', 'maintain', 'admin'];

export function runGh(args, env = process.env) {
  const result = spawnSync('gh', args, {
    encoding: 'utf8',
    env,
    timeout: 20000,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) {
    return { ok: false, code: result.error.code ?? 'command_failed' };
  }
  if (result.status !== 0) {
    const match = (result.stderr ?? '').match(/(?:HTTP\s+|^)(401|403|404|429)\b/m);
    return { ok: false, code: match ? `http_${match[1]}` : 'command_failed' };
  }
  return { ok: true, text: result.stdout };
}

function parseJson(result) {
  if (!result.ok) return result;
  try {
    return { ok: true, value: JSON.parse(result.text) };
  } catch {
    return { ok: false, code: 'invalid_response' };
  }
}

function check(id, status, message, next, details = {}) {
  return { id, status, message, ...(next ? { next } : {}), ...details };
}

export function summarize(checks) {
  if (checks.some((c) => c.status === 'error')) return 'error';
  if (checks.some((c) => c.status === 'action')) return 'action';
  if (checks.some((c) => c.status === 'unknown')) return 'unknown';
  return 'ready';
}

function hasRole(permissions, role) {
  if (permissions === undefined || permissions === null) return role === 'read' ? true : null;
  if (typeof permissions !== 'object' || Array.isArray(permissions)
    || ['admin', 'maintain', 'push', 'triage', 'pull'].some((key) => (
      permissions[key] !== undefined && typeof permissions[key] !== 'boolean'
    ))) return null;
  const actual = permissions.admin ? 'admin' : permissions.maintain ? 'maintain'
    : permissions.push ? 'write' : permissions.triage ? 'triage'
      : permissions.pull ? 'read' : null;
  if (!actual) return null;
  return ROLES.indexOf(actual) >= ROLES.indexOf(role);
}

export function diagnose({ account, orgs = [], repos = [], role = 'read', run = runGh, env = process.env } = {}) {
  if (account && !ACCOUNT.test(account)) throw new Error('Invalid GitHub account name.');
  if (orgs.some((org) => !ORG.test(org))) throw new Error('Invalid GitHub organization name.');
  if (!ROLES.includes(role) || role === 'admin') throw new Error('Role must be read, triage, write, or maintain.');
  if (repos.some((repo) => !REPO.test(repo))) throw new Error('Each repository must be owner/name on github.com.');

  const checks = [];
  let ghEnv = { ...env, GH_HOST: 'github.com' };
  if (account) {
    const token = run(['auth', 'token', '--hostname', 'github.com', '--user', account], ghEnv);
    if (!token.ok || !token.text?.trim()) {
      const missingCli = token.code === 'ENOENT';
      const timedOut = token.code === 'ETIMEDOUT';
      checks.push(check('github.authentication', missingCli ? 'error' : timedOut ? 'unknown' : 'action',
        missingCli ? 'The GitHub CLI could not be found.'
          : timedOut ? 'The selected GitHub account could not be checked before the timeout.'
            : 'The selected GitHub account is not available to gh.',
        missingCli ? 'Install the GitHub CLI using your organization’s approved process.'
          : timedOut ? 'Check the GitHub CLI and retry.'
            : 'Sign in with gh auth login, then retry with the intended account.',
        token.code ? { code: token.code } : {}));
      return { schemaVersion: 1, kind: 'github', status: summarize(checks), checks };
    }
    ghEnv = { ...ghEnv, GH_TOKEN: token.text.trim() };
  }

  const user = parseJson(run(['api', '--hostname', 'github.com', 'user'], ghEnv));
  if (!user.ok || typeof user.value?.login !== 'string' || !ACCOUNT.test(user.value.login)) {
    checks.push(check('github.authentication', user.code === 'ENOENT' ? 'error' : 'unknown',
      'GitHub authentication could not be verified.', 'Check gh auth status and your network connection.',
      { code: user.code ?? 'invalid_response' }));
    return { schemaVersion: 1, kind: 'github', status: summarize(checks), checks };
  }
  const login = user.value.login;
  if (account && login.toLowerCase() !== account.toLowerCase()) {
    checks.push(check('github.authentication', 'error', 'The authenticated account does not match the requested account.',
      'Resolve the conflicting GitHub credentials before checking repository access.'));
    return { schemaVersion: 1, kind: 'github', status: summarize(checks), checks };
  }
  checks.push(check('github.authentication', 'pass', 'GitHub authentication is working.', null, { account: login }));
  checks.push(login.toLowerCase().endsWith('_microsoft')
    ? check('github.emu', 'unknown', 'The authenticated account has the Microsoft EMU naming convention, but managed status was not independently verified.',
      'Confirm the account in the Microsoft GitHub enterprise if managed status is required.')
    : check('github.emu', 'unknown', 'The authenticated account does not have the common Microsoft EMU naming convention; managed status was not independently verified.',
      'Confirm the account in the Microsoft GitHub enterprise if managed status is required; personal and managed accounts can have different access.'));

  for (const org of [...new Set(orgs.map((value) => value.toLowerCase()))]) {
    const membership = parseJson(run(['api', '--hostname', 'github.com', `user/memberships/orgs/${org}`], ghEnv));
    const state = membership.value?.state;
    checks.push(check(`github.organization.${org}`, !membership.ok ? 'unknown'
      : state === 'active' ? 'pass' : state === 'pending' ? 'action' : 'unknown',
    state === 'active' ? 'The authenticated account has an active organization membership.'
      : state === 'pending' ? 'The organization membership is pending.'
        : 'Organization membership could not be established from this account.',
    state === 'active' ? null : 'Verify the organization and its sanctioned membership process; Microsoft EMU organizations may be available through StartRight Join Organization.',
    { organization: org, ...(!membership.ok ? { code: membership.code } : {}) }));
  }
  const uniqueRepos = [...new Set(repos.map((repo) => repo.toLowerCase()))];
  if (!uniqueRepos.length) {
    checks.push(check('github.repositories', 'unknown', 'No repositories were supplied.',
      'Repeat --repo owner/name for each repository required by this role.'));
  }
  for (const repo of uniqueRepos) {
    const result = parseJson(run(['api', '--hostname', 'github.com', `repos/${repo}`], ghEnv));
    if (!result.ok) {
      const inaccessible = result.code === 'http_404' || result.code === 'http_403';
      checks.push(check(`github.repository.${repo}`, inaccessible ? 'action' : 'unknown',
        inaccessible ? 'The repository is not visible to this account; its existence and access cannot be distinguished.'
          : 'Repository access could not be verified.',
        'Confirm the repository and account with its owner; for Microsoft EMU, request access through its governed ACL or group.',
        { repository: repo, code: result.code }));
      continue;
    }
    if (typeof result.value?.full_name !== 'string' || result.value.full_name.toLowerCase() !== repo) {
      checks.push(check(`github.repository.${repo}`, 'unknown',
        'The repository response did not confirm the requested repository.',
        'Verify the repository name and inspect the GitHub response before requesting access.',
        { repository: repo, code: 'invalid_response' }));
      continue;
    }
    const allowed = hasRole(result.value?.permissions, role);
    checks.push(check(`github.repository.${repo}`, allowed === null ? 'unknown' : allowed ? 'pass' : 'action',
      allowed === null ? `The repository is visible, but ${role} permission could not be verified.`
        : allowed ? `The repository is visible with at least ${role} permission.`
          : `The repository is visible but the requested ${role} permission is not present.`,
      allowed === true ? null : 'Ask the repository owner to review the required role and the governed ACL or group.',
      { repository: repo, requestedRole: role }));
  }
  checks.push(check('github.copilot-entitlement', 'unknown', 'Copilot entitlement was not verified.',
    'Verify the license for the intended account using your organization’s approved process.'));
  checks.push(check('github.dual-access', 'unknown', 'Dual Access eligibility and entitlement were not verified.',
    'Check the applicable Dual Access process only if the role requires it.'));
  return { schemaVersion: 1, kind: 'github', status: summarize(checks), checks };
}

export function planRequest({ account, repo, role, recipient, reason }) {
  if (!account || !ACCOUNT.test(account)) throw new Error('A valid GitHub account is required.');
  if (!repo || !REPO.test(repo)) throw new Error('A repository in owner/name form is required.');
  if (!role || !ROLES.includes(role) || role === 'admin') throw new Error('Role must be read, triage, write, or maintain.');
  if (!recipient || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) throw new Error('An exact recipient email is required.');
  if (!reason || !reason.trim() || reason.length > 500 || /[\r\n]/.test(reason)) throw new Error('A single-line justification of at most 500 characters is required.');
  return { schemaVersion: 1, kind: 'github-access-request', status: 'preview', submitted: false,
    request: { account, repository: repo, role, recipient, justification: reason },
    message: {
      subject: `Request for ${role} access to ${repo}`,
      body: `Please advise on the approved group or access package for ${role} access to ${repo}.\n\nGitHub account: ${account}\nJustification: ${reason}`,
    },
    next: 'Review these values and use the organization’s governed ACL or group process; confirm before sending a request.' };
}

export function parseArgs(args) {
  const command = args[0];
  if (!['check', 'plan'].includes(command)) throw new Error('Usage: github-access.mjs check|plan [options]');
  const options = command === 'check' ? { orgs: [], repos: [] } : {};
  for (let i = 1; i < args.length; i++) {
    const flag = args[i];
    const allowed = command === 'check' ? ['--account', '--org', '--repo', '--role']
      : ['--account', '--repo', '--role', '--recipient', '--reason'];
    if (!allowed.includes(flag) || !args[i + 1] || args[i + 1].startsWith('--')) {
      throw new Error(`Invalid or missing value for ${flag}.`);
    }
    const value = args[++i];
    if (command === 'check' && flag === '--repo') options.repos.push(value);
    else if (command === 'check' && flag === '--org') options.orgs.push(value);
    else if (flag === '--repo') {
      if (options.repo) throw new Error('--repo can only be supplied once for a plan.');
      options.repo = value;
    } else {
      const key = flag.slice(2);
      if (options[key]) throw new Error(`${flag} can only be supplied once.`);
      options[key] = value;
    }
  }
  return { command, options };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { command, options } = parseArgs(process.argv.slice(2));
    const result = command === 'plan' ? planRequest(options) : diagnose(options);
    console.log(JSON.stringify(result));
    process.exitCode = result.status === 'ready' || result.status === 'preview' ? 0 : result.status === 'error' ? 1 : 2;
  } catch (error) {
    console.log(JSON.stringify({ schemaVersion: 1, kind: 'github', status: 'error', checks: [
      check('github.arguments', 'error', error.message),
    ] }));
    process.exitCode = 1;
  }
}

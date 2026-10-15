// CLI behaviour that needs no browser: help, argument handling, local refusals, and the guidance hints.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, nextHint, HELP } from '../../skills/request-new-github-repository/scripts/startright-repo.mjs';

// An unroutable URL: if any command wrongly opened a browser, it could not reach a real service from here.
const env = () => ({ ...process.env, STARTRIGHT_URL: 'http://127.0.0.1:9', STARTRIGHT_SKILL_HOME: mkdtempSync(join(tmpdir(), 'sr-cli-')) });
const ARGS = ['--org', 'o', '--name', 'n', '--description', 'd', '--direct-owner', 'a@b.com'];

describe('help and arguments', () => {
  it('prints help', async () => {
    for (const a of [['--help'], ['-h'], ['plan', '--help']]) { const r = await run(a, { env: env() }); assert.equal(r.code, 0); assert.equal(r.out.usage, HELP); }
    assert.equal((await run([], { env: env() })).code, 1);
  });
  it('rejects unknown commands, flags and stray arguments', async () => {
    assert.equal((await run(['frobnicate'], { env: env() })).out.error, 'bad_args');
    assert.equal((await run(['plan', '--allow-duplicate'], { env: env() })).out.error, 'bad_args');
    assert.equal((await run(['status', 'extra'], { env: env() })).out.error, 'bad_args');
    assert.equal((await run(['status', '--repo', 'not-a-repo'], { env: env() })).out.error, 'bad_args');
    assert.equal((await run(['options', '--purpose', 'x'], { env: env() })).out.error, 'bad_args');
    assert.equal((await run(['verify', '--org', 'x'], { env: env() })).out.error, 'bad_args');
  });
  it('submit needs a plan and the terms sha', async () => {
    assert.equal((await run(['submit'], { env: env() })).out.error, 'bad_args');
    assert.equal((await run(['submit', '--plan', 'abc'], { env: env() })).out.error, 'bad_args');
    assert.equal((await run(['submit', '--plan', 'abc', '--accept-terms', 'x'], { env: env() })).out.error, 'plan_invalid');
  });
  it('there is no way to skip the duplicate or terms checks', () => {
    assert.ok(!/allow-duplicate|--force|--yes|--no-confirm/.test(HELP));
  });
});

describe('local refusals never open a browser', () => {
  it('production is blocked with Proxima guidance', async () => {
    for (const c of ['production', 'tcb', 'HVT']) {
      const r = await run(['plan', ...ARGS, '--classification', c], { env: env() });
      assert.equal(r.code, 2);
      assert.equal(r.out.status, 'blocked');
      assert.equal(r.out.browser, 'not opened');
      assert.match(r.out.next, /Proxima/);
    }
  });
  it('invalid input is reported with a suggestion', async () => {
    const r = await run(['plan', ...ARGS.map((x) => (x === 'n' ? 'bad name!' : x)), '--classification', 'non-production'], { env: env() });
    assert.equal(r.code, 2);
    assert.equal(r.out.status, 'invalid');
    assert.equal(r.out.errors[0].suggestion, 'bad-name');
  });
  it('conflicting ownership and bad access are caught locally', async () => {
    const r = await run(['plan', ...ARGS, '--classification', 'non-production', '--service-tree', '123e4567-e89b-42d3-a456-426614174000', '--access', 'x=boss'], { env: env() });
    assert.equal(r.out.status, 'invalid');
    assert.deepEqual(r.out.errors.map((e) => e.code).sort(), ['access_role_invalid', 'ownership_conflict']);
  });
});

describe('next hints', () => {
  it('ready plans point at submit with the exact id and terms sha', () => {
    const n = nextHint('plan', { status: 'ready', planId: 'p1', terms: { sha: 's1' } });
    assert.match(n, /explicitly accept/);
    assert.match(n, /--plan p1 --accept-terms s1/);
  });
  it('never suggests resubmitting after an ambiguous outcome', () => {
    for (const outcome of ['partial', 'unknown']) assert.match(nextHint('submit', { outcome, repo: 'o/n' }), /Do NOT resubmit/);
    assert.match(nextHint('submit', { outcome: 'success', repo: 'o/n', webUrl: 'u' }), /o\/n/);
    assert.match(nextHint('submit', { outcome: 'rejected', retryable: true }), /status first/);
  });
  it('covers the error codes', () => {
    for (const error of ['auth_required', 'startright_unreachable', 'plan_invalid', 'terms_not_accepted', 'already_submitted', 'contract_violation', 'non_microsoft_account', 'session_expired']) assert.ok(nextHint('plan', { ok: false, error }), error);
    assert.match(nextHint('plan', { ok: false, error: 'auth_required' }), /--headed/);
    assert.match(nextHint('plan', { ok: false, error: 'contract_violation' }), /Nothing was created/);
  });
});

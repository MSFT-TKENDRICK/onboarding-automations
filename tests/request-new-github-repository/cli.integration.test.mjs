// End-to-end contract tests: the real CLI, driving a real headless Chromium-family browser, against the mock StartRight
// service on 127.0.0.1. Skipped automatically when no browser is installed. No scenario can reach the real service.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMockStartRight, IDS } from './fixtures/mock-startright.mjs';
import { run } from '../../skills/request-new-github-repository/scripts/startright-repo.mjs';
import { findBrowser } from '../../skills/request-new-github-repository/scripts/lib/browser.mjs';

let skip = false;
try { findBrowser(); } catch { skip = 'no Chromium-family browser found'; }

const BASE = ['--org', 'contoso-eng', '--name', 'my-new-repo', '--description', 'A test repository', '--classification', 'non-production', '--direct-owner', 'alex@contoso.com', '--access', 'Contoso Eng Maintainers=maintain'];

async function scenario(overrides = {}) {
  const m = await startMockStartRight(overrides);
  const home = mkdtempSync(join(tmpdir(), 'sr-it-'));
  const env = { ...process.env, STARTRIGHT_URL: m.url, STARTRIGHT_SKILL_HOME: home, STARTRIGHT_LOG_FILE: join(home, 'run.log'), STARTRIGHT_EPHEMERAL: '1', STARTRIGHT_AUTH_TIMEOUT_MS: '6000' };
  delete env.STARTRIGHT_PROFILE_DIR;
  const cli = (...args) => run(args, { env });
  return { m, cli, env, home, async done() { await m.close(); await rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 }).catch(() => {}); } };
}

async function with_(overrides, fn) {
  const sc = await scenario(overrides);
  try { await fn(sc); } catch (e) {
    try { e.message += `\n--- driver log ---\n${readFileSync(join(sc.home, 'run.log'), 'utf8').split('\n').slice(-40).join('\n')}`; } catch {}
    throw e;
  } finally { await sc.done(); }
}

const plan = (sc, extra = [], base = BASE) => sc.cli('plan', ...base, ...extra);
const submit = (sc, p, sha = p.out.terms?.sha, extra = []) => {
  assert.equal(p.out.status, 'ready', `plan was not ready: ${JSON.stringify(p.out)}`);
  return sc.cli('submit', '--plan', p.out.planId, '--accept-terms', sha, ...extra);
};
const noViolations = (sc) => assert.deepEqual(sc.m.state.violations, [], 'the client broke the contract (or the mock did)');

describe('startright-repo CLI against the mock StartRight', { skip, concurrency: 2, timeout: 600000 }, () => {
  it('plan resolves everything, reads the terms, and sends no writes at all', () => with_({}, async (sc) => {
    const r = await plan(sc);
    assert.equal(r.code, 0, JSON.stringify(r.out));
    assert.equal(r.out.status, 'ready');
    assert.match(r.out.planId, /^[0-9a-f]{16}$/);
    assert.equal(r.out.resolved.organization, 'contoso-eng');
    assert.equal(r.out.resolved.requester, 'testuser_microsoft');
    assert.deepEqual(r.out.resolved.ownership.owners.map((o) => o.displayName), ['Test User', 'Alex Rivera']);
    assert.deepEqual(r.out.resolved.access.map((a) => `${a.displayName}:${a.role}`), ['Test User:maintain', 'Contoso Eng Maintainers:maintain']);
    assert.ok(r.out.defaulted.some((d) => d.field === 'visibility'));
    assert.match(r.out.terms.sha, /^[0-9a-f]{16}$/);
    assert.match(r.out.next, /--accept-terms/);
    assert.deepEqual(sc.m.state.writes, [], 'plan must not write anything');
    noViolations(sc);
  }));

  it('submit creates the repository exactly once with the exact planned body', () => with_({}, async (sc) => {
    const p = await plan(sc);
    const r = await submit(sc, p);
    assert.equal(r.code, 0, JSON.stringify(r.out));
    assert.equal(r.out.outcome, 'success');
    assert.equal(r.out.repo, 'contoso-eng/my-new-repo');
    assert.match(r.out.webUrl, /my-new-repo$/);
    assert.equal(sc.m.createWrites().length, 1);
    const b = sc.m.state.creates[0];
    assert.equal(b.classification, 'nonproduction');
    assert.equal(b.repository.visibility, 'internal');
    assert.equal(b.ownership.type, 'directOwners');
    assert.equal(b.ownership.owners.length, 2);
    assert.deepEqual(b.accessControl.map((a) => a.permission), ['maintain', 'maintain']);
    noViolations(sc);
    const again = await sc.cli('submit', '--plan', p.out.planId, '--accept-terms', p.out.terms.sha);
    assert.equal(again.code, 1);
    assert.equal(again.out.error, 'already_submitted');
    assert.equal(sc.m.createWrites().length, 1, 'a second submit must never reach the service');
  }));

  it('submit refuses without the exact terms sha and never opens a browser for it', () => with_({}, async (sc) => {
    const p = await plan(sc);
    const before = sc.m.state.requests;
    const r = await submit(sc, p, 'f'.repeat(64));
    assert.equal(r.code, 1);
    assert.equal(r.out.error, 'terms_not_accepted');
    assert.equal(sc.m.state.requests, before);
    assert.equal(sc.m.createWrites().length, 0);
  }));

  it('a service tree owner resolves by name, honours restrictions and ambiguity', () => with_({}, async (sc) => {
    const base = ['--org', 'contoso-eng', '--name', 'svc-repo', '--description', 'd', '--classification', 'non-production', '--access', 'Contoso Eng Maintainers=maintain'];
    const ok = await sc.cli('plan', ...base, '--service-tree-name', 'Widget Service');
    assert.equal(ok.out.status, 'ready', JSON.stringify(ok.out));
    assert.equal(ok.out.resolved.ownership.serviceTreeId, IDS.svc);
    const amb = await sc.cli('plan', ...base, '--service-tree-name', 'Twin Service');
    assert.equal(amb.code, 2);
    assert.equal(amb.out.status, 'needs_input');
    assert.equal(amb.out.missing.find((m) => m.code === 'ambiguous_service').candidates.length, 2);
    const blocked = await sc.cli('plan', ...base, '--service-tree', IDS.restricted);
    assert.equal(blocked.out.status, 'blocked');
    assert.equal(blocked.out.blockers[0].code, 'service_restricted');
    const near = await sc.cli('plan', ...base, '--service-tree-name', 'Widget');
    assert.equal(near.out.status, 'invalid');
    assert.equal(near.out.errors[0].candidates[0].name, 'Widget Service');
    noViolations(sc);
  }));

  it('never picks between ambiguous people, and reports what is missing', () => with_({}, async (sc) => {
    const amb = await plan(sc, [], ['--org', 'contoso-eng', '--name', 'x1', '--description', 'd', '--classification', 'non-production', '--direct-owner', 'Pat Kim', '--access', 'Contoso Eng Maintainers=maintain']);
    assert.equal(amb.out.status, 'needs_input');
    assert.equal(amb.out.missing.find((m) => m.code === 'ambiguous_person').candidates.length, 2);
    const noRule = await plan(sc, [], ['--org', 'contoso-eng', '--name', 'x2', '--description', 'd', '--classification', 'non-production', '--direct-owner', 'alex@contoso.com']);
    assert.equal(noRule.out.status, 'needs_input');
    assert.ok(noRule.out.missing.some((m) => m.code === 'maintain_rule'));
    noViolations(sc);
  }));

  it('refuses taken names, unknown organizations and organizations not joined', () => with_({}, async (sc) => {
    const taken = await plan(sc, [], ['--org', 'contoso-eng', '--name', 'taken-repo', '--description', 'd', '--classification', 'non-production', '--direct-owner', 'alex@contoso.com', '--access', 'Contoso Eng Maintainers=maintain']);
    assert.equal(taken.out.errors[0].code, 'name_unavailable');
    const unknown = await plan(sc, [], ['--org', 'nope-org', '--name', 'x3', '--description', 'd', '--classification', 'non-production', '--direct-owner', 'alex@contoso.com']);
    assert.equal(unknown.out.errors[0].code, 'org_unknown');
    const joinable = await plan(sc, [], ['--org', 'contoso-secret', '--name', 'x4', '--description', 'd', '--classification', 'non-production', '--direct-owner', 'alex@contoso.com']);
    assert.equal(joinable.out.status, 'blocked');
    assert.equal(joinable.out.blockers[0].code, 'not_a_member');
    assert.deepEqual(sc.m.state.writes, []);
    noViolations(sc);
  }));

  it('production classification is refused before any browser or network use', () => with_({}, async (sc) => {
    const r = await plan(sc, [], ['--org', 'contoso-eng', '--name', 'p1', '--description', 'd', '--classification', 'production', '--direct-owner', 'alex@contoso.com']);
    assert.equal(r.out.status, 'blocked');
    assert.equal(r.out.browser, 'not opened');
    assert.match(r.out.blockers[0].message, /Proxima/);
    assert.equal(sc.m.state.requests, 0);
  }));

  describe('every documented outcome of the create call', () => {
    const cases = [
      ['conflict', 2, 'rejected', (o) => assert.equal(o.reason, 'conflict')],
      ['forbidden', 2, 'rejected', (o) => assert.equal(o.reason, 'forbidden')],
      ['rate_limited', 2, 'rejected', (o) => assert.equal(o.retryable, true)],
      ['unavailable', 2, 'rejected', (o) => assert.equal(o.retryable, true)],
      ['partial', 3, 'partial', (o) => assert.equal(o.failedStage, 'accessControl')],
      ['unknown500', 3, 'unknown', () => {}],
      ['garbage500', 3, 'unknown', () => {}],
      ['drop', 3, 'unknown', () => {}],
    ];
    for (const [mode, code, outcome, extra] of cases) {
      it(`${mode} -> ${outcome}`, () => with_({ createMode: mode }, async (sc) => {
        const p = await plan(sc);
        const r = await submit(sc, p);
        assert.equal(r.out.outcome, outcome, JSON.stringify(r.out));
        assert.equal(r.code, code);
        extra(r.out);
        assert.equal(sc.m.createWrites().length, 1);
        const retry = await sc.cli('submit', '--plan', p.out.planId, '--accept-terms', p.out.terms.sha);
        if (['partial', 'unknown'].includes(outcome)) {
          assert.equal(retry.out.error, 'already_submitted', 'an ambiguous outcome must block any resubmission');
          assert.equal(sc.m.createWrites().length, 1);
        }
        assert.match(r.out.next ?? '', /./);
      }));
    }

    it('a dropped connection after the repository was created is reconciled by status, never by resubmitting', () => with_({ createMode: 'drop_after_create' }, async (sc) => {
      const p = await plan(sc);
      const r = await submit(sc, p);
      assert.equal(r.out.outcome, 'unknown');
      const st = await sc.cli('status', '--repo', 'contoso-eng/my-new-repo');
      assert.equal(st.out.found, true);
      assert.equal(st.out.journal.state, 'sent');
    }));

    it('a rejection is safe to correct and resubmit once', () => with_({ createMode: 'conflict' }, async (sc) => {
      const p = await plan(sc);
      assert.equal((await submit(sc, p)).out.outcome, 'rejected');
      sc.m.cfg.createMode = 'created';
      const ok = await sc.cli('submit', '--plan', p.out.planId, '--accept-terms', p.out.terms.sha);
      assert.equal(ok.out.outcome, 'success', JSON.stringify(ok.out));
      assert.equal(sc.m.createWrites().length, 2);
    }));
  });

  describe('sign-in', () => {
    it('silent sign-in works with an empty profile', () => with_({ auth: 'silent' }, async (sc) => {
      assert.equal((await plan(sc)).out.status, 'ready');
    }));
    it('an unfinished sign-in is reported as auth_required with the --headed hint', () => with_({ auth: 'login' }, async (sc) => {
      const r = await plan(sc);
      assert.equal(r.code, 1);
      assert.equal(r.out.error, 'auth_required');
      assert.match(r.out.next, /--headed/);
      assert.deepEqual(sc.m.state.writes, []);
    }));
  });

  describe('safety rails', () => {
    it('status, options and verify-style reads never write', () => with_({}, async (sc) => {
      assert.equal((await sc.cli('status')).out.ok, true);
      const o = await sc.cli('options', '--org', 'contoso-eng', '--find-principal', 'alex', '--find-service', 'widget');
      assert.deepEqual(o.out.organizations, ['contoso-eng', 'contoso-labs']);
      assert.equal(o.out.principals[0].email, 'alex@contoso.com');
      assert.ok(o.out.services.near.length || o.out.services.exact.length);
      assert.deepEqual(sc.m.state.writes, []);
      noViolations(sc);
    }));

    it('verify proves the contract against the mock and reports that the live service was not checked', () => with_({}, async (sc) => {
      const r = await sc.cli('verify');
      assert.equal(r.code, 0, JSON.stringify(r.out));
      assert.equal(r.out.ok, true);
      assert.equal(r.out.live, false);
      assert.ok(r.out.checks.find((c) => c.id === 'no_writes_sent').pass);
      assert.deepEqual(sc.m.state.writes, []);
      noViolations(sc);
    }));

    it('a plan made for another service URL is refused', () => with_({}, async (sc) => {
      const p = await plan(sc);
      const other = await run(['submit', '--plan', p.out.planId, '--accept-terms', p.out.terms.sha], { env: { ...sc.env, STARTRIGHT_URL: 'http://127.0.0.1:9' } });
      assert.equal(other.out.error, 'plan_mismatch');
    }));

    it('a plan expires and submit refuses an unknown plan id', () => with_({}, async (sc) => {
      const r = await sc.cli('submit', '--plan', 'deadbeefdeadbeef', '--accept-terms', 'a'.repeat(64));
      assert.equal(r.out.error, 'plan_invalid');
    }));
  });
});

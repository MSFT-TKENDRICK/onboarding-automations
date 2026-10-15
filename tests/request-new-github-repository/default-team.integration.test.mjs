// End-to-end tests for the manager and default-team defaults: the real CLI and a real headless browser against the mock
// StartRight, plus a mock Microsoft Graph, both on 127.0.0.1. Fake people only. Skipped when no browser is installed.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMockStartRight, DEFAULTS } from './fixtures/mock-startright.mjs';
import { startMockGraph, GRAPH_TOKEN, PEOPLE, gUser } from './fixtures/mock-graph.mjs';
import { run } from '../../skills/request-new-github-repository/scripts/startright-repo.mjs';
import { findBrowser } from '../../skills/request-new-github-repository/scripts/lib/browser.mjs';

let skip = false;
try { findBrowser(); } catch { skip = 'no Chromium-family browser found'; }

const MORGAN = '12121212-1212-4212-8212-121212121212';
const principals = [...DEFAULTS.principals, { principalId: MORGAN, type: 'user', displayName: 'Morgan Chu', secondaryText: 'morgan@contoso.com' }];
const BASE = ['--org', 'contoso-eng', '--name', 'my-new-repo', '--description', 'A test repository', '--classification', 'non-production'];

async function scenario({ graph = {}, startright = {} } = {}) {
  const sr = await startMockStartRight({ principals, ...startright });
  const g = await startMockGraph(graph);
  const home = mkdtempSync(join(tmpdir(), 'sr-team-'));
  const env = { ...process.env, STARTRIGHT_URL: sr.url, STARTRIGHT_GRAPH_URL: g.url, STARTRIGHT_GRAPH_TOKEN: GRAPH_TOKEN, STARTRIGHT_SKILL_HOME: home, STARTRIGHT_LOG_FILE: join(home, 'run.log'), STARTRIGHT_EPHEMERAL: '1', STARTRIGHT_AUTH_TIMEOUT_MS: '6000' };
  delete env.STARTRIGHT_PROFILE_DIR;
  return { sr, g, home, cli: (...args) => run(args, { env }), async done() { await sr.close(); await g.close(); await rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 }).catch(() => {}); } };
}

async function with_(opts, fn) {
  const sc = await scenario(opts);
  try { await fn(sc); } catch (e) {
    try { e.message += `\n--- driver log ---\n${readFileSync(join(sc.home, 'run.log'), 'utf8').split('\n').slice(-40).join('\n')}`; } catch {}
    throw e;
  } finally { await sc.done(); }
}

const clean = (sc) => { assert.deepEqual(sc.sr.state.violations, [], 'StartRight contract violated'); assert.deepEqual(sc.g.state.violations, [], 'Graph client was not read-only'); };
const access = (r) => r.out.resolved.access.map((a) => `${a.displayName}:${a.role}`);
const warning = (r, code) => r.out.warnings.find((w) => w.code === code);

describe('manager co-owner and default team', { skip, concurrency: 2, timeout: 600000 }, () => {
  it('defaults the manager as co-owner and your manager\'s other reports as the write team', () => with_({}, async (sc) => {
    const r = await sc.cli('plan', ...BASE);
    assert.equal(r.out.status, 'ready', JSON.stringify(r.out));
    assert.deepEqual(r.out.resolved.ownership.owners.map((o) => o.displayName), ['Test User', 'Morgan Chu']);
    assert.equal(r.out.resolved.ownership.owners[1].githubHandle, 'morgan_microsoft');
    assert.deepEqual(access(r).sort(), ['Alex Rivera:write', 'Morgan Chu:maintain', 'Sam Lee:write', 'Test User:maintain']);
    assert.deepEqual(r.out.resolved.access.filter((a) => a.role === 'write').map((a) => a.githubHandle).sort(), ['alex_microsoft', 'sam_microsoft']);
    assert.ok(r.out.defaulted.some((d) => d.field === 'ownership' && /Morgan Chu/.test(d.value)));
    assert.ok(r.out.defaulted.some((d) => d.field === 'access' && /alex_microsoft/.test(d.value) && /write/.test(d.value)));
    assert.match(warning(r, 'team_members_unresolved').message, /ghost_microsoft/, 'a report StartRight cannot find is named, not silently dropped');
    assert.ok(!JSON.stringify(r.out).includes('Dee Disabled'), 'disabled accounts are skipped');
    assert.ok(!r.out.warnings.some((w) => w.code === 'org_defaults_skipped'));
    assert.deepEqual(sc.sr.state.writes, []);
    assert.deepEqual(sc.g.state.requests.map((x) => x.split(' ')[0]), ['GET', 'GET', 'GET']);
    clean(sc);
  }));

  it('submits the manager as the second owner and the team with their roles', () => with_({}, async (sc) => {
    const p = await sc.cli('plan', ...BASE);
    const r = await sc.cli('submit', '--plan', p.out.planId, '--accept-terms', p.out.terms.sha);
    assert.equal(r.out.outcome, 'success', JSON.stringify(r.out));
    const b = sc.sr.state.creates[0];
    assert.equal(b.ownership.type, 'directOwners');
    assert.equal(b.ownership.owners.length, 2);
    assert.deepEqual(b.accessControl.map((a) => a.permission).sort(), ['maintain', 'maintain', 'write', 'write']);
    assert.equal(sc.sr.createWrites().length, 1);
    clean(sc);
  }));

  it('--team-role changes the role; maintain is refused', () => with_({}, async (sc) => {
    const r = await sc.cli('plan', ...BASE, '--team-role', 'read');
    assert.deepEqual(access(r).sort(), ['Alex Rivera:read', 'Morgan Chu:maintain', 'Sam Lee:read', 'Test User:maintain']);
    const bad = await sc.cli('plan', ...BASE, '--team-role', 'maintain');
    assert.equal(bad.out.status, 'invalid');
    assert.ok(bad.out.errors.some((e) => e.code === 'team_role_invalid'));
  }));

  it('--no-default-team keeps the manager but adds nobody else', () => with_({}, async (sc) => {
    const r = await sc.cli('plan', ...BASE, '--no-default-team');
    assert.equal(r.out.status, 'ready', JSON.stringify(r.out));
    assert.deepEqual(access(r).sort(), ['Morgan Chu:maintain', 'Test User:maintain']);
    clean(sc);
  }));

  it('--no-manager-owner asks for the owner again but still adds the team', () => with_({}, async (sc) => {
    const r = await sc.cli('plan', ...BASE, '--no-manager-owner', '--access', 'Contoso Eng Maintainers=maintain');
    assert.equal(r.out.status, 'needs_input');
    assert.ok(r.out.missing.some((m) => m.field === 'ownership'));
    assert.ok(!r.out.defaulted.some((d) => d.value.includes('Morgan')), 'the manager is neither owner nor team member');
    assert.ok(r.out.defaulted.some((d) => /alex_microsoft/.test(d.value)));
  }));

  it('an explicitly named owner replaces the manager default', () => with_({}, async (sc) => {
    const r = await sc.cli('plan', ...BASE, '--direct-owner', 'alex@contoso.com', '--access', 'Contoso Eng Maintainers=maintain');
    assert.equal(r.out.status, 'ready', JSON.stringify(r.out));
    assert.deepEqual(r.out.resolved.ownership.owners.map((o) => o.displayName), ['Test User', 'Alex Rivera']);
    assert.ok(!access(r).some((a) => a.startsWith('Morgan')), 'the manager is not added when someone else owns the repo');
    assert.ok(access(r).includes('Sam Lee:write'));
  }));

  it('a Service Tree owner cannot co-own, so the manager gets maintain', () => with_({}, async (sc) => {
    const r = await sc.cli('plan', ...BASE, '--service-tree-name', 'Widget Service', '--access', 'Contoso Eng Maintainers=maintain');
    assert.equal(r.out.status, 'ready', JSON.stringify(r.out));
    assert.equal(r.out.resolved.ownership.type, 'serviceTree');
    assert.ok(access(r).includes('Morgan Chu:maintain'));
    assert.ok(r.out.defaulted.some((d) => /Service Tree/.test(d.why) && /Morgan/.test(d.value)));
  }));

  it('a person you listed explicitly keeps the role you gave them', () => with_({}, async (sc) => {
    const r = await sc.cli('plan', ...BASE, '--access', 'alex@contoso.com=triage');
    assert.equal(r.out.status, 'ready', JSON.stringify(r.out));
    assert.ok(access(r).includes('Alex Rivera:triage'));
    assert.ok(!access(r).includes('Alex Rivera:write'));
  }));

  it('asks instead of guessing when the manager has too many reports', () => with_({
    graph: { reports: [PEOPLE.me, ...Array.from({ length: 26 }, (_, i) => gUser(`bbbbbbbb-0000-4000-8000-${String(i).padStart(12, '0')}`, `Person ${i}`, `person${i}`))] },
  }, async (sc) => {
    const r = await sc.cli('plan', ...BASE);
    assert.equal(r.out.status, 'needs_input');
    assert.ok(r.out.missing.some((m) => m.code === 'default_team_too_large'));
    assert.equal((await sc.cli('plan', ...BASE, '--no-default-team')).out.status, 'ready');
  }));

  it('falls back to asking for the owner when Graph is refused, and says why', () => with_({ graph: { status: { '/v1.0/me/manager': 403 } } }, async (sc) => {
    const r = await sc.cli('plan', ...BASE);
    assert.equal(r.out.status, 'needs_input');
    assert.equal(warning(r, 'org_defaults_skipped').reason, 'graph_forbidden');
    assert.ok(r.out.missing.some((m) => m.field === 'ownership'));
    assert.deepEqual(sc.sr.state.writes, []);
  }));

  it('refuses the defaults when the Azure CLI is signed in as somebody else', () => with_({ graph: { me: PEOPLE.alex } }, async (sc) => {
    const r = await sc.cli('plan', ...BASE);
    assert.equal(r.out.status, 'needs_input');
    assert.equal(warning(r, 'org_defaults_skipped').reason, 'graph_identity_mismatch');
    assert.ok(!JSON.stringify(r.out.resolved ?? {}).includes('Morgan'));
  }));

  it('does not add a manager StartRight cannot find, and asks for the owner', () => with_({ startright: { principals: DEFAULTS.principals } }, async (sc) => {
    const r = await sc.cli('plan', ...BASE);
    assert.equal(r.out.status, 'needs_input');
    assert.ok(warning(r, 'manager_not_found'));
    assert.ok(r.out.missing.some((m) => m.field === 'ownership'));
  }));

  it('options --show-team previews the manager and team without planning anything', () => with_({}, async (sc) => {
    const r = await sc.cli('options', '--org', 'contoso-eng', '--show-team');
    assert.equal(r.code, 0, JSON.stringify(r.out));
    assert.equal(r.out.team.available, true);
    assert.equal(r.out.team.manager.githubHandle, 'morgan_microsoft');
    assert.deepEqual(r.out.team.members.map((m) => `${m.githubHandle}:${m.inOrganization}`), ['alex_microsoft:true', 'ghost_microsoft:false', 'sam_microsoft:true']);
    assert.deepEqual(sc.sr.state.writes, []);
    clean(sc);
  }));
});

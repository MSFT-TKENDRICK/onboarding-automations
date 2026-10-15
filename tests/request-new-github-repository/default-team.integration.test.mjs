// End-to-end tests for the manager and default-team defaults: the real CLI and a real headless browser against the mock
// StartRight, plus a mock Microsoft Graph, both on 127.0.0.1. Fake people only. Skipped when no browser is installed.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMockStartRight, DEFAULTS } from './fixtures/mock-startright.mjs';
import { startMockGraph, GRAPH_TOKEN, PEOPLE, gUser, gGroup } from './fixtures/mock-graph.mjs';
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

// ---------------------------------------------------------------- the default team as an Entra group
const GRP = { good: 'cccccccc-0000-4000-8000-000000000001', partial: 'cccccccc-0000-4000-8000-000000000002', outsiders: 'cccccccc-0000-4000-8000-000000000003', nested: 'cccccccc-0000-4000-8000-000000000004' };
const SR_GROUPS = [
  { principalId: 'dddddddd-0000-4000-8000-000000000001', type: 'group', displayName: 'Morgan Directs', secondaryText: 'morgan-directs' },
  { principalId: 'dddddddd-0000-4000-8000-000000000002', type: 'group', displayName: 'Partial Directs', secondaryText: 'partial-directs' },
  { principalId: 'dddddddd-0000-4000-8000-000000000003', type: 'group', displayName: 'Morgan Direct Team', secondaryText: 'morgan-direct-team' },
  { principalId: 'dddddddd-0000-4000-8000-000000000004', type: 'group', displayName: 'Nested Directs', secondaryText: 'nested-directs' },
];
const OUTSIDER = gUser('eeeeeeee-0000-4000-8000-000000000001', 'Olive Outsider', 'olive');
const gGroups = () => [
  gGroup(GRP.good, 'Morgan Directs', 'morgan-directs', [PEOPLE.me, PEOPLE.alex, PEOPLE.sam, PEOPLE.gina]),
  gGroup(GRP.partial, 'Partial Directs', 'partial-directs', [PEOPLE.me, PEOPLE.alex]),
  gGroup(GRP.outsiders, 'Morgan Direct Team', 'morgan-direct-team', [PEOPLE.me, PEOPLE.alex, OUTSIDER]),
  gGroup(GRP.nested, 'Nested Directs', 'nested-directs', [PEOPLE.me, { '@odata.type': '#microsoft.graph.group', id: 'ffffffff-0000-4000-8000-000000000001', displayName: 'Inner' }]),
];
const withGroups = (extra = {}) => ({ graph: { groups: gGroups(), ...extra.graph }, startright: { principals: [...principals, ...SR_GROUPS], ...extra.startright } });

describe('default team as an Entra group', { skip, concurrency: 2, timeout: 600000 }, () => {
  it('accepts a group that holds only your manager\'s team, instead of adding people one by one', () => with_(withGroups(), async (sc) => {
    const r = await sc.cli('plan', ...BASE, '--team-group', 'Morgan Directs');
    assert.equal(r.out.status, 'ready', JSON.stringify(r.out));
    assert.deepEqual(access(r).sort(), ['Morgan Chu:maintain', 'Morgan Directs:write', 'Test User:maintain']);
    assert.ok(r.out.defaulted.some((d) => /Morgan Directs \(group\): write/.test(d.value)));
    assert.ok(warning(r, 'group_sync_delay'), 'a group takes 5-6 hours to reach GitHub');
    assert.ok(!warning(r, 'team_members_unresolved'));
    assert.equal(r.out.references.accessControl, 'https://eng.ms/docs/more/github-inside-microsoft/policies/access.html');
    assert.equal(r.out.references.policyService, 'https://eng.ms/docs/more/github-inside-microsoft/policies/index.html');
    assert.equal(r.out.references.exampleRepository, 'https://github.com/gim-home/us-ss-fis-onboarding');
    assert.deepEqual(sc.sr.state.writes, []);
    clean(sc);
  }));

  it('submits the group as a group principal with the chosen role', () => with_(withGroups(), async (sc) => {
    const p = await sc.cli('plan', ...BASE, '--team-group', 'Morgan Directs', '--team-role', 'push');
    assert.equal(p.out.status, 'ready', JSON.stringify(p.out));
    const r = await sc.cli('submit', '--plan', p.out.planId, '--accept-terms', p.out.terms.sha);
    assert.equal(r.out.outcome, 'success', JSON.stringify(r.out));
    const b = sc.sr.state.creates[0];
    assert.deepEqual(b.accessControl.map((a) => `${a.principalType}:${a.permission}`).sort(), ['group:write', 'user:maintain', 'user:maintain']);
    clean(sc);
  }));

  it('warns, but still accepts, a group that is missing some of the team', () => with_(withGroups(), async (sc) => {
    const r = await sc.cli('plan', ...BASE, '--team-group', 'Partial Directs');
    assert.equal(r.out.status, 'ready', JSON.stringify(r.out));
    assert.match(warning(r, 'team_group_partial').message, /Sam Lee.*Gina Ghost|Gina Ghost.*Sam Lee/);
  }));

  it('refuses a look-alike group that contains people who do not report to your manager', () => with_(withGroups(), async (sc) => {
    const r = await sc.cli('plan', ...BASE, '--team-group', 'Morgan Direct Team');
    assert.equal(r.out.status, 'invalid');
    const e = r.out.errors.find((x) => x.code === 'team_group_not_directs');
    assert.ok(e, JSON.stringify(r.out));
    assert.match(e.message, /Olive Outsider/);
    assert.deepEqual(e.outsiders.map((o) => o.displayName), ['Olive Outsider']);
    assert.equal(r.out.resolved, undefined, 'nothing is planned for it');
    clean(sc);
  }));

  it('refuses a group with nested groups, which Entra SCIM does not expand', () => with_(withGroups(), async (sc) => {
    const r = await sc.cli('plan', ...BASE, '--team-group', 'Nested Directs');
    assert.ok(r.out.errors.some((e) => e.code === 'team_group_not_directs' && /nested/.test(e.message)), JSON.stringify(r.out));
  }));

  it('will not vouch for a group Graph cannot find by that name and alias', () => with_(withGroups({ graph: { groups: [] } }), async (sc) => {
    const r = await sc.cli('plan', ...BASE, '--team-group', 'Morgan Directs');
    assert.equal(r.out.status, 'invalid');
    assert.ok(r.out.errors.some((e) => e.code === 'team_group_unverifiable'), JSON.stringify(r.out));
  }));

  it('will not vouch for a group when Graph is unavailable', () => with_(withGroups({ graph: { status: { '/v1.0/me/manager': 403 } } }), async (sc) => {
    const r = await sc.cli('plan', ...BASE, '--team-group', 'Morgan Directs', '--direct-owner', 'alex@contoso.com');
    assert.equal(r.out.status, 'invalid');
    assert.ok(r.out.errors.some((e) => e.code === 'team_group_unverifiable'), JSON.stringify(r.out));
    assert.equal(warning(r, 'org_defaults_skipped').reason, 'graph_forbidden');
  }));

  it('asks about a group StartRight does not know and rejects combining it with --no-default-team', () => with_(withGroups(), async (sc) => {
    const none = await sc.cli('plan', ...BASE, '--team-group', 'no-such-group');
    assert.ok(none.out.errors.some((e) => e.code === 'person_not_found' && e.field === 'teamGroup'), JSON.stringify(none.out));
    const bad = await sc.cli('plan', ...BASE, '--team-group', 'Morgan Directs', '--no-default-team');
    assert.ok(bad.out.errors.some((e) => e.code === 'team_group_conflict'));
  }));

  it('does not let --team-group name a person', () => with_(withGroups(), async (sc) => {
    const r = await sc.cli('plan', ...BASE, '--team-group', 'alex@contoso.com');
    assert.equal(r.out.status, 'invalid');
    assert.ok(r.out.errors.some((e) => e.code === 'person_not_found'));
  }));

  it('understands the policy\'s role names: pull and push mean read and write, and admin is refused', () => with_({}, async (sc) => {
    const r = await sc.cli('plan', ...BASE, '--access', 'alex@contoso.com=push', '--access', 'sam@contoso.com=pull');
    assert.ok(access(r).includes('Alex Rivera:write') && access(r).includes('Sam Lee:read'), JSON.stringify(access(r)));
    const admin = await sc.cli('plan', ...BASE, '--access', 'alex@contoso.com=admin');
    assert.equal(admin.out.status, 'invalid');
    const e = admin.out.errors.find((x) => x.code === 'access_role_admin');
    assert.ok(e && e.links.includes('https://eng.ms/docs/more/github-inside-microsoft/policies/access.html'));
  }));

  it('options --show-team lists the groups that hold your manager\'s team, flagging look-alikes', () => with_(withGroups(), async (sc) => {
    const r = await sc.cli('options', '--org', 'contoso-eng', '--show-team');
    assert.equal(r.code, 0, JSON.stringify(r.out));
    const by = Object.fromEntries(r.out.team.groups.map((g) => [g.alias, g.status]));
    assert.deepEqual(by, { 'morgan-directs': 'matches', 'partial-directs': 'partial', 'morgan-direct-team': 'has_outsiders', 'nested-directs': 'has_outsiders' });
    assert.equal(r.out.team.references.accessControl, 'https://eng.ms/docs/more/github-inside-microsoft/policies/access.html');
    assert.deepEqual(sc.sr.state.writes, []);
    clean(sc);
  }));
});

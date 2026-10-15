// Unit tests for the Microsoft Graph client and the org-context (manager and default team) logic. Fake fetch only: no
// network, no real people.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createGraph, GraphError, GRAPH_URL } from '../../skills/request-new-github-repository/scripts/lib/graph.mjs';
import { loadOrgContext, aliasFromGraphUser, githubHandleOf, personFromGraph, findStartRightUser, verifyTeamGroup, suggestTeamGroups } from '../../skills/request-new-github-repository/scripts/lib/team.mjs';
import { parseRole, isAdminRole } from '../../skills/request-new-github-repository/scripts/lib/policy.mjs';
import { PEOPLE, GID, gUser } from './fixtures/mock-graph.mjs';

const ENV = { STARTRIGHT_GRAPH_URL: 'http://127.0.0.1:9', STARTRIGHT_GRAPH_TOKEN: 'tok-123' };
const reply = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const fakeFetch = (routes, seen = []) => async (url, init) => {
  seen.push({ url: String(url), init });
  const u = new URL(url);
  const r = routes[u.pathname + (u.search.includes('$skip') ? `?skip=${u.searchParams.get('$skip')}` : '')];
  return typeof r === 'function' ? r(u) : r ?? reply(404);
};

describe('graph client', () => {
  it('only ever sends GET to the configured origin, with the bearer token', async () => {
    const seen = [];
    const g = createGraph({ env: ENV, fetchImpl: fakeFetch({ '/v1.0/me': reply(200, PEOPLE.me), '/v1.0/me/manager': reply(200, PEOPLE.mgr) }, seen) });
    await g.me(); await g.manager();
    assert.equal(seen.length, 2);
    for (const s of seen) {
      assert.equal(s.init.method, 'GET');
      assert.equal(new URL(s.url).origin, 'http://127.0.0.1:9');
      assert.equal(s.init.headers.Authorization, 'Bearer tok-123');
    }
  });

  it('treats 404 as nothing and maps 401/403/5xx to distinct codes', async () => {
    const mk = (status) => createGraph({ env: ENV, fetchImpl: fakeFetch({ '/v1.0/me/manager': reply(status) }) });
    assert.equal(await mk(404).manager(), null);
    await assert.rejects(mk(401).manager(), (e) => e instanceof GraphError && e.code === 'graph_unauthorized');
    await assert.rejects(mk(403).manager(), (e) => e.code === 'graph_forbidden');
    await assert.rejects(mk(500).manager(), (e) => e.code === 'graph_failed');
  });

  it('reports an unreachable Graph as graph_unavailable', async () => {
    const g = createGraph({ env: ENV, fetchImpl: async () => { throw Object.assign(new Error('x'), { cause: { code: 'ECONNREFUSED' } }); } });
    await assert.rejects(g.me(), (e) => e.code === 'graph_unavailable' && /ECONNREFUSED/.test(e.message));
  });

  it('reports a missing az token as graph_unavailable', async () => {
    const g = createGraph({ env: { STARTRIGHT_GRAPH_URL: ENV.STARTRIGHT_GRAPH_URL }, fetchImpl: fakeFetch({}), getToken: async () => { throw new GraphError('graph_unavailable', 'no token'); } });
    await assert.rejects(g.me(), (e) => e.code === 'graph_unavailable');
  });

  it('follows paging on the same origin and refuses a next link to another origin', async () => {
    const page = (n, next) => reply(200, { value: [PEOPLE.alex, gUser(`aaaaaaaa-0000-4000-8000-0000000001${n}0`, `P${n}`, `p${n}`)], ...(next ? { '@odata.nextLink': next } : {}) });
    const ok = createGraph({ env: ENV, fetchImpl: fakeFetch({
      [`/v1.0/users/${GID.mgr}/directReports`]: page(1, `http://127.0.0.1:9/v1.0/users/${GID.mgr}/directReports?$skip=2`),
      [`/v1.0/users/${GID.mgr}/directReports?skip=2`]: page(2),
    }) });
    assert.equal((await ok.directReports(GID.mgr)).length, 4);
    const evil = createGraph({ env: ENV, fetchImpl: fakeFetch({ [`/v1.0/users/${GID.mgr}/directReports`]: page(1, 'https://evil.example/steal') }) });
    await assert.rejects(evil.directReports(GID.mgr), (e) => e.code === 'graph_failed' && /different origin/.test(e.message));
  });

  it('refuses a manager id that is not a guid, and non-user directory objects', async () => {
    const g = createGraph({ env: ENV, fetchImpl: fakeFetch({ [`/v1.0/users/${GID.mgr}/directReports`]: reply(200, { value: [PEOPLE.alex, { '@odata.type': '#microsoft.graph.group', id: 'x' }] }) }) });
    await assert.rejects(g.directReports('../../me'), (e) => e.code === 'graph_failed');
    assert.deepEqual((await g.directReports(GID.mgr)).map((u) => u.displayName), ['Alex Rivera']);
  });

  it('refuses to contact the real Graph from a test run', async () => {
    const g = createGraph({ env: { STARTRIGHT_GRAPH_TOKEN: 'tok' }, fetchImpl: async () => { throw new Error('must not be called'); } });
    assert.equal(g.base, GRAPH_URL);
    await assert.rejects(g.me(), (e) => e.code === 'graph_unavailable' && /test run/.test(e.message));
  });
});

describe('org context', () => {
  const graphOf = (o) => ({ me: async () => o.me ?? PEOPLE.me, manager: async () => (o.manager === undefined ? PEOPLE.mgr : o.manager), directReports: async () => o.reports ?? [PEOPLE.me, PEOPLE.mgr, PEOPLE.sam, PEOPLE.alex, PEOPLE.dee, PEOPLE.gina], ...o.fns });

  it('derives the documented EMU handle <alias>_microsoft', () => {
    assert.equal(githubHandleOf('Alex'), 'alex_microsoft');
    assert.equal(aliasFromGraphUser({ userPrincipalName: 'Jo@contoso.com' }), 'jo');
    assert.equal(personFromGraph(PEOPLE.alex).githubHandle, 'alex_microsoft');
  });

  it('returns the manager and the sorted peers, without you, the manager or disabled accounts', async () => {
    const r = await loadOrgContext(graphOf({}), 'testuser');
    assert.equal(r.ok, true);
    assert.equal(r.manager.githubHandle, 'morgan_microsoft');
    assert.deepEqual(r.peers.map((p) => p.githubHandle), ['alex_microsoft', 'ghost_microsoft', 'sam_microsoft']);
  });

  it('stops when the Azure CLI identity is not the StartRight identity', async () => {
    const r = await loadOrgContext(graphOf({}), 'someone-else');
    assert.equal(r.ok, false);
    assert.equal(r.code, 'graph_identity_mismatch');
  });

  it('reports no manager, and turns Graph errors into a result instead of throwing', async () => {
    assert.equal((await loadOrgContext(graphOf({ manager: null }), 'testuser')).code, 'no_manager');
    const r = await loadOrgContext(graphOf({ fns: { manager: async () => { throw new GraphError('graph_forbidden', 'nope'); } } }), 'testuser');
    assert.deepEqual([r.ok, r.code], [false, 'graph_forbidden']);
    await assert.rejects(loadOrgContext(graphOf({ fns: { manager: async () => { throw new TypeError('bug'); } } }), 'testuser'), TypeError);
  });
});

describe('team groups', () => {
  const grp = (id, name, extra = {}) => ({ id, displayName: name, mailNickname: name.toLowerCase().replace(/\W+/g, '-'), mailEnabled: true, ...extra });
  const ctx = { manager: { displayName: 'Morgan Chu' }, peers: [{ id: PEOPLE.alex.id }, { id: PEOPLE.sam.id }], memberIds: new Set([PEOPLE.me.id, PEOPLE.mgr.id, PEOPLE.alex.id, PEOPLE.sam.id]) };
  const graphOf = (groups, members) => ({
    groupsByNickname: async () => groups,
    myGroups: async () => groups,
    groupMembers: async (id) => ({ users: members[id] ?? [], others: 0, ...(members[`${id}:others`] ? { others: members[`${id}:others`] } : {}) }),
  });
  const G = grp('g1', 'Morgan Directs');

  it('accepts a mail-enabled group of only your manager\'s team', async () => {
    const r = await verifyTeamGroup(graphOf([G], { g1: [PEOPLE.me, PEOPLE.alex, PEOPLE.sam] }), ctx, { displayName: 'Morgan Directs', keys: ['morgan-directs', 'morgan-directs'] });
    assert.deepEqual([r.ok, r.missing.length], [true, 0]);
  });

  it('reports the people a subset group is missing', async () => {
    const r = await verifyTeamGroup(graphOf([G], { g1: [PEOPLE.alex] }), ctx, { displayName: 'Morgan Directs', keys: ['x'] });
    assert.equal(r.ok, true);
    assert.equal(r.missing.length, 1);
  });

  it('rejects a group with an outsider, or with non-person members', async () => {
    const out = gUser('eeeeeeee-0000-4000-8000-000000000009', 'Olive Outsider', 'olive');
    const a = await verifyTeamGroup(graphOf([G], { g1: [PEOPLE.alex, out] }), ctx, { displayName: 'Morgan Directs', keys: ['x'] });
    assert.deepEqual([a.ok, a.code, a.outsiders.map((o) => o.displayName)], [false, 'team_group_not_directs', ['Olive Outsider']]);
    const b = await verifyTeamGroup(graphOf([G], { g1: [PEOPLE.alex], 'g1:others': 2 }), ctx, { displayName: 'Morgan Directs', keys: ['x'] });
    assert.equal(b.code, 'team_group_not_directs');
  });

  it('never binds on the alias alone, nor to a non-mail-enabled or ambiguous group', async () => {
    const ask = (groups) => verifyTeamGroup(graphOf(groups, { g1: [PEOPLE.alex], g2: [PEOPLE.alex] }), ctx, { displayName: 'Morgan Directs', keys: ['morgan-directs'] });
    assert.equal((await ask([grp('g1', 'Morgan Directs Two')])).code, 'team_group_unverifiable');
    assert.equal((await ask([grp('g1', 'Morgan Directs', { mailEnabled: false })])).code, 'team_group_unverifiable');
    assert.equal((await ask([grp('g1', 'Morgan Directs'), grp('g2', 'Morgan Directs')])).code, 'team_group_unverifiable');
    assert.equal((await ask([grp('g1', 'morgan directs')])).code, 'team_group_unverifiable', 'the name must match exactly, case included');
    assert.equal((await ask([])).code, 'team_group_unverifiable');
  });

  it('turns Graph failures into a result, and too-large groups into unverifiable', async () => {
    const boom = (code) => ({ groupsByNickname: async () => { throw new GraphError(code, 'x'); } });
    assert.equal((await verifyTeamGroup(boom('graph_forbidden'), ctx, { displayName: 'a', keys: ['a'] })).code, 'graph_forbidden');
    assert.equal((await verifyTeamGroup(boom('graph_too_large'), ctx, { displayName: 'a', keys: ['a'] })).code, 'team_group_unverifiable');
    await assert.rejects(verifyTeamGroup({ groupsByNickname: async () => { throw new TypeError('bug'); } }, ctx, { displayName: 'a', keys: ['a'] }), TypeError);
  });

  it('suggests only groups that look like direct-report groups, and classifies them', async () => {
    const full = grp('g1', 'Morgan Directs'), part = grp('g2', 'Team Reports'), bad = grp('g3', 'Frank Directs'), other = grp('g4', 'Lunch Club');
    const out = gUser('eeeeeeee-0000-4000-8000-000000000009', 'Olive Outsider', 'olive');
    const r = await suggestTeamGroups(graphOf([full, part, bad, other], { g1: [PEOPLE.alex, PEOPLE.sam], g2: [PEOPLE.alex], g3: [PEOPLE.alex, out], g4: [PEOPLE.alex] }), ctx);
    assert.deepEqual(r.map((g) => [g.displayName, g.status]), [['Morgan Directs', 'matches'], ['Team Reports', 'partial'], ['Frank Directs', 'has_outsiders']]);
    assert.deepEqual(await suggestTeamGroups({ myGroups: async () => { throw new GraphError('graph_forbidden', 'x'); } }, ctx), []);
  });

  it('only sends a safe nickname to Graph\'s filter, and refuses to page forever', async () => {
    const seen = [];
    const g = createGraph({ env: ENV, fetchImpl: fakeFetch({ '/v1.0/groups': (u) => { seen.push(u.search); return reply(200, { value: [] }); } }) });
    assert.deepEqual(await g.groupsByNickname("x' or 1 eq 1 or mailNickname eq 'y"), []);
    assert.deepEqual(await g.groupsByNickname('a b'), []);
    assert.equal(seen.length, 0, 'an unsafe nickname never reaches Graph');
    await g.groupsByNickname('morgan-directs');
    assert.match(decodeURIComponent(seen[0]), /mailNickname eq 'morgan-directs'/);
    const loop = createGraph({ env: ENV, fetchImpl: fakeFetch({ '/v1.0/me/memberOf/microsoft.graph.group': reply(200, { value: [], '@odata.nextLink': `${ENV.STARTRIGHT_GRAPH_URL}/v1.0/me/memberOf/microsoft.graph.group` }) }) });
    await assert.rejects(loop.myGroups(), (e) => e.code === 'graph_too_large');
    const bad = createGraph({ env: ENV, fetchImpl: fakeFetch({ '/v1.0/me/memberOf/microsoft.graph.group': reply(200, { value: 'nope' }) }) });
    await assert.rejects(bad.myGroups(), (e) => e.code === 'graph_failed');
    const junk = createGraph({ env: ENV, fetchImpl: fakeFetch({ '/v1.0/me/memberOf/microsoft.graph.group': { status: 200, ok: true, json: async () => { throw new SyntaxError('x'); } } }) });
    await assert.rejects(junk.myGroups(), (e) => e.code === 'graph_failed');
  });

  it('counts a group member as a user only when Graph says so explicitly', async () => {
    const id = 'cccccccc-0000-4000-8000-000000000001';
    const untyped = { id: 'u1', displayName: 'Mystery' };
    const g = createGraph({ env: ENV, fetchImpl: fakeFetch({ [`/v1.0/groups/${id}/members`]: reply(200, { value: [PEOPLE.alex, untyped, { '@odata.type': '#microsoft.graph.group', id: 'x' }] }) }) });
    const r = await g.groupMembers(id);
    assert.deepEqual([r.users.map((u) => u.displayName), r.others], [['Alex Rivera'], 2]);
  });

  it('understands the access policy\'s role names', () => {
    assert.equal(parseRole('push'), 'write');
    assert.equal(parseRole('Pull'), 'read');
    assert.equal(parseRole('admin'), null);
    assert.equal(isAdminRole('Admin'), true);
  });
});

describe('matching a person to StartRight', () => {
  const sessionFor = (principals) => ({ api: async () => ({ ok: true, status: 200, body: principals }) });
  const person = { email: 'alex@contoso.com', displayName: 'Alex Rivera' };
  const user = (id, name, email) => ({ principalId: id, type: 'user', displayName: name, secondaryText: email });

  it('accepts only an exact e-mail match', async () => {
    const hit = await findStartRightUser(sessionFor([user('1', 'Alex Rivera', 'alex@contoso.com')]), { org: 'o', purpose: 'acl', person });
    assert.equal(hit?.principalId, '1');
    assert.equal(await findStartRightUser(sessionFor([user('2', 'Alex Rivera', 'alex@other.com')]), { org: 'o', purpose: 'acl', person }), null);
    assert.equal(await findStartRightUser(sessionFor([]), { org: 'o', purpose: 'acl', person }), null);
  });
});

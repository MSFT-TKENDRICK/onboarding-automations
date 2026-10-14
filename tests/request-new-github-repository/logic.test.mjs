import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classify, validateRepo, parseRole, accessErrors, TERMS, WARN, PROXIMA_GUIDANCE } from '../../skills/request-new-github-repository/scripts/lib/policy.mjs';
import { matchPrincipal, aliasOf, searchCatalog, candidateView, lookupTerm } from '../../skills/request-new-github-repository/scripts/lib/resolve.mjs';
import { normalizeInput, localCheck, parseAccess, buildBody, bodyDiffersFromPlan } from '../../skills/request-new-github-repository/scripts/lib/flows.mjs';

const ok = { org: 'contoso-eng', name: 'repo', description: 'd', visibility: 'internal' };

describe('classification', () => {
  it('requires an explicit non-production answer', () => {
    assert.equal(classify(undefined).kind, 'missing');
    assert.equal(classify('  ').kind, 'missing');
    for (const v of ['non-production', 'Non-Production', 'nonproduction', 'non_production']) assert.equal(classify(v).kind, 'nonproduction', v);
    for (const v of ['production', 'prod', 'TCB', 'hvt', 'production-hvt', 'tcb/hvt']) assert.equal(classify(v).kind, 'blocked', v);
    assert.equal(classify('maybe').kind, 'invalid');
  });
});

describe('repository validation', () => {
  const codes = (o) => validateRepo({ ...ok, ...o }).map((e) => e.code);
  it('accepts a valid request', () => assert.deepEqual(validateRepo(ok), []));
  it('reports required fields', () => assert.deepEqual(validateRepo({}).map((e) => e.code), ['org_required', 'name_required', 'description_required', 'visibility_required']));
  it('enforces names', () => {
    assert.deepEqual(codes({ name: '.' }), ['name_invalid']);
    assert.deepEqual(codes({ name: '..' }), ['name_invalid']);
    assert.deepEqual(codes({ name: 'a'.repeat(101) }), ['name_too_long']);
    assert.deepEqual(codes({ name: 'a'.repeat(100) }), []);
    assert.deepEqual(codes({ name: 'my repo!' }), ['name_invalid']);
    assert.equal(validateRepo({ ...ok, name: 'my repo!' })[0].suggestion, 'my-repo');
    assert.deepEqual(codes({ name: 'a.b_c-D9' }), []);
  });
  it('enforces org, description and visibility', () => {
    assert.deepEqual(codes({ org: '-bad' }), ['org_invalid']);
    assert.deepEqual(codes({ org: 'o'.repeat(40) }), ['org_invalid']);
    assert.deepEqual(codes({ description: 'x'.repeat(351) }), ['description_too_long']);
    assert.deepEqual(codes({ visibility: 'public' }), ['visibility_invalid']);
    assert.deepEqual(codes({ visibility: 'private' }), []);
  });
});

describe('roles and access rules', () => {
  const U = (id, role) => ({ principalId: id, type: 'user', role });
  const Gp = (id, role) => ({ principalId: id, type: 'group', role });
  it('parses roles', () => { assert.equal(parseRole(' Maintain '), 'maintain'); assert.equal(parseRole('admin'), null); assert.equal(parseAccess('Alex=write').role, 'write'); assert.equal(parseAccess('nope').error.code, 'access_role_required'); assert.equal(parseAccess('a=boss').error.code, 'access_role_invalid'); });
  it('needs a maintaining group or two maintaining users', () => {
    assert.deepEqual(accessErrors([U('me', 'maintain'), Gp('g', 'maintain')], 'me'), []);
    assert.deepEqual(accessErrors([U('me', 'maintain'), U('b', 'maintain')], 'me'), []);
    assert.deepEqual(accessErrors([U('me', 'maintain')], 'me').map((e) => e.code), ['maintain_rule']);
    assert.deepEqual(accessErrors([U('me', 'maintain'), Gp('g', 'write')], 'me').map((e) => e.code), ['maintain_rule']);
  });
  it('needs the requester to maintain, and no duplicates', () => {
    assert.ok(accessErrors([U('me', 'write'), Gp('g', 'maintain')], 'me').some((e) => e.code === 'requester_must_maintain'));
    assert.ok(accessErrors([U('x', 'maintain'), Gp('g', 'maintain')], 'me').some((e) => e.code === 'requester_must_maintain'));
    assert.ok(accessErrors([U('me', 'maintain'), U('me', 'maintain')], 'me').some((e) => e.code === 'access_duplicate'));
    assert.deepEqual(accessErrors([], 'me').map((e) => e.code), ['access_required']);
  });
});

describe('terms and guidance', () => {
  it('terms are stable and point at Proxima and support', () => {
    assert.match(TERMS.sha, /^[0-9a-f]{16}$/);
    assert.match(TERMS.text, /secret/i);
    assert.ok(TERMS.links.some((l) => /proxima/.test(l)));
    assert.match(PROXIMA_GUIDANCE, /TCB/);
    assert.ok(WARN.prefer_proxima && WARN.secret_scan && WARN.group_delay && WARN.propagation);
  });
});

describe('people matching never guesses', () => {
  const U = (id, name, email, extra = {}) => ({ principalId: id, type: 'user', displayName: name, secondaryText: email, ...extra });
  const list = [U('1', 'Alex Rivera', 'alex@contoso.com'), U('2', 'Alexandra Ng', 'alexandra@contoso.com'), U('3', 'Pat Kim', 'pat1@contoso.com'), U('4', 'Pat Kim', 'pat2@contoso.com'), { principalId: '5', type: 'group', displayName: 'Eng Group', secondaryText: 'eng' }];
  it('matches by e-mail, alias and full name, case-insensitively', () => {
    assert.equal(matchPrincipal('ALEX@contoso.com', list).principal.principalId, '1');
    assert.equal(matchPrincipal('alex', list).principal.principalId, '1');
    assert.equal(matchPrincipal('alexandra ng', list).principal.principalId, '2');
    assert.equal(matchPrincipal('Eng Group', list).principal.principalId, '5');
  });
  it('returns candidates for ambiguity and nothing for partial matches', () => {
    assert.equal(matchPrincipal('Pat Kim', list).kind, 'many');
    assert.equal(matchPrincipal('Pat', list).kind, 'none');
    assert.equal(matchPrincipal('Ale', list).kind, 'none');
    assert.equal(matchPrincipal('', list).kind, 'none');
  });
  it('helpers', () => {
    assert.equal(aliasOf('pat_microsoft'), 'pat');
    assert.equal(candidateView(U('1', 'A', 'a@b.com', { isRequester: true })).isRequester, true);
    assert.equal(candidateView(list[4]).email, undefined);
    assert.equal(lookupTerm(list[0]), 'alex@contoso.com');
    assert.equal(lookupTerm(list[4]), 'Eng Group');
  });
});

describe('Service Tree search', () => {
  const cat = [{ id: 'a', name: 'Widget Service', type: 'Service', parentId: 'p' }, { id: 'p', name: 'Parent', type: 'Division' }, { id: 'b', name: 'Widget Service Tools', type: 'ServiceGroup' }, { id: 'c', name: 'widget  service', type: 'Service' }];
  it('exact (case/space-insensitive) beats near, and ambiguity is surfaced', () => {
    const r = searchCatalog(cat, 'Widget Service');
    assert.deepEqual(r.exact.map((e) => e.id), ['a', 'c']);
    assert.equal(r.exact[0].parent, 'Parent');
    assert.deepEqual(searchCatalog(cat, 'Widget Service Tools').exact.map((e) => e.id), ['b']);
  });
  it('returns near matches only when nothing is exact', () => {
    const r = searchCatalog(cat, 'widg');
    assert.equal(r.exact.length, 0);
    assert.ok(r.near.length >= 3);
    assert.equal(searchCatalog(cat, 'zzz').near.length, 0);
  });
});

describe('local checks (no network)', () => {
  const input = (o = {}) => normalizeInput({ org: 'o', name: 'n', description: 'd', classification: 'non-production', owners: ['a'], ...o });
  it('asks for the classification and offers no default', () => {
    const r = localCheck(input({ classification: undefined }));
    assert.equal(r.missing[0].field, 'classification');
    assert.deepEqual(r.missing[0].options, ['non-production']);
  });
  it('blocks production with Proxima guidance', () => {
    const r = localCheck(input({ classification: 'production' }));
    assert.equal(r.blockers[0].code, 'production_not_allowed');
    assert.match(r.blockers[0].message, /Proxima/);
  });
  it('requires exactly one ownership mode', () => {
    assert.equal(localCheck(input({ owners: [] })).missing[0].field, 'ownership');
    assert.ok(localCheck(input({ serviceTree: '123e4567-e89b-42d3-a456-426614174000' })).errors.some((e) => e.code === 'ownership_conflict'));
    assert.ok(localCheck(input({ owners: [], serviceTree: 'nope' })).errors.some((e) => e.code === 'service_tree_invalid'));
    assert.ok(localCheck(input({ owners: ['a', 'b', 'c'] })).errors.some((e) => e.code === 'too_many_owners'));
  });
  it('defaults visibility to internal and says so', () => {
    const r = localCheck(input());
    assert.equal(r.visibility, 'internal');
    assert.equal(r.defaulted[0].field, 'visibility');
    assert.deepEqual(localCheck(input({ visibility: 'private' })).defaulted, []);
  });
  it('parses access entries and reports malformed ones', () => {
    const r = localCheck(input({ access: ['Eng=maintain', 'bad', 'x=boss'] }));
    assert.deepEqual(r.access, [{ who: 'Eng', role: 'maintain' }]);
    assert.deepEqual(r.errors.map((e) => e.code), ['access_role_required', 'access_role_invalid']);
  });
});

describe('request body', () => {
  const m = {
    org: 'o', repo: { name: 'n', visibility: 'internal', description: 'd' },
    ownership: { type: 'directOwners', owners: [{ principalId: 'u1' }, { principalId: 'u2' }] },
    access: [{ principalId: 'u1', type: 'user', role: 'maintain' }, { principalId: 'g1', type: 'group', role: 'write' }],
  };
  const refs = { ownership: { u1: 'oR1', u2: 'oR2' }, acl: { u1: 'aR1', g1: 'aR2' } };
  it('is built from the plan and verified independently', () => {
    const b = buildBody(m, refs);
    assert.equal(b.classification, 'nonproduction');
    assert.deepEqual(b.ownership.owners, ['oR1', 'oR2']);
    assert.deepEqual(b.accessControl.map((a) => [a.principalRef, a.permission]), [['aR1', 'maintain'], ['aR2', 'write']]);
    assert.deepEqual(bodyDiffersFromPlan(b, m, refs), []);
  });
  it('detects any tampering', () => {
    const tamper = (f) => { const b = buildBody(m, refs); f(b); return bodyDiffersFromPlan(b, m, refs); };
    assert.deepEqual(tamper((b) => { b.organization = 'x'; }), ['organization']);
    assert.deepEqual(tamper((b) => { b.repository.visibility = 'private'; }), ['repository']);
    assert.deepEqual(tamper((b) => { b.classification = 'production'; }), ['classification']);
    assert.deepEqual(tamper((b) => { b.ownership.owners.reverse(); }), ['ownership']);
    assert.deepEqual(tamper((b) => { b.accessControl[1].permission = 'maintain'; }), ['accessControl']);
    assert.deepEqual(tamper((b) => { b.accessControl.pop(); }), ['accessControl']);
  });
});

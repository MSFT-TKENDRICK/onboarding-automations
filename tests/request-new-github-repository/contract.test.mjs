// Contract tests: the schema DSL, request/response checking, the create-outcome classifier, and the recorded live samples.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validate, ENDPOINTS, READ_ENDPOINTS, CreateBody, buildPath, endpointFor, checkRequest, checkResponse, classifyCreate, isGuid, WRITE_PATH } from '../../skills/request-new-github-repository/scripts/lib/contract.mjs';

const G = '123e4567-e89b-42d3-a456-426614174000';
const validBody = () => ({
  organization: 'contoso-eng',
  repository: { name: 'repo', visibility: 'internal', description: 'd' },
  ownership: { type: 'directOwners', owners: ['ref-a', 'ref-b'] },
  accessControl: [{ principalRef: 'ref-a', principalType: 'user', permission: 'maintain' }],
  classification: 'nonproduction',
});

describe('schema validation', () => {
  it('accepts a valid body and rejects every deviation', () => {
    assert.deepEqual(validate(CreateBody, validBody()), []);
    const mutations = {
      'unknown top-level field': (b) => { b.extra = 1; },
      'unknown repository field': (b) => { b.repository.template = 'x'; },
      'production classification': (b) => { b.classification = 'production'; },
      'bad visibility': (b) => { b.repository.visibility = 'public'; },
      'bad name': (b) => { b.repository.name = 'a b'; },
      'empty description': (b) => { b.repository.description = ''; },
      'description too long': (b) => { b.repository.description = 'x'.repeat(351); },
      'one owner': (b) => { b.ownership.owners = ['only']; },
      'three owners': (b) => { b.ownership.owners = ['a', 'b', 'c']; },
      'bad service tree id': (b) => { b.ownership = { type: 'serviceTree', serviceTreeId: 'nope' }; },
      'no access entries': (b) => { b.accessControl = []; },
      'bad role': (b) => { b.accessControl[0].permission = 'admin'; },
      'bad principal type': (b) => { b.accessControl[0].principalType = 'bot'; },
      'missing org': (b) => { delete b.organization; },
      'org too long': (b) => { b.organization = 'o'.repeat(40); },
    };
    for (const [label, mutate] of Object.entries(mutations)) {
      const b = validBody();
      mutate(b);
      assert.ok(validate(CreateBody, b).length > 0, `${label} should be rejected`);
    }
  });
  it('accepts a service tree owner', () => {
    const b = validBody();
    b.ownership = { type: 'serviceTree', serviceTreeId: G };
    assert.deepEqual(validate(CreateBody, b), []);
  });
  it('guids', () => { assert.ok(isGuid(G)); assert.ok(!isGuid('x')); assert.ok(!isGuid(undefined)); });
});

describe('endpoints', () => {
  it('has exactly one write endpoint and it is the create POST', () => {
    const writes = Object.entries(ENDPOINTS).filter(([, e]) => e.method !== 'GET');
    assert.deepEqual(writes.map(([id]) => id), ['create']);
    assert.equal(WRITE_PATH, '/api/v1/resource/github/repositories');
    assert.ok(READ_ENDPOINTS.every((id) => ENDPOINTS[id].method === 'GET'));
  });
  it('builds and matches paths', () => {
    assert.equal(buildPath('membership', { path: { organization: 'a b' } }), '/api/v1/resource/github/organizations/a%20b/membership');
    assert.equal(buildPath('availability', { query: { organization: 'o', name: 'n', skip: undefined } }), '/api/v1/resource/github/repositories/availability?organization=o&name=n');
    assert.throws(() => buildPath('membership'), /missing path parameter/);
    assert.equal(endpointFor('GET', '/api/v1/resource/github/organizations/x/membership'), 'membership');
    assert.equal(endpointFor('POST', WRITE_PATH), 'create');
    assert.equal(endpointFor('GET', WRITE_PATH), null);
    assert.equal(endpointFor('DELETE', WRITE_PATH), null);
  });
  it('checks requests strictly', () => {
    assert.deepEqual(checkRequest('availability', { query: { organization: 'o', name: 'n' } }), []);
    assert.match(checkRequest('availability', { query: { organization: 'o' } }).join(), /name: required/);
    assert.match(checkRequest('availability', { query: { organization: 'o', name: 'n', extra: 1 } }).join(), /not part of the contract/);
    assert.match(checkRequest('principals', { query: { organization: 'o', purpose: 'x', query: 'q' } }).join(), /purpose/);
    assert.match(checkRequest('restriction', { query: { organization: 'o', serviceTreeId: 'no' } }).join(), /malformed/);
    assert.match(checkRequest('organizations', { body: {} }).join(), /takes no body/);
    assert.match(checkRequest('create', { body: validBody() }).join(), /X-CSRF-TOKEN/);
    assert.deepEqual(checkRequest('create', { body: validBody(), headers: { 'x-csrf-token': 't' } }), []);
  });
  it('checks responses and rejects undocumented statuses', () => {
    assert.equal(checkResponse('availability', 200, { organization: 'o', name: 'n', available: true }).ok, true);
    assert.equal(checkResponse('availability', 200, { organization: 'o', name: 'n', available: 'yes' }).ok, false);
    const unexpected = checkResponse('availability', 418, {});
    assert.equal(unexpected.ok, false);
    assert.equal(unexpected.unexpectedStatus, true);
    assert.equal(checkResponse('session', 401, undefined).ok, true);
    assert.equal(checkResponse('create', 201, { organization: 'o', name: 'n', webUrl: 'not-a-url' }).ok, false);
  });
});

describe('classifyCreate: only a documented answer ever frees the journal', () => {
  const cases = [
    [201, {}, 'success'], [400, {}, 'rejected'], [401, {}, 'rejected'], [403, {}, 'rejected'], [409, {}, 'rejected'],
    [429, {}, 'rejected'], [503, {}, 'rejected'],
    [500, { failureKind: 'partialFailure', repositoryOutcome: 'created', failedStage: 'inventory', remediation: 'r' }, 'partial'],
    [500, { title: 'x' }, 'unknown'], [500, undefined, 'unknown'], [502, {}, 'unknown'], [504, {}, 'unknown'], [302, {}, 'unknown'], [200, {}, 'unknown'], [404, {}, 'unknown'],
  ];
  for (const [status, body, outcome] of cases) it(`${status} ${body?.failureKind ?? ''} -> ${outcome}`, () => assert.equal(classifyCreate(status, body).outcome, outcome));
  it('429 and 503 are retryable rejections', () => { assert.equal(classifyCreate(429, {}).retryable, true); assert.equal(classifyCreate(503, {}).retryable, true); assert.equal(classifyCreate(409, {}).retryable, undefined); });
});

describe('recorded live samples (sanitized) satisfy the contract', () => {
  const samples = JSON.parse(readFileSync(new URL('./fixtures/live-samples.json', import.meta.url), 'utf8'));
  it('has coverage of success and problem shapes', () => {
    assert.ok(samples.length >= 8);
    assert.ok(samples.some((s) => s.status >= 400) && samples.some((s) => s.status === 200));
  });
  for (const [i, s] of samples.entries()) it(`#${i} ${s.id} ${s.status}`, () => {
    const r = checkResponse(s.id, s.status, s.body);
    assert.deepEqual(r.errors, []);
  });
  it('contains no real identifiers', () => {
    const text = JSON.stringify(samples);
    assert.ok(!/microsoft|_microsoft|1ES|tykendrick/i.test(text));
  });
});

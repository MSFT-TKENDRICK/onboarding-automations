import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listOwnRequests, parseOutcome } from '../../skills/request-new-azure-subscription/scripts/lib/page.mjs';
import { classifyReconciliation, confirmsSubmittedCase, findDuplicates, reconcileRequestList, submittedResponseCaseIds } from '../../skills/request-new-azure-subscription/scripts/lib/portal.mjs';

const CONTACT = '11111111-2222-3333-4444-555555555555';
const SINCE = '2026-01-01T00:00:00.000Z';
const ORIGIN = 'https://portal.example.test';
const record = (overrides = {}) => ({
  apitil_servicerequestid: 'request-1',
  apitil_requestnumber: 'REQ-123456-2026',
  apitil_name: 'REQ-123456-2026 - IT lab',
  statuscode: 1,
  statecode: 0,
  createdon: '2026-01-02T00:00:00.000Z',
  ...overrides,
});

async function withFetch(fetchImpl, fn) {
  const previousFetch = globalThis.fetch;
  const previousLocation = globalThis.location;
  globalThis.fetch = fetchImpl;
  globalThis.location = new URL(`${ORIGIN}/support/`);
  try { return await fn(); } finally {
    globalThis.fetch = previousFetch;
    if (previousLocation === undefined) delete globalThis.location;
    else globalThis.location = previousLocation;
  }
}

const response = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: String(status),
  json: async () => body,
});

test('complete request reads follow same-query pagination without applying a total-result cap', async () => {
  const calls = [];
  const result = await withFetch(async (url, options) => {
    const parsed = new URL(url, ORIGIN);
    calls.push({ parsed, options });
    if (calls.length === 1) {
      parsed.searchParams.set('$skiptoken', 'page-2');
      return response({ value: [record()], '@odata.nextLink': parsed.href });
    }
    return response({ value: [record({
      apitil_servicerequestid: 'request-2',
      apitil_requestnumber: 'REQ-123457-2026',
      apitil_name: 'REQ-123457-2026 - Other',
    })] });
  }, () => listOwnRequests(CONTACT, SINCE, 25, undefined, { complete: true }));
  assert.equal(result.ok, true);
  assert.equal(result.complete, true);
  assert.deepEqual(result.rows.map((row) => row.caseId), ['REQ-123456-2026', 'REQ-123457-2026']);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].parsed.searchParams.has('$top'), false);
  assert.equal(calls[1].parsed.searchParams.get('$skiptoken'), 'page-2');
  assert.ok(calls.every(({ options }) => options.credentials === 'same-origin'));
});

test('malformed or missing provider lists never prove that there are no requests', async () => {
  for (const body of [null, {}, { value: null }, { value: {} }]) {
    const result = await withFetch(async () => response(body),
      () => listOwnRequests(CONTACT, SINCE, 25, undefined, { complete: true }));
    assert.equal(result.ok, false);
    assert.notEqual(result.complete, true);
  }
});

test('malformed records preserve known rows but make the list incomplete', async () => {
  for (const invalid of [
    null,
    record({ apitil_name: undefined }),
    record({ apitil_requestnumber: undefined }),
    record({ apitil_servicerequestid: '' }),
    record({ statecode: undefined }),
    record({ statecode: '0' }),
    record({ statecode: 2 }),
    record({ createdon: 'not-a-date' }),
    record({ statuscode: undefined }),
  ]) {
    const result = await withFetch(async () => response({ value: [record(), invalid] }),
      () => listOwnRequests(CONTACT, SINCE, 25, undefined, { complete: true }));
    assert.equal(result.ok, true);
    assert.equal(result.complete, false);
    assert.equal(result.rows.length, 1);
    assert.ok(result.error);
  }
});

test('partial, cyclic, cross-origin, and changed-query continuations fail closed', async () => {
  for (const continuation of ['cross-origin', 'cycle', 'changed', 'duplicate-filter']) {
    let calls = 0;
    const result = await withFetch(async (url) => {
      calls++;
      const current = new URL(url, ORIGIN);
      if (continuation === 'cross-origin') {
        current.host = 'other.example.test';
        current.searchParams.set('$skiptoken', '1');
        return response({ value: [record()], '@odata.nextLink': current.href });
      }
      if (continuation === 'cycle') return response({ value: [record()], '@odata.nextLink': current.href });
      if (continuation === 'changed') {
        current.searchParams.set('$filter', '_apitil_contact_value eq someone-else');
        return response({ value: [record()], '@odata.nextLink': current.href });
      }
      if (continuation === 'duplicate-filter') {
        current.searchParams.append('$filter', '_apitil_contact_value eq someone-else');
        return response({ value: [record()], '@odata.nextLink': current.href });
      }
      return response({ value: [record()], '@odata.nextLink': continuation });
    }, () => listOwnRequests(CONTACT, SINCE, 25, undefined, { complete: true }));
    assert.equal(result.ok, true);
    assert.equal(result.complete, false);
    assert.equal(calls, 1);
    assert.ok(result.error);
  }
  let calls = 0;
  const limited = await withFetch(async (url) => {
    calls++;
    const next = new URL(url, ORIGIN);
    next.searchParams.set('$skiptoken', String(calls));
    return response({ value: [], '@odata.nextLink': next.href });
  }, () => listOwnRequests(CONTACT, SINCE, 25, undefined, { complete: true }));
  assert.equal(limited.complete, false);
  assert.ok(calls <= 8);
});

test('invalid request parameters and excessive records never trigger a successful complete read', async () => {
  let calls = 0;
  await withFetch(async () => { calls++; return response({ value: [] }); }, async () => {
    for (const [contact, since, top, caseId] of [
      ['------------------------------------', SINCE, 25, undefined],
      [CONTACT, '2026-01-01&$filter=ignored', 25, undefined],
      [CONTACT, SINCE, 0, undefined],
      [CONTACT, SINCE, 101, undefined],
      [CONTACT, SINCE, 25, 'REQ-invalid'],
    ]) {
      assert.equal((await listOwnRequests(contact, since, top, caseId, { complete: true })).ok, false);
    }
  });
  assert.equal(calls, 0);
  const many = Array.from({ length: 201 }, (_, index) => record({
    apitil_servicerequestid: `request-${index}`,
    apitil_requestnumber: `REQ-${String(index).padStart(6, '0')}-2026`,
  }));
  const result = await withFetch(async () => response({ value: many }),
    () => listOwnRequests(CONTACT, SINCE, 25, undefined, { complete: true }));
  assert.equal(result.complete, false);
  assert.equal(result.rows.length, 200);
  assert.match(result.error, /limit/);
});

test('request status exposes truncation, and a failed later page cannot become a complete result', async () => {
  const status = await withFetch(async () => response({ value: [record()] }),
    () => listOwnRequests(CONTACT, undefined, 1));
  assert.equal(status.ok, true);
  assert.equal(status.complete, false);

  let calls = 0;
  const partial = await withFetch(async (url) => {
    calls++;
    if (calls === 1) {
      const next = new URL(url, ORIGIN);
      next.searchParams.set('$skiptoken', 'next');
      return response({ value: [record()], '@odata.nextLink': next.href });
    }
    return response({}, 503);
  }, () => listOwnRequests(CONTACT, SINCE, 25, undefined, { complete: true }));
  assert.equal(partial.ok, true);
  assert.equal(partial.complete, false);
  assert.equal(partial.rows.length, 1);
  assert.match(partial.error, /503/);
});

test('duplicate checks require a complete list, even if a partial list already has a match', async () => {
  const row = { caseId: 'REQ-123456-2026', name: 'REQ-123456-2026 - IT lab', active: true };
  for (const rows of [[], [row]]) {
    const s = { page: { call: async () => ({ ok: true, complete: false, error: 'request_list_incomplete', rows }) } };
    const result = await findDuplicates(s, CONTACT, 'IT lab');
    assert.equal(result.ok, false);
    assert.ok(result.error);
  }
  const s = { page: { call: async () => ({ ok: true, complete: true, rows: [row] }) } };
  const result = await findDuplicates(s, CONTACT, 'IT lab');
  assert.equal(result.ok, true);
  assert.deepEqual(result.rows, [row]);
  assert.deepEqual(result.previousCaseIds, [row.caseId]);
  const closed = { ...row, caseId: 'REQ-123457-2026', active: false };
  const withClosed = await findDuplicates({ page: { call: async () => ({ ok: true, complete: true, rows: [row, closed] }) } }, CONTACT, 'IT lab');
  assert.deepEqual(withClosed.rows, [row]);
  assert.deepEqual(withClosed.previousCaseIds, [row.caseId, closed.caseId]);
});

test('submission reconciliation requires a complete, valid list before confirming or rejecting', () => {
  const row = { caseId: 'REQ-123456-2026', name: 'REQ-123456-2026 - IT lab', createdOn: '2026-01-02T00:00:00.000Z' };
  const options = { title: 'IT lab', since: Date.parse(SINCE) };
  for (const rows of [[], [row]]) {
    assert.equal(reconcileRequestList({ ok: true, complete: false, rows }, options).ok, false);
  }
  for (const invalid of [null, { ...row, name: '' }, { ...row, caseId: '' }, { ...row, createdOn: 'invalid' }]) {
    assert.equal(reconcileRequestList({ ok: true, complete: true, rows: [invalid] }, options).ok, false);
  }
  assert.equal(reconcileRequestList({ ok: true, complete: true, rows: [] }, { ...options, since: NaN }).ok, false);
  assert.deepEqual(reconcileRequestList({ ok: true, complete: true, rows: [row] }, options),
    { ok: true, found: row, ambiguous: null });
  assert.deepEqual(reconcileRequestList({ ok: true, complete: true, rows: [row] }, { ...options, previous: [row.caseId] }),
    { ok: true, found: null, ambiguous: null });
  const other = { ...row, caseId: 'REQ-123457-2026' };
  assert.deepEqual(reconcileRequestList({ ok: true, complete: true, rows: [row, other] }, options),
    { ok: true, found: null, ambiguous: [row, other] });
});

test('a newly visible case is not attributed to this submission without matching response evidence', () => {
  const found = { caseId: 'REQ-123456-2026' };
  const page = { url: `${ORIGIN}/support/request/`, hasForm: false, confirmation: true, caseIds: [found.caseId] };
  const commit = { status: 302, responseCaseIds: [found.caseId] };
  assert.equal(confirmsSubmittedCase(found, page, commit, ORIGIN), true);
  for (const [candidate, view, response, origin] of [
    [null, page, commit, ORIGIN],
    [found, { ...page, caseIds: ['REQ-999999-2026'] }, commit, ORIGIN],
    [found, { ...page, caseIds: [found.caseId, 'REQ-999999-2026'] }, commit, ORIGIN],
    [found, { ...page, hasForm: true }, commit, ORIGIN],
    [found, { ...page, confirmation: false }, commit, ORIGIN],
    [found, { ...page, url: 'https://other.example.test/' }, commit, ORIGIN],
    [found, { ...page, url: 'bad-url' }, commit, ORIGIN],
    [found, page, { status: 302, responseCaseIds: [] }, ORIGIN],
    [found, page, { status: 302, responseCaseIds: ['REQ-999999-2026'] }, ORIGIN],
    [found, page, { status: 302, responseCaseIds: [found.caseId, 'REQ-999999-2026'] }, ORIGIN],
    [found, page, { status: 500 }, ORIGIN],
    [found, page, { error: 'connection dropped' }, ORIGIN],
    [found, page, { status: 302, error: 'connection dropped' }, ORIGIN],
  ]) assert.equal(confirmsSubmittedCase(candidate, view, response, origin), false);
});

test('submitted case evidence comes from the successful response itself', () => {
  const id = 'REQ-123456-2026';
  assert.deepEqual(submittedResponseCaseIds({ status: 302, location: `/request/?case=${id}`, body: '' }), [id]);
  assert.deepEqual(submittedResponseCaseIds({ status: 200, body: `Request ${id} submitted` }), [id]);
  assert.deepEqual(submittedResponseCaseIds({ status: 302, location: '/request/', body: id }), []);
  assert.deepEqual(submittedResponseCaseIds({ status: 500, body: id }), []);
  assert.deepEqual(submittedResponseCaseIds({ status: 200, body: `${id} REQ-999999-2026` }), [id, 'REQ-999999-2026']);
  assert.deepEqual(submittedResponseCaseIds({ status: 200, body: `${id}${'x'.repeat(1048576)}` }), []);
});

test('a same-origin request list is not mistaken for a confirmation page', () => {
  const prior = { document: globalThis.document, location: globalThis.location };
  globalThis.location = new URL(`${ORIGIN}/support/request/`);
  globalThis.document = {
    title: 'Requests',
    body: { innerText: 'Recent requests: REQ-123456-2026' },
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: () => null,
  };
  try {
    assert.equal(parseOutcome().confirmation, false);
    globalThis.document.body.innerText = 'Your request REQ-123456-2026 has been submitted.';
    assert.equal(parseOutcome().confirmation, true);
  } finally {
    if (prior.document === undefined) delete globalThis.document; else globalThis.document = prior.document;
    if (prior.location === undefined) delete globalThis.location; else globalThis.location = prior.location;
  }
});

test('a form rejection cannot prove failure when a new or ambiguous case exists', () => {
  const found = { caseId: 'REQ-123456-2026' };
  const rejected = { lastOk: true, page: { hasForm: true, errors: [{ message: 'Invalid' }] }, commit: { status: 200 }, origin: ORIGIN };
  assert.equal(classifyReconciliation({ ...rejected, found: null, ambiguous: null }), 'rejected');
  assert.equal(classifyReconciliation({ ...rejected, found, ambiguous: null }), 'unknown');
  assert.equal(classifyReconciliation({ ...rejected, found: null, ambiguous: [found, found] }), 'unknown');
  assert.equal(classifyReconciliation({ ...rejected, found: null, ambiguous: null, lastOk: false }), 'unknown');
});

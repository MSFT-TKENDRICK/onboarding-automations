import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  planDealTeams, rankCandidates, rankCustomerCandidates,
} from '../../skills/verify-customer-deal-teams/scripts/plan.mjs';

const now = Date.parse('2026-11-09T12:00:00Z');
const date = new Date(now).toISOString();
const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const snapshot = records => ({ complete: true, observedAt: date, records });
const sourceKinds = [
  'account-team', 'account-owner', 'opportunity-owner', 'opportunity-team',
  'open-opportunity', 'milestone-owner', 'm365-engagement',
];
const signal = (kind, overrides = {}) => ({
  kind, source: 'Fixture source', recordId: id(3), userId: id(2),
  observedAt: date, strength: 'current', summary: 'Synthetic association', ...overrides,
});

function refreshCustomerReview(input, clock = now) {
  const review = input.assignments.customerReview;
  const result = rankCustomerCandidates({
    expectedIdentity: input.expectedIdentity,
    identity: input.identity,
    discovery: review.discovery,
  }, { now: clock });
  assert.equal(result.status, 'customer-candidates', result.reason);
  review.confirmation.customerSetId = result.customerSetId;
  return result;
}

function refreshCandidateSet(input, clock = now) {
  const result = rankCandidates({
    expectedIdentity: input.expectedIdentity,
    identity: input.identity,
    customerReview: input.assignments.customerReview,
    discovery: input.assignments.discovery,
  }, { now: clock });
  assert.equal(result.status, 'candidates', result.reason);
  input.assignments.confirmation.candidateSetId = result.candidateSetId;
  return result;
}

function evidence() {
  const input = {
    expectedIdentity: { tenantId: id(1), userId: id(2) },
    identity: {
      tenantId: id(1), userId: id(2), displayName: 'Fixture User',
      role: 'SE', active: true, observedAt: date,
    },
    assignments: {
      source: 'user-confirmed-candidates',
      customerReview: {
        discovery: {
          observedAt: date,
          sources: sourceKinds.map(kind => ({ kind, status: 'complete' })),
          records: [{
            customerId: 'fixture-customer', customerName: 'Fixture Customer',
            signals: [signal('opportunity-team'), signal('open-opportunity')],
          }],
        },
        confirmation: {
          customerSetId: '', userId: id(2), observedAt: date,
          selectedCustomerIds: ['fixture-customer'],
        },
        accountMappings: [{ customerId: 'fixture-customer', accountId: id(4) }],
      },
      discovery: {
        observedAt: date,
        sources: sourceKinds.map(kind => ({ kind, status: 'complete' })),
        records: [{
          accountId: id(4), accountName: 'Fixture Customer', active: true,
          signals: [signal('opportunity-team'), signal('open-opportunity')],
        }],
      },
      accounts: snapshot([{ accountId: id(4), accountName: 'Fixture Customer', active: true }]),
      confirmation: { candidateSetId: '', userId: id(2), observedAt: date, selectedAccountIds: [id(4)] },
    },
    opportunities: snapshot([{
      id: id(5), accountId: id(4), name: 'Fixture opportunity', state: 'open',
    }]),
    memberships: snapshot([]),
  };
  refreshCustomerReview(input);
  refreshCandidateSet(input);
  return input;
}

function customerEvidence() {
  const input = evidence();
  return {
    expectedIdentity: input.expectedIdentity,
    identity: input.identity,
    discovery: structuredClone(input.assignments.customerReview.discovery),
  };
}

function refreshCustomerReviewTime(input, observedAt) {
  const review = input.assignments.customerReview;
  review.discovery.observedAt = observedAt;
  for (const candidate of review.discovery.records) {
    for (const item of candidate.signals) item.observedAt = observedAt;
  }
  review.confirmation.observedAt = observedAt;
  return refreshCustomerReview(input, Date.parse(observedAt));
}

function blocked(input, pattern) {
  const result = planDealTeams(input, { now });
  assert.equal(result.status, 'blocked');
  assert.deepEqual(result.proposals, []);
  assert.equal(result.writesPerformed, 0);
  if (pattern) assert.match(result.reason, pattern);
}

test('confirmed exact candidate yields pending self-add, never write authorization', () => {
  const input = evidence();
  const before = structuredClone(input);
  const result = planDealTeams(input, { now });
  assert.equal(result.status, 'planned');
  assert.equal(result.verifiedAccountCount, 1);
  assert.deepEqual(result.proposals, [{
    status: 'pending-approval', tenantId: id(1), userId: id(2),
    userName: 'Fixture User', role: 'SE', accountId: id(4),
    accountName: 'Fixture Customer', opportunityId: id(5),
    opportunityName: 'Fixture opportunity', assignmentIds: [],
    assignmentEvidence: {
      method: 'user-confirmed-candidates',
      customerSetId: input.assignments.customerReview.confirmation.customerSetId,
      customerId: 'fixture-customer',
      customerConfirmedAt: date,
      candidateSetId: input.assignments.confirmation.candidateSetId,
      confirmedAt: date,
      confidence: 75,
    },
  }]);
  assert.equal(result.candidateReview.candidateCount, 1);
  assert.equal(result.candidateReview.confirmedAccountCount, 1);
  assert.equal(result.candidateReview.scopeComplete, true);
  assert.equal(result.candidateReview.customerReview.candidateCount, 1);
  assert.equal(result.candidateReview.customerReview.selectedCustomerCount, 1);
  assert.equal(result.writesPerformed, 0);
  assert.equal(result.requiresLiveRevalidation, true);
  assert.equal(result.requiresProviderApproval, true);
  assert.deepEqual(input, before);
});

const hostileCases = [
  ['wrong tenant', input => { input.identity.tenantId = id(8); }, /identity mismatch/],
  ['wrong user', input => { input.identity.userId = id(8); }, /identity mismatch/],
  ['inactive user', input => { input.identity.active = false; }, /not active/],
  ['unknown role', input => { input.identity.role = 'probably SE'; }, /unresolved role/],
  ['name-only identity', input => { input.expectedIdentity.userId = 'Fixture User'; }, /GUID/],
  ['zero tenant', input => { input.expectedIdentity.tenantId = '00000000-0000-0000-0000-000000000000'; }, /GUID/],
  ['confirmation of another user', input => { input.assignments.confirmation.userId = id(8); }, /another user/],
  ['inactive confirmed account', input => { input.assignments.accounts.records[0].active = false; }, /not active/],
  ['stale confirmation', input => {
    input.assignments.confirmation.observedAt = new Date(now - 86400001).toISOString();
  }, /stale/],
  ['future confirmation', input => {
    input.assignments.confirmation.observedAt = new Date(now + 1).toISOString();
  }, /future/],
  ['confirmation before discovery', input => {
    input.assignments.confirmation.observedAt = new Date(now - 1).toISOString();
  }, /before candidate discovery/],
  ['unsupported assignment source', input => { input.assignments.source = 'confidence'; }, /user confirmation/],
  ['changed candidate set', input => { input.assignments.confirmation.candidateSetId = 'sha256:wrong'; }, /list changed/],
  ['unreviewed selected account', input => { input.assignments.confirmation.selectedAccountIds = [id(8)]; }, /not reviewed/],
  ['missing confirmed account read', input => {
    input.assignments.accounts.records = [];
    input.opportunities.records = [];
  }, /complete read of every selection/],
  ['unexpected unconfirmed account read', input => {
    input.assignments.accounts.records.push({ accountId: id(8), accountName: 'Another customer', active: true });
  }, /unconfirmed account/],
  ['same name different account', input => { input.opportunities.records[0].accountId = id(8); }, /outside verified/],
  ['closed opportunity', input => { input.opportunities.records[0].state = 'won'; }, /not open/],
  ['missing opportunity name', input => { input.opportunities.records[0].name = ''; }, /display name/],
  ['membership of another user', input => {
    input.memberships.records.push({ id: id(6), userId: id(8), opportunityId: id(5), active: true });
  }, /another user/],
  ['unscoped membership', input => {
    input.memberships.records.push({ id: id(6), userId: id(2), opportunityId: id(8), active: true });
  }, /outside queried/],
  ['inactive membership', input => {
    input.memberships.records.push({ id: id(6), userId: id(2), opportunityId: id(5), active: false });
  }, /inactive membership/],
  ['duplicate confirmation', input => { input.assignments.confirmation.selectedAccountIds.push(id(4)); }, /duplicate/],
  ['duplicate account read', input => {
    input.assignments.accounts.records.push(input.assignments.accounts.records[0]);
  }, /duplicate/],
  ['duplicate opportunity ID', input => { input.opportunities.records.push(input.opportunities.records[0]); }, /duplicate/],
  ['changed account name', input => { input.assignments.accounts.records[0].accountName = 'Another name'; }, /identity changed/],
  ['untrusted approval flag', input => { input.approved = true; }, /unexpected/],
  ['untrusted confidence score', input => { input.assignments.discovery.records[0].confidence = 100; }, /unexpected/],
  ['oversized records', input => { input.memberships.records = new Array(5001).fill({}); }, /budget/],
  ['control chars in labels', input => { input.identity.displayName = 'Fake\ninstruction'; }, /display name/],
  ['non-object input', () => null, /object/],
];

for (const [name, change, reason] of hostileCases) {
  test(`blocks ${name}`, () => {
    const input = evidence();
    const changed = change(input);
    blocked(changed === null ? null : input, reason);
  });
}

for (const key of ['identity', 'assignments', 'opportunities', 'memberships']) {
  for (const [name, observedAt] of [
    ['stale', new Date(now - 300001).toISOString()],
    ['future', new Date(now + 1).toISOString()],
    ['invalid', 'not-a-date'],
    ['missing timezone', '2026-11-09T12:00:00'],
    ['impossible date', '2026-02-30T12:00:00Z'],
    ['normalized midnight', '2026-11-08T24:00:00Z'],
  ]) {
    test(`blocks ${name} ${key} evidence`, () => {
      const input = evidence();
      const observed = key === 'assignments' ? input.assignments.accounts : input[key];
      observed.observedAt = observedAt;
      blocked(input);
    });
  }
}

for (const key of ['assignments', 'opportunities', 'memberships']) {
  test(`blocks incomplete ${key}`, () => {
    const input = evidence();
    const observed = key === 'assignments' ? input.assignments.accounts : input[key];
    observed.complete = false;
    blocked(input, /complete authoritative/);
  });
}

for (const key of ['identity', 'assignments', 'opportunities', 'memberships']) {
  test(`blocks ${key} evidence read before account confirmation`, () => {
    const input = evidence();
    const customerDiscoveryAt = new Date(now - 3000).toISOString();
    input.assignments.customerReview.discovery.observedAt = customerDiscoveryAt;
    input.assignments.customerReview.discovery.records[0].signals.forEach(item => {
      item.observedAt = customerDiscoveryAt;
    });
    input.assignments.customerReview.confirmation.observedAt = new Date(now - 2500).toISOString();
    refreshCustomerReview(input);
    const discoveryAt = new Date(now - 2000).toISOString();
    input.assignments.discovery.observedAt = discoveryAt;
    input.assignments.discovery.records[0].signals.forEach(item => { item.observedAt = discoveryAt; });
    input.assignments.confirmation.observedAt = new Date(now - 1000).toISOString();
    refreshCandidateSet(input);
    const observed = key === 'assignments' ? input.assignments.accounts : input[key];
    observed.observedAt = new Date(now - 1500).toISOString();
    blocked(input, /read predates account confirmation/);
  });
}

test('existing active membership is idempotent and contributes no proposal', () => {
  const input = evidence();
  input.memberships.records.push({ id: id(6), userId: id(2), opportunityId: id(5), active: true });
  const first = planDealTeams(input, { now });
  assert.equal(first.status, 'planned');
  assert.deepEqual(first.proposals, []);
  assert.deepEqual(first.alreadyMember, [id(5)]);
  assert.deepEqual(planDealTeams(input, { now }), first);
});

test('no selected candidates is a valid zero-change plan, not proof of no assignments', () => {
  const input = evidence();
  input.assignments.confirmation.selectedAccountIds = [];
  input.assignments.accounts.records = [];
  input.opportunities.records = [];
  const result = planDealTeams(input, { now });
  assert.equal(result.status, 'planned');
  assert.equal(result.verifiedAccountCount, 0);
  assert.equal(result.candidateReview.candidateCount, 1);
  assert.deepEqual(result.proposals, []);
});

test('GUID case does not change exact identity or membership', () => {
  const input = evidence();
  const withLetters = value => value.replace('10000000', 'ABCDEFAB');
  const raw = JSON.stringify(input).replaceAll('10000000', 'abcdefab');
  const changed = JSON.parse(raw);
  changed.identity.userId = withLetters(input.identity.userId);
  refreshCustomerReview(changed);
  refreshCandidateSet(changed);
  assert.equal(planDealTeams(changed, { now }).status, 'planned');
});

test('generated permutations preserve proposals and every active membership removes exactly one', () => {
  for (let count = 1; count <= 100; count++) {
    const input = evidence();
    input.opportunities.records = Array.from({ length: count }, (_, n) => ({
      id: id(100 + n), accountId: id(4), name: `Fixture ${n}`, state: 'open',
    }));
    const baseline = planDealTeams(input, { now });
    input.opportunities.records.reverse();
    assert.deepEqual(planDealTeams(input, { now }), baseline);
    input.memberships.records.push({
      id: id(9), userId: id(2), opportunityId: id(100), active: true,
    });
    const result = planDealTeams(input, { now });
    assert.equal(result.status, 'planned');
    assert.equal(result.proposals.length, count - 1);
    assert.ok(result.proposals.every(item =>
      item.userId === id(2) && item.accountId === id(4) && item.status === 'pending-approval'));
    assert.equal(result.writesPerformed, 0);
  }
});

test('candidate scores are transparent, bounded, and do not count duplicate signal kinds twice', () => {
  const input = evidence();
  const signals = input.assignments.discovery.records[0].signals;
  signals.push(
    signal('m365-engagement', { recordId: id(10) }),
    signal('coverage-transition', { recordId: id(11) }),
    signal('opportunity-team', { recordId: id(12) }),
  );
  const result = refreshCandidateSet(input);
  assert.equal(result.candidates[0].confidence, 85);
  assert.deepEqual(result.candidates[0].reasons, [
    { kind: 'coverage-transition', points: -5 },
    { kind: 'm365-engagement', points: 15 },
    { kind: 'open-opportunity', points: 20 },
    { kind: 'opportunity-team', points: 55 },
  ]);
  assert.equal(result.candidates[0].signals.length, 5);
  assert.equal(planDealTeams(input, { now }).proposals[0].assignmentEvidence.confidence, 85);
});

test('unknown assignment semantics lower a heuristic score without blocking human review', () => {
  const input = evidence();
  input.assignments.discovery.records[0].signals = [
    signal('account-team', { strength: 'unknown', summary: 'Effective dates are unavailable' }),
  ];
  const result = refreshCandidateSet(input);
  assert.equal(result.candidates[0].confidence, 25);
  assert.equal(planDealTeams(input, { now }).status, 'planned');
});

test('a weaker duplicate signal cannot replace a stronger signal of the same kind', () => {
  const input = evidence();
  input.assignments.discovery.records[0].signals.push(
    signal('opportunity-team', { strength: 'historical', recordId: id(10) }),
  );
  const result = refreshCandidateSet(input);
  assert.equal(result.candidates[0].confidence, 75);
});

test('partial source coverage is reported and never implied to cover all customers', () => {
  const input = evidence();
  input.assignments.discovery.sources.find(source => source.kind === 'm365-engagement').status = 'unavailable';
  input.assignments.discovery.sources.find(source => source.kind === 'account-team').status = 'partial';
  const ranked = refreshCandidateSet(input);
  assert.equal(ranked.scopeComplete, false);
  const result = planDealTeams(input, { now });
  assert.equal(result.status, 'planned');
  assert.equal(result.candidateReview.scopeComplete, false);
  assert.ok(result.candidateReview.sources.some(source =>
    source.kind === 'm365-engagement' && source.status === 'unavailable'));
});

test('partial customer-name discovery remains visible after a complete exact-account read', () => {
  const input = evidence();
  input.assignments.customerReview.discovery.sources.find(source => source.kind === 'account-team').status = 'partial';
  refreshCustomerReview(input);
  const ranked = refreshCandidateSet(input);
  const result = planDealTeams(input, { now });
  assert.equal(ranked.scopeComplete, false);
  assert.equal(result.status, 'planned');
  assert.equal(result.candidateReview.scopeComplete, false);
  assert.equal(result.candidateReview.customerReview.scopeComplete, false);
});

test('preliminary customer review ranks unresolved names without granting account confirmation', () => {
  const input = customerEvidence();
  input.discovery.sources.find(source => source.kind === 'account-team').status = 'partial';
  input.discovery.records.push({
    customerId: 'another-customer', customerName: 'Fixture Customer',
    signals: [signal('m365-engagement', { strength: 'historical' })],
  });
  const before = structuredClone(input);
  const result = rankCustomerCandidates(input, { now });
  assert.equal(result.status, 'customer-candidates');
  assert.match(result.customerSetId, /^sha256:[0-9a-f]{64}$/);
  assert.equal(result.scopeComplete, false);
  assert.equal(result.requiresExactAccountReview, true);
  assert.equal(result.grantsAssignment, false);
  assert.equal(result.writesPerformed, 0);
  assert.deepEqual(result.candidates.map(item => [item.customerId, item.confidence]), [
    ['fixture-customer', 75], ['another-customer', 4],
  ]);
  assert.ok(result.candidates.every(item => !Object.hasOwn(item, 'accountId')));
  assert.equal(Object.hasOwn(result, 'candidateSetId'), false);
  assert.deepEqual(input, before);
});

test('preliminary review fingerprints bind names and evidence regardless of input order', () => {
  const input = customerEvidence();
  input.discovery.records.push({
    customerId: 'other', customerName: 'Other Customer',
    signals: [signal('m365-engagement', { strength: 'unknown' })],
  });
  const first = rankCustomerCandidates(input, { now });
  const reordered = structuredClone(input);
  reordered.discovery.sources.reverse();
  reordered.discovery.records.reverse();
  reordered.discovery.records.forEach(candidate => candidate.signals.reverse());
  assert.equal(rankCustomerCandidates(reordered, { now }).customerSetId, first.customerSetId);
  reordered.discovery.records[0].customerName = 'Changed Customer';
  assert.notEqual(rankCustomerCandidates(reordered, { now }).customerSetId, first.customerSetId);
});

test('preliminary customer selection cannot authorize the exact-account planner', () => {
  const preliminary = rankCustomerCandidates(customerEvidence(), { now });
  const input = evidence();
  input.assignments.confirmation.candidateSetId = preliminary.customerSetId;
  blocked(input, /list changed/);
  const namesAsAccounts = evidence();
  namesAsAccounts.assignments.confirmation.selectedAccountIds = ['fixture-customer'];
  blocked(namesAsAccounts, /GUID/);
  const namesAsDiscovery = evidence();
  namesAsDiscovery.assignments.discovery = customerEvidence().discovery;
  blocked(namesAsDiscovery, /unexpected or missing fields/);
});

const invalidCustomerReviewCases = [
  ['missing name review', input => { delete input.assignments.customerReview; }, /object required|unexpected or missing fields/],
  ['changed name list', input => {
    input.assignments.customerReview.discovery.records[0].customerName = 'Changed customer';
  }, /name list changed/],
  ['stale signal in the name review', input => {
    input.assignments.customerReview.discovery.records[0].signals[0].observedAt =
      new Date(now - 86400001).toISOString();
  }, /candidate signal: stale evidence/],
  ['name confirmation of another user', input => {
    input.assignments.customerReview.confirmation.userId = id(8);
  }, /another user/],
  ['stale name confirmation', input => {
    input.assignments.customerReview.confirmation.observedAt = new Date(now - 86400001).toISOString();
  }, /stale/],
  ['future name confirmation', input => {
    input.assignments.customerReview.confirmation.observedAt = new Date(now + 1).toISOString();
  }, /future/],
  ['name confirmation before discovery', input => {
    input.assignments.customerReview.confirmation.observedAt = new Date(now - 1).toISOString();
  }, /before customer discovery/],
  ['exact discovery before name selection', input => {
    input.assignments.discovery.observedAt = new Date(now - 1).toISOString();
  }, /predates customer-name confirmation/],
  ['exact signal read before name selection', input => {
    input.assignments.discovery.records[0].signals[0].observedAt = new Date(now - 1).toISOString();
  }, /candidate signal: read predates customer-name confirmation/],
  ['unreviewed customer selected', input => {
    input.assignments.customerReview.confirmation.selectedCustomerIds = ['not-reviewed'];
  }, /customer was not reviewed/],
  ['duplicate customer selection', input => {
    input.assignments.customerReview.confirmation.selectedCustomerIds.push('fixture-customer');
  }, /duplicate/],
  ['unselected customer mapped', input => {
    input.assignments.customerReview.confirmation.selectedCustomerIds = [];
  }, /customer was not selected/],
  ['selected customer without a mapping', input => {
    input.assignments.customerReview.accountMappings = [];
  }, /every selected customer must be resolved/],
  ['candidate without a customer mapping', input => {
    input.assignments.customerReview.accountMappings[0].accountId = id(8);
  }, /no selected customer mapping/],
  ['mapped account missing from review', input => {
    input.assignments.customerReview.accountMappings.push({ customerId: 'fixture-customer', accountId: id(8) });
  }, /every mapped account must be reviewed/],
  ['duplicate mapped account', input => {
    input.assignments.customerReview.accountMappings.push({ customerId: 'fixture-customer', accountId: id(4) });
  }, /duplicate/],
];

for (const [name, change, reason] of invalidCustomerReviewCases) {
  test(`exact-account ranking and planning block ${name}`, () => {
    const input = evidence();
    change(input);
    const ranked = rankCandidates({
      expectedIdentity: input.expectedIdentity,
      identity: input.identity,
      customerReview: input.assignments.customerReview,
      discovery: input.assignments.discovery,
    }, { now });
    assert.equal(ranked.status, 'blocked');
    assert.match(ranked.reason, reason);
    blocked(input, reason);
  });
}

test('name selection and account mapping are bound to the exact-account review', () => {
  const input = evidence();
  input.assignments.customerReview.discovery.records.push({
    customerId: 'second-customer', customerName: 'Second Customer',
    signals: [signal('account-owner', { recordId: id(10) })],
  });
  input.assignments.customerReview.confirmation.selectedCustomerIds.push('second-customer');
  input.assignments.customerReview.accountMappings.push({
    customerId: 'second-customer', accountId: id(8),
  });
  input.assignments.discovery.records.push({
    accountId: id(8), accountName: 'Second CRM account', active: true,
    signals: [signal('account-owner', { recordId: id(10) })],
  });
  refreshCustomerReview(input);
  const initial = refreshCandidateSet(input);
  const reordered = structuredClone(input);
  reordered.assignments.customerReview.confirmation.selectedCustomerIds.reverse();
  reordered.assignments.customerReview.accountMappings.reverse();
  assert.equal(refreshCandidateSet(reordered).candidateSetId, initial.candidateSetId);
  reordered.assignments.customerReview.accountMappings[0].customerId = 'fixture-customer';
  reordered.assignments.customerReview.accountMappings[1].customerId = 'second-customer';
  const changed = rankCandidates({
    expectedIdentity: reordered.expectedIdentity,
    identity: reordered.identity,
    customerReview: reordered.assignments.customerReview,
    discovery: reordered.assignments.discovery,
  }, { now });
  assert.equal(changed.status, 'candidates');
  assert.notEqual(changed.candidateSetId, initial.candidateSetId);
  blocked(reordered, /candidate list changed/);
});

test('no customer names selected yields an empty plan, not an assignment claim', () => {
  const input = evidence();
  input.assignments.customerReview.confirmation.selectedCustomerIds = [];
  input.assignments.customerReview.accountMappings = [];
  input.assignments.discovery.records = [];
  input.assignments.confirmation.selectedAccountIds = [];
  input.assignments.accounts.records = [];
  input.opportunities.records = [];
  refreshCandidateSet(input);
  const result = planDealTeams(input, { now });
  assert.equal(result.status, 'planned');
  assert.equal(result.candidateReview.customerReview.candidateCount, 1);
  assert.equal(result.candidateReview.customerReview.selectedCustomerCount, 0);
  assert.equal(result.verifiedAccountCount, 0);
  assert.deepEqual(result.proposals, []);
});

const invalidCustomerCases = [
  ['wrong signal user', input => { input.discovery.records[0].signals[0].userId = id(8); }, /another user/],
  ['duplicate ID', input => { input.discovery.records.push(structuredClone(input.discovery.records[0])); }, /duplicate/],
  ['invalid ID', input => { input.discovery.records[0].customerId = '../customer'; }, /invalid ID/],
  ['extra account field', input => { input.discovery.records[0].accountId = id(4); }, /unexpected or missing fields/],
  ['missing signals', input => { input.discovery.records[0].signals = []; }, /bounded signals/],
  ['unavailable source', input => {
    input.discovery.sources.find(source => source.kind === 'opportunity-team').status = 'unavailable';
  }, /source marked unavailable/],
  ['open opportunity without association', input => {
    input.discovery.records[0].signals = [signal('open-opportunity')];
  }, /association signal/],
  ['signal after discovery', input => {
    input.discovery.records[0].signals[0].observedAt = new Date(now + 1).toISOString();
  }, /after discovery/],
  ['stale signal in a fresh discovery', input => {
    input.discovery.records[0].signals[0].observedAt = new Date(now - 86400001).toISOString();
  }, /candidate signal: stale evidence/],
  ['stale discovery', input => { input.discovery.observedAt = new Date(now - 86400001).toISOString(); }, /stale/],
  ['future discovery', input => { input.discovery.observedAt = new Date(now + 1).toISOString(); }, /future/],
  ['stale identity', input => { input.identity.observedAt = new Date(now - 300001).toISOString(); }, /stale/],
];

for (const [name, change, reason] of invalidCustomerCases) {
  test(`preliminary customer ranking blocks ${name}`, () => {
    const input = customerEvidence();
    change(input);
    const result = rankCustomerCandidates(input, { now });
    assert.equal(result.status, 'blocked');
    assert.deepEqual(result.candidates, []);
    assert.match(result.reason, reason);
  });
}

test('customer evidence expires at its oldest signal even when discovery remains fresh', () => {
  const input = customerEvidence();
  input.discovery.records[0].signals[0].observedAt = new Date(now - 86400000).toISOString();
  assert.equal(rankCustomerCandidates(input, { now }).status, 'customer-candidates');

  input.identity.observedAt = new Date(now + 1).toISOString();
  const result = rankCustomerCandidates(input, { now: now + 1 });
  assert.equal(result.status, 'blocked');
  assert.deepEqual(result.candidates, []);
  assert.match(result.reason, /candidate signal: stale evidence/);
});

test('candidate fingerprints are order-independent and bind identity, evidence and scores', () => {
  const input = evidence();
  input.assignments.discovery.records.push({
    accountId: id(8), accountName: 'Another customer', active: true,
    signals: [signal('account-team', { strength: 'unknown' })],
  });
  input.assignments.customerReview.accountMappings.push({
    customerId: 'fixture-customer', accountId: id(8),
  });
  const initial = refreshCandidateSet(input);
  assert.deepEqual(initial.candidates.map(candidate => candidate.accountId), [id(4), id(8)]);
  const reordered = structuredClone(input);
  reordered.assignments.discovery.sources.reverse();
  reordered.assignments.discovery.records.reverse();
  reordered.assignments.discovery.records.forEach(candidate => candidate.signals.reverse());
  assert.equal(refreshCandidateSet(reordered).candidateSetId, initial.candidateSetId);
  reordered.assignments.discovery.records[0].signals[0].summary = 'Changed evidence';
  assert.notEqual(refreshCandidateSet(reordered).candidateSetId, initial.candidateSetId);
  assert.equal(planDealTeams({ ...input, assignments: {
    ...input.assignments, discovery: reordered.assignments.discovery,
  } }, { now }).status, 'blocked');
});

test('only explicitly selected accounts can contribute opportunities, regardless of score', () => {
  const input = evidence();
  input.assignments.discovery.records.push({
    accountId: id(8), accountName: 'Fixture Customer alternate entity', active: true,
    signals: [signal('account-owner'), signal('opportunity-team'), signal('open-opportunity')],
  });
  input.assignments.customerReview.accountMappings.push({
    customerId: 'fixture-customer', accountId: id(8),
  });
  const ranked = refreshCandidateSet(input);
  assert.equal(ranked.candidates[0].accountId, id(8));
  assert.equal(ranked.candidates[0].confidence, 100);
  const result = planDealTeams(input, { now });
  assert.equal(result.status, 'planned');
  assert.equal(result.candidateReview.candidateCount, 2);
  assert.equal(result.verifiedAccountCount, 1);
  assert.equal(result.proposals[0].accountId, id(4));
  input.opportunities.records.push({ id: id(9), accountId: id(8), name: 'Outside', state: 'open' });
  blocked(input, /outside verified/);
});

test('a user-provided exact account is reviewable without inventing evidence or confidence', () => {
  const input = evidence();
  input.assignments.discovery.records[0].signals = [
    signal('user-provided', { recordId: null, source: 'User', summary: 'User supplied this account' }),
  ];
  const result = refreshCandidateSet(input);
  assert.equal(result.candidates[0].confidence, 0);
  assert.equal(planDealTeams(input, { now }).status, 'planned');
});

const invalidCandidateCases = [
  ['wrong signal user', input => { input.assignments.discovery.records[0].signals[0].userId = id(8); }, /another user/],
  ['name-only account', input => { input.assignments.discovery.records[0].accountId = 'Fixture Customer'; }, /GUID/],
  ['duplicate candidate', input => {
    input.assignments.discovery.records.push(structuredClone(input.assignments.discovery.records[0]));
  }, /duplicate/],
  ['missing source status', input => { input.assignments.discovery.sources.pop(); }, /every source status/],
  ['duplicate source', input => {
    input.assignments.discovery.sources[0] = structuredClone(input.assignments.discovery.sources[1]);
  }, /duplicate/],
  ['invalid source status', input => { input.assignments.discovery.sources[0].status = 'assumed'; }, /invalid status/],
  ['evidence from unavailable source', input => {
    input.assignments.discovery.sources.find(source => source.kind === 'opportunity-team').status = 'unavailable';
  }, /source marked unavailable/],
  ['unknown signal kind', input => { input.assignments.discovery.records[0].signals[0].kind = 'guess'; }, /unknown kind/],
  ['unknown strength', input => { input.assignments.discovery.records[0].signals[0].strength = 'certain'; }, /invalid strength/],
  ['missing source record', input => { input.assignments.discovery.records[0].signals[0].recordId = null; }, /record ID/],
  ['signal after discovery', input => {
    input.assignments.discovery.records[0].signals[0].observedAt = new Date(now + 1).toISOString();
  }, /after discovery/],
  ['stale signal in a fresh discovery', input => {
    input.assignments.discovery.records[0].signals[0].observedAt = new Date(now - 86400001).toISOString();
  }, /candidate signal: stale evidence/],
  ['open opportunity without an association', input => {
    input.assignments.discovery.records[0].signals = [signal('open-opportunity')];
  }, /association signal/],
  ['stale discovery', input => {
    input.assignments.discovery.observedAt = new Date(now - 86400001).toISOString();
  }, /stale/],
  ['future discovery', input => {
    input.assignments.discovery.observedAt = new Date(now + 1).toISOString();
  }, /future/],
];

for (const [name, change, reason] of invalidCandidateCases) {
  test(`candidate ranking blocks ${name}`, () => {
    const input = evidence();
    change(input);
    const result = rankCandidates({
      expectedIdentity: input.expectedIdentity,
      identity: input.identity,
      customerReview: input.assignments.customerReview,
      discovery: input.assignments.discovery,
    }, { now });
    assert.equal(result.status, 'blocked');
    assert.deepEqual(result.candidates, []);
    assert.match(result.reason, reason);
    blocked(input);
  });
}

test('old authoritative-only snapshots and fabricated approval fields cannot bypass account confirmation', () => {
  const input = evidence();
  input.assignments = snapshot([{
    id: id(3), userId: id(2), accountId: id(4), accountName: 'Fixture Customer',
    active: true, validFrom: null, validUntil: null,
  }]);
  blocked(input, /unexpected or missing fields/);
  const another = evidence();
  another.assignments.confirmation.approved = true;
  blocked(another, /unexpected or missing fields/);
});

test('JSON CLI ranks fresh candidates without granting approval', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deal-team-candidates-'));
  try {
    const input = evidence();
    const observedAt = new Date().toISOString();
    input.identity.observedAt = observedAt;
    refreshCustomerReviewTime(input, observedAt);
    input.assignments.discovery.observedAt = observedAt;
    for (const candidate of input.assignments.discovery.records) {
      for (const item of candidate.signals) item.observedAt = observedAt;
    }
    const file = join(root, 'candidates.json');
    await writeFile(file, JSON.stringify({
      expectedIdentity: input.expectedIdentity,
      identity: input.identity,
      customerReview: input.assignments.customerReview,
      discovery: input.assignments.discovery,
    }));
    const script = fileURLToPath(new URL('../../skills/verify-customer-deal-teams/scripts/plan.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [script, '--candidates', file], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, 'candidates');
    assert.equal(output.candidates[0].confidence, 75);
    assert.match(output.candidateSetId, /^sha256:[0-9a-f]{64}$/);
    assert.equal(Object.hasOwn(output, 'approved'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('JSON CLI ranks preliminary customer names without resolving or confirming accounts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deal-team-customers-'));
  try {
    const input = customerEvidence();
    const observedAt = new Date().toISOString();
    input.identity.observedAt = observedAt;
    input.discovery.observedAt = observedAt;
    input.discovery.records[0].signals.forEach(item => { item.observedAt = observedAt; });
    const file = join(root, 'customers.json');
    await writeFile(file, JSON.stringify(input));
    const script = fileURLToPath(new URL('../../skills/verify-customer-deal-teams/scripts/plan.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [script, '--customers', file], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, 'customer-candidates');
    assert.equal(output.requiresExactAccountReview, true);
    assert.equal(output.grantsAssignment, false);
    assert.equal(output.writesPerformed, 0);
    assert.equal(output.candidates[0].confidence, 75);
    assert.equal(Object.hasOwn(output.candidates[0], 'accountId'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('JSON CLI returns blocked with exit 2 for malformed or missing input', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deal-team-test-'));
  try {
    const file = join(root, 'evidence.json');
    await writeFile(file, '{invalid');
    const script = fileURLToPath(new URL('../../skills/verify-customer-deal-teams/scripts/plan.mjs', import.meta.url));
    for (const args of [[], ['--input', file]]) {
      const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 10000 });
      assert.equal(result.status, 2);
      assert.equal(JSON.parse(result.stdout).status, 'blocked');
      assert.deepEqual(JSON.parse(result.stdout).proposals, []);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('JSON CLI enforces byte budget and reports unreadable input without a success fallback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deal-team-budget-'));
  try {
    const file = join(root, 'large.json');
    await writeFile(file, Buffer.alloc(8 * 1024 * 1024 + 1, 32));
    const script = fileURLToPath(new URL('../../skills/verify-customer-deal-teams/scripts/plan.mjs', import.meta.url));
    for (const [path, reason] of [[file, /8 MiB/], [join(root, 'missing.json'), /ENOENT/]]) {
      const result = spawnSync(process.execPath, [script, '--input', path], { encoding: 'utf8', timeout: 10000 });
      assert.equal(result.status, 2);
      const output = JSON.parse(result.stdout);
      assert.equal(output.status, 'blocked');
      assert.match(output.reason, reason);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('JSON CLI emits exactly one successful pending proposal from fresh evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deal-team-cli-'));
  try {
    const input = evidence();
    const observedAt = new Date().toISOString();
    for (const key of ['identity', 'opportunities', 'memberships']) {
      input[key].observedAt = observedAt;
    }
    refreshCustomerReviewTime(input, observedAt);
    input.assignments.accounts.observedAt = observedAt;
    input.assignments.discovery.observedAt = observedAt;
    input.assignments.confirmation.observedAt = observedAt;
    for (const candidate of input.assignments.discovery.records) {
      for (const item of candidate.signals) item.observedAt = observedAt;
    }
    const ranked = rankCandidates({
      expectedIdentity: input.expectedIdentity, identity: input.identity,
      customerReview: input.assignments.customerReview,
      discovery: input.assignments.discovery,
    });
    assert.equal(ranked.status, 'candidates');
    input.assignments.confirmation.candidateSetId = ranked.candidateSetId;
    const file = join(root, 'evidence.json');
    await writeFile(file, JSON.stringify(input));
    const script = fileURLToPath(new URL('../../skills/verify-customer-deal-teams/scripts/plan.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [script, '--input', file], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, 'planned');
    assert.equal(output.proposals.length, 1);
    assert.equal(output.proposals[0].status, 'pending-approval');
    assert.equal(output.writesPerformed, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

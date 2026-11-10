import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { planDealTeams } from '../../skills/verify-customer-deal-teams/scripts/plan.mjs';

const now = Date.parse('2026-11-09T12:00:00Z');
const date = new Date(now).toISOString();
const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const snapshot = records => ({ complete: true, observedAt: date, records });

function evidence() {
  return {
    expectedIdentity: { tenantId: id(1), userId: id(2) },
    identity: {
      tenantId: id(1), userId: id(2), displayName: 'Fixture User',
      role: 'SE', active: true, observedAt: date,
    },
    assignments: snapshot([{
      id: id(3), userId: id(2), accountId: id(4), accountName: 'Fixture Customer',
      active: true, validFrom: null, validUntil: null,
    }]),
    opportunities: snapshot([{
      id: id(5), accountId: id(4), name: 'Fixture opportunity', state: 'open',
    }]),
    memberships: snapshot([]),
  };
}

function blocked(input, pattern) {
  const result = planDealTeams(input, { now });
  assert.equal(result.status, 'blocked');
  assert.deepEqual(result.proposals, []);
  assert.equal(result.writesPerformed, 0);
  if (pattern) assert.match(result.reason, pattern);
}

test('complete exact assignment yields pending self-add, never write authorization', () => {
  const input = evidence();
  const before = structuredClone(input);
  const result = planDealTeams(input, { now });
  assert.equal(result.status, 'planned');
  assert.equal(result.verifiedAccountCount, 1);
  assert.deepEqual(result.proposals, [{
    status: 'pending-approval', tenantId: id(1), userId: id(2),
    userName: 'Fixture User', role: 'SE', accountId: id(4),
    accountName: 'Fixture Customer', opportunityId: id(5),
    opportunityName: 'Fixture opportunity', assignmentIds: [id(3)],
  }]);
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
  ['assignment of another user', input => { input.assignments.records[0].userId = id(8); }, /another user/],
  ['inactive assignment', input => { input.assignments.records[0].active = false; }, /inactive assignment/],
  ['expired assignment', input => { input.assignments.records[0].validUntil = date; }, /not currently effective/],
  ['future assignment', input => { input.assignments.records[0].validFrom = new Date(now + 1).toISOString(); }, /not currently effective/],
  ['reversed dates', input => {
    input.assignments.records[0].validFrom = date;
    input.assignments.records[0].validUntil = new Date(now - 1).toISOString();
  }, /not currently effective/],
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
  ['duplicate assignment ID', input => { input.assignments.records.push(input.assignments.records[0]); }, /duplicate/],
  ['duplicate opportunity ID', input => { input.opportunities.records.push(input.opportunities.records[0]); }, /duplicate/],
  ['conflicting account name', input => {
    input.assignments.records.push({ ...input.assignments.records[0], id: id(8), accountName: 'Another name' });
  }, /conflicting account/],
  ['untrusted approval flag', input => { input.approved = true; }, /unexpected/],
  ['untrusted confidence score', input => { input.assignments.records[0].confidence = 1; }, /unexpected/],
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
      input[key].observedAt = observedAt;
      blocked(input);
    });
  }
}

for (const key of ['assignments', 'opportunities', 'memberships']) {
  test(`blocks incomplete ${key}`, () => {
    const input = evidence();
    input[key].complete = false;
    blocked(input, /complete authoritative/);
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

test('empty exhaustive assignment and opportunity sets are a valid zero-change plan', () => {
  const input = evidence();
  input.assignments.records = [];
  input.opportunities.records = [];
  const result = planDealTeams(input, { now });
  assert.equal(result.status, 'planned');
  assert.equal(result.verifiedAccountCount, 0);
  assert.deepEqual(result.proposals, []);
});

test('GUID case does not change exact identity or membership', () => {
  const input = evidence();
  const withLetters = value => value.replace('10000000', 'ABCDEFAB');
  const raw = JSON.stringify(input).replaceAll('10000000', 'abcdefab');
  const changed = JSON.parse(raw);
  changed.identity.userId = withLetters(input.identity.userId);
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
    for (const key of ['identity', 'assignments', 'opportunities', 'memberships']) {
      input[key].observedAt = observedAt;
    }
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

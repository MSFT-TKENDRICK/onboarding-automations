import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stableStringify, sha256, planId, requestKey, savePlan, loadPlan, acquireSubmitLock, markSent, recordOutcome, readLock, releaseUnsent, claimStale } from '../../skills/request-new-github-repository/scripts/lib/plan-store.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'plan-store-'));
const validPlan = (over = {}) => {
  const material = { v: 1, input: { title: 'x' }, terms: 'tsha' };
  return { planId: planId(material), createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString(), material, terms: { sha: 'tsha' }, ...over };
};

test('stableStringify sorts keys recursively', () => {
  assert.equal(stableStringify({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: null } }), '{"a":{"c":null,"d":[2,{"y":2,"z":1}]},"b":1}');
});

test('planId is stable across key order and changes with values', () => {
  const a = planId({ fields: { title: 'x', type: '1' }, terms: 'h' });
  assert.equal(a, planId({ terms: 'h', fields: { type: '1', title: 'x' } }));
  assert.notEqual(a, planId({ fields: { title: 'y', type: '1' }, terms: 'h' }));
  assert.match(a, /^[0-9a-f]{16}$/);
});

test('sha256 hex', () => {
  assert.equal(sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('requestKey ignores case/whitespace and is per organization', () => {
  assert.equal(requestKey({ org: ' Contoso ', name: 'My-Repo' }), requestKey({ org: 'contoso', name: 'my-repo' }));
  assert.notEqual(requestKey({ org: 'a', name: 'x' }), requestKey({ org: 'b', name: 'x' }));
  assert.notEqual(requestKey({ org: 'a', name: 'x' }), requestKey({ org: 'a', name: 'y' }));
});

test('save and load plan round-trip; unknown plan throws', () => {
  const dir = tmp();
  try {
    const p = validPlan({ fields: { t: 1 } });
    savePlan(dir, p);
    assert.deepEqual(loadPlan(dir, p.planId).fields, { t: 1 });
    assert.throws(() => loadPlan(dir, 'nope'), /unknown plan/i);
    assert.throws(() => loadPlan(dir, '../etc'), /invalid plan id/i);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('submit lock is exclusive and survives the process', () => {
  const dir = tmp();
  try {
    const lock = acquireSubmitLock(dir, 'key1', { planId: 'p1' });
    assert.ok(existsSync(lock.path));
    assert.throws(() => acquireSubmitLock(dir, 'key1', { planId: 'p2' }), (e) => e.code === 'ALREADY_SUBMITTED' && e.lock.planId === 'p1');
    recordOutcome(lock, { outcome: 'success', caseId: 'REQ-000001-2026' });
    const saved = JSON.parse(readFileSync(lock.path, 'utf8'));
    assert.equal(saved.outcome, 'success');
    assert.equal(saved.caseId, 'REQ-000001-2026');
    assert.equal(readLock(dir, 'key1').caseId, 'REQ-000001-2026');
    assert.equal(readLock(dir, 'other'), null);
    assert.throws(() => acquireSubmitLock(dir, 'key1', {}), /already/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('journal: prepared lock can be released, sent lock never', () => {
  const dir = tmp();
  try {
    const lock = acquireSubmitLock(dir, 'k', { planId: 'p' });
    assert.equal(readLock(dir, 'k').state, 'prepared');
    assert.equal(releaseUnsent(dir, 'k'), true);
    assert.equal(readLock(dir, 'k'), null);
    const lock2 = acquireSubmitLock(dir, 'k', { planId: 'p' });
    markSent(lock2, { at: 't' });
    assert.equal(readLock(dir, 'k').state, 'sent');
    assert.throws(() => releaseUnsent(dir, 'k'), /was sent/);
    recordOutcome(lock2, { outcome: 'unknown' });
    assert.equal(readLock(dir, 'k').state, 'sent');
    recordOutcome(lock2, { outcome: 'success', caseId: 'REQ-1' });
    assert.equal(readLock(dir, 'k').state, 'reconciled');
    assert.equal(lock.path, lock2.path);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a conclusively rejected submission can be retried; unknown cannot', () => {
  const dir = tmp();
  try {
    const l1 = acquireSubmitLock(dir, 'r', {});
    markSent(l1);
    recordOutcome(l1, { outcome: 'rejected', errors: ['Title is required'] });
    const l2 = acquireSubmitLock(dir, 'r', {});
    assert.equal(l2.record.state, 'prepared');
    markSent(l2);
    recordOutcome(l2, { outcome: 'unknown' });
    assert.throws(() => acquireSubmitLock(dir, 'r', {}), (e) => e.code === 'ALREADY_SUBMITTED');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('plans expire', () => {
  const dir = tmp();
  try {
    const p = validPlan({ expiresAt: new Date(Date.now() - 1000).toISOString() });
    savePlan(dir, p);
    assert.throws(() => loadPlan(dir, p.planId), /expired/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('concurrent lock attempts: exactly one wins', async () => {
  const dir = tmp();
  try {
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => Promise.resolve().then(() => acquireSubmitLock(dir, 'race', {}))));
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a prepared lock left by a dead process is reclaimed; a live or sent one is not', () => {
  const dir = tmp();
  try {
    const path = join(dir, 'locks', 'submit-k1.json');
    acquireSubmitLock(dir, 'k1');
    writeFileSync(path, JSON.stringify({ key: 'k1', state: 'prepared', pid: 2 ** 22 + 12345 }));
    const lock = acquireSubmitLock(dir, 'k1');
    assert.equal(lock.record.pid, process.pid);
    writeFileSync(path, JSON.stringify({ key: 'k1', state: 'sent', pid: 2 ** 22 + 12345 }));
    assert.throws(() => acquireSubmitLock(dir, 'k1'), (e) => e.code === 'ALREADY_SUBMITTED');
    writeFileSync(path, JSON.stringify({ key: 'k1', state: 'prepared', pid: process.ppid }));
    assert.throws(() => acquireSubmitLock(dir, 'k1'), (e) => e.code === 'ALREADY_SUBMITTED');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('loadPlan verifies integrity: expiry required, material hash and terms must match the id', () => {
  const dir = tmp();
  try {
    const good = validPlan();
    savePlan(dir, good);
    assert.equal(loadPlan(dir, good.planId).planId, good.planId);
    const noExpiry = validPlan(); delete noExpiry.expiresAt; noExpiry.material = { ...noExpiry.material, v: 2 }; noExpiry.planId = planId(noExpiry.material);
    savePlan(dir, noExpiry);
    assert.throws(() => loadPlan(dir, noExpiry.planId), /expir/i);
    const edited = validPlan(); edited.material = { ...edited.material, input: { title: 'edited' } };
    savePlan(dir, edited);
    assert.throws(() => loadPlan(dir, edited.planId), /integrity/i);
    const m2 = { v: 1, input: { title: 'y' }, terms: 'tsha' };
    const terms = validPlan({ material: m2, planId: planId(m2), terms: { sha: 'other' } });
    savePlan(dir, terms);
    assert.throws(() => loadPlan(dir, terms.planId), /integrity/i);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('stale-lock takeover never removes a lock that changed after it was read', () => {
  const dir = tmp();
  try {
    const path = join(dir, 'locks', 'submit-k2.json');
    acquireSubmitLock(dir, 'k2');
    const dead = { key: 'k2', state: 'prepared', pid: 2 ** 22 + 999, preparedAt: 'a', nonce: 'n1' };
    writeFileSync(path, JSON.stringify(dead));
    // Another process reclaimed it between our read and our takeover: its fresh lock must survive.
    const fresh = { key: 'k2', state: 'prepared', pid: process.ppid, preparedAt: 'b', nonce: 'n2' };
    writeFileSync(path, JSON.stringify(fresh));
    assert.equal(claimStale(path, dead), false);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), fresh);
    writeFileSync(path, JSON.stringify(dead));
    assert.equal(claimStale(path, dead), true);
    assert.equal(existsSync(path), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('claimStale is serialized: while another run holds the reclaim mutex the lock is left alone', () => {
  const dir = tmp();
  try {
    const lock = acquireSubmitLock(dir, 'k4');
    const dead = { ...lock.record, pid: 999999 };
    writeFileSync(lock.path, JSON.stringify(dead));
    const mutex = `${lock.path.slice(0, -5)}.claim`;
    writeFileSync(mutex, String(process.pid));
    assert.equal(claimStale(lock.path, dead), false);
    assert.deepEqual(JSON.parse(readFileSync(lock.path, 'utf8')), dead);
    rmSync(mutex);
    assert.equal(claimStale(lock.path, dead), true);
    assert.equal(existsSync(mutex), false, 'mutex released');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('markSent refuses (so nothing is sent) when the lock no longer belongs to this attempt', () => {
  const dir = tmp();
  try {
    const lock = acquireSubmitLock(dir, 'k3');
    writeFileSync(lock.path, JSON.stringify({ ...lock.record, nonce: 'someone-else' }));
    assert.throws(() => markSent(lock), /no longer owns/);
    assert.equal(JSON.parse(readFileSync(lock.path, 'utf8')).nonce, 'someone-else');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('allowAfterSuccess reopens only a request that provably succeeded', () => {
  const dir = tmp();
  try {
    const l1 = acquireSubmitLock(dir, 'd');
    markSent(l1); recordOutcome(l1, { outcome: 'success', caseId: 'REQ-000001-2026' });
    assert.throws(() => acquireSubmitLock(dir, 'd'), (e) => e.code === 'ALREADY_SUBMITTED');
    const l2 = acquireSubmitLock(dir, 'd', {}, { allowAfterSuccess: true });
    assert.equal(l2.record.state, 'prepared');
    markSent(l2); recordOutcome(l2, { outcome: 'unknown' });
    assert.throws(() => acquireSubmitLock(dir, 'd', {}, { allowAfterSuccess: true }), (e) => e.code === 'ALREADY_SUBMITTED');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Plan persistence and the durable submit journal (prepared -> sent -> reconciled).
import { createHash, randomUUID } from 'node:crypto';
import { openSync, writeSync, fsyncSync, closeSync, readFileSync, mkdirSync, existsSync, unlinkSync, renameSync, linkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';

export const stableStringify = (v) => {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
};
export const sha256 = (s) => createHash('sha256').update(String(s)).digest('hex');
export const planId = (material) => sha256(stableStringify(material)).slice(0, 16);
const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
export const requestKey = ({ title, owner, type, purpose }) => sha256(stableStringify({ t: norm(title), o: norm(owner), y: String(type), p: String(purpose) })).slice(0, 24);

export function stateDir(env = process.env) {
  const base = env.MCAPS_SKILL_HOME
    || (env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'mcaps-subscription-skill'))
    || (env.XDG_STATE_HOME && join(env.XDG_STATE_HOME, 'mcaps-subscription-skill'))
    || join(homedir() || tmpdir(), '.local', 'state', 'mcaps-subscription-skill');
  // Owner-only on POSIX (plans hold names, UPNs and ids). On Windows %LOCALAPPDATA% is already per-user.
  mkdirSync(join(base, 'plans'), { recursive: true, mode: 0o700 });
  mkdirSync(join(base, 'locks'), { recursive: true, mode: 0o700 });
  return base;
}

const ID = /^[0-9a-zA-Z_-]{1,64}$/;
const checkId = (id, what) => { if (!ID.test(String(id))) throw new Error(`invalid ${what} id`); return id; };
const ensure = (d) => { mkdirSync(d, { recursive: true, mode: 0o700 }); return d; };

function durableWrite(path, obj) {
  const tmp = `${path}.${process.pid}.tmp`;
  const fd = openSync(tmp, 'w', 0o600);
  try { writeSync(fd, JSON.stringify(obj, null, 2)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, path);
}

export function savePlan(dir, plan) {
  checkId(plan.planId, 'plan');
  durableWrite(join(ensure(join(dir, 'plans')), `${plan.planId}.json`), plan);
  return plan;
}

// A plan is only usable if it is unexpired and its id still is the hash of its material (incl. the terms sha).
export function loadPlan(dir, id) {
  checkId(id, 'plan');
  const p = join(dir, 'plans', `${id}.json`);
  if (!existsSync(p)) throw new Error(`Unknown plan ${id}. Run plan again.`);
  const plan = JSON.parse(readFileSync(p, 'utf8'));
  const exp = Date.parse(plan.expiresAt);
  if (!Number.isFinite(exp)) throw new Error(`Plan ${id} has no valid expiry. Run plan again.`);
  if (exp < Date.now()) throw new Error(`Plan ${id} expired at ${plan.expiresAt}. Run plan again and re-confirm.`);
  if (plan.planId !== id || !plan.material || planId(plan.material) !== id || (plan.material.terms ?? null) !== (plan.terms?.sha ?? null)) {
    throw new Error(`Plan ${id} failed its integrity check (edited or corrupt). Run plan again.`);
  }
  return plan;
}

const lockPath = (dir, key) => join(ensure(join(dir, 'locks')), `submit-${checkId(key, 'request')}.json`);
const pidAlive = (pid) => { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const sameRecord = (a, b) => !!a && !!b && a.state === b.state && a.pid === b.pid && a.preparedAt === b.preparedAt && a.nonce === b.nonce;

export function readLock(dir, key) {
  const p = lockPath(dir, key);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
}

// Move a reclaimable lock out of the way, but only if it is still the exact record we inspected: a concurrent
// run may have reclaimed it and written its own lock in between. Reclaims are serialized by an O_EXCL mutex so a
// third run cannot take the slot while it is briefly empty. Returns true when the slot is free.
export function claimStale(path, expected, { keepAs } = {}) {
  const mutex = `${path.slice(0, -5)}.claim`;
  let mfd;
  try { mfd = openSync(mutex, 'wx', 0o600); } catch {
    // A reclaimer that crashed mid-claim leaves the mutex behind; it is only ever held for milliseconds.
    try { if (Date.now() - statSync(mutex).mtimeMs > 60000) unlinkSync(mutex); } catch {}
    return false;
  }
  try {
    const aside = `${path.slice(0, -5)}.${keepAs ?? 'stale'}-${process.pid}-${randomUUID().slice(0, 8)}.json`;
    try { renameSync(path, aside); } catch { return false; }
    let moved = null;
    try { moved = JSON.parse(readFileSync(aside, 'utf8')); } catch {}
    if (!sameRecord(moved, expected)) {
      // Not the record we judged reclaimable: put it back without clobbering (link fails if the slot is taken).
      try { linkSync(aside, path); unlinkSync(aside); } catch {}
      return false;
    }
    if (!keepAs) { try { unlinkSync(aside); } catch {} }
    return true;
  } finally {
    closeSync(mfd);
    try { unlinkSync(mutex); } catch {}
  }
}

// O_EXCL create: exactly one process wins per request key. Never removed once sent.
// allowAfterSuccess: a request that provably succeeded may be deliberately requested again (--allow-duplicate).
export function acquireSubmitLock(dir, key, meta = {}, { allowAfterSuccess = false, _retried = false } = {}) {
  const path = lockPath(dir, key);
  const record = { ...meta, key, state: 'prepared', pid: process.pid, preparedAt: new Date().toISOString(), nonce: randomUUID() };
  let fd;
  try { fd = openSync(path, 'wx', 0o600); } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    let existing = null;
    try { existing = JSON.parse(readFileSync(path, 'utf8')); } catch {}
    const settled = existing?.state === 'reconciled';
    const reopen = settled && (existing.outcome === 'rejected' || (allowAfterSuccess && existing.outcome === 'success'));
    // 'prepared' is fsynced as 'sent' before any POST leaves, so a prepared lock whose owner died was never sent.
    const abandoned = existing?.state === 'prepared' && existing.pid !== process.pid && !pidAlive(existing.pid);
    if (!_retried && (reopen || abandoned) && claimStale(path, existing, reopen ? { keepAs: existing.outcome } : {})) {
      return acquireSubmitLock(dir, key, meta, { allowAfterSuccess, _retried: true });
    }
    const err = new Error(`A submission for this request was already ${existing?.state ?? 'started'}${existing?.caseId ? ` (${existing.caseId})` : ''}. Refusing to submit again; run status.`);
    err.code = 'ALREADY_SUBMITTED';
    err.lock = existing;
    throw err;
  }
  try { writeSync(fd, JSON.stringify(record, null, 2)); fsyncSync(fd); } finally { closeSync(fd); }
  return { path, record };
}

const update = (lock, patch) => { lock.record = { ...lock.record, ...patch }; durableWrite(lock.path, lock.record); return lock.record; };

// Must be called (synchronously, fsynced) BEFORE the intercepted POST is released to the network. Throws (so the
// POST is failed, never sent) if the journal slot no longer holds this attempt's own lock.
export function markSent(lock, meta = {}) {
  let onDisk = null;
  try { onDisk = JSON.parse(readFileSync(lock.path, 'utf8')); } catch {}
  if (!sameRecord(onDisk, lock.record)) throw new Error('This attempt no longer owns the submit lock; refusing to send.');
  return update(lock, { ...meta, state: 'sent', sentAt: new Date().toISOString() });
}

export function recordOutcome(lock, outcome) {
  const settled = outcome.outcome === 'success' || outcome.outcome === 'rejected';
  const state = lock.record.state === 'prepared' && outcome.outcome !== 'success' ? 'prepared' : settled ? 'reconciled' : lock.record.state;
  return update(lock, { ...outcome, state, updatedAt: new Date().toISOString() });
}

// Only a lock that provably never released a POST may be removed.
export function releaseUnsent(dir, key) {
  const rec = readLock(dir, key);
  if (!rec) return false;
  if (rec.state !== 'prepared') throw new Error(`Cannot release: request was sent (state=${rec.state}). Use status to reconcile.`);
  unlinkSync(lockPath(dir, key));
  return true;
}

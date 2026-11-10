import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const ROLES = new Set(['AE', 'Specialist', 'SE', 'CSA', 'CSAM', 'ATS', 'IA', 'ATU Sales Director']);
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_AGE_MS = 5 * 60 * 1000;

function requireThat(condition, reason) {
  if (!condition) throw new Error(reason);
}

function object(value, keys, label) {
  requireThat(value !== null && typeof value === 'object' && !Array.isArray(value), `${label}: object required`);
  requireThat(Object.keys(value).length === keys.length
    && keys.every(key => Object.hasOwn(value, key)), `${label}: unexpected or missing fields`);
  return value;
}

function guid(value, label) {
  requireThat(typeof value === 'string' && GUID.test(value)
    && value.toLowerCase() !== '00000000-0000-0000-0000-000000000000', `${label}: nonzero GUID required`);
  return value.toLowerCase();
}

function text(value, label) {
  requireThat(typeof value === 'string' && value.trim().length > 0
    && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value), `${label}: bounded display name required`);
  return value;
}

function timestamp(value, label) {
  requireThat(typeof value === 'string' && ISO.test(value), `${label}: ISO timestamp required`);
  const parsed = Date.parse(value);
  requireThat(Number.isFinite(parsed), `${label}: invalid timestamp`);
  // Date.parse normalizes impossible calendar dates such as February 30.
  const date = value.slice(0, 10);
  const midnight = new Date(`${date}T00:00:00Z`);
  requireThat(Number.isFinite(midnight.getTime()) && midnight.toISOString().slice(0, 10) === date,
    `${label}: invalid calendar date`);
  requireThat(Number(value.slice(11, 13)) < 24 && Number(value.slice(14, 16)) < 60
    && Number(value.slice(17, 19)) < 60, `${label}: invalid time`);
  return parsed;
}

function fresh(value, now, label) {
  const at = timestamp(value, label);
  requireThat(at <= now && now - at <= MAX_AGE_MS, `${label}: stale or future evidence`);
  return at;
}

function snapshot(value, now, label) {
  object(value, ['complete', 'observedAt', 'records'], label);
  requireThat(value.complete === true, `${label}: complete authoritative read required`);
  fresh(value.observedAt, now, `${label}.observedAt`);
  requireThat(Array.isArray(value.records) && value.records.length <= 5000, `${label}: record budget exceeded`);
  return value.records;
}

function unique(set, id, label) {
  requireThat(!set.has(id), `${label}: duplicate/conflicting record ID`);
  set.add(id);
}

/**
 * Validate normalized live evidence and produce pending proposals only.
 * This checks consistency, not provenance; the harness must collect authoritative
 * records itself and must never treat an uploaded evidence file as trusted.
 */
export function planDealTeams(input, { now = Date.now() } = {}) {
  try {
    requireThat(Number.isFinite(now), 'invalid clock');
    object(input, ['expectedIdentity', 'identity', 'assignments', 'opportunities', 'memberships'], 'evidence');
    object(input.expectedIdentity, ['tenantId', 'userId'], 'expectedIdentity');
    const tenantId = guid(input.expectedIdentity.tenantId, 'expected tenant');
    const userId = guid(input.expectedIdentity.userId, 'expected user');
    const identity = object(input.identity,
      ['tenantId', 'userId', 'displayName', 'role', 'active', 'observedAt'], 'identity');
    requireThat(guid(identity.tenantId, 'tenant') === tenantId
      && guid(identity.userId, 'user') === userId, 'authenticated identity mismatch');
    requireThat(identity.active === true, 'authenticated user is not active');
    requireThat(ROLES.has(identity.role), 'unresolved role');
    text(identity.displayName, 'user name');
    fresh(identity.observedAt, now, 'identity.observedAt');

    const assigned = new Map();
    const assignmentIds = new Set();
    for (const row of snapshot(input.assignments, now, 'assignments')) {
      object(row, ['id', 'userId', 'accountId', 'accountName', 'active', 'validFrom', 'validUntil'], 'assignment');
      const id = guid(row.id, 'assignment ID');
      unique(assignmentIds, id, 'assignment');
      requireThat(guid(row.userId, 'assignment user') === userId, 'assignment belongs to another user');
      const accountId = guid(row.accountId, 'assignment account');
      text(row.accountName, 'account name');
      requireThat(row.active === true, 'inactive assignment in current coverage');
      const start = row.validFrom === null ? -Infinity : timestamp(row.validFrom, 'assignment start');
      const end = row.validUntil === null ? Infinity : timestamp(row.validUntil, 'assignment end');
      requireThat(start < end && start <= now && now < end, 'assignment is not currently effective');
      const existing = assigned.get(accountId);
      requireThat(!existing || existing.accountName === row.accountName, 'conflicting account identity');
      if (existing) existing.assignmentIds.push(id);
      else assigned.set(accountId, { accountName: row.accountName, assignmentIds: [id] });
    }

    const opportunities = new Map();
    for (const row of snapshot(input.opportunities, now, 'opportunities')) {
      object(row, ['id', 'accountId', 'name', 'state'], 'opportunity');
      const id = guid(row.id, 'opportunity ID');
      requireThat(!opportunities.has(id), 'duplicate/conflicting opportunity ID');
      const accountId = guid(row.accountId, 'opportunity account');
      requireThat(assigned.has(accountId), 'opportunity outside verified assignments');
      requireThat(row.state === 'open', 'opportunity is not open');
      text(row.name, 'opportunity name');
      opportunities.set(id, { ...row, id, accountId });
    }

    const members = new Set();
    const membershipIds = new Set();
    for (const row of snapshot(input.memberships, now, 'memberships')) {
      object(row, ['id', 'userId', 'opportunityId', 'active'], 'membership');
      unique(membershipIds, guid(row.id, 'membership ID'), 'membership');
      requireThat(guid(row.userId, 'membership user') === userId, 'membership belongs to another user');
      const opportunityId = guid(row.opportunityId, 'membership opportunity');
      requireThat(opportunities.has(opportunityId), 'membership outside queried opportunities');
      requireThat(row.active === true, 'inactive membership in active-only read');
      members.add(opportunityId);
    }

    const proposals = [];
    const alreadyMember = [];
    for (const opportunity of [...opportunities.values()].sort((a, b) => a.id.localeCompare(b.id))) {
      if (members.has(opportunity.id)) {
        alreadyMember.push(opportunity.id);
        continue;
      }
      const assignment = assigned.get(opportunity.accountId);
      proposals.push({
        status: 'pending-approval',
        tenantId,
        userId,
        userName: identity.displayName,
        role: identity.role,
        accountId: opportunity.accountId,
        accountName: assignment.accountName,
        opportunityId: opportunity.id,
        opportunityName: opportunity.name,
        assignmentIds: [...assignment.assignmentIds].sort(),
      });
    }
    return {
      status: 'planned',
      generatedAt: new Date(now).toISOString(),
      observedAt: Object.fromEntries(['identity', 'assignments', 'opportunities', 'memberships']
        .map(key => [key, input[key].observedAt])),
      verifiedAccountCount: assigned.size,
      alreadyMember,
      proposals,
      writesPerformed: 0,
      requiresLiveRevalidation: true,
      requiresProviderApproval: true,
    };
  } catch (error) {
    return { status: 'blocked', reason: error.message, proposals: [], writesPerformed: 0 };
  }
}

export async function main(args) {
  try {
    requireThat(args.length === 2 && args[0] === '--input', 'usage: plan.mjs --input <evidence.json>');
    const file = await open(resolve(args[1]), 'r');
    let input;
    try {
      requireThat((await file.stat()).isFile(), 'evidence must be a regular file');
      const buffer = Buffer.alloc(MAX_BYTES + 1);
      let size = 0;
      while (size < buffer.byteLength) {
        const { bytesRead } = await file.read(buffer, size, buffer.byteLength - size, null);
        if (bytesRead === 0) break;
        size += bytesRead;
      }
      requireThat(size <= MAX_BYTES, 'evidence exceeds 8 MiB');
      input = buffer.subarray(0, size);
    } finally {
      await file.close();
    }
    const result = planDealTeams(JSON.parse(input.toString('utf8')));
    console.log(JSON.stringify(result));
    return result.status === 'blocked' ? 2 : 0;
  } catch (error) {
    console.log(JSON.stringify({ status: 'blocked', reason: error.message, proposals: [], writesPerformed: 0 }));
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}

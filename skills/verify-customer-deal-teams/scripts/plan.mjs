import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const ROLES = new Set(['AE', 'Specialist', 'SE', 'CSA', 'CSAM', 'ATS', 'IA', 'ATU Sales Director']);
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_AGE_MS = 5 * 60 * 1000;
const MAX_REVIEW_AGE_MS = 24 * 60 * 60 * 1000;
const SOURCE_KINDS = [
  'account-team', 'account-owner', 'opportunity-owner', 'opportunity-team',
  'open-opportunity', 'milestone-owner', 'm365-engagement',
];
const SIGNAL_WEIGHTS = {
  'account-team': 50,
  'account-owner': 50,
  'opportunity-owner': 40,
  'opportunity-team': 55,
  'open-opportunity': 20,
  'milestone-owner': 20,
  'm365-engagement': 15,
  'coverage-transition': -5,
  'user-provided': 0,
};
const STRENGTH = { current: 1, unknown: 0.5, historical: 0.25 };

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

function fresh(value, now, label, notBefore) {
  const at = timestamp(value, label);
  requireThat(at <= now && now - at <= MAX_AGE_MS, `${label}: stale or future evidence`);
  if (notBefore !== undefined) {
    requireThat(at >= notBefore, `${label}: read predates account confirmation`);
  }
  return at;
}

function snapshot(value, now, label, notBefore) {
  object(value, ['complete', 'observedAt', 'records'], label);
  requireThat(value.complete === true, `${label}: complete authoritative read required`);
  fresh(value.observedAt, now, `${label}.observedAt`, notBefore);
  requireThat(Array.isArray(value.records) && value.records.length <= 5000, `${label}: record budget exceeded`);
  return value.records;
}

function unique(set, id, label) {
  requireThat(!set.has(id), `${label}: duplicate/conflicting record ID`);
  set.add(id);
}

function compare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function resolveIdentity(expected, identity, now) {
  object(expected, ['tenantId', 'userId'], 'expectedIdentity');
  const tenantId = guid(expected.tenantId, 'expected tenant');
  const userId = guid(expected.userId, 'expected user');
  object(identity, ['tenantId', 'userId', 'displayName', 'role', 'active', 'observedAt'], 'identity');
  requireThat(guid(identity.tenantId, 'tenant') === tenantId
    && guid(identity.userId, 'user') === userId, 'authenticated identity mismatch');
  requireThat(identity.active === true, 'authenticated user is not active');
  requireThat(ROLES.has(identity.role), 'unresolved role');
  text(identity.displayName, 'user name');
  fresh(identity.observedAt, now, 'identity.observedAt');
  return { tenantId, userId };
}

function readDiscovery(discovery, now) {
  object(discovery, ['observedAt', 'sources', 'records'], 'candidate discovery');
  const discoveredAt = timestamp(discovery.observedAt, 'candidate discovery.observedAt');
  requireThat(discoveredAt <= now && now - discoveredAt <= MAX_REVIEW_AGE_MS,
    'candidate discovery: stale or future evidence');
  requireThat(Array.isArray(discovery.sources) && discovery.sources.length === SOURCE_KINDS.length,
    'candidate discovery: every source status required');
  const sourceStatuses = new Map();
  for (const source of discovery.sources) {
    object(source, ['kind', 'status'], 'candidate source');
    requireThat(SOURCE_KINDS.includes(source.kind), 'candidate source: unknown kind');
    requireThat(!sourceStatuses.has(source.kind), 'candidate source: duplicate kind');
    requireThat(['complete', 'partial', 'unavailable'].includes(source.status), 'candidate source: invalid status');
    sourceStatuses.set(source.kind, source.status);
  }
  requireThat(SOURCE_KINDS.every(kind => sourceStatuses.has(kind)), 'candidate discovery: missing source status');
  const sources = SOURCE_KINDS.map(kind => ({ kind, status: sourceStatuses.get(kind) }));
  requireThat(Array.isArray(discovery.records) && discovery.records.length <= 5000,
    'candidate discovery: record budget exceeded');
  return { discoveredAt, sourceStatuses, sources };
}

function rankSignals(rawSignals, sourceStatuses, userId, discoveredAt, label) {
  requireThat(Array.isArray(rawSignals) && rawSignals.length > 0 && rawSignals.length <= 100,
    `${label}: bounded signals required`);
  const contributions = new Map();
  const signals = rawSignals.map(signal => {
    object(signal, ['kind', 'source', 'recordId', 'userId', 'observedAt', 'strength', 'summary'], 'candidate signal');
    requireThat(Object.hasOwn(SIGNAL_WEIGHTS, signal.kind), 'candidate signal: unknown kind');
    requireThat(guid(signal.userId, 'candidate signal user') === userId, 'candidate signal belongs to another user');
    if (SOURCE_KINDS.includes(signal.kind)) {
      requireThat(sourceStatuses.get(signal.kind) !== 'unavailable', 'candidate signal: source marked unavailable');
    }
    text(signal.source, 'candidate signal source');
    if (signal.kind !== 'user-provided' || signal.recordId !== null) {
      text(signal.recordId, 'candidate signal record ID');
    }
    requireThat(timestamp(signal.observedAt, 'candidate signal.observedAt') <= discoveredAt,
      'candidate signal: observed after discovery');
    requireThat(Object.hasOwn(STRENGTH, signal.strength), 'candidate signal: invalid strength');
    text(signal.summary, 'candidate signal summary');
    const points = Math.round(SIGNAL_WEIGHTS[signal.kind] * STRENGTH[signal.strength]);
    const previous = contributions.get(signal.kind);
    if (previous === undefined || (points >= 0 ? points > previous : points < previous)) {
      contributions.set(signal.kind, points);
    }
    return {
      kind: signal.kind, source: signal.source, recordId: signal.recordId,
      userId, observedAt: signal.observedAt, strength: signal.strength, summary: signal.summary,
    };
  }).sort((left, right) => compare(JSON.stringify(left), JSON.stringify(right)));
  requireThat(signals.some(signal => signal.kind !== 'open-opportunity' && signal.kind !== 'coverage-transition'),
    `${label}: an association signal is required`);
  const reasons = [...contributions].sort(([left], [right]) => compare(left, right))
    .map(([kind, points]) => ({ kind, points }));
  const confidence = Math.max(0, Math.min(100, reasons.reduce((sum, reason) => sum + reason.points, 0)));
  return { confidence, reasons, signals };
}

function scopeComplete(sources) {
  return sources.every(source => source.status === 'complete');
}

function collectCandidates(discovery, { tenantId, userId }, now) {
  const { discoveredAt, sourceStatuses, sources } = readDiscovery(discovery, now);
  const accountIds = new Set();
  const candidates = discovery.records.map(row => {
    object(row, ['accountId', 'accountName', 'active', 'signals'], 'candidate');
    const accountId = guid(row.accountId, 'candidate account');
    unique(accountIds, accountId, 'candidate account');
    text(row.accountName, 'candidate account name');
    requireThat(typeof row.active === 'boolean', 'candidate account: active state required');
    return {
      accountId, accountName: row.accountName, active: row.active,
      ...rankSignals(row.signals, sourceStatuses, userId, discoveredAt, 'candidate account'),
    };
  });
  const canonical = [...candidates].sort((left, right) => compare(left.accountId, right.accountId));
  const candidateSetId = `sha256:${createHash('sha256').update(JSON.stringify({
    tenantId, userId, observedAt: discovery.observedAt, sources, candidates: canonical,
  })).digest('hex')}`;
  return {
    status: 'candidates',
    candidateSetId,
    observedAt: discovery.observedAt,
    scopeComplete: scopeComplete(sources),
    sources,
    candidates: candidates.sort((left, right) =>
      right.confidence - left.confidence
      || compare(left.accountName, right.accountName)
      || compare(left.accountId, right.accountId)),
  };
}

function collectCustomerCandidates(discovery, { tenantId, userId }, now) {
  const { discoveredAt, sourceStatuses, sources } = readDiscovery(discovery, now);
  const customerIds = new Set();
  const candidates = discovery.records.map(row => {
    object(row, ['customerId', 'customerName', 'signals'], 'customer candidate');
    requireThat(typeof row.customerId === 'string'
      && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(row.customerId), 'customer candidate: invalid ID');
    unique(customerIds, row.customerId, 'customer candidate');
    text(row.customerName, 'customer name');
    return {
      customerId: row.customerId, customerName: row.customerName,
      ...rankSignals(row.signals, sourceStatuses, userId, discoveredAt, 'customer candidate'),
    };
  });
  const canonical = [...candidates].sort((left, right) => compare(left.customerId, right.customerId));
  const customerSetId = `sha256:${createHash('sha256').update(JSON.stringify({
    reviewKind: 'customer-name-only', tenantId, userId, observedAt: discovery.observedAt, sources,
    candidates: canonical,
  })).digest('hex')}`;
  return {
    status: 'customer-candidates',
    customerSetId,
    observedAt: discovery.observedAt,
    scopeComplete: scopeComplete(sources),
    sources,
    candidates: candidates.sort((left, right) =>
      right.confidence - left.confidence
      || compare(left.customerName, right.customerName)
      || compare(left.customerId, right.customerId)),
    requiresExactAccountReview: true,
    grantsAssignment: false,
    writesPerformed: 0,
  };
}

/**
 * Rank collected signals for human review; scores are heuristics, not assignment proof.
 */
export function rankCandidates(input, { now = Date.now() } = {}) {
  try {
    requireThat(Number.isFinite(now), 'invalid clock');
    object(input, ['expectedIdentity', 'identity', 'discovery'], 'candidate evidence');
    return collectCandidates(input.discovery, resolveIdentity(input.expectedIdentity, input.identity, now), now);
  } catch (error) {
    return { status: 'blocked', reason: error.message, candidates: [] };
  }
}

/**
 * Rank customer names for preliminary review without resolving or confirming CRM accounts.
 */
export function rankCustomerCandidates(input, { now = Date.now() } = {}) {
  try {
    requireThat(Number.isFinite(now), 'invalid clock');
    object(input, ['expectedIdentity', 'identity', 'discovery'], 'customer evidence');
    return collectCustomerCandidates(input.discovery, resolveIdentity(input.expectedIdentity, input.identity, now), now);
  } catch (error) {
    return { status: 'blocked', reason: error.message, candidates: [] };
  }
}

function confirmedAssignments(assignments, identity, now) {
  object(assignments, ['source', 'discovery', 'accounts', 'confirmation'], 'assignments');
  requireThat(assignments.source === 'user-confirmed-candidates', 'assignments: user confirmation required');
  const ranked = collectCandidates(assignments.discovery, identity, now);
  const confirmation = object(assignments.confirmation,
    ['candidateSetId', 'userId', 'observedAt', 'selectedAccountIds'], 'confirmation');
  requireThat(confirmation.candidateSetId === ranked.candidateSetId, 'confirmation: candidate list changed');
  requireThat(guid(confirmation.userId, 'confirmation user') === identity.userId, 'confirmation belongs to another user');
  const confirmedAt = timestamp(confirmation.observedAt, 'confirmation.observedAt');
  requireThat(confirmedAt >= timestamp(ranked.observedAt, 'candidate discovery.observedAt')
    && confirmedAt <= now && now - confirmedAt <= MAX_REVIEW_AGE_MS,
  'confirmation: stale, future, or before candidate discovery');
  requireThat(Array.isArray(confirmation.selectedAccountIds) && confirmation.selectedAccountIds.length <= 5000,
    'confirmation: selected account budget exceeded');
  const selected = new Set();
  const candidateById = new Map(ranked.candidates.map(candidate => [candidate.accountId, candidate]));
  for (const rawId of confirmation.selectedAccountIds) {
    const accountId = guid(rawId, 'confirmed account');
    unique(selected, accountId, 'confirmed account');
    requireThat(candidateById.has(accountId), 'confirmation: account was not reviewed');
  }
  const assigned = new Map();
  for (const row of snapshot(assignments.accounts, now, 'confirmed accounts', confirmedAt)) {
    object(row, ['accountId', 'accountName', 'active'], 'confirmed account');
    const accountId = guid(row.accountId, 'confirmed account');
    requireThat(selected.has(accountId), 'account read includes an unconfirmed account');
    requireThat(!assigned.has(accountId), 'confirmed account: duplicate/conflicting record ID');
    const candidate = candidateById.get(accountId);
    requireThat(candidate.active === true && row.active === true, 'confirmed account is not active');
    requireThat(text(row.accountName, 'account name') === candidate.accountName,
      'confirmed account identity changed after review');
    assigned.set(accountId, {
      accountName: row.accountName,
      assignmentIds: [],
      assignmentEvidence: {
        method: 'user-confirmed-candidates',
        candidateSetId: ranked.candidateSetId,
        confirmedAt: confirmation.observedAt,
        confidence: candidate.confidence,
      },
    });
  }
  requireThat(assigned.size === selected.size, 'confirmed accounts: complete read of every selection required');
  return {
    assigned,
    observedAt: assignments.accounts.observedAt,
    confirmedAt,
    review: {
      candidateSetId: ranked.candidateSetId,
      candidateCount: ranked.candidates.length,
      confirmedAccountCount: selected.size,
      confirmedAt: confirmation.observedAt,
      scopeComplete: ranked.scopeComplete,
      sources: ranked.sources,
    },
  };
}

/**
 * Validate normalized live evidence and produce pending proposals only.
 * This checks consistency, not provenance; the harness must collect live records
 * and a real human response, not treat an uploaded evidence file as either.
 */
export function planDealTeams(input, { now = Date.now() } = {}) {
  try {
    requireThat(Number.isFinite(now), 'invalid clock');
    object(input, ['expectedIdentity', 'identity', 'assignments', 'opportunities', 'memberships'], 'evidence');
    const identity = input.identity;
    const { tenantId, userId } = resolveIdentity(input.expectedIdentity, identity, now);
    const confirmation = confirmedAssignments(input.assignments, { tenantId, userId }, now);
    const assigned = confirmation.assigned;
    fresh(identity.observedAt, now, 'identity.observedAt', confirmation.confirmedAt);

    const opportunities = new Map();
    for (const row of snapshot(input.opportunities, now, 'opportunities', confirmation.confirmedAt)) {
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
    for (const row of snapshot(input.memberships, now, 'memberships', confirmation.confirmedAt)) {
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
        assignmentEvidence: assignment.assignmentEvidence,
      });
    }
    return {
      status: 'planned',
      generatedAt: new Date(now).toISOString(),
      observedAt: {
        identity: input.identity.observedAt,
        assignments: confirmation.observedAt,
        opportunities: input.opportunities.observedAt,
        memberships: input.memberships.observedAt,
      },
      verifiedAccountCount: assigned.size,
      candidateReview: confirmation.review,
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
    requireThat(args.length === 2 && ['--input', '--candidates', '--customers'].includes(args[0]),
      'usage: plan.mjs --input|--candidates|--customers <evidence.json>');
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
    const evidence = JSON.parse(input.toString('utf8'));
    const result = args[0] === '--customers'
      ? rankCustomerCandidates(evidence)
      : args[0] === '--candidates' ? rankCandidates(evidence) : planDealTeams(evidence);
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

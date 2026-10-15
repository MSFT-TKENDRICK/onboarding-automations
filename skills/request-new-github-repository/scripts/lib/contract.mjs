// The StartRight EMU API contract this skill depends on (see references/STARTRIGHT.md for how it was captured).
// One source of truth, enforced three ways: the client validates every response it consumes and every request it
// builds, the mock service in tests validates every request it receives, and `verify` replays the read-only
// endpoints against the live service. A mismatch is drift (`contract_violation`), never silently tolerated.
export const CONTRACT_VERSION = 1;
export const STARTRIGHT_URL = 'https://startright.app.prod.gitops.startclean.microsoft.com';

// ---------------------------------------------------------------- schema DSL (deliberately tiny)
const str = (o = {}) => ({ t: 'string', ...o });
const bool = (o = {}) => ({ t: 'boolean', ...o });
const num = () => ({ t: 'number' });
const arr = (items, o = {}) => ({ t: 'array', items, ...o });
// Responses are open (a service may add fields); request bodies are strict (we never send an unknown field).
const obj = (props, { req, strict = false } = {}) => ({ t: 'object', props, req: req ?? Object.keys(props), strict });

export function validate(schema, value, path = '$') {
  const err = (m) => [`${path}: ${m}`];
  if (value === undefined || value === null) return err(`expected ${schema.t}, got ${value === null ? 'null' : 'nothing'}`);
  switch (schema.t) {
    case 'string': {
      if (typeof value !== 'string') return err(`expected string, got ${typeof value}`);
      if (schema.enum && !schema.enum.includes(value)) return err(`"${value}" is not one of ${schema.enum.join('|')}`);
      if (schema.pattern && !schema.pattern.test(value)) return err(`"${value.slice(0, 40)}" does not match ${schema.pattern}`);
      if (schema.min !== undefined && value.length < schema.min) return err(`shorter than ${schema.min}`);
      if (schema.max !== undefined && value.length > schema.max) return err(`longer than ${schema.max}`);
      return [];
    }
    case 'boolean': return typeof value === 'boolean' ? (schema.const !== undefined && value !== schema.const ? err(`expected ${schema.const}`) : []) : err(`expected boolean, got ${typeof value}`);
    case 'number': return typeof value === 'number' && Number.isFinite(value) ? [] : err(`expected number, got ${typeof value}`);
    case 'array': {
      if (!Array.isArray(value)) return err(`expected array, got ${typeof value}`);
      const out = [];
      if (schema.min !== undefined && value.length < schema.min) out.push(`${path}: fewer than ${schema.min} items`);
      if (schema.max !== undefined && value.length > schema.max) out.push(`${path}: more than ${schema.max} items`);
      value.forEach((v, i) => out.push(...validate(schema.items, v, `${path}[${i}]`)));
      return out;
    }
    case 'object': {
      if (typeof value !== 'object' || Array.isArray(value)) return err(`expected object, got ${Array.isArray(value) ? 'array' : typeof value}`);
      const out = [];
      for (const k of schema.req) if (value[k] === undefined || value[k] === null) out.push(`${path}.${k}: required`);
      for (const [k, s] of Object.entries(schema.props)) if (value[k] !== undefined && value[k] !== null) out.push(...validate(s, value[k], `${path}.${k}`));
      if (schema.strict) for (const k of Object.keys(value)) if (!(k in schema.props)) out.push(`${path}.${k}: unexpected field`);
      return out;
    }
    case 'oneOf': {
      const tried = schema.of.map((s) => validate(s, value, path));
      return tried.some((e) => e.length === 0) ? [] : tried.reduce((best, e) => (e.length < best.length ? e : best));
    }
    default: throw new Error(`unknown schema type ${schema.t}`);
  }
}

// ---------------------------------------------------------------- shared shapes
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isGuid = (s) => typeof s === 'string' && GUID.test(s.trim());
export const ROLES = ['read', 'triage', 'write', 'maintain'];
export const VISIBILITIES = ['internal', 'private'];
export const PURPOSES = ['acl', 'ownership'];
export const PRINCIPAL_TYPES = ['user', 'group'];
export const REPO_NAME = /^[A-Za-z0-9._-]+$/;
export const LIMITS = { org: 39, name: 100, description: 350, owners: 2 };

export const Problem = obj({ status: num(), title: str(), correlationId: str(), retryable: bool(), type: str(), detail: str(), message: str(), policyUrl: str() }, { req: ['status', 'title', 'correlationId'] });
export const PartialFailure = obj({
  status: num(), title: str(), correlationId: str(), failureKind: str({ enum: ['partialFailure'] }),
  repositoryOutcome: str({ enum: ['created', 'unknown'] }), failedStage: str({ enum: ['repository', 'inventory', 'accessControl', 'jitAccess'] }),
  remediation: str(), automaticReplayAllowed: bool({ const: false }),
  repository: obj({ id: str(), organization: str(), name: str(), webUrl: str() }),
}, { req: ['status', 'title', 'correlationId', 'failureKind', 'repositoryOutcome', 'failedStage', 'remediation', 'automaticReplayAllowed'] });
const Session = obj({ userId: str(), login: str(), antiForgeryToken: str(), avatarUrl: str(), expiresAt: str() }, { req: ['userId', 'login', 'antiForgeryToken'] });
const Org = obj({ login: str(), avatarUrl: str(), displayName: str() }, { req: ['login'] });
const Membership = obj({ organization: str(), state: str(), role: str() }, { req: ['organization', 'state'] });
const Availability = obj({ organization: str(), name: str(), available: bool() });
export const Principal = obj({
  principalId: str({ min: 1 }), principalRef: str({ min: 1 }), type: str({ enum: PRINCIPAL_TYPES }), displayName: str(), isRequester: bool(),
  secondaryText: str(), expiresAt: str(), memberCount: num(), members: arr(obj({ displayName: str() }, { req: [] })),
}, { req: ['principalId', 'principalRef', 'type', 'displayName'] });
const Restriction = obj({ blocked: bool(), message: str(), policyUrl: str() }, { req: ['blocked'] });
export const CatalogItem = obj({ id: str({ pattern: GUID }), parentId: str(), name: str(), type: str({ enum: ['Division', 'Organization', 'ServiceGroup', 'TeamGroup', 'Service'] }) }, { req: ['id', 'name', 'type'] });
const Recent = obj({ organization: str(), name: str(), webUrl: str(), description: str(), createdAt: str() }, { req: ['organization', 'name', 'webUrl'] });
const Created = obj({ organization: str(), name: str(), webUrl: str({ pattern: /^https?:\/\//i }), id: str() }, { req: ['organization', 'name', 'webUrl'] });

export const CreateBody = obj({
  organization: str({ min: 1, max: LIMITS.org }),
  repository: obj({ name: str({ min: 1, max: LIMITS.name, pattern: REPO_NAME }), visibility: str({ enum: VISIBILITIES }), description: str({ min: 1, max: LIMITS.description }) }, { strict: true }),
  ownership: { t: 'oneOf', of: [
    obj({ type: str({ enum: ['serviceTree'] }), serviceTreeId: str({ pattern: GUID }) }, { strict: true }),
    obj({ type: str({ enum: ['directOwners'] }), owners: arr(str({ min: 1 }), { min: LIMITS.owners, max: LIMITS.owners }) }, { strict: true }),
  ] },
  accessControl: arr(obj({ principalRef: str({ min: 1 }), principalType: str({ enum: PRINCIPAL_TYPES }), permission: str({ enum: ROLES }) }, { strict: true }), { min: 1 }),
  classification: str({ enum: ['nonproduction'] }),
}, { strict: true });

// ---------------------------------------------------------------- endpoints
// kind: read endpoints may be called by plan/options/status/verify; the single write is gated by the guard.
const q = (name, o = {}) => ({ name, required: true, ...o });
const P = '/api/v1/resource/github';
export const ENDPOINTS = {
  session: { method: 'GET', path: '/api/v1/auth/github/session', responses: { 200: Session, 401: null } },
  organizations: { method: 'GET', path: `${P}/organizations`, responses: { 200: arr(Org), 401: Problem, 403: Problem } },
  joinable: { method: 'GET', path: `${P}/organizations/joinable`, query: [q('query'), q('top', { required: false, pattern: /^\d+$/ })], responses: { 200: arr(Org), 400: Problem } },
  membership: { method: 'GET', path: `${P}/organizations/{organization}/membership`, responses: { 200: Membership, 404: Problem } },
  availability: { method: 'GET', path: `${P}/repositories/availability`, query: [q('organization'), q('name')], responses: { 200: Availability, 400: Problem } },
  principals: { method: 'GET', path: `${P}/ownership/principals`, query: [q('organization'), q('purpose', { enum: PURPOSES }), q('query'), q('types', { required: false, pattern: /^(user|group)(,(user|group))*$/ })], responses: { 200: arr(Principal), 403: Problem } },
  restriction: { method: 'GET', path: `${P}/ownership/restriction`, query: [q('organization'), q('serviceTreeId', { pattern: GUID })], responses: { 200: Restriction, 400: Problem, 403: Problem } },
  catalog: { method: 'GET', path: '/api/v1/product-catalog/products', responses: { 200: arr(CatalogItem) } },
  recent: { method: 'GET', path: `${P}/repositories/recent`, responses: { 200: arr(Recent) } },
  create: {
    method: 'POST', path: `${P}/repositories`, csrf: true, body: CreateBody,
    responses: { 201: Created, 400: Problem, 401: Problem, 403: Problem, 409: Problem, 429: Problem, 503: Problem, 500: { t: 'oneOf', of: [PartialFailure, Problem] } },
  },
};
export const READ_ENDPOINTS = Object.keys(ENDPOINTS).filter((k) => ENDPOINTS[k].method === 'GET');
export const WRITE_PATH = ENDPOINTS.create.path;

export function buildPath(id, { path = {}, query = {} } = {}) {
  const e = ENDPOINTS[id];
  if (!e) throw new Error(`unknown endpoint ${id}`);
  let p = e.path.replace(/\{(\w+)\}/g, (_, k) => {
    if (path[k] === undefined) throw new Error(`${id}: missing path parameter ${k}`);
    return encodeURIComponent(path[k]);
  });
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  const s = qs.toString();
  return s ? `${p}?${s}` : p;
}

// Match a concrete method+path back to an endpoint id (used by the mock and the guard).
export function endpointFor(method, pathname) {
  const m = String(method).toUpperCase();
  for (const [id, e] of Object.entries(ENDPOINTS)) {
    if (e.method !== m) continue;
    const re = new RegExp(`^${e.path.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{\w+\}/g, '([^/]+)')}$`);
    if (re.test(pathname)) return id;
  }
  return null;
}

// Validate a request we are about to send (client) or have received (mock). Never throws.
export function checkRequest(id, { query = {}, body, headers = {} } = {}) {
  const e = ENDPOINTS[id];
  if (!e) return [`unknown endpoint ${id}`];
  const errors = [];
  const known = new Set((e.query ?? []).map((x) => x.name));
  for (const spec of e.query ?? []) {
    const v = query[spec.name];
    if (v === undefined || v === null || v === '') { if (spec.required) errors.push(`query ${spec.name}: required`); continue; }
    if (spec.enum && !spec.enum.includes(String(v))) errors.push(`query ${spec.name}: "${v}" is not one of ${spec.enum.join('|')}`);
    if (spec.pattern && !spec.pattern.test(String(v))) errors.push(`query ${spec.name}: "${String(v).slice(0, 40)}" is malformed`);
  }
  for (const k of Object.keys(query)) if (!known.has(k)) errors.push(`query ${k}: not part of the contract`);
  if (e.body) errors.push(...validate(e.body, body, 'body'));
  else if (body !== undefined) errors.push('body: this endpoint takes no body');
  if (e.csrf && !Object.entries(headers).some(([k, v]) => k.toLowerCase() === 'x-csrf-token' && String(v).length > 0)) errors.push('header X-CSRF-TOKEN: required');
  return errors;
}

// Validate a response we received (client, verify) or are about to send (mock provider verification).
export function checkResponse(id, status, body) {
  const e = ENDPOINTS[id];
  if (!e) return { ok: false, errors: [`unknown endpoint ${id}`] };
  if (!(status in e.responses)) return { ok: false, errors: [`status ${status} is not part of the contract for ${id} (${Object.keys(e.responses).join(', ')})`], unexpectedStatus: true };
  const schema = e.responses[status];
  if (schema === null) return { ok: true, errors: [] };
  const errors = validate(schema, body, 'body');
  return { ok: errors.length === 0, errors };
}

// How a POST /repositories answer must be treated by the journal. Only 201 proves a repository exists.
export function classifyCreate(status, body) {
  if (status === 201) return { outcome: 'success' };
  if (status === 500 && body?.failureKind === 'partialFailure') return { outcome: 'partial', repositoryOutcome: body.repositoryOutcome, failedStage: body.failedStage, remediation: body.remediation };
  // Refused before anything was created: safe to fix the cause and plan again.
  if ([400, 401, 403, 409].includes(status)) return { outcome: 'rejected', reason: { 400: 'invalid', 401: 'unauthorized', 403: 'forbidden', 409: 'conflict' }[status] };
  // The service said it did not take the request, but cannot prove nothing started: check status before any retry.
  if ([429, 503].includes(status)) return { outcome: 'rejected', reason: status === 429 ? 'rate_limited' : 'unavailable', retryable: true };
  return { outcome: 'unknown' };
}

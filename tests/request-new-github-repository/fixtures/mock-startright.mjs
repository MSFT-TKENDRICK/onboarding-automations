// A mock StartRight service for contract tests. It is an *independent* implementation of the recorded contract: every
// request it receives is validated with checkRequest (violations are 400s AND logged in state.violations, which tests
// assert is empty), and every answer it gives is validated with checkResponse before it is sent. It records every write.
// Nothing here ever leaves 127.0.0.1.
import { createServer } from 'node:http';
import { randomUUID, randomBytes } from 'node:crypto';
import { ENDPOINTS, checkRequest, checkResponse, endpointFor, isGuid, ROLES } from '../../../skills/request-new-github-repository/scripts/lib/contract.mjs';

export const IDS = {
  me: '11111111-1111-4111-8111-111111111111', alex: '22222222-2222-4222-8222-222222222222', sam: '33333333-3333-4333-8333-333333333333',
  pat1: '44444444-4444-4444-8444-444444444441', pat2: '44444444-4444-4444-8444-444444444442', grp: '55555555-5555-4555-8555-555555555555',
  svc: '66666666-6666-4666-8666-666666666666', svc2: '77777777-7777-4777-8777-777777777771', svc3: '77777777-7777-4777-8777-777777777772',
  restricted: '88888888-8888-4888-8888-888888888888', division: '99999999-9999-4999-8999-999999999999',
};
export const ME = { login: 'testuser_microsoft', userId: 'gh-1001', alias: 'testuser' };

const user = (principalId, displayName, email, extra = {}) => ({ principalId, type: 'user', displayName, secondaryText: email, ...extra });
export const DEFAULTS = {
  orgs: [{ login: 'contoso-eng', avatarUrl: 'https://avatars.invalid/1' }, { login: 'contoso-labs', avatarUrl: 'https://avatars.invalid/2' }],
  joinable: [{ login: 'contoso-secret' }, { login: 'contoso-eng' }],
  principals: [
    user(IDS.me, 'Test User', 'testuser@contoso.com', { isRequester: true }),
    user(IDS.alex, 'Alex Rivera', 'alex@contoso.com'),
    user(IDS.sam, 'Sam Lee', 'sam@contoso.com'),
    user(IDS.pat1, 'Pat Kim', 'pat.kim@contoso.com'),
    user(IDS.pat2, 'Pat Kim', 'pat.kim2@contoso.com'),
    { principalId: IDS.grp, type: 'group', displayName: 'Contoso Eng Maintainers', secondaryText: 'contoso-eng-maintainers' },
  ],
  catalog: [
    { id: IDS.division, name: 'Contoso Division', type: 'Division' },
    { id: IDS.svc, parentId: IDS.division, name: 'Widget Service', type: 'Service' },
    { id: IDS.svc2, parentId: IDS.division, name: 'Twin Service', type: 'Service' },
    { id: IDS.svc3, parentId: IDS.division, name: 'Twin Service', type: 'Service' },
    { id: IDS.restricted, parentId: IDS.division, name: 'Frozen Service', type: 'Service' },
  ],
  restrictedServices: [IDS.restricted],
  takenNames: ['contoso-eng/taken-repo'],
  recent: [{ organization: 'contoso-eng', name: 'older-repo', webUrl: 'https://github.example/contoso-eng/older-repo', description: 'an older repo', createdAt: '2025-01-01T00:00:00Z' }],
};

const problem = (status, title, extra = {}) => ({ status, title, correlationId: randomUUID(), retryable: [429, 503].includes(status), ...extra });
const ROUTE = /^\/web\/emu\/?$/;

// auth: 'signed-in' (cookie already trusted: SSO is silent), 'silent' (oauth/start signs you in), 'login' (never completes),
// 'consent' (oauth/start lands on a consent page that needs a click, i.e. --headed).
export async function startMockStartRight(opts = {}) {
  const cfg = { ...structuredClone(DEFAULTS), auth: 'silent', createMode: 'created', sessionTtlRequests: Infinity, catalogLatencyMs: 0, ...opts };
  const state = {
    writes: [], reads: [], violations: [], creates: [], created: [], tokens: new Map(), cookies: new Set(),
    csrf: `csrf-${randomBytes(6).toString('hex')}`, requests: 0,
  };
  const origin = () => `http://127.0.0.1:${server.address().port}`;

  const refFor = (purpose, org, p) => {
    const ref = `ref.${randomBytes(9).toString('hex')}`;
    state.tokens.set(ref, { purpose, org, principalId: p.principalId, type: p.type });
    return ref;
  };
  const signedIn = (req) => /(?:^|;\s*)sr_session=ok(?:;|$)/.test(req.headers.cookie ?? '') && state.cookies.has('ok');

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const method = req.method.toUpperCase();
    state.requests++;
    const body = await new Promise((resolve) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => resolve(Buffer.concat(c).toString('utf8'))); });
    const send = (status, payload, headers = {}) => {
      const isJson = payload !== undefined && typeof payload !== 'string';
      res.writeHead(status, { 'content-type': isJson ? (status >= 400 ? 'application/problem+json' : 'application/json') : 'text/html', 'x-gitops-operation-id': randomUUID(), ...headers });
      res.end(isJson ? JSON.stringify(payload) : (payload ?? ''));
    };
    const redirect = (to, headers = {}) => { res.writeHead(302, { location: to, ...headers }); res.end(); };
    if (method !== 'GET' && method !== 'HEAD') state.writes.push({ method, path: url.pathname, at: Date.now() });
    else state.reads.push({ method, path: url.pathname });

    // ---- app shell + sign-in simulation
    if (ROUTE.test(url.pathname)) {
      if (!signedIn(req)) return send(404, 'not found');
      return send(200, '<!doctype html><title>StartRight (mock)</title><div id=root>ok</div>');
    }
    if (url.pathname === '/api/v1/auth/github/oauth/start') {
      const back = url.searchParams.get('returnUrl') ?? `${origin()}/web/emu/`;
      if (cfg.auth === 'login') return redirect('/mock/login');
      if (cfg.auth === 'consent') return redirect(`/mock/consent?returnUrl=${encodeURIComponent(back)}`);
      state.cookies.add('ok');
      return redirect(back, { 'set-cookie': 'sr_session=ok; Path=/; HttpOnly; SameSite=Lax' });
    }
    if (url.pathname === '/mock/login') return send(200, '<!doctype html><title>Sign in</title><p>Mock sign-in that never completes</p>');
    if (url.pathname === '/mock/consent') {
      const back = url.searchParams.get('returnUrl') ?? `${origin()}/web/emu/`;
      return send(200, `<!doctype html><title>Authorize</title><a id=approve href="/mock/consent/approve?returnUrl=${encodeURIComponent(back)}">Authorize StartRight</a>`);
    }
    if (url.pathname === '/mock/consent/approve') {
      state.cookies.add('ok');
      return redirect(url.searchParams.get('returnUrl') ?? '/web/emu/', { 'set-cookie': 'sr_session=ok; Path=/; HttpOnly; SameSite=Lax' });
    }

    const id = endpointFor(method, url.pathname);
    if (!id) return send(404, problem(404, 'Not found'));
    if (id === 'session') {
      if (!signedIn(req)) return send(401);
      return send(200, { userId: ME.userId, login: ME.login, avatarUrl: 'https://avatars.invalid/me', expiresAt: new Date(Date.now() + 8 * 3600e3).toISOString(), antiForgeryToken: state.csrf });
    }
    if (!signedIn(req)) return send(401, problem(401, 'Unauthorized'));

    // ---- contract enforcement on the request
    const query = Object.fromEntries(url.searchParams);
    let parsed;
    if (body) { try { parsed = JSON.parse(body); } catch { return send(400, problem(400, 'Malformed JSON')); } }
    const errs = checkRequest(id, { query, body: parsed, headers: req.headers });
    if (errs.length) {
      state.violations.push({ id, errors: errs });
      return send(400, problem(400, 'Request does not match the contract', { detail: errs.join('; ') }));
    }
    const reply = (status, payload) => {
      const chk = checkResponse(id, status, payload);
      if (!chk.ok) { state.violations.push({ id, provider: true, errors: chk.errors }); return send(500, problem(500, 'mock produced a contract-violating answer', { detail: chk.errors.join('; ') })); }
      return send(status, payload);
    };
    const memberOf = (org) => cfg.orgs.some((o) => o.login.toLowerCase() === String(org).toLowerCase());

    switch (id) {
      case 'organizations': return reply(200, cfg.orgs);
      case 'joinable': return reply(200, cfg.joinable.filter((o) => o.login.includes(query.query.toLowerCase())));
      case 'membership': return memberOf(decodeURIComponent(url.pathname.split('/')[6])) ? reply(200, { organization: decodeURIComponent(url.pathname.split('/')[6]), state: 'active' }) : reply(404, problem(404, 'Not a member'));
      case 'availability': {
        if (!memberOf(query.organization)) return reply(400, problem(400, 'Unknown organization'));
        if (!/^[A-Za-z0-9._-]+$/.test(query.name) || query.name === '.' || query.name === '..' || query.name.length > 100) return reply(400, problem(400, 'Invalid repository name'));
        const taken = [...cfg.takenNames, ...state.created.map((c) => `${c.organization}/${c.name}`)].some((n) => n.toLowerCase() === `${query.organization}/${query.name}`.toLowerCase());
        return reply(200, { organization: query.organization, name: query.name, available: !taken });
      }
      case 'principals': {
        if (!memberOf(query.organization)) return reply(403, problem(403, 'Not a member'));
        const types = (query.types ?? 'user,group').split(',');
        const q = query.query.toLowerCase();
        const list = cfg.principals.filter((p) => types.includes(p.type) && [p.displayName, p.secondaryText].some((x) => String(x ?? '').toLowerCase().includes(q)));
        return reply(200, list.map((p) => ({ ...p, principalRef: refFor(query.purpose, query.organization, p), expiresAt: new Date(Date.now() + 15 * 60e3).toISOString() })));
      }
      case 'restriction': return reply(200, cfg.restrictedServices.includes(query.serviceTreeId.toLowerCase()) ? { blocked: true, message: 'New repositories are blocked for this service (mock policy).', policyUrl: 'https://policy.invalid/frozen' } : { blocked: false });
      case 'catalog': if (cfg.catalogLatencyMs) await new Promise((r) => setTimeout(r, cfg.catalogLatencyMs)); return reply(200, cfg.catalog);
      case 'recent': return reply(200, [...state.created.map((c) => ({ organization: c.organization, name: c.name, webUrl: c.webUrl })).reverse(), ...cfg.recent]);
      case 'create': return create(req, parsed, reply, send);
      default: return send(500, problem(500, 'mock gap'));
    }
  });

  function create(req, b, reply, send) {
    state.creates.push(structuredClone(b));
    if (req.headers['x-csrf-token'] !== state.csrf) return reply(403, problem(403, 'Bad CSRF token'));
    const bad = (detail) => reply(400, problem(400, 'Validation failed', { detail }));
    const org = cfg.orgs.find((o) => o.login.toLowerCase() === b.organization.toLowerCase());
    if (!org) return reply(403, problem(403, 'Not a member'));
    const resolveRef = (ref, purpose) => { const t = state.tokens.get(ref); return t && t.purpose === purpose && t.org === b.organization ? cfg.principals.find((p) => p.principalId === t.principalId) : null; };
    if (b.ownership.type === 'directOwners') {
      const owners = b.ownership.owners.map((r) => resolveRef(r, 'ownership'));
      if (owners.some((o) => !o)) return bad('an owner reference is unknown or expired');
      if (new Set(owners.map((o) => o.principalId)).size !== 2) return bad('owners must be two different people');
      if (!owners.some((o) => o.isRequester)) return bad('the requester must be one of the direct owners');
    } else if (cfg.restrictedServices.includes(b.ownership.serviceTreeId.toLowerCase())) return reply(403, problem(403, 'Blocked by policy', { policyUrl: 'https://policy.invalid/frozen' }));
    const acl = b.accessControl.map((a) => ({ a, p: resolveRef(a.principalRef, 'acl') }));
    if (acl.some((x) => !x.p || x.p.type !== x.a.principalType)) return bad('an access reference is unknown, expired or of the wrong type');
    const maintain = acl.filter((x) => x.a.permission === 'maintain');
    if (!maintain.some((x) => x.p.isRequester)) return bad('the requester must have the maintain role');
    if (!(maintain.some((x) => x.p.type === 'group') || maintain.filter((x) => x.p.type === 'user').length >= 2)) return bad('at least one group or two users must have maintain');
    if (cfg.takenNames.concat(state.created.map((c) => `${c.organization}/${c.name}`)).some((n) => n.toLowerCase() === `${b.organization}/${b.repository.name}`.toLowerCase())) return reply(409, problem(409, 'Repository already exists'));

    switch (cfg.createMode) {
      case 'conflict': return reply(409, problem(409, 'Repository already exists'));
      case 'rate_limited': return reply(429, problem(429, 'Too many requests'));
      case 'unavailable': return reply(503, problem(503, 'Service unavailable'));
      case 'forbidden': return reply(403, problem(403, 'Forbidden by policy', { detail: 'mock policy' }));
      case 'partial': return reply(500, { status: 500, title: 'Partial failure', correlationId: randomUUID(), retryable: false, failureKind: 'partialFailure', repositoryOutcome: 'created', failedStage: 'accessControl', remediation: 'Contact GiM support with the correlation id.', automaticReplayAllowed: false, repository: { organization: b.organization, name: b.repository.name, webUrl: `https://github.example/${b.organization}/${b.repository.name}` } });
      case 'unknown500': return reply(500, problem(500, 'Internal error'));
      case 'garbage500': return send(500, '<html>gateway exploded</html>');
      case 'drop': req.socket.destroy(); return undefined;
      case 'drop_after_create': state.created.push({ organization: b.organization, name: b.repository.name, webUrl: 'x' }); req.socket.destroy(); return undefined;
      default: {
        const webUrl = `https://github.example/${b.organization}/${b.repository.name}`;
        state.created.push({ organization: b.organization, name: b.repository.name, webUrl });
        return reply(201, { id: randomUUID(), organization: b.organization, name: b.repository.name, webUrl });
      }
    }
  }

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: origin(), state, cfg,
    createWrites: () => state.writes.filter((w) => w.method === 'POST' && w.path === ENDPOINTS.create.path),
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
}

export { isGuid, ROLES };

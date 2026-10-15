// A mock Microsoft Graph for the manager/default-team tests. Fake people only; it listens on 127.0.0.1 and answers the
// three read-only calls the skill makes. Any non-GET request, or a call without the test bearer token, is recorded as a
// violation so tests can assert the client stayed read-only.
import { createServer } from 'node:http';

export const GRAPH_TOKEN = 'test-graph-token';
export const GID = {
  me: 'aaaaaaaa-0000-4000-8000-000000000001', mgr: 'aaaaaaaa-0000-4000-8000-000000000002', alex: 'aaaaaaaa-0000-4000-8000-000000000003',
  sam: 'aaaaaaaa-0000-4000-8000-000000000004', dee: 'aaaaaaaa-0000-4000-8000-000000000005', gina: 'aaaaaaaa-0000-4000-8000-000000000006',
};
export const gUser = (id, name, alias, extra = {}) => ({ '@odata.type': '#microsoft.graph.user', id, displayName: name, userPrincipalName: `${alias}@contoso.com`, mail: `${alias}@contoso.com`, mailNickname: alias, accountEnabled: true, ...extra });
export const gGroup = (id, name, nickname, members, extra = {}) => ({ '@odata.type': '#microsoft.graph.group', id, displayName: name, mail: `${nickname}@contoso.com`, mailNickname: nickname, mailEnabled: true, securityEnabled: true, groupTypes: [], members, ...extra });
export const PEOPLE = {
  me: gUser(GID.me, 'Test User', 'testuser'),
  mgr: gUser(GID.mgr, 'Morgan Chu', 'morgan'),
  alex: gUser(GID.alex, 'Alex Rivera', 'alex'),
  sam: gUser(GID.sam, 'Sam Lee', 'sam'),
  dee: gUser(GID.dee, 'Dee Disabled', 'dee', { accountEnabled: false }),
  gina: gUser(GID.gina, 'Gina Ghost', 'ghost'),
};

export async function startMockGraph(opts = {}) {
  const cfg = { me: PEOPLE.me, manager: PEOPLE.mgr, reports: [PEOPLE.me, PEOPLE.alex, PEOPLE.sam, PEOPLE.dee, PEOPLE.gina], groups: [], status: {}, pageSize: 100, ...opts };
  const state = { requests: [], violations: [] };
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    state.requests.push(`${req.method} ${url.pathname}`);
    if (req.method !== 'GET') state.violations.push(`non-GET ${req.method} ${url.pathname}`);
    if (req.headers.authorization !== `Bearer ${GRAPH_TOKEN}`) state.violations.push(`bad authorization on ${url.pathname}`);
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body ?? {})); };
    const forced = cfg.status[url.pathname];
    if (forced) return send(forced, { error: { code: 'forced' } });
    if (url.pathname === '/v1.0/me') return send(200, cfg.me);
    if (url.pathname === '/v1.0/me/manager') return cfg.manager ? send(200, cfg.manager) : send(404);
    const m = url.pathname.match(/^\/v1\.0\/users\/([^/]+)\/directReports$/);
    if (m) {
      const skip = Number(url.searchParams.get('$skip') ?? 0);
      const value = cfg.reports.slice(skip, skip + cfg.pageSize);
      const more = skip + cfg.pageSize < cfg.reports.length;
      return send(200, { value, ...(more ? { '@odata.nextLink': `${origin()}${url.pathname}?$skip=${skip + cfg.pageSize}` } : {}) });
    }
    const gm = url.pathname.match(/^\/v1\.0\/groups\/([^/]+)\/members$/);
    if (gm) {
      const g = cfg.groups.find((x) => x.id === gm[1]);
      return g ? send(200, { value: g.members }) : send(404);
    }
    if (url.pathname === '/v1.0/groups') {
      const f = /^mailNickname eq '([^']*)'$/.exec(url.searchParams.get('$filter') ?? '');
      return send(200, { value: f ? cfg.groups.filter((g) => g.mailNickname.toLowerCase() === f[1].toLowerCase()).map(({ members, ...g }) => g) : [] });
    }
    if (url.pathname === '/v1.0/me/memberOf/microsoft.graph.group') return send(200, { value: cfg.groups.filter((g) => g.members.some((u) => u.id === cfg.me.id)).map(({ members, ...g }) => g) });
    return send(404);
  });
  const origin = () => `http://127.0.0.1:${server.address().port}`;
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: origin(), state, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}

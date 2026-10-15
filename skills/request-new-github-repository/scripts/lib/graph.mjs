// Read-only Microsoft Graph client: who is my manager, and who else reports to them. GET only, to one fixed origin.
// The token comes from STARTRIGHT_GRAPH_TOKEN (CI/tests) or from the signed-in Azure CLI (`az login`); it is never
// stored, logged or sent anywhere but the Graph origin.
import { exec } from 'node:child_process';
import { isGuid } from './contract.mjs';

export const GRAPH_URL = 'https://graph.microsoft.com';
export const USER_FIELDS = 'id,displayName,userPrincipalName,mail,mailNickname,accountEnabled,jobTitle';
const MAX_PAGES = 5;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

export class GraphError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function azToken() {
  return new Promise((resolve, reject) => {
    // Fixed command, no user input: `az` is a .cmd shim on Windows, which needs a shell.
    exec('az account get-access-token --resource-type ms-graph --query accessToken -o tsv', { timeout: 30000, windowsHide: true }, (err, stdout, stderr) => {
      const token = String(stdout ?? '').trim();
      if (err || token.length < 100) reject(new GraphError('graph_unavailable', `No Microsoft Graph token: sign in with "az login" (or set STARTRIGHT_GRAPH_TOKEN). ${String(stderr ?? err?.message ?? '').split('\n')[0].slice(0, 160)}`.trim()));
      else resolve(token);
    });
  });
}

export function createGraph({ env = process.env, log = () => {}, fetchImpl = globalThis.fetch, getToken } = {}) {
  const base = new URL(env.STARTRIGHT_GRAPH_URL || GRAPH_URL).origin;
  const host = new URL(base).hostname;
  const testing = !!(env.NODE_TEST_CONTEXT || process.env.NODE_TEST_CONTEXT);
  let token = env.STARTRIGHT_GRAPH_TOKEN || null;

  const get = async (pathOrUrl) => {
    if (testing && !LOOPBACK.has(host)) throw new GraphError('graph_unavailable', 'Refusing to contact Microsoft Graph from a test run (set STARTRIGHT_GRAPH_URL to a loopback mock).');
    const url = new URL(pathOrUrl, base);
    if (url.origin !== base) throw new GraphError('graph_failed', 'Refusing to follow a Graph link to a different origin.');
    token ??= await (getToken ?? azToken)();
    let res;
    try { res = await fetchImpl(url, { method: 'GET', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(15000) }); }
    catch (e) { throw new GraphError('graph_unavailable', `Microsoft Graph is unreachable (${e.cause?.code ?? e.name}). Check the network or VPN.`); }
    if (res.status === 404) return null;
    if (res.status === 401) { token = env.STARTRIGHT_GRAPH_TOKEN || null; throw new GraphError('graph_unauthorized', 'Microsoft Graph rejected the token: run "az login" again.'); }
    if (res.status === 403) throw new GraphError('graph_forbidden', 'Microsoft Graph refused to show the manager or direct reports for this account.');
    if (!res.ok) throw new GraphError('graph_failed', `Microsoft Graph answered ${res.status}.`);
    log(`graph GET ${url.pathname} -> ${res.status}`);
    return res.json();
  };

  const asUser = (u) => (u && typeof u === 'object' && (u['@odata.type'] ?? '#microsoft.graph.user') === '#microsoft.graph.user' ? u : null);

  return {
    base,
    async me() { return asUser(await get(`/v1.0/me?$select=${USER_FIELDS}`)); },
    async manager() { return asUser(await get(`/v1.0/me/manager?$select=${USER_FIELDS}`)); },
    async directReports(id) {
      if (!isGuid(id)) throw new GraphError('graph_failed', 'Graph returned an unexpected manager id.');
      const out = [];
      let next = `/v1.0/users/${id}/directReports?$select=${USER_FIELDS}&$top=100`;
      for (let page = 0; next && page < MAX_PAGES; page++) {
        const body = await get(next);
        out.push(...(body?.value ?? []).map(asUser).filter(Boolean));
        next = body?.['@odata.nextLink'];
      }
      return out;
    },
  };
}

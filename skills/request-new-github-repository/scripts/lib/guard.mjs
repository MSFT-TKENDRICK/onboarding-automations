// Write guard. Two layers, both default-deny:
//  1. classify(): the CDP Fetch interceptor. The browser may READ anything, but it may never write to StartRight and
//     may write only to the sign-in hosts (Entra, GitHub login / SSO / OAuth consent). Repository creation is not
//     browser-originated at all.
//  2. authorizeCreate(): the only way the one create POST is ever sent. It is sent from Node, one-shot, and only when the
//     body equals the body armed for it. A test run can never reach a non-local service (kill switch).
import { WRITE_PATH } from './contract.mjs';
import { stableStringify } from './plan-store.mjs';

export const READ = new Set(['GET', 'HEAD', 'OPTIONS']);
const IDENTITY_HOSTS = ['login.microsoftonline.com', 'login.windows.net', 'login.live.com', 'device.login.microsoftonline.com', 'autologon.microsoftazuread-sso.com'];
// GitHub sign-in writes only: password/SSO/SAML/2FA posts and the OAuth consent. Nothing here can create a repository.
const GITHUB_HOSTS = ['github.com', 'www.github.com'];
const GITHUB_AUTH_PATHS = [/^\/session$/i, /^\/sessions?\//i, /^\/login(\/|$)/i, /^\/sso(\/|$)/i, /^\/saml\/consume$/i, /^\/enterprises\/[^/]+\/saml\/consume$/i, /^\/orgs\/[^/]+\/sso(\/|$)/i, /^\/login\/oauth\/authorize$/i];
const BLOCKED_TYPES = new Set(['Image', 'Media', 'Font']);
const TELEMETRY = /(^|\.)(clarity\.ms|applicationinsights\.azure\.com|applicationinsights\.io|monitor\.azure\.com|events\.data\.microsoft\.com|browser\.events\.data\.msn\.com|google-analytics\.com|googletagmanager\.com|collector\.github\.com)$/i;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export const isLoopback = (url) => { try { return LOOPBACK.has(new URL(url).hostname); } catch { return false; } };

// `node --test` exports NODE_TEST_CONTEXT to everything it starts. A test may only ever write to a local mock, so a
// misconfigured test (wrong STARTRIGHT_URL, a forgotten override) cannot create a real repository.
export const underTest = (env = process.env) => !!env.NODE_TEST_CONTEXT;
export function liveWriteRefusal(baseUrl, env = process.env) {
  return underTest(env) && !isLoopback(baseUrl) ? `Refusing to write to ${new URL(baseUrl).origin} from a test run: tests may only write to a local mock.` : null;
}

export class GuardError extends Error {
  constructor(code, message, extra = {}) { super(message); this.code = code; Object.assign(this, extra); }
}

export function createGuard({ baseUrl, blockResources = true, allowSubmit = true, env = process.env } = {}) {
  const base = new URL(baseUrl);
  const blockedWrites = [];
  // Every write decision, allowed or denied, with the phase it happened in (the ledger `verify` reports).
  const writes = [];
  let blockedResources = 0;
  let phase = null;
  let gate = null;
  let everArmed = false;
  let createsSent = 0;

  const record = (entry) => writes.push({ phase, ...entry });

  function classify(req) {
    const v = decide(req);
    const m = String(req.method || 'GET').toUpperCase();
    if (!READ.has(m)) {
      let u = null;
      try { u = new URL(req.url); } catch {}
      record({ origin: 'browser', method: m, host: u?.hostname ?? '', path: u?.pathname ?? '', service: u?.origin === base.origin, action: v.action, reason: v.reason, ref: req.ref ?? null });
    }
    return v;
  }

  function decide({ method, url, resourceType }) {
    let u;
    try { u = new URL(url); } catch { return { action: 'continue', reason: 'unparsed' }; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return { action: 'continue', reason: 'scheme' };
    const m = String(method || 'GET').toUpperCase();
    if (READ.has(m)) {
      if (blockResources && (BLOCKED_TYPES.has(resourceType) || TELEMETRY.test(u.hostname))) { blockedResources++; return { action: 'fail', reason: 'blocked-resource' }; }
      return { action: 'continue', reason: 'read' };
    }
    const deny = (reason) => { blockedWrites.push({ method: m, host: u.hostname, path: u.pathname, reason }); return { action: 'fail', reason }; };
    // The service origin: the browser never writes to it, whatever the path.
    if (u.origin === base.origin) return deny(u.pathname === WRITE_PATH ? 'blocked-create-from-browser' : 'blocked-write');
    const host = u.hostname.toLowerCase();
    if (IDENTITY_HOSTS.includes(host)) return { action: 'continue', reason: 'identity' };
    if (GITHUB_HOSTS.includes(host) && GITHUB_AUTH_PATHS.some((re) => re.test(u.pathname))) return { action: 'continue', reason: 'identity' };
    return deny('blocked-write');
  }

  return {
    classify,
    // Arm the single create. expectedBody is the exact object that was validated against the plan.
    armCreate({ expectedBody }) {
      if (!allowSubmit) throw new GuardError('submit_disabled', 'Creating is disabled for this session.');
      const refusal = liveWriteRefusal(baseUrl, env);
      if (refusal) throw new GuardError('test_environment_refuses_live_write', refusal);
      gate = { canonical: stableStringify(expectedBody) };
      everArmed = true;
    },
    disarm() { gate = null; },
    get armed() { return !!gate; },
    // Called by the Node-side sender immediately before the POST. One-shot: the gate is consumed even on refusal.
    authorizeCreate({ method, url, body }) {
      const g = gate;
      gate = null;
      let u = null;
      try { u = new URL(url); } catch {}
      const entry = { origin: 'node', method: String(method).toUpperCase(), host: u?.hostname ?? '', path: u?.pathname ?? '', service: u?.origin === base.origin };
      const deny = (code, message) => { record({ ...entry, action: 'fail', reason: code }); blockedWrites.push({ method: entry.method, host: entry.host, path: entry.path, reason: code }); throw new GuardError(code, message); };
      if (!allowSubmit) deny('submit_disabled', 'Creating is disabled for this session.');
      const refusal = liveWriteRefusal(baseUrl, env);
      if (refusal) deny('test_environment_refuses_live_write', refusal);
      if (!g) deny('create_not_armed', 'The create gate was not armed (or was already used).');
      if (entry.method !== 'POST' || u?.origin !== base.origin || u.pathname !== WRITE_PATH) deny('create_target_mismatch', 'The create request does not target the repository endpoint.');
      if (stableStringify(body) !== g.canonical) deny('create_body_mismatch', 'The request body differs from the validated plan body.');
      createsSent++;
      record({ ...entry, action: 'continue', reason: 'create' });
    },
    setPhase(p) { phase = p; },
    get phase() { return phase; },
    stats: () => ({ createsSent, blockedResources, blockedWrites: blockedWrites.slice(), writes: writes.map((w) => ({ ...w })), everArmed }),
  };
}

// StartRight driver: a guarded headless-browser session. Reads are same-origin `fetch` calls inside the signed-in page
// (cookies never leave the browser); the single create POST is sent from Node, one-shot and journaled, never by the page.
import { pageSession } from './cdp.mjs';
import { launchBrowser } from './browser.mjs';
import { createGuard, GuardError, READ } from './guard.mjs';
import { buildPath, checkRequest, checkResponse, WRITE_PATH, STARTRIGHT_URL } from './contract.mjs';

export { STARTRIGHT_URL };
export const SPA_PATH = '/web/emu/';
const NAV_TIMEOUT_MS = 25000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();

export class SkillError extends Error {
  constructor(code, message, extra = {}) { super(message); this.code = code; Object.assign(this, extra); }
}

// Runs inside the page. Redirects are not followed: an API that redirects means the session is gone.
async function inPageFetch(url) {
  try {
    const r = await fetch(url, { credentials: 'same-origin', redirect: 'manual', headers: { accept: 'application/json' } });
    if (r.type === 'opaqueredirect') return { status: 401, redirected: true, text: '', type: '' };
    return { status: r.status, text: await r.text(), type: r.headers.get('content-type') || '', operationId: r.headers.get('x-gitops-operation-id') };
  } catch (e) { return { error: String((e && e.message) || e) }; }
}
const pageState = () => ({ url: location.href, ready: document.readyState });

const CONNECT_ERRORS = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'ENETUNREACH', 'EHOSTUNREACH', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID', 'DEPTH_ZERO_SELF_SIGNED_CERT']);

function parseJson(text) {
  if (text === '' || text === undefined) return { value: undefined };
  try { return { value: JSON.parse(text) }; } catch { return { error: true }; }
}

export async function openSession({ baseUrl = STARTRIGHT_URL, headless = true, browserPath, profileDir, allowSubmit = true, commitTimeoutMs = 120000, authTimeoutMs: defaultAuthTimeout, env = process.env, log = () => {} } = {}) {
  const base = new URL(baseUrl);
  const origin = base.origin;
  const t0 = now();
  const browser = await launchBrowser({ browserPath, headless, profileDir, log });
  if (profileDir) log(`profile: ${browser.persistent ? 'persistent' : 'throwaway (fallback)'}`);
  const cdp = browser.cdp;
  const guard = createGuard({ baseUrl, allowSubmit, env });
  const guardFailures = [];
  let mainSid = null;
  const readyTargets = new Map();
  const attachWaiters = new Map();

  async function onPaused(p, sid) {
    const { requestId, request, resourceType, networkId } = p;
    const verdict = guard.classify({ method: request.method, url: request.url, resourceType, ref: networkId ? `${sid}|${networkId}` : null });
    if (!READ.has(String(request.method).toUpperCase()) && verdict.action !== 'continue') log(`blocked ${request.method} ${request.url.split('?')[0]} (${verdict.reason})`);
    if (verdict.action === 'continue') cdp.send('Fetch.continueRequest', { requestId }, sid).catch(() => {});
    else cdp.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }, sid).catch(() => {});
  }

  async function setupTarget({ sessionId, targetInfo, waitingForDebugger }) {
    const { type, targetId, url = '' } = targetInfo;
    const s = (m, params) => cdp.send(m, params, sessionId, { timeoutMs: 5000 }).catch((e) => { log(`${m} on ${type}: ${e.message}`); });
    const web = !url || /^(https?:|about:blank)/.test(url);
    try {
      const batch = [];
      if (web && ['page', 'iframe', 'worker', 'service_worker', 'shared_worker'].includes(type)) {
        batch.push(cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }, sessionId, { timeoutMs: 10000 })
          .catch((e) => { if (!cdp.closed) { guardFailures.push({ type, url: url.slice(0, 200), error: e.message }); log(`INTERCEPTION FAILED on ${type}: ${e.message}`); } }));
        if (type === 'page' || type === 'iframe') batch.push(s('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }));
      }
      if (web && type === 'page') batch.push(s('Network.enable'), s('Page.enable'));
      if (waitingForDebugger) batch.push(s('Runtime.runIfWaitingForDebugger'));
      await Promise.all(batch);
    } finally {
      readyTargets.set(targetId, sessionId);
      attachWaiters.get(targetId)?.(sessionId);
    }
  }

  cdp.on('Target.attachedToTarget', (p) => { setupTarget(p).catch((e) => log(`attach: ${e.message}`)); });
  cdp.on('Fetch.requestPaused', (p, sid) => { onPaused(p, sid).catch((e) => log(`paused: ${e.message}`)); });
  cdp.on('Page.javascriptDialogOpening', (p, sid) => { cdp.send('Page.handleJavaScriptDialog', { accept: false }, sid).catch(() => {}); });

  // Witness: an independent record, from the Network domain rather than the guard, of every write to the service
  // origin that a page target put on the wire. `verify` requires it to be empty.
  const witness = [];
  cdp.on('Network.requestWillBeSent', (p) => {
    let u = null;
    try { u = new URL(p.request.url); } catch {}
    if (!u || u.origin !== origin || READ.has(String(p.request.method).toUpperCase())) return;
    witness.push({ method: String(p.request.method).toUpperCase(), path: u.pathname, phase: guard.phase });
  });

  try {
    await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    mainSid = readyTargets.get(targetId) ?? await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new SkillError('browser_unresponsive', 'The browser did not attach the page in time (machine overloaded?). Retry.')), 30000);
      attachWaiters.set(targetId, (sid) => { clearTimeout(t); resolve(sid); });
    });
  } catch (e) { cdp.close(); await browser.close(); throw e; }
  const page = pageSession(cdp, mainSid);
  let requester = null;
  let csrf = null;

  const session = {
    baseUrl: origin, profile: browser.persistent ? 'persistent' : 'throwaway', headless, guard, cdp, page, log,
    elapsed: () => Math.round(now() - t0),
    get requester() { return requester; },
    witness: () => witness.map((e) => ({ ...e })),
    assertGuarded() { if (guardFailures.length) throw new SkillError('guard_unavailable', 'Request interception could not be enabled on every page target; refusing to continue.', { targets: guardFailures.slice() }); },

    async goto(url) {
      const unreachable = (why) => new SkillError('startright_unreachable', `StartRight did not respond (${why}). Check the corporate network / VPN and retry; nothing was submitted.`, { url: url.split('?')[0] });
      const r = await page.send('Page.navigate', { url }, { timeoutMs: NAV_TIMEOUT_MS }).catch((e) => { throw e.code === 'cdp_timeout' ? unreachable(`no response in ${NAV_TIMEOUT_MS / 1000}s`) : e; });
      if (r.errorText) throw /^net::ERR_(CONNECTION_|NAME_|ADDRESS_|INTERNET_|TIMED_OUT|NETWORK_|PROXY_|TUNNEL_)/.test(r.errorText) ? unreachable(r.errorText) : new SkillError('navigation_failed', `${url}: ${r.errorText}`);
      return r;
    },
    async state() { try { return await page.call(pageState); } catch { return null; } },

    // Sign in (or confirm the existing sign-in) and learn who the requester is. Headless relies on the persistent
    // profile; a first sign-in or GitHub OAuth consent needs --headed. Credentials are never handled here.
    async ensureAuth({ authTimeoutMs = defaultAuthTimeout ?? (headless ? 45000 : 300000) } = {}) {
      session.assertGuarded();
      // Signed out, the app shell itself answers with an HTTP error; that only means "start the sign-in".
      await session.goto(`${origin}${SPA_PATH}`).catch((e) => { if (!(e.code === 'navigation_failed' && /ERR_HTTP_RESPONSE_CODE_FAILURE/.test(e.message))) throw e; });
      const adopt = async () => {
        const r = await session.rawGet('session');
        if (r.status !== 200) return false;
        requester = { login: r.body.login, userId: r.body.userId };
        csrf = r.body.antiForgeryToken;
        return true;
      };
      const settle = async () => { for (let i = 0; i < 40; i++) { const st = await session.state(); if (st && new URL(st.url).origin === origin && st.ready !== 'loading') return st; await sleep(50); } return null; };
      await settle();
      if (await adopt().catch(() => false)) { guard.setPhase('authenticated'); return requester; }
      log('not signed in; starting GitHub OAuth');
      await session.goto(`${origin}/api/v1/auth/github/oauth/start?returnUrl=${encodeURIComponent(`${origin}${SPA_PATH}`)}`);
      const start = now();
      let backAtApp = 0;
      let lastUrl = '';
      for (;;) {
        const st = await session.state();
        if (st) {
          let u = null;
          try { u = new URL(st.url); } catch {}
          if (st.url !== lastUrl) { lastUrl = st.url; log(`at ${u ? `${u.hostname}${u.pathname}` : st.url}`); }
          if (u && u.origin === origin && u.pathname.startsWith('/web/') && st.ready !== 'loading') {
            if (await adopt().catch(() => false)) { guard.setPhase('authenticated'); return requester; }
            if (++backAtApp >= 3) throw new SkillError('auth_required', 'StartRight did not accept the sign-in. Re-run with --headed and finish sign-in (including the GitHub authorization prompt) in the browser window.');
          }
        }
        if (now() - start > authTimeoutMs) {
          throw new SkillError('auth_required', headless ? 'Silent sign-in did not complete. Re-run with --headed and finish sign-in (SSO, and the one-time GitHub authorization of the StartRight app) in the browser window.' : 'Sign-in was not completed in time.');
        }
        await sleep(250);
      }
    },

    // One GET without status policy (used for the session probe).
    async rawGet(id, params = {}) {
      const errors = checkRequest(id, { query: params.query });
      if (errors.length) throw new SkillError('request_contract_violation', `Refusing to send ${id}: ${errors.join('; ')}`, { endpoint: id, errors });
      const r = await page.call(inPageFetch, `${origin}${buildPath(id, params)}`);
      if (r.error) throw new SkillError('startright_unreachable', `StartRight could not be reached (${r.error}). Check the network / VPN; nothing was submitted.`);
      const parsed = parseJson(r.text);
      return { status: r.status, body: parsed.error ? undefined : parsed.value, text: r.text, jsonError: !!parsed.error, operationId: r.operationId ?? null };
    },

    // A contract-checked read. Documented error statuses are returned (ok: false); anything else is drift.
    async api(id, params = {}) {
      const r = await session.rawGet(id, params);
      if (r.status === 401 && id !== 'session') throw new SkillError('session_expired', 'The StartRight session expired. Re-run the command; if it persists, re-run with --headed to sign in again.');
      if (r.jsonError) throw new SkillError('contract_violation', `${id}: the response (status ${r.status}) is not JSON`, { endpoint: id, status: r.status, errors: ['non-JSON body'] });
      const chk = checkResponse(id, r.status, r.body);
      if (!chk.ok) throw new SkillError('contract_violation', `${id}: StartRight no longer matches the recorded contract (${chk.errors.slice(0, 3).join('; ')}). The skill needs an update (references/DRIFT.md); nothing was submitted.`, { endpoint: id, status: r.status, errors: chk.errors.slice(0, 8) });
      return { status: r.status, ok: r.status >= 200 && r.status < 300, body: r.body, operationId: r.operationId };
    },

    // The one write. Armed + authorized by the guard, journaled by beforeSend (fsync) and sent from Node (fetch never
    // retries a POST, unlike the browser network stack). Returns what the service answered; never throws after send.
    async create(body, { beforeSend } = {}) {
      if (!csrf) throw new SkillError('auth_required', 'Not signed in.');
      const url = `${origin}${WRITE_PATH}`;
      const errors = checkRequest('create', { body, headers: { 'X-CSRF-TOKEN': csrf } });
      if (errors.length) throw new SkillError('request_contract_violation', `Refusing to send the create request: ${errors.join('; ')}`, { endpoint: 'create', errors });
      guard.armCreate({ expectedBody: body });
      guard.authorizeCreate({ method: 'POST', url, body });
      const { cookies } = await cdp.send('Network.getCookies', { urls: [url] }, mainSid);
      const headers = { 'content-type': 'application/json', accept: 'application/json', 'x-csrf-token': csrf, origin, referer: `${origin}${SPA_PATH}` };
      if (cookies.length) headers.cookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
      beforeSend?.();
      const started = Date.now();
      try {
        const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), redirect: 'manual', signal: AbortSignal.timeout(commitTimeoutMs) });
        const text = await res.text();
        const parsed = parseJson(text);
        return { sent: true, status: res.status, body: parsed.error ? undefined : parsed.value, text: parsed.error ? text.slice(0, 500) : undefined, operationId: res.headers.get('x-gitops-operation-id'), ms: Date.now() - started };
      } catch (e) {
        const code = e.cause?.code ?? e.code;
        log(`create failed: ${code ?? ''} ${e.message}`);
        return { sent: false, error: e.message, errorCode: code ?? null, notDelivered: CONNECT_ERRORS.has(code), ms: Date.now() - started };
      }
    },

    async close() {
      if (browser.persistent) {
        await persistSession(cdp, origin, log).catch((e) => log(`session persist skipped: ${e.message}`));
        await cdp.send('Browser.close', {}, undefined, { timeoutMs: 1500 }).catch(() => {});
      }
      try { cdp.close(); } catch {}
      await browser.close();
    },
  };
  return session;
}

// Persistent profile only: sign-in cookies are session cookies, which Chromium drops on a clean shutdown. Re-set the
// StartRight and GitHub session cookies with a bounded expiry so the browser keeps them in its own OS-encrypted
// cookie store; later runs then skip sign-in. Nothing is written outside the browser profile.
export const SESSION_TTL_S = 8 * 3600;
async function persistSession(cdp, origin, log) {
  const host = new URL(origin).hostname;
  const hosts = new Set([host, 'github.com']);
  const { cookies } = await cdp.send('Storage.getCookies', {}, undefined, { timeoutMs: 1500 });
  const expires = Math.floor(Date.now() / 1000) + SESSION_TTL_S;
  const promote = cookies.filter((c) => c.session && [...hosts].some((h) => c.domain === h || c.domain === `.${h}`)).map((c) => ({
    name: c.name, value: c.value, path: c.path, secure: c.secure, httpOnly: c.httpOnly, expires,
    ...(c.sameSite ? { sameSite: c.sameSite } : {}),
    ...(c.domain.startsWith('.') ? { domain: c.domain } : { url: `${c.secure ? 'https' : 'http'}://${c.domain}${c.domain === host && new URL(origin).port ? `:${new URL(origin).port}` : ''}${c.path}` }),
  }));
  if (promote.length) await cdp.send('Storage.setCookies', { cookies: promote }, undefined, { timeoutMs: 1500 });
  log(`persisted ${promote.length} session cookie(s) for ${SESSION_TTL_S / 3600}h`);
}

export { GuardError };

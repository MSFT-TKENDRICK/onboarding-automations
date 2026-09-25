// Portal driver: guarded CDP session + plan / submit / status flows.
import { pageSession } from './cdp.mjs';
import { launchBrowser } from './browser.mjs';
import { createGuard, isInfraName, READ } from './guard.mjs';
import { resolveSlot, fingerprint, isChoiceField, validateMap, CANON } from './resolve.mjs';
import { matchOption, matchOwner, ownerSearchTerm, normalize } from './match.mjs';
import { redactor } from './systemone.mjs';
import { INTENT_SLOTS, optionCriteria, decideIntent } from './intent.mjs';
import { DEFAULT_TYPE, highestAmount, onlyOption, defaultTitle } from './defaults.mjs';
import { planId as hashPlan, sha256, stableStringify, requestKey, acquireSubmitLock, markSent, recordOutcome, releaseUnsent } from './plan-store.mjs';
import * as P from './page.mjs';

// Slow page-load checks that do not affect form state. quiet() ignores them; finish() drains them and then
// verifies the page is still the form (the VPN check redirects to /VPNRequired/ on failure).
const BACKGROUND = /\/AzureSubscription\/CheckPortalAccess(\?|$)/i;
export const DEFAULT_FORM_URL = 'https://mcapsservices.powerappsportals.com/support/eslabs-newazuresubscription/?ServiceId=78b2e66c-42f2-e811-a96a-000d3a30da4f';
export const PLAN_SCHEMA = 2;
// Page.navigate resolves at commit; the live form commits in ~1.5 s even through the SSO redirects.
const NAV_TIMEOUT_MS = 25000;

export const F = {
  title: 'apitil_title', purpose: 'desitsm_subscriptionpurposeaz', type: 'desitsm_subscriptiontypes', owner: 'desitsm_subscriptionowner',
  ownerGuid: 'itserv_businessmanageruserid', ownerUpn: 'itserv_businessmanager', manager: 'desitsm_eslabs_projectlevel',
  managerEmail: 'desitsm_eslabs_projectlevelemailid', allowance: 'desitsm_monthlyspend', timezone: 'desitsm_timezonelist',
  tenantType: 'desitsm_tenanttypes', tenantLicensing: 'desitsm_tenantlicensing', tenantName: 'desitsm_tenantdisplayname', requester: 'apitil_contact_name',
};
// Type-dependent inputs: [input key, field id, match kind]
const DEPENDENT = [['allowance', F.allowance, 'money'], ['timezone', F.timezone, 'timezone'], ['tenantType', F.tenantType], ['tenantLicensing', F.tenantLicensing], ['tenantName', F.tenantName, 'text']];
const AUTO_FIELDS = new Set([F.requester, F.manager, F.owner]);
const KNOWN = new Set([F.title, F.purpose, F.type, F.owner, ...DEPENDENT.map((d) => d[1]), F.requester, F.manager]);
const TYPE_ALIASES = { internal: 'Internal', external: 'External' };
// Logical input (slot) -> the control id it has on the live form today. Resolved per stage (lib/resolve.mjs).
export const SLOT_ID = { title: F.title, purpose: F.purpose, type: F.type, owner: F.owner, allowance: F.allowance, timezone: F.timezone, tenantType: F.tenantType, tenantLicensing: F.tenantLicensing, tenantName: F.tenantName };
const TERMS_BOX = 'desitsm_agreetothetermsandconditions';
// Portal-populated companions: always id-bound, never a --map target or a --field.
const ID_BOUND = new Set([F.ownerGuid, F.ownerUpn, F.manager, F.managerEmail, F.requester, TERMS_BOX, `${TERMS_BOX}One`]);
// Dependents the selected type is expected to show: if one of these is gone, that is drift, not "does not apply".
export const APPLIES = { internal: ['allowance', 'timezone'], external: ['tenantType', 'tenantLicensing', 'tenantName'] };
// What each slot means, for System One questions (static text: never user or page data).
const SLOT_DESC = {
  title: 'the free-text title of the request', purpose: 'the business purpose category of the subscription', type: 'whether the subscription is internal or external',
  owner: 'the person who will own the subscription', allowance: 'the monthly spending allowance', timezone: 'the time zone of the subscription',
  tenantType: 'the kind of tenant for an external subscription', tenantLicensing: 'the licensing of the tenant for an external subscription', tenantName: 'the display name of the new tenant',
};
// System One ranking of drift candidates: at most this many controls per question; a leader is only suggested at
// this confidence and margin (it is still never applied without the user's --map).
const RANK_MAX = 20;
const SUGGEST_P = 0.85;
const SUGGEST_MARGIN = 0.3;
const round3 = (p) => Math.round(p * 1000) / 1000;
const crlf = (v) => String(v).replace(/\r?\n|\r/g, '\r\n');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();

export class SkillError extends Error {
  constructor(code, message, extra = {}) { super(message); this.code = code; Object.assign(this, extra); }
}

// ---------------------------------------------------------------- session
// allowSubmit false (verify): the guard can never arm the submit gate, so no form POST can ever be sent.
export async function openSession({ formUrl = DEFAULT_FORM_URL, headless = true, browserPath, profileDir, blockResources = true, commitTimeoutMs = 120000, traceNet = false, allowSubmit = true, log = () => {} } = {}) {
  const t0 = now();
  const marks = {};
  const mark = (k) => { marks[k] = Math.round(now() - t0); log(`mark ${k} ${marks[k]}ms`); };
  const browser = await launchBrowser({ browserPath, headless, profileDir, log });
  if (profileDir) log(`profile: ${browser.persistent ? 'persistent' : 'throwaway (fallback)'}`);
  mark('browserLaunched');
  const cdp = browser.cdp;
  const guard = createGuard({ formUrl, blockResources, allowSubmit });
  const hooks = { onSubmit: null };
  const dialogs = [];
  const submitEvents = [];
  const guardFailures = [];
  const inflight = new Map();
  let lastActivity = now();
  let mainSid = null;
  let mainTarget = null;
  const readyTargets = new Map();
  const attachWaiters = new Map();

  const decodeEntries = (entries) => entries?.length ? entries.map((e) => (e.bytes ? Buffer.from(e.bytes, 'base64').toString('utf8') : '')).join('') : undefined;
  const entriesBytes = (entries) => entries?.length ? Buffer.concat(entries.map((e) => (e.bytes ? Buffer.from(e.bytes, 'base64') : Buffer.alloc(0)))) : undefined;
  const HOP = new Set(['host', 'content-length', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'expect', 'te', 'trailer', 'cookie', 'accept-encoding']);
  const CONNECT_ERRORS = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'ENETUNREACH', 'EHOSTUNREACH', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID', 'DEPTH_ZERO_SELF_SIGNED_CERT']);

  // Exactly-once commit. Chromium's network stack transparently re-sends a POST when a reused keep-alive
  // connection is reset before the response starts (below the Fetch interception layer), which would
  // create duplicate requests. So the single submit POST is sent from Node (fetch never retries POSTs)
  // with the browser's cookies, and the browser is fulfilled with the real response.
  async function commit(requestId, request, body, sid) {
    const ev = { at: Date.now(), url: request.url };
    submitEvents.push(ev);
    try {
      const { cookies } = await cdp.send('Network.getCookies', { urls: [request.url] }, mainSid);
      const headers = Object.fromEntries(Object.entries(request.headers ?? {}).filter(([k]) => !HOP.has(k.toLowerCase())));
      if (cookies.length) headers.cookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
      const res = await fetch(request.url, { method: 'POST', headers, body, redirect: 'manual', signal: AbortSignal.timeout(commitTimeoutMs) });
      const buf = Buffer.from(await res.arrayBuffer());
      Object.assign(ev, { status: res.status, location: res.headers.get('location') ?? null, ms: Date.now() - ev.at });
      const responseHeaders = [];
      res.headers.forEach((value, name) => { if (!['set-cookie', 'content-encoding', 'content-length', 'transfer-encoding'].includes(name)) responseHeaders.push({ name, value }); });
      for (const c of res.headers.getSetCookie?.() ?? []) responseHeaders.push({ name: 'set-cookie', value: c });
      await cdp.send('Fetch.fulfillRequest', { requestId, responseCode: res.status, responseHeaders, body: buf.toString('base64') }, sid);
    } catch (e) {
      const code = e.cause?.code ?? e.code;
      Object.assign(ev, { error: e.message, errorCode: code ?? null, notDelivered: CONNECT_ERRORS.has(code), ms: Date.now() - ev.at });
      log(`commit failed: ${code ?? ''} ${e.message}`);
      cdp.send('Fetch.failRequest', { requestId, errorReason: 'Failed' }, sid).catch(() => {});
    }
  }

  async function onPaused(p, sid) {
    const { requestId, request, resourceType, frameId, networkId } = p;
    let postData = request.postData ?? decodeEntries(request.postDataEntries);
    let body = entriesBytes(request.postDataEntries);
    const write = !['GET', 'HEAD', 'OPTIONS'].includes(request.method);
    if (write && postData === undefined && request.hasPostData && networkId) {
      try { postData = (await cdp.send('Network.getRequestPostData', { requestId: networkId }, sid)).postData; } catch {}
    }
    if (body === undefined && typeof postData === 'string') body = Buffer.from(postData, 'utf8');
    const isMainFrame = sid === mainSid && frameId === mainTarget;
    const contentType = Object.entries(request.headers ?? {}).find(([k]) => k.toLowerCase() === 'content-type')?.[1];
    const verdict = guard.classify({ method: request.method, url: request.url, resourceType, postData, contentType, isMainFrame, ref: networkId ? `${sid}|${networkId}` : null });
    if (verdict.action === 'continue' && verdict.reason === 'submit') {
      try { hooks.onSubmit?.(); } catch (e) {
        submitEvents.push({ at: Date.now(), error: `journal write failed: ${e.message}`, notDelivered: true });
        return cdp.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }, sid).catch(() => {});
      }
      return commit(requestId, request, body, sid);
    }
    if (write && verdict.action !== 'continue') log(`blocked ${request.method} ${request.url} (${verdict.reason})`);
    if (verdict.action === 'continue') cdp.send('Fetch.continueRequest', { requestId }, sid).catch(() => {});
    else cdp.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }, sid).catch(() => {});
  }

  async function setupTarget({ sessionId, targetInfo, waitingForDebugger }) {
    const { type, targetId, url = '' } = targetInfo;
    const s = (m, params) => cdp.send(m, params, sessionId, { timeoutMs: 5000 }).catch((e) => { log(`${m} on ${type}: ${e.message}`); });
    // Browser-internal targets (edge://, extensions) can't touch the portal; resume them untouched.
    const web = !url || /^(https?:|about:blank)/.test(url);
    if (type !== 'page' && type !== 'iframe') log(`attached ${type} ${url.slice(0, 120)}${web ? '' : ' (not intercepted)'}`);
    try {
      // Pipelined like Playwright: all setup commands are queued in order, then the target is resumed in the
      // same batch. CDP dispatches per-session in order, so interception is active before any request.
      const batch = [];
      if (web && ['page', 'iframe', 'worker', 'service_worker', 'shared_worker'].includes(type)) {
        batch.push(cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }, sessionId, { timeoutMs: 10000 })
          .catch((e) => { if (!cdp.closed) { guardFailures.push({ type, url: url.slice(0, 200), error: e.message }); log(`INTERCEPTION FAILED on ${type}: ${e.message}`); } }));
        if (type === 'page' || type === 'iframe') batch.push(s('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }));
      }
      if (web && type === 'page') batch.push(s('Network.enable', { maxPostDataSize: 1 << 20 }), s('Page.enable'), s('Page.addScriptToEvaluateOnNewDocument', { source: `(${P.installRecorder})()` }));
      if (waitingForDebugger) batch.push(s('Runtime.runIfWaitingForDebugger'));
      await Promise.all(batch);
    } finally {
      readyTargets.set(targetId, sessionId);
      attachWaiters.get(targetId)?.(sessionId);
    }
  }

  cdp.on('Target.attachedToTarget', (p) => { setupTarget(p).catch((e) => log(`attach: ${e.message}`)); });
  cdp.on('Fetch.requestPaused', (p, sid) => { onPaused(p, sid).catch((e) => log(`paused: ${e.message}`)); });
  // Only request types that can change form state count toward "busy"; favicon/beacon/image loads are ignored
  // (Chromium never emits loadingFinished for favicon fetches, which previously stalled idle detection ~20 s).
  const TRACKED = new Set(['Document', 'XHR', 'Fetch', 'Script']);
  cdp.on('Network.requestWillBeSent', (p, sid) => {
    if (sid !== mainSid || !TRACKED.has(p.type)) return;
    if (p.type === 'Document') for (const [id, a] of inflight) if (a.background) inflight.delete(id);
    const background = BACKGROUND.test(p.request.url);
    inflight.set(p.requestId, { t: now(), url: p.request.url, type: p.type, background });
    if (!background) lastActivity = now();
  });
  const done = (p, sid) => {
    if (sid !== mainSid) return;
    const a = inflight.get(p.requestId);
    if (a && traceNet) log(`net ${Math.round(now() - a.t)}ms ${a.type} ${a.url.split('?')[0]}${p.errorText ? ` (${p.errorText})` : ''}`);
    if (a && inflight.delete(p.requestId) && !a.background) lastActivity = now();
  };
  cdp.on('Network.loadingFinished', done);
  cdp.on('Network.loadingFailed', done);
  // Witness (verify): an independent record, from the Network domain rather than the guard, of every portal write a
  // page target put on the wire and whether the network answered it or the client blocked it. Keyed like the guard's
  // ref (session|requestId); a redirect answers the previous hop.
  const witness = [];
  const witnessBy = new Map();
  const portalOrigin = new URL(formUrl).origin;
  cdp.on('Network.requestWillBeSent', (p, sid) => {
    const key = `${sid}|${p.requestId}`;
    if (p.redirectResponse && witnessBy.has(key)) Object.assign(witnessBy.get(key), { responded: true, status: p.redirectResponse.status });
    let u = null;
    try { u = new URL(p.request.url); } catch {}
    if (!u || u.origin !== portalOrigin || READ.has(String(p.request.method).toUpperCase())) { witnessBy.delete(key); return; }
    const e = { ref: key, method: String(p.request.method).toUpperCase(), path: u.pathname, type: p.type ?? null, phase: guard.phase, responded: false, blocked: false };
    witness.push(e);
    witnessBy.set(key, e);
  });
  cdp.on('Network.responseReceived', (p, sid) => { const e = witnessBy.get(`${sid}|${p.requestId}`); if (e) Object.assign(e, { responded: true, status: p.response?.status ?? null }); });
  cdp.on('Network.loadingFailed', (p, sid) => { const e = witnessBy.get(`${sid}|${p.requestId}`); if (e && (p.blockedReason || /BLOCKED_BY_CLIENT/.test(p.errorText ?? ''))) e.blocked = true; });
  cdp.on('Page.javascriptDialogOpening', (p, sid) => {
    dialogs.push({ type: p.type, message: String(p.message).slice(0, 1000) });
    cdp.send('Page.handleJavaScriptDialog', { accept: p.type === 'alert' || p.type === 'beforeunload' }, sid).catch(() => {});
  });

  try {
    await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    mainTarget = targetId;
    mainSid = readyTargets.get(targetId) ?? await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new SkillError('browser_unresponsive', 'The browser did not attach the page in time (machine overloaded?). Retry.')), 30000);
      attachWaiters.set(targetId, (sid) => { clearTimeout(t); resolve(sid); });
    });
  } catch (e) { cdp.close(); await browser.close(); throw e; }
  mark('pageReady');
  const page = pageSession(cdp, mainSid);

  const session = {
    profile: browser.persistent ? 'persistent' : 'throwaway',
    formUrl, origin: new URL(formUrl).origin, page, cdp, guard, hooks, dialogs, submitEvents, marks, mark, log, headless,
    elapsed: () => Math.round(now() - t0),
    witness: () => witness.map((e) => ({ ...e })),
    inflight: () => [...inflight.values()].map((a) => ({ ...a, age: Math.round(now() - a.t) })),
    // Fail closed: never keep operating if any web target runs without request interception.
    assertGuarded() { if (guardFailures.length) throw new SkillError('guard_unavailable', 'Request interception could not be enabled on every page target; refusing to continue.', { targets: guardFailures.slice() }); },
    async goto(url) {
      const unreachable = (why) => new SkillError('portal_unreachable', `The portal did not respond (${why}). Check the corporate network / VPN (Global Secure Access) and retry; nothing was submitted.`, { url: url.split('?')[0] });
      const r = await page.send('Page.navigate', { url }, { timeoutMs: NAV_TIMEOUT_MS }).catch((e) => { throw e.code === 'cdp_timeout' ? unreachable(`no response in ${NAV_TIMEOUT_MS / 1000}s`) : e; });
      if (r.errorText) throw /^net::ERR_(CONNECTION_|NAME_|ADDRESS_|INTERNET_|TIMED_OUT|NETWORK_|PROXY_|TUNNEL_)/.test(r.errorText) ? unreachable(r.errorText) : new SkillError('navigation_failed', `${url}: ${r.errorText}`);
      return r;
    },
    async state() { try { return await page.call(P.pageState); } catch { return null; } },
    // Network-idle (main page, CDP in-flight tracking) + portal overlay hidden.
    async quiet({ quietMs = 350, timeoutMs = 30000, stuckMs = 20000 } = {}) {
      const start = now();
      for (;;) {
        const t = now();
        const active = [...inflight.values()].filter((s) => !s.background && t - s.t < stuckMs);
        for (const a of active) if (!a.warned && t - a.t > 3000) { a.warned = true; log(`slow request (>3s): ${a.type} ${a.url.split(/[?#]/)[0]}`); }
        if (active.length === 0 && t - lastActivity >= quietMs) {
          const st = await session.state();
          if (st && !st.overlay) return { ms: Math.round(now() - start) };
          lastActivity = now();
        }
        if (t - start > timeoutMs) { log(`quiet timeout; in flight: ${active.map((a) => `${a.type} ${a.url.split(/[?#]/)[0]}`).join(', ')}`); return { ms: Math.round(t - start), timedOut: true, active: active.length }; }
        await sleep(20);
      }
    },
    // Wait for background requests (quiet() ignores them so filling overlaps their latency).
    async drainBackground({ timeoutMs = 30000 } = {}) {
      const start = now();
      for (;;) {
        const pending = [...inflight.values()].filter((a) => a.background);
        if (!pending.length) return { ms: Math.round(now() - start) };
        if (now() - start > timeoutMs) { log(`background still pending: ${pending.map((a) => a.url.split(/[?#]/)[0]).join(', ')}`); return { ms: Math.round(now() - start), timedOut: true, pending: pending.map((a) => a.url.split(/[?#]/)[0]) }; }
        await sleep(25);
      }
    },
    async close() {
      const t = now();
      if (browser.persistent) {
        await persistPortalSession(cdp, formUrl, log).catch((e) => log(`session persist skipped: ${e.message}`));
        await cdp.send('Browser.close', {}, undefined, { timeoutMs: 1500 }).catch(() => {});
      }
      try { cdp.close(); } catch {}
      await browser.close();
      if (browser.persistent) log(`profile released (${Math.round(now() - t)}ms)`);
    },
  };
  return session;
}

// The form is usable once portal init has replaced the server-rendered purposes with the allowed ones.
const formUsable = (st) => st.hasForm && !st.overlay && st.purposeOptions > 0 && !st.purposeLoading && st.purposeInit !== false;

// Persistent profile only: the portal's sign-in cookies are session cookies, which Chromium drops on a clean
// shutdown. Re-set the portal host's session cookies with a bounded expiry so the browser persists them in its
// own (OS-encrypted) cookie store; later runs then skip the SSO round trips. The server still enforces its own
// session lifetime, and nothing is written outside the browser profile.
export const SESSION_TTL_S = 8 * 3600;
async function persistPortalSession(cdp, formUrl, log) {
  const origin = new URL(formUrl);
  const host = origin.hostname;
  const { cookies } = await cdp.send('Storage.getCookies', {}, undefined, { timeoutMs: 1500 });
  const expires = Math.floor(Date.now() / 1000) + SESSION_TTL_S;
  const promote = cookies.filter((c) => c.session && (c.domain === host || c.domain === `.${host}`)).map((c) => ({
    name: c.name, value: c.value, path: c.path, secure: c.secure, httpOnly: c.httpOnly, expires,
    ...(c.sameSite ? { sameSite: c.sameSite } : {}),
    ...(c.domain.startsWith('.') ? { domain: c.domain } : { url: `${origin.protocol}//${host}${origin.port ? `:${origin.port}` : ''}${c.path}` }),
  }));
  if (promote.length) await cdp.send('Storage.setCookies', { cookies: promote }, undefined, { timeoutMs: 1500 });
  log(`persisted ${promote.length} portal session cookie(s) for ${SESSION_TTL_S / 3600}h`);
}

// Portal pages that end the flow (VPN check failed, non-Microsoft account).
function throwIfTerminalPage(st) {
  const path = (() => { try { return new URL(st.url).pathname; } catch { return ''; } })();
  if (/^\/VPNRequired\/?$/i.test(path)) throw new SkillError('vpn_required', 'The portal requires the corporate network: connect to VPN (or MSFT-AzVPN) and retry.', { url: path });
  if (/^\/NonMSUser\/?$/i.test(path)) throw new SkillError('non_microsoft_account', 'The portal rejected the signed-in account (not a Microsoft corporate account).', { url: path });
}

// Navigate to the form, completing SSO when needed. Headless: silent SSO only (Windows PRT / cookies).
export async function openForm(s, { authTimeoutMs = s.headless ? 45000 : 300000, readyTimeoutMs = 90000 } = {}) {
  await s.goto(s.formUrl);
  const start = now();
  let clicked = 0;
  let lastUrl = '';
  let lastSig = '';
  let sawLoading = false;
  let onIdpSince = 0;
  for (;;) {
    const st = await s.state();
    if (st) {
      const sig = `${st.url.split('?')[0]} hasForm=${st.hasForm} overlay=${st.overlay} purposes=${st.purposeOptions} init=${st.purposeInit} loading=${st.purposeLoading}`;
      if (sig !== lastSig) { lastSig = sig; lastUrl = st.url; s.log(`at ${sig}`); }
      const host = (() => { try { return new URL(st.url).hostname; } catch { return ''; } })();
      if (formUsable(st)) break;
      throwIfTerminalPage(st);
      if (st.purposeLoading) sawLoading = true;
      // Live: strip -> (later) loading class -> billing XHR -> class removed + allowed purposes appended.
      if (sawLoading && st.hasForm && st.purposeInit === true && !st.purposeLoading && st.purposeOptions === 0) {
        await sleep(400);
        const again = await s.state();
        if (again && again.purposeOptions === 0 && !again.purposeLoading) {
          const modals = await s.page.call(P.takeModals).catch(() => []);
          throw new SkillError('no_eligible_purpose', 'The portal offers no subscription purpose for your organization (no billing offer is configured for your leadership chain).', { portal: modals.map((m) => ({ title: m.title, message: m.body.slice(0, 500) })) });
        }
      }
      if (st.signIn && clicked < 2 && st.readyState !== 'loading') { if (await s.page.call(P.clickSignIn).catch(() => false)) { clicked++; s.mark('signInClicked'); await sleep(300); continue; } }
      if (/login\.(microsoftonline|windows|live)\.com$/.test(host)) {
        onIdpSince ||= now();
        if (now() - onIdpSince > authTimeoutMs) {
          throw new SkillError('auth_required', s.headless ? 'Silent sign-in did not complete. Re-run with --headed and finish sign-in in the browser window.' : 'Sign-in was not completed in time.', { url: `${host}` });
        }
      } else onIdpSince = 0;
    }
    if (now() - start > readyTimeoutMs + (clicked ? authTimeoutMs : 0)) throw new SkillError('portal_timeout', `Form did not become ready (last url: ${lastUrl.split('?')[0]})`, { state: st && { url: st.url.split('?')[0], hasForm: st.hasForm, overlay: st.overlay, purposeOptions: st.purposeOptions, purposeInit: st.purposeInit, purposeLoading: st.purposeLoading, text: st.bodyText?.slice(0, 300) } });
    await sleep(60);
  }
  s.mark('formReady');
  await s.quiet();
  s.assertGuarded();
  s.mark('formQuiet');
}

// ---------------------------------------------------------------- fill (shared by plan and submit)
const byId = (fields) => Object.fromEntries(fields.map((f) => [f.id, f]));
const optionsOf = (f) => (f?.options ?? []).filter((o) => o.value !== '').map((o) => o.label);

function classifyModals(modals, out) {
  for (const m of modals) {
    if (m.id === 'myAgreeTermsModalPopup' || /terms and conditions/i.test(m.title)) continue;
    const entry = { title: m.title, message: m.body.slice(0, 800) };
    if (/^(note|info|information)$/i.test(m.title)) out.warnings.push({ code: 'portal_note', ...entry });
    else out.blockers.push({ code: /active service request/i.test(m.body) ? 'active_request' : /maximum|limit/i.test(m.body) ? 'limit_reached' : 'portal_alert', ...entry });
  }
}

export function normalizeInput(raw = {}) {
  const pick = (...keys) => { for (const k of keys) if (raw[k] !== undefined && raw[k] !== null && String(raw[k]).trim() !== '') return String(raw[k]).trim(); return undefined; };
  return {
    title: pick('title'), purpose: pick('purpose'), type: pick('type', 'subscriptionType'), owner: pick('owner', 'subscriptionOwner'),
    allowance: pick('allowance', 'monthlyAllowance', 'monthly'), timezone: pick('timezone', 'timeZone', 'tz'),
    tenantType: pick('tenantType'), tenantLicensing: pick('tenantLicensing', 'licensing'), tenantName: pick('tenantName', 'tenantDisplayName'),
    fields: raw.fields && typeof raw.fields === 'object' ? Object.fromEntries(Object.entries(raw.fields).map(([k, v]) => [k, String(v)])) : {},
    map: validMap(raw.map),
  };
}

// --map slot=id: part of the effective input (hashed into the plan, replayed at submit).
function validMap(map) {
  const m = validateMap(map, { expected: SLOT_ID, reserved: ID_BOUND });
  if (!m.ok) throw new SkillError('invalid_mapping', `Invalid --map: ${m.errors.join('; ')}`, { errors: m.errors });
  return m.map;
}

export async function fill(s, input, opts) {
  try { return await fillForm(s, input, opts); } catch (e) {
    if (!['vpn_required', 'non_microsoft_account', 'guard_unavailable'].includes(e.code)) {
      await sleep(300);
      const st = await s.state();
      if (st) throwIfTerminalPage(st);
    }
    throw e;
  }
}

// systemOne: an optional System One client (plan only; submit never passes one). It ranks drift candidates and may
// resolve a user's own wording to one live option for INTENT_SLOTS; it never selects a field.
async function fillForm(s, input, { discover = false, defaults = true, timeZone = null, systemOne = null } = {}) {
  const t0 = now();
  const timings = {};
  const lap = (k) => { timings[k] = Math.round(now() - t0); s.log(`fill ${k} ${timings[k]}ms`); };
  const out = { resolved: {}, derived: {}, defaulted: [], inferred: [], missing: [], errors: [], blockers: [], warnings: [], options: {}, eligibility: null, validation: null };
  // How each slot was bound (or why not), for verify. Not enumerable: never part of plan output.
  const bindings = {};
  Object.defineProperty(out, 'bindings', { value: bindings, enumerable: false });
  // The effective input: what the user gave plus every applied default, made explicit so submit replays it exactly.
  const eff = { ...input, fields: { ...(input.fields ?? {}) }, map: { ...(input.map ?? {}) } };
  const call = (fn, ...a) => s.page.call(fn, ...a);
  const drainModals = async () => { classifyModals(await call(P.takeModals), out); await call(P.hideModals); };
  let fields = byId(await call(P.snapshotFields));
  // Page_Validators of the current snapshot, read only when a slot failed deterministic resolution.
  let validators = null;
  const refresh = async () => { fields = byId(await call(P.snapshotFields)); validators = null; };
  // Resolution state: slot -> {id, name, fp} of the control it was bound to; ids no other slot may take.
  const fieldMap = {};
  const claimed = new Set();
  const unresolved = [];
  const drifts = [];
  // Never a legal candidate for `key`: other slots' own controls, id-bound companions, other explicit targets.
  const reservedFor = (key) => new Set([
    ...Object.entries(SLOT_ID).filter(([k]) => k !== key).map(([, id]) => id), ...ID_BOUND, F.requester, F.manager,
    ...Object.entries(input.map ?? {}).filter(([k]) => k !== key).map(([, id]) => id), ...Object.keys(input.fields ?? {}),
  ]);
  // Everything that could identify a person or the request: masked in every System One payload. The signed-in user
  // is read up front: purpose is chosen before the owner defaults to them.
  const me = systemOne ? await s.state() : null;
  const redact = () => {
    const vals = [input.title, input.owner, input.tenantName, eff.title, eff.owner, me?.userEmail, ...Object.values(input.fields ?? {}),
      out.resolved.owner?.upn, out.resolved.owner?.display, ...[F.requester, F.owner, F.manager, F.managerEmail, F.ownerUpn].map((id) => fields[id]?.value)]
      .filter((v) => typeof v === 'string' && v.trim());
    return redactor([...vals, ...vals.filter((v) => v.includes('@')).map((v) => v.split('@')[0])]);
  };
  const driftMessage = (key, sug) => `The ${key} control changed on the portal.${sug ? ` Likely ${sug.id} ("${sug.label}"): confirm with the user, then rerun with --map ${key}=${sug.id}.` : ' Ask the user which field it is and rerun with --map.'}`;

  // Bind a slot against the current snapshot. Returns the id, undefined when the slot is not shown, or null when
  // the failure was already reported (field_drift/field_absent in missing, invalid_mapping in errors, form_drift for owner).
  const bind = async (key, { optional = false, applicable = false } = {}) => {
    const opts = { claimed, mapped: input.map?.[key], optional, applicable, given: input[key] !== undefined, reserved: reservedFor(key) };
    let r = resolveSlot(key, SLOT_ID[key], Object.values(fields), opts);
    // Proofs need the page's validators: read them (read-only) only when a legal candidate could be proven.
    if (!r.ok && r.code === 'field_drift' && r.pool?.length && key !== 'owner') {
      validators ??= await call(P.validatorIndex);
      r = resolveSlot(key, SLOT_ID[key], Object.values(fields), { ...opts, validators });
    }
    bindings[key] = r.ok ? { ok: true, tier: r.via, id: r.id } : { ok: false, tier: r.code, id: r.id ?? null };
    if (r.ok) {
      fieldMap[key] = { id: r.id, name: r.field.name, fp: fingerprint(r.field), ...(r.via === 'validator' ? { proof: sha256(stableStringify({ id: r.id, message: r.evidence.message })) } : {}) };
      claimed.add(r.id);
      if (r.via !== 'id') out.warnings.push({ code: 'field_remapped', field: key, expectedId: SLOT_ID[key], id: r.id, label: r.field.label, via: r.via, ...(r.via === 'validator' ? { evidence: { message: r.evidence.message.slice(0, 300) } } : {}) });
      return r.id;
    }
    if (r.code === 'not_shown' || (r.code === 'invalid_mapping' && r.reason === 'hidden' && optional && !applicable)) return undefined;
    unresolved.push(r);
    if (r.code === 'invalid_mapping') out.errors.push({ code: 'invalid_mapping', field: key, id: r.id, reason: r.reason, message: `--map ${key}=${r.id} cannot be used (${r.reason}).` });
    else if (key === 'owner') out.blockers.push({ code: 'form_drift', field: 'owner', expectedId: r.expectedId, message: 'The subscription owner control changed on the portal; the driver will not guess it. Update the skill.' });
    else if (r.code === 'field_absent') out.missing.push({ field: key, code: 'field_absent', expectedId: r.expectedId, message: `The ${key} control is no longer on the portal form and nothing like it remains. Tell the user; the skill needs an update.` });
    else {
      const entry = { field: key, code: 'field_drift', expectedId: r.expectedId, ...(r.label !== undefined ? { label: r.label } : {}), ...(r.suggested ? { suggested: r.suggested } : {}), candidates: r.candidates, message: driftMessage(key, r.suggested) };
      out.missing.push(entry);
      if (systemOne && r.pool?.length) drifts.push({ key, entry, pool: r.pool.map((id) => fields[id]).filter(Boolean) });
    }
    return null;
  };

  // Probabilities rank: reorder a drift entry's candidates by System One. Never binds, never changes the status.
  const rankDrift = async ({ key, entry, pool }) => {
    const mask = redact();
    const shown = pool.slice(0, RANK_MAX);
    const truncated = pool.length > shown.length;
    const criteria = {};
    const keyToField = {};
    shown.forEach((f, i) => {
      const opts = isChoiceField(f) ? (f.options ?? []).filter((o) => o.value !== '' && o.value != null).slice(0, 30).map((o) => mask(o.label).slice(0, 80)) : [];
      criteria[`c${i + 1}`] = `Control labelled "${mask(f.label || '(no label)').slice(0, 120)}" (${isChoiceField(f) ? 'choice' : 'text'})${opts.length ? `; options: ${opts.join(' | ')}` : ''}`;
      keyToField[`c${i + 1}`] = f;
    });
    criteria.none = truncated ? `None of these controls is the "${CANON[key]}" field.` : `No control on this form is the "${CANON[key]}" field.`;
    const ans = await systemOne.choose(`field_${key}`, { form: 'Azure subscription request form', field: SLOT_DESC[key] }, `Which form control is the "${CANON[key]}" field (${SLOT_DESC[key]})?`, criteria);
    if (!ans.ok) { s.log(`systemone field_${key}: ${ans.error}${ans.why ? ` (${ans.why})` : ''}`); return; }
    const score = new Map(entry.candidates.map((c) => [c.id, c.score]));
    const ranked = Object.entries(ans.probabilities).filter(([k]) => k !== 'none').map(([k, p]) => ({ f: keyToField[k], p }));
    entry.candidates = ranked.slice(0, 5).map(({ f, p }) => ({ id: f.id, label: f.label, score: score.get(f.id) ?? 0, p: round3(p) }));
    entry.rankedBy = 'systemone';
    entry.pNone = round3(ans.probabilities.none);
    if (truncated) entry.truncated = { shown: shown.length, total: pool.length };
    if (ans.choice !== 'none' && ans.p >= SUGGEST_P && ans.margin >= SUGGEST_MARGIN && !truncated) {
      const f = keyToField[ans.choice];
      entry.suggested = { id: f.id, label: f.label, evidence: [...(entry.suggested?.id === f.id ? entry.suggested.evidence : []), 'systemone'], p: round3(ans.p) };
      entry.message = driftMessage(key, entry.suggested);
    }
  };

  // A user's own wording for an allowlisted choice slot that matched no single option: ask System One which live
  // option it means. Commits only a confident, exact option (reported in `inferred` for the user to confirm).
  const inferOption = async (key, f, wanted, m) => {
    const mask = redact();
    const options = (f.options ?? []).filter((o) => o.value !== '' && o.value != null);
    const { criteria, keyToValue } = optionCriteria(options, mask);
    const ans = await systemOne.choose(`option_${key}`, { field: SLOT_DESC[key], request: mask(wanted) }, `Which option of the "${CANON[key]}" field does the request mean? Answer none unless one option clearly matches.`, criteria);
    if (!ans.ok) { s.log(`systemone option_${key}: ${ans.error}${ans.why ? ` (${ans.why})` : ''}`); return null; }
    const byValue = new Map(options.map((o) => [o.value, o]));
    const allowed = m.error === 'ambiguous' ? new Set(m.candidates) : null;
    const ranked = Object.keys(ans.probabilities).filter((k) => k !== 'none').map((k) => byValue.get(keyToValue[k])?.label).filter((l) => l !== undefined && (!allowed || allowed.has(l))).slice(0, 12);
    const d = decideIntent(ans, keyToValue);
    const o = d.commit ? byValue.get(d.value) : null;
    // The committed option must be unambiguous by label, and for an ambiguous match one of the matched options.
    if (o && options.filter((x) => normalize(x.label) === normalize(o.label)).length === 1 && (!allowed || allowed.has(o.label))) return { commit: true, value: o.value, label: o.label, p: round3(d.p) };
    s.log(`systemone option_${key}: not committed (${d.reason ?? 'identity'})`);
    return { commit: false, ranked };
  };

  const defaultFor = (key, f) => {
    if (!defaults) return null;
    if (key === 'type') {
      // Tenant values only apply to External subscriptions: defaulting to Internal would silently drop them.
      if (['tenantType', 'tenantLicensing', 'tenantName'].some((k) => input[k] !== undefined)) return null;
      return { value: DEFAULT_TYPE, reason: 'Internal subscription unless the user asks for external' };
    }
    if (key === 'allowance') { const o = isChoiceField(f) && highestAmount(f.options); return o ? { value: o.value, reason: 'Highest monthly allowance offered' } : null; }
    if (key === 'timezone') return timeZone ? { value: timeZone, reason: `This computer's time zone (${timeZone})` } : null;
    if (key === 'title') { const t = defaultTitle(out.resolved.owner?.upn); return t ? { value: t, reason: "Owner alias and today's date" } : null; }
    if (['purpose', 'tenantType', 'tenantLicensing'].includes(key) && isChoiceField(f)) { const o = onlyOption(f.options); return o ? { value: o.value, reason: 'The only option offered' } : null; }
    return null;
  };
  const missingEntry = (key, id, f) => ({ field: key, id, label: f.label, ...(isChoiceField(f) ? { options: optionsOf(f) } : {}) });

  const choose = async (key, id, kind, given = input[key]) => {
    const f = fields[id];
    if (!f || !f.visible) {
      if (given !== undefined) out.errors.push({ code: 'field_unavailable', field: key, id, message: `${key} is not shown on the form for the current selections.` });
      return false;
    }
    const choice = isChoiceField(f);
    if (choice) out.options[key] = optionsOf(f);
    const dflt = given === undefined ? defaultFor(key, f) : null;
    const wanted = given ?? dflt?.value;
    if (wanted === undefined) { out.missing.push(missingEntry(key, id, f)); return false; }
    let value = wanted;
    let label = wanted;
    let inf = null;
    if (choice) {
      const m = matchOption(f.options, key === 'type' ? (TYPE_ALIASES[normalize(wanted)] ?? wanted) : wanted, { kind });
      // A default that does not map to exactly one option is simply not applied: ask the user instead.
      if (!m.ok && dflt) { out.missing.push(missingEntry(key, id, f)); return false; }
      if (!m.ok && systemOne && INTENT_SLOTS.has(key) && (m.error === 'no_match' || m.error === 'ambiguous')) inf = await inferOption(key, f, wanted, m);
      if (!m.ok && !inf?.commit) { out.errors.push({ code: m.error === 'ambiguous' ? 'ambiguous_option' : 'invalid_option', field: key, id, wanted, candidates: inf?.ranked ?? m.candidates, ...(inf?.ranked ? { rankedBy: 'systemone' } : {}) }); return false; }
      ({ value, label } = m.ok ? m : inf);
    } else if (f.type !== 'text' && f.tag !== 'textarea') {
      out.errors.push({ code: 'unsupported_field', field: key, id, type: f.type }); return false;
    }
    const r = await call(P.setField, id, value);
    if (!r.ok) { out.errors.push({ code: 'set_failed', field: key, id, wanted, detail: r.error ?? `value became ${JSON.stringify(r.value)}` }); return false; }
    out.resolved[key] = choice ? { value, label, ...(inf?.commit ? { matchedBy: 'systemone', confidence: inf.p } : {}) } : { value };
    if (dflt) { eff[key] = value; out.defaulted.push({ field: key, value: label, reason: dflt.reason }); }
    // The exact option replaces the user's wording in the effective input (submit replays it with no model); the
    // provenance is part of the plan identity.
    if (inf?.commit) { eff[key] = value; eff.inferred = { ...(eff.inferred ?? {}), [key]: { wanted, value } }; out.inferred.push({ field: key, wanted, value, label, confidence: inf.p }); }
    return true;
  };

  // 1) purpose (drives visibility of everything else)
  const purposeId = await bind('purpose');
  if (purposeId === null || !(await choose('purpose', purposeId ?? F.purpose))) {
    if (!defaults) for (const k of ['title', 'type', 'owner']) if (input[k] === undefined) out.missing.push({ field: k });
    return finish();
  }
  await s.quiet(); lap('purpose');
  await drainModals();
  await refresh();

  // 2) owner BEFORE type: the portal only runs owner eligibility on type change. Default: the signed-in user.
  // Owner is never healed or remapped (its hidden companions are id-bound): only the expected id is accepted.
  let ownerWanted = input.owner;
  const ownerDefault = ownerWanted === undefined && defaults ? (await s.state())?.userEmail ?? null : null;
  if (ownerDefault) ownerWanted = ownerDefault;
  const ownerErrors = out.errors.length;
  const ownerId = await bind('owner');
  if (ownerId === null) { /* form_drift blocker already reported */ }
  else if (ownerWanted === undefined) out.missing.push({ field: 'owner', id: F.owner, label: fields[F.owner]?.label });
  else if (!fields[F.owner]?.visible) out.errors.push({ code: 'field_unavailable', field: 'owner', id: F.owner });
  else {
    let term;
    try { term = ownerSearchTerm(ownerWanted); } catch (e) { out.errors.push({ code: 'invalid_owner', field: 'owner', message: e.message }); }
    if (term) {
      const sug = await call(P.ownerSuggestions, F.owner, term, 20000);
      lap('ownerSuggestions');
      if (!sug.ok) out.errors.push({ code: 'owner_not_found', field: 'owner', wanted: ownerWanted, message: 'No directory suggestions for that owner.' });
      else {
        const m = matchOwner(sug.items, ownerWanted);
        if (!m.ok) out.errors.push({ code: m.error === 'ambiguous' ? 'ambiguous_owner' : 'owner_not_found', field: 'owner', wanted: ownerWanted, candidates: m.candidates });
        else {
          const picked = await call(P.pickSuggestion, sug.items[m.index], F.ownerGuid, 15000);
          if (!picked.ok) out.errors.push({ code: 'owner_not_bound', field: 'owner', wanted: ownerWanted, detail: picked.error });
          else {
            out.resolved.owner = { display: m.display, upn: m.upn, matchedBy: m.matchedBy };
            if (ownerDefault) { eff.owner = ownerDefault; out.defaulted.push({ field: 'owner', value: m.display ? `${m.display} (${m.upn})` : m.upn, reason: 'The signed-in user' }); }
            await s.quiet();
          }
        }
      }
    }
    // The signed-in user could not be bound as owner: ask rather than report an error for a value nobody typed.
    if (ownerDefault && !out.resolved.owner) { out.errors.splice(ownerErrors); out.missing.push({ field: 'owner', id: F.owner, label: fields[F.owner]?.label }); }
  }
  lap('owner');
  await drainModals();
  await refresh();

  // 3) type (runs the portal's eligibility checks against the now-bound owner)
  const typeId = await bind('type');
  if (typeId !== null && await choose('type', typeId ?? F.type)) { await s.quiet(); lap('type'); }
  await drainModals();
  await refresh();

  // 4) type-dependent fields (only those the selected type shows), then user-provided extra fields
  const typeLabel = normalize(out.resolved.type?.label ?? '');
  const applies = new Set(/internal/.test(typeLabel) ? APPLIES.internal : /external/.test(typeLabel) ? APPLIES.external : []);
  for (const [key, , kind] of DEPENDENT) {
    const id = await bind(key, { optional: true, applicable: applies.has(key) });
    if (id === null) continue;
    if (id === undefined) { if (input[key] !== undefined) out.warnings.push({ code: 'input_ignored', field: key, message: `${key} does not apply to the selected subscription type.` }); continue; }
    if (kind === 'text' && input[key] !== undefined) {
      const max = key === 'tenantName' ? 50 : 256;
      if (input[key].length > max) { out.errors.push({ code: 'too_long', field: key, max }); continue; }
    }
    if (await choose(key, id, kind === 'text' ? undefined : kind)) await s.quiet({ quietMs: 200 });
  }
  // Named inputs, their resolved or mapped controls and the portal-populated companions are never set via --field.
  const reserved = new Set([...KNOWN, ...ID_BOUND, ...Object.values(input.map ?? {}), ...claimed]);
  for (const [id, value] of Object.entries(input.fields ?? {})) {
    if (reserved.has(id)) { out.errors.push({ code: 'use_named_input', id, message: `Use the named input for ${id}.` }); continue; }
    claimed.add(id);
    await refresh();
    if (await choose(`fields.${id}`, id, undefined, value)) await s.quiet({ quietMs: 200 });
  }
  lap('dependent');
  await drainModals();

  // 5) title last (some handlers reset text fields)
  if (input.title !== undefined && input.title.length > 256) out.errors.push({ code: 'too_long', field: 'title', max: 256 });
  else { await refresh(); const titleId = await bind('title'); if (titleId !== null) await choose('title', titleId ?? F.title); }

  // 6) explicit eligibility (fail closed), independent of the portal's event ordering
  const derived = await call(P.readValues, [F.ownerGuid, F.ownerUpn, F.manager, F.managerEmail, F.owner]);
  if (out.resolved.owner && out.resolved.type) {
    if (!derived[F.ownerGuid]) out.blockers.push({ code: 'owner_cleared', message: 'The portal cleared the subscription owner after eligibility checks.' });
    else {
      const e = await call(P.checkEligibility, derived[F.ownerGuid], out.resolved.type.value);
      out.eligibility = e;
      if (!e.ok) out.blockers.push({ code: 'eligibility_unverified', message: `Could not verify the owner's active requests: ${e.error}` });
      else if (e.active.length) out.blockers.push({ code: 'active_request', message: `The owner already has ${e.active.length} active request(s) of this type.`, requests: e.active });
    }
  }
  lap('eligibility');
  return finish(derived);

  async function finish(derivedIn) {
    s.assertGuarded();
    for (const d of drifts) await rankDrift(d);
    await drainModals();
    await refresh();
    const d = derivedIn ?? await call(P.readValues, [F.ownerGuid, F.ownerUpn, F.manager, F.managerEmail, F.owner]);
    out.derived = { ownerGuid: d[F.ownerGuid] || null, ownerUpn: d[F.ownerUpn] || null, ownerDisplay: d[F.owner] || null, manager: d[F.manager] || null, managerEmail: d[F.managerEmail] || null };
    const bg = await s.drainBackground();
    lap('background');
    const st = await s.state();
    if (st) throwIfTerminalPage(st);
    if (!st || !st.hasForm) throw new SkillError('form_lost', 'The portal navigated away from the form while filling.', { url: st?.url?.split('?')[0] ?? null });
    if (bg.timedOut) out.warnings.push({ code: 'portal_check_pending', message: 'A portal access check had not completed; results may change on submit.', pending: bg.pending });
    out.contactId = st?.contactId ?? null;
    if (st?.mcaps && st.mcaps !== 'True') out.blockers.push({ code: 'mcaps_access', message: 'The portal reports you are not eligible (MCAPS access check failed).' });
    // Re-attest every bound control against what the browser would post now: exactly one pair under the recorded
    // name, carrying the value that was set (a late handler or a second control with that name is drift).
    const ser = await call(P.serializeForm);
    const serialized = ser.ok ? ser.pairs : [];
    if (ser.files) out.blockers.push({ code: 'form_drift', reason: 'file_input', message: 'The form carries a file upload; this skill never uploads files.' });
    const attest = [
      ...Object.entries(fieldMap).filter(([k]) => out.resolved[k]).map(([k, m]) => ({ field: k, id: m.id, name: m.name, value: k === 'owner' ? undefined : out.resolved[k].value })),
      ...Object.keys(input.fields ?? {}).filter((id) => out.resolved[`fields.${id}`]).map((id) => ({ field: `fields.${id}`, id, name: fields[id]?.name, value: out.resolved[`fields.${id}`].value })),
    ];
    for (const a of attest) {
      const b = await call(P.formBinding, [a.id]);
      const reason = b.length !== 1 || b[0][0] !== a.name || serialized.filter(([n]) => n === a.name).length !== 1 ? 'unbound' : a.value !== undefined && b[0][1] !== crlf(a.value) ? 'value_changed' : null;
      if (reason) out.blockers.push({ code: 'form_drift', field: a.field, id: a.id, reason, message: `The ${a.field} control does not post the value that was set (${reason}).` });
    }
    for (const id of Object.keys(input.fields ?? {})) {
      const slot = Object.keys(fieldMap).find((k) => fieldMap[k].id === id);
      if (slot && !out.errors.some((e) => e.code === 'use_named_input' && e.id === id)) out.errors.push({ code: 'use_named_input', id, field: slot, message: `${id} is the ${slot} field; use the named input.` });
    }
    const slotOf = Object.fromEntries(Object.entries(fieldMap).map(([k, m]) => [m.id, k]));
    const known = new Set([...out.missing.map((m) => m.id), ...out.errors.map((e) => e.id)]);
    for (const u of unresolved) for (const id of [u.expectedId, u.id, u.suggested?.id, ...(u.candidates ?? []).map((c) => c.id)]) if (id) known.add(id);
    for (const f of Object.values(fields)) {
      if (!f.visible || !f.required || f.value || known.has(f.id)) continue;
      if (AUTO_FIELDS.has(f.id)) { if (f.id === F.manager && out.resolved.owner) out.blockers.push({ code: 'manager_missing', message: 'Reporting manager was not populated for the owner.' }); continue; }
      const named = slotOf[f.id] ?? (KNOWN.has(f.id) ? f.id : null);
      out.missing.push({ field: named ?? `fields.${f.id}`, id: f.id, label: f.label, ...(named ? {} : { code: 'unknown_required_field' }), ...(f.options ? { options: optionsOf(f) } : {}) });
      known.add(f.id);
    }
    const ready = !out.missing.length && !out.errors.length;
    if (ready) {
      out.validation = await call(P.validate);
      await drainModals();
      if (!out.validation.ok) for (const v of out.validation.failures) if (!known.has(v.id)) out.errors.push({ code: 'portal_validation', id: v.id, message: v.message });
    }
    const terms = await call(P.readTerms);
    out.terms = terms.ok ? { sha: sha256(`${terms.text}\n${terms.links.join('\n')}`), text: terms.display, links: terms.links } : { error: terms.error };
    if (!terms.ok && ready) out.blockers.push({ code: 'terms_unavailable', message: 'Could not read the current terms and conditions.' });
    out.contract = sha256(stableStringify(Object.values(fields).filter((f) => f.visible).map((f) => [f.id, f.label, f.required, f.tag]).sort())).slice(0, 16);
    out.fieldMap = fieldMap;
    // Names (not values) of every business control that would be posted with a value: a new default-populated field
    // changes the plan identity.
    out.postNames = serialized.filter(([n, v]) => v !== '' && !isInfraName(n)).map(([n]) => n).sort();
    out.status = out.blockers.length ? 'blocked' : out.errors.length ? 'invalid' : out.missing.length ? 'needs_input' : 'ready';
    if (discover) out.fields = Object.values(fields).filter((f) => f.visible).map((f) => ({ id: f.id, label: f.label, required: f.required, value: f.value, ...(f.options ? { options: optionsOf(f) } : {}) }));
    out.dialogs = s.dialogs.splice(0);
    out.input = eff;
    if (!out.inferred.length) delete out.inferred;
    timings.total = Math.round(now() - t0);
    out.timings = timings;
    return out;
  }
}

export function planMaterial(formUrl, input, r) {
  return {
    v: PLAN_SCHEMA, formUrl,
    actor: r.contactId,
    input: { title: input.title, fields: input.fields ?? {}, map: input.map ?? {}, ...(input.inferred ? { inferred: input.inferred } : {}) },
    resolved: Object.fromEntries(Object.entries(r.resolved).map(([k, v]) => [k, k === 'owner' ? v.upn : v.value])),
    derived: { ownerGuid: r.derived.ownerGuid, ownerUpn: r.derived.ownerUpn, manager: r.derived.manager, managerEmail: r.derived.managerEmail },
    fieldMap: r.fieldMap ?? {},
    postNames: r.postNames ?? [],
    terms: r.terms?.sha ?? null,
    contract: r.contract,
  };
}

// ---------------------------------------------------------------- submit
function diffMaterial(a, b, prefix = '') {
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
  const out = [];
  for (const k of keys) {
    const x = a?.[k]; const y = b?.[k];
    if (x && y && typeof x === 'object' && typeof y === 'object') out.push(...diffMaterial(x, y, `${prefix}${k}.`));
    else if (stableStringify(x) !== stableStringify(y)) out.push({ path: `${prefix}${k}`, planned: x ?? null, now: y ?? null });
  }
  return out;
}

const DAY = 24 * 3600 * 1000;
const titleMatches = (name, title) => normalize(name).endsWith(` - ${normalize(title)}`);
// Every field whose posted value must be exactly what fill() verified against the plan (resolved ids included).
const bindIds = (input, fieldMap = {}) => [...new Set([F.title, F.purpose, F.type, F.owner, F.ownerGuid, F.ownerUpn, F.manager, F.managerEmail, F.requester, ...DEPENDENT.map((d) => d[1]), ...Object.keys(input.fields ?? {}), ...Object.values(fieldMap).map((m) => m.id)])];
const pairsDiff = (a, b) => {
  const A = new Map(a); const B = new Map(b);
  return [...new Set([...A.keys(), ...B.keys()])].filter((k) => A.get(k) !== B.get(k)).map((k) => k.split('$').pop());
};
const raceTimeout = (p, ms, v) => { let t; return Promise.race([p, new Promise((r) => { t = setTimeout(r, ms, v); })]).finally(() => clearTimeout(t)); };

// Active requests by the signed-in user with the same title in the last 24h.
export async function findDuplicates(s, contactId, title) {
  const recent = await s.page.call(P.listOwnRequests, contactId, new Date(Date.now() - DAY).toISOString(), 25);
  if (!recent.ok) return { ok: false, error: recent.error };
  return { ok: true, rows: recent.rows.filter((x) => x.active && titleMatches(x.name, title)) };
}

export async function submit(s, plan, { dir, allowDuplicate = false, resultTimeoutMs = 90000 } = {}) {
  const t0 = now();
  // The plan's input already carries every default explicitly; never re-default at submit time.
  const r = await fill(s, plan.input, { defaults: false });
  s.mark('filled');
  if (r.status !== 'ready') return { outcome: 'not_submitted', reason: 'plan_no_longer_ready', status: r.status, missing: r.missing, errors: r.errors, blockers: r.blockers };
  const material = planMaterial(s.formUrl, plan.input, r);
  if (hashPlan(material) !== plan.planId) return { outcome: 'not_submitted', reason: 'plan_mismatch', message: 'The form or resolved values changed since planning. Re-run plan and re-confirm.', changes: diffMaterial(plan.material, material) };
  const title = plan.input.title;
  const ids = bindIds(plan.input, r.fieldMap);
  // Snapshot of exactly what the browser will post, taken right after fill() re-verified it against the plan.
  const verified = await s.page.call(P.formBinding, ids);

  const dup = await findDuplicates(s, r.contactId, title);
  if (!dup.ok) return { outcome: 'not_submitted', reason: 'duplicate_check_failed', message: dup.error };
  const dupes = dup.rows;
  if (dupes.length && !allowDuplicate) return { outcome: 'not_submitted', reason: 'duplicate_active', message: 'You already have an active request with this title in the last 24h.', requests: dupes };

  const key = requestKey({ title, owner: r.resolved.owner.upn, type: r.resolved.type.value, purpose: r.resolved.purpose.value });
  const lock = acquireSubmitLock(dir, key, { planId: plan.planId, title, contactId: r.contactId, formUrl: s.formUrl }, { allowAfterSuccess: allowDuplicate });
  const notSent = (reason, extra = {}) => { releaseUnsent(dir, key); return { outcome: 'not_submitted', reason, ...extra }; };
  try {
    const terms = await s.page.call(P.acceptTerms);
    if (!terms.ok) return notSent('terms_ui_failed', { detail: terms });
    const v = await s.page.call(P.validate);
    if (!v.ok) return notSent('validation_failed', { failures: v.failures });
    const btn = await s.page.call(P.insertButtonInfo);
    if (!btn?.name || !btn.onclickPostback || btn.disabled) return notSent('submit_contract_changed', { button: btn });
    const current = await s.page.call(P.formBinding, ids);
    const drift = pairsDiff(verified, current);
    if (drift.length) return notSent('form_changed', { message: 'Form values changed after verification; nothing was sent. Re-run plan.', fields: drift });
    const accepted = await s.page.call(P.formBinding, [TERMS_BOX]);
    if (!accepted.length) return notSent('terms_ui_failed', { detail: { error: 'terms checkbox not set after acceptance' } });
    // Everything the browser would post now. Every resolved slot must still be exactly one pair under its planned
    // name, and every verified pair must be part of it; the gate then pins the whole business serialization.
    const ser = await s.page.call(P.serializeForm);
    if (!ser?.ok || ser.files) return notSent('form_changed', { message: ser?.files ? 'The form now carries a file upload; nothing was sent.' : 'Could not read the form serialization; nothing was sent.' });
    const unbound = [];
    for (const [slot, m] of Object.entries(r.fieldMap ?? {})) {
      const b = await s.page.call(P.formBinding, [m.id]);
      if (b.length !== 1 || b[0][0] !== m.name || ser.pairs.filter(([n]) => n === m.name).length !== 1) unbound.push(slot);
    }
    const business = ser.pairs.filter(([n]) => !isInfraName(n));
    for (const [n, v] of [...current, ...accepted]) if (!business.some(([bn, bv]) => bn === n && bv === v)) unbound.push(n.split('$').pop());
    if (unbound.length) return notSent('form_changed', { message: 'The form no longer posts the verified fields the planned way; nothing was sent. Re-run plan.', fields: unbound });

    const T0 = Date.now();
    s.hooks.onSubmit = () => markSent(lock, { sentAt: new Date().toISOString() });
    // The gate lets the POST out only if it carries exactly the business values serialized now (owner, type, purpose,
    // every hidden companion, ...) and no name that was not serialized now.
    s.guard.armSubmit({ mustContain: [btn.name], mustEqual: business, onlyNames: [...ser.pairs.map(([n]) => n), btn.name] });
    const loaded = s.page.waitFor('Page.loadEventFired', () => true, { timeoutMs: resultTimeoutMs }).then(() => 'loaded', () => 'timeout');
    s.assertGuarded();
    await s.page.call(P.clickInsert);
    const sentBy = Date.now() + 10000;
    while (s.guard.stats().submitsSent === 0 && Date.now() < sentBy) {
      if (s.guard.stats().blockedWrites.some((w) => /^submit-body/.test(w.reason))) break;
      await sleep(25);
    }
    s.guard.disarm();
    s.hooks.onSubmit = null;
    if (s.guard.stats().submitsSent === 0) {
      const mismatch = s.guard.stats().blockedWrites.find((w) => /^submit-body/.test(w.reason));
      if (mismatch) return notSent('submit_body_mismatch', { message: 'The browser tried to post values other than the verified ones; it was blocked and nothing was sent. Re-run plan.', fields: (mismatch.fields ?? []).map((n) => n.split('$').pop()) });
      const modals = await s.page.call(P.takeModals).catch(() => []);
      const val = await s.page.call(P.validate).catch(() => null);
      return notSent('no_post', { message: 'The portal did not send the request (client-side checks stopped it).', modals, validation: val, blocked: s.guard.stats().blockedWrites.filter((w) => /^submit/.test(w.reason)) });
    }
    s.mark('posted');
    const commitEv = s.submitEvents.at(-1);
    for (let i = 0; commitEv && commitEv.status === undefined && commitEv.error === undefined && i < 2400; i++) await sleep(50);
    s.mark('committed');
    if (commitEv?.notDelivered) {
      const why = commitEv.error ?? 'not delivered';
      if (lock.record.state === 'prepared') return notSent('not_delivered', { message: why });
      recordOutcome(lock, { outcome: 'rejected', reason: 'not_delivered', error: why });
      return { outcome: 'not_submitted', reason: 'not_delivered', message: `The request never reached the portal (${commitEv.errorCode ?? why}). Nothing was created; it is safe to retry.`, requestKey: key };
    }
    const nav = commitEv?.error ? 'commit_error' : await raceTimeout(loaded, 15000, 'timeout');
    await sleep(100);
    const page = await s.page.call(P.parseOutcome).catch(() => null);
    const pageModals = await s.page.call(P.takeModals).catch(() => []);

    // Reconcile against the server (source of truth), never resubmitting. Success needs an API row that is
    // unambiguously this request; a page-only case id or an unprovable rejection stays 'unknown'.
    let st = await s.state();
    if (!st || !st.url.startsWith(s.origin)) { await s.goto(`${s.origin}/`).catch(() => {}); await s.quiet({ timeoutMs: 15000 }); }
    let found = null;
    let ambiguous = null;
    let lastOk = false;
    let apiError = null;
    for (let i = 0; i < 8 && !found && !ambiguous; i++) {
      const res = await s.page.call(P.listOwnRequests, r.contactId, new Date(T0 - 120000).toISOString(), 10).catch((e) => ({ ok: false, error: e.message }));
      lastOk = !!res.ok;
      if (res.ok) {
        const hits = res.rows.filter((x) => titleMatches(x.name, title) && Date.parse(x.createdOn) >= T0 - 120000 && !dupes.some((d) => d.caseId === x.caseId));
        if (hits.length === 1) found = hits[0];
        else if (hits.length > 1) ambiguous = hits;
      } else apiError = res.error;
      if (!found && !ambiguous) await sleep(i < 2 ? 750 : 2000);
    }
    const probable = page?.caseIds?.length === 1 ? page.caseIds[0] : null;
    let result;
    if (found) result = { outcome: 'success', caseId: found.caseId, status: found.status, createdOn: found.createdOn };
    else if (!ambiguous && lastOk && commitEv?.status === 200 && page?.hasForm && page.errors?.length) result = { outcome: 'rejected', errors: page.errors, modals: pageModals };
    else result = {
      outcome: 'unknown',
      message: `The request was sent but could not be confirmed as exactly one new case. Do NOT resubmit; run status${probable ? ` --case ${probable}` : ''} in a few minutes.`,
      ...(probable ? { probableCaseId: probable } : {}),
      ...(ambiguous ? { candidates: ambiguous.map((x) => ({ caseId: x.caseId, createdOn: x.createdOn, status: x.status })) } : {}),
      page: page && { url: page.url.split('?')[0], title: page.title, excerpt: page.excerpt.slice(0, 300) }, navigation: nav, commit: commitEv && { status: commitEv.status ?? null, error: commitEv.error ?? null }, apiError,
    };
    recordOutcome(lock, { outcome: result.outcome, caseId: result.caseId ?? null, ...(probable && !result.caseId ? { probableCaseId: probable } : {}) });
    return { ...result, requestKey: key, timings: { ...s.marks, submitMs: Math.round(now() - t0) } };
  } catch (e) {
    s.guard.disarm();
    s.hooks.onSubmit = null;
    const rec = lock.record;
    if (rec.state === 'prepared') { try { releaseUnsent(dir, key); } catch {} return { outcome: 'not_submitted', reason: 'error', message: e.message }; }
    recordOutcome(lock, { outcome: 'unknown', error: e.message });
    return { outcome: 'unknown', message: `Error after the request was sent: ${e.message}. Do NOT resubmit; run status.`, requestKey: key };
  }
}

// ---------------------------------------------------------------- status
// Sign in via the portal's SignIn page and land on the home page (lighter than loading the form).
export async function signInHome(s, { timeoutMs = s.headless ? 60000 : 300000 } = {}) {
  await s.goto(`${s.origin}/SignIn?returnUrl=%2F`);
  const until = now() + timeoutMs;
  let clicked = 0;
  for (;;) {
    const st = await s.state();
    if (st?.signIn && clicked < 2 && st.readyState !== 'loading') { if (await s.page.call(P.clickSignIn).catch(() => false)) { clicked++; await sleep(300); continue; } }
    if (st && st.url.startsWith(s.origin) && !st.signIn && st.readyState === 'complete' && !/\/SignIn/i.test(st.url)) return st;
    if (now() > until) throw new SkillError('auth_required', s.headless ? 'Silent sign-in did not complete. Re-run with --headed.' : 'Sign-in was not completed in time.');
    await sleep(80);
  }
}

export async function ownRequests(s, cachedContactId, { sinceIso, top = 10, caseId } = {}) {
  const st = await signInHome(s);
  // The live signed-in identity wins; the cache is only a fallback when the home page does not expose it.
  let id = st.contactId || cachedContactId;
  if (!id) { await openForm(s); id = (await s.state())?.contactId; }
  if (!id) throw new SkillError('contact_unknown', 'Could not determine your portal contact id.');
  const res = await s.page.call(P.listOwnRequests, id, sinceIso, caseId ? 1 : top, caseId);
  if (!res.ok) throw new SkillError('api_failed', `Web API query failed: ${res.error}`);
  return { contactId: id, requests: res.rows };
}

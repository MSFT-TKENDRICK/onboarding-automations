// Pure request classifier behind the CDP Fetch interceptor. Default-deny for writes.
const READ = new Set(['GET', 'HEAD', 'OPTIONS']);
const IDENTITY_HOSTS = ['login.microsoftonline.com', 'login.windows.net', 'login.live.com', 'device.login.microsoftonline.com', 'autologon.microsoftazuread-sso.com'];
const AUTH_PATHS = [/^\/$/, /^\/_services\/auth\/token$/i, /^\/Account\/Login\/ExternalLogin/i, /^\/signin-/i];
const BLOCKED_TYPES = new Set(['Image', 'Media', 'Font']);
const TELEMETRY = /(^|\.)(clarity\.ms|applicationinsights\.azure\.com|applicationinsights\.io|monitor\.azure\.com|az416426\.vo\.msecnd\.net|events\.data\.microsoft\.com|browser\.events\.data\.msn\.com|google-analytics\.com|googletagmanager\.com)$/i;

// Parse a form POST body into name -> [values]. Supports the two HTML form encodings; anything else is null
// (callers fail closed). File parts are recorded with an empty value.
export function parseFormBody(postData, contentType = 'application/x-www-form-urlencoded') {
  const ct = String(contentType).toLowerCase();
  const out = new Map();
  const add = (k, v) => { if (!out.has(k)) out.set(k, []); out.get(k).push(v); };
  if (ct.startsWith('application/x-www-form-urlencoded')) {
    for (const [k, v] of new URLSearchParams(postData)) add(k, v);
    return out;
  }
  if (!ct.startsWith('multipart/form-data')) return null;
  const m = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  if (!m) return null;
  const delim = `--${m[1] ?? m[2]}`;
  const chunks = postData.split(delim);
  if (chunks.length < 2 || !chunks.at(-1).startsWith('--')) return null;
  for (const c of chunks.slice(1, -1)) {
    const sep = c.indexOf('\r\n\r\n');
    if (!c.startsWith('\r\n') || sep < 0 || !c.endsWith('\r\n')) return null;
    const head = c.slice(2, sep);
    const name = /;\s*name="([^"]*)"/i.exec(head)?.[1];
    if (name === undefined) return null;
    const decoded = name.replace(/%22/g, '"').replace(/%0D/gi, '\r').replace(/%0A/gi, '\n');
    add(decoded, /;\s*filename=/i.test(head) ? '' : c.slice(sep + 4, -2));
  }
  return out;
}

export function createGuard({ formUrl, allowWriteHosts = IDENTITY_HOSTS, blockResources = true } = {}) {
  const form = new URL(formUrl);
  const blockedWrites = [];
  let gate = null;
  let submitsSent = 0;
  let blockedResources = 0;

  const isForm = (u) => u.origin === form.origin && u.pathname.toLowerCase() === form.pathname.toLowerCase() && u.searchParams.get('ServiceId') === form.searchParams.get('ServiceId');

  function classify({ method, url, resourceType, postData, contentType, isMainFrame = true }) {
    let u;
    try { u = new URL(url); } catch { return { action: 'continue', reason: 'unparsed' }; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return { action: 'continue', reason: 'scheme' };
    const m = String(method || 'GET').toUpperCase();
    if (READ.has(m)) {
      if (blockResources && (BLOCKED_TYPES.has(resourceType) || TELEMETRY.test(u.hostname))) { blockedResources++; return { action: 'fail', reason: 'blocked-resource' }; }
      return { action: 'continue', reason: 'read' };
    }
    const deny = (reason, extra = {}) => { blockedWrites.push({ method: m, host: u.hostname, path: u.pathname, reason, ...extra }); return { action: 'fail', reason }; };
    if (u.origin === form.origin) {
      if (gate && isForm(u) && resourceType === 'Document' && isMainFrame) {
        if (gate.mustContain.length || gate.mustEqual.length) {
          if (typeof postData !== 'string') return deny('submit-body-unverified');
          const params = parseFormBody(postData, contentType);
          // Markers match the raw body or, for parsed bodies, a decoded field name/value (urlencoding escapes `$`).
          const has = (s) => postData.includes(s) || (!!params && [...params].some(([k, vs]) => k === s || vs.includes(s)));
          if (!gate.mustContain.every(has)) return deny('submit-body-mismatch');
          // The serialized form must carry exactly the verified value for every bound field (names only are logged).
          if (gate.mustEqual.length) {
            if (!params) return deny('submit-body-mismatch', { fields: ['<unparsed body>'] });
            const bad = gate.mustEqual.filter(([name, value]) => { const got = params.get(name) ?? []; return got.length !== 1 || got[0] !== value; }).map(([name]) => name);
            if (bad.length) return deny('submit-body-mismatch', { fields: bad });
          }
        }
        gate = null;
        submitsSent++;
        return { action: 'continue', reason: 'submit' };
      }
      if (AUTH_PATHS.some((re) => re.test(u.pathname))) return { action: 'continue', reason: 'auth' };
      return deny('blocked-write');
    }
    if (allowWriteHosts.includes(u.hostname.toLowerCase())) return { action: 'continue', reason: 'identity' };
    return deny('blocked-write');
  }

  return {
    classify,
    armSubmit({ mustContain = [], mustEqual = [] } = {}) { gate = { mustContain, mustEqual }; },
    disarm() { gate = null; },
    get armed() { return !!gate; },
    stats: () => ({ submitsSent, blockedResources, blockedWrites: blockedWrites.slice() }),
  };
}

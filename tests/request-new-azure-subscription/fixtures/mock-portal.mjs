// Mock MCAPS portal emulating the live DOM/JS contract (sanitized, synthetic data) for integration tests.
// Deliberately hostile: stale jQuery whose trigger() is a no-op, async option loading, eligibility that
// clears the owner, informational modals, a permanent .ui-autocomplete-loading element, and a server-side
// oracle that rejects incomplete posts.
import http from 'node:http';
import { randomUUID, randomInt } from 'node:crypto';

export const P = 'ctl00$ContentContainer$EntityFormControl_f187$EntityFormControl_f187_EntityFormView$';
export const INSERT = 'ctl00$ContentContainer$EntityFormControl_f187$InsertButton';
const SERVICE = '78b2e66c-42f2-e811-a96a-000d3a30da4f';
const FORM_PATH = '/support/eslabs-newazuresubscription/';

export const DEFAULTS = {
  auth: true,
  me: { contactId: 'c0ffee00-0000-4000-8000-000000000001', display: 'Test User', upn: 'testuser@contoso.com' },
  users: [
    { display: 'Test User', upn: 'testuser@contoso.com', guid: '11111111-1111-4111-8111-111111111111', manager: { display: 'Manager One', upn: 'mgr1@contoso.com' } },
    { display: 'Other Person', upn: 'other@contoso.com', guid: '22222222-2222-4222-8222-222222222222', manager: { display: 'Manager Two', upn: 'mgr2@contoso.com' } },
    { display: 'Other Personality', upn: 'otherp@contoso.com', guid: '33333333-3333-4333-8333-333333333333', manager: { display: 'Manager Two', upn: 'mgr2@contoso.com' } },
  ],
  purposes: [['444350001', 'Hybrid (Self-Learning/Demo)'], ['444350003', 'CSS Support']],
  monthly: ['500', '1000', '1500'],
  timezones: [['tz-pst', '(UTC-08:00) Pacific Time (US & Canada)'], ['tz-baja', '(UTC-08:00) Baja California'], ['tz-est', '(UTC-05:00) Eastern Time (US & Canada)'], ['tz-utc', '(UTC) Coordinated Universal Time']],
  activeOwners: [],
  mcaps: true,
  submitMode: 'success',
  loadDelayMs: 150,
  // Live: purposes are re-added ~5 s after load (2 s + 3 s timers, then a billing-sections XHR); the gap has no network.
  purposeDelayMs: 700,
  // Live: document-ready VPN check against an external backend; slow (often >3 s) and redirects to /VPNRequired/ on failure.
  vpnDelayMs: 1500,
  hangPages: false, // never answer page requests (portal unreachable)
  vpnFail: false,
  tamperOwner: null, // page script swaps the owner GUID when the form is serialized
  hideCreated: false, // created requests never show up in the Web API (confirmation page only)
  apiFailAfterPost: false, // the Web API errors once a form POST has been received
  apiDelayMs: 80,
  termsText: 'You acknowledge that: access is monitored. Microsoft prohibits customer data in non-production subscriptions. I agree to the Terms and Conditions.',
  drift: {},
};

// Server-rendered purpose options; portal JS strips them at load and re-adds only the allowed ones later.
const ALL_PURPOSES = [['444350001', 'Hybrid (Self-Learning/Demo)'], ['444350003', 'CSS Support'], ['444350004', 'Customer Project']];

function page(cfg, { error } = {}) {
  const d = cfg.drift;
  const honeypot = `frm_pref_${randomUUID().slice(0, 8)}`;
  const row = (id, label, control, hidden = true) => `<tr${hidden ? ' style="display:none"' : ''}><td class="clearfix cell"><div class="info"><label id="${id}_label" for="${id}">${d.relabel?.[id] ?? label}</label></div><div class="control">${control}</div></td></tr>`;
  const sel = (id, opts) => `<select id="${id}" name="${P}${id}" class="form-control">${opts.map(([v, t]) => `<option value="${v}">${t}</option>`).join('')}</select>`;
  const txt = (id, extra = '') => `<input type="text" id="${id}" name="${P}${id}" class="text form-control" ${extra}/>`;
  const hid = (id, v = '') => `<input type="hidden" id="${id}" name="${P}${id}" value="${v}"/>`;
  const rows = [
    row('apitil_title', 'Title', txt('apitil_title', 'maxlength="256"'), false),
    row('desitsm_subscriptionpurposeaz', 'Subscription Purpose', sel('desitsm_subscriptionpurposeaz', [['', 'Select'], ...ALL_PURPOSES]), false),
    row('apitil_contact_name', 'Requester', txt('apitil_contact_name', `readonly value="${cfg.me.display}"`), false),
    row('desitsm_subscriptiontypes', 'Subscription Type', sel('desitsm_subscriptiontypes', [['', 'Select'], ['444350000', 'Internal Subscription'], ['444350001', 'External Subscription']])),
    row('desitsm_tenanttypes', 'Tenant Type', sel('desitsm_tenanttypes', [['', 'Select'], ['444350003', 'Managed Environment - Team Tenant'], ['444350001', 'Managed Environment - User Tenant']])),
    row('desitsm_tenantlicensing', 'Tenant Licensing', sel('desitsm_tenantlicensing', [['', 'Select'], ['444350000', 'Enterprise Premium P2'], ['444350001', 'M365 E5']])),
    row('desitsm_subscriptionowner', 'Subscription Owner', txt('desitsm_subscriptionowner', 'autocomplete="off"')),
    row('desitsm_eslabs_projectlevel', 'Reporting Manager', txt('desitsm_eslabs_projectlevel', 'readonly')),
    row('desitsm_tenantdisplayname', 'Tenant Display Name', txt('desitsm_tenantdisplayname', 'maxlength="50"')),
    cfg.drift.removeField === 'desitsm_monthlyspend' ? '' : row('desitsm_monthlyspend', 'Monthly Allowance', sel('desitsm_monthlyspend', [['', ''], ...cfg.monthly.map((m) => [m, `$${m}`])])),
    cfg.drift.removeField === 'desitsm_timezonelist' ? '' : row('desitsm_timezonelist', 'Time Zone', sel('desitsm_timezonelist', [['', 'Select'], ...cfg.timezones])),
    cfg.drift.extraRequired ? row(cfg.drift.extraRequired.id, cfg.drift.extraRequired.label, sel(cfg.drift.extraRequired.id, [['', 'Select'], ['1', 'Yes'], ['2', 'No']])) : '',
    row(honeypot, 'Leave this field blank', `<input type="text" id="${honeypot}" name="${honeypot}"/>`, false),
  ];
  // A second control with the same label and options as `of` (shown together with it).
  if (d.duplicateLabel) { const src = rows.find((r) => r.includes(`id="${d.duplicateLabel.of}"`)); if (src) rows.push(src.replaceAll(d.duplicateLabel.of, d.duplicateLabel.id)); }
  const hidden = [hid('apitil_contact', cfg.me.contactId), hid('apitil_service', SERVICE), hid('itserv_businessmanageruserid'), hid('itserv_businessmanager', cfg.me.upn),
    hid('desitsm_eslabs_projectlevelemailid'), hid('desitsm_aduserguid'), hid('desitsm_treeview'), hid('desitsm_estimatedmonthlyspend'),
    ...(d.extraPopulated ? [hid(d.extraPopulated.id, d.extraPopulated.value)] : []),
    `<input type="checkbox" id="desitsm_agreetothetermsandconditions" name="${P}desitsm_agreetothetermsandconditions" style="display:none"/>`].join('');
  return renameIds(d, `<!doctype html><html><head><title>Request New Cloud Services - MCAPS Services</title></head><body>
<div id="pageLoaderOverlay" style="display:block">Loading...</div>
<span class="ui-autocomplete-loading"></span>
<form id="liquid_form" method="post" enctype="multipart/form-data" action="${FORM_PATH}?ServiceId=${SERVICE}" onsubmit="javascript:return WebForm_OnSubmit();">
<input type="hidden" name="__EVENTTARGET" id="__EVENTTARGET" value=""/><input type="hidden" name="__EVENTARGUMENT" id="__EVENTARGUMENT" value=""/>
<input type="hidden" name="__VIEWSTATE" id="__VIEWSTATE" value="${randomUUID()}${randomUUID()}"/><input type="hidden" name="__EVENTVALIDATION" value="${randomUUID()}"/>
<input type="hidden" name="__RequestVerificationToken" value="${randomUUID()}"/>
${error ? `<div id="ValidationSummaryEntityFormView" class="validation-summary alert alert-error"><ul><li>${error}</li></ul></div>` : '<div id="ValidationSummaryEntityFormView" class="validation-summary" style="display:none"><ul></ul></div>'}
<table class="section">${rows.join('')}</table>${hidden}
<a href="#" onclick="showTermsAndConditionModal();return false;">Terms and Conditions</a>
<div class="actions"><input type="button" id="InsertButton" name="${INSERT}" value="Submit" disabled="disabled" onclick="javascript:if(typeof entityFormClientValidate === 'function'){if(entityFormClientValidate()){if(typeof Page_ClientValidate === 'function'){if(Page_ClientValidate('')){this.value = 'Processing...';}}}else{return false;}};WebForm_DoPostBackWithOptions(new WebForm_PostBackOptions(&quot;${INSERT}&quot;, &quot;&quot;, true, &quot;&quot;, &quot;&quot;, false, true))"/></div>
</form>
<script>window.Microsoft = { Dynamic365: { Portal: { User: ${JSON.stringify({ contactId: cfg.me.contactId, email: cfg.me.upn, userName: cfg.me.upn })} } } };</script>
<script>window.__CFG = ${JSON.stringify({ mcaps: cfg.mcaps, loadDelayMs: cfg.loadDelayMs, purposeDelayMs: cfg.purposeDelayMs, vpnFail: cfg.vpnFail, termsText: cfg.termsText, extraRequired: cfg.drift.extraRequired?.id ?? null, tamperOwner: cfg.tamperOwner ?? null, dup: d.duplicateLabel ?? null, clickTamper: d.clickTamper ?? null, validatorLabel: d.validatorLabel ?? null })};</script>
<script src="/mock-portal.js"></script></body></html>`);
}

// drift.rename {oldId: newId}: the portal renamed a control (id, name, label-for and every script reference).
function renameIds(drift, text) {
  let out = text;
  for (const [from, to] of Object.entries(drift.rename ?? {})) out = out.replace(new RegExp(`(?<![A-Za-z0-9_])${from}(?![A-Za-z0-9])`, 'g'), to);
  return out;
}

// Runs in the browser. Plain ES5-style code, no template literals.
const PAGE_JS = String.raw`
let subscriptionPurposeOptions = '';
(function () {
  var C = window.__CFG;
  var $id = function (id) { return document.getElementById(id); };
  var rowOf = function (id) { var e = $id(id); return e && e.closest('tr'); };
  var show = function (id, on) { var r = rowOf(id); if (r) r.style.display = on ? '' : 'none'; };
  var visible = function (id) { var e = $id(id); return !!(e && e.offsetParent !== null); };
  // Decoy jQuery: a stale instance whose trigger() does nothing (models $.getScript replacing window.jQuery).
  window.jQuery = window.$ = function () { return { trigger: function () {}, val: function () { return ''; }, autocomplete: function () { throw new Error('stale jQuery'); } }; };
  window.jQuery.active = 0;
  window.McapsResponse = 'True';
  var api = function (url) { return fetch(url, { headers: { Accept: 'application/json' } }).then(function (r) { return r.json(); }); };
  fetch('/AzureSubscription/CheckPortalAccess').then(function (r) { if (!r.ok) location.href = '/VPNRequired/'; }, function () { location.href = '/VPNRequired/'; });
  var modal = function (title, body, id) {
    var s = document.createElement('section');
    s.id = id || 'myModalPopup'; s.className = 'modal fade in'; s.style.display = 'block';
    s.innerHTML = "<div class='modal-dialog'><div class='modal-content'><div class='modal-header'><h1 class='modal-title' title='" + title + "'>" + title + "</h1></div><div class='modal-body'>" + body + "</div><div class='modal-footer'><button id='btnftrClose' type='button' class='Close btn'>Ok</button></div></div></div>";
    s.querySelector('#btnftrClose').addEventListener('click', function () { s.style.display = 'none'; s.classList.remove('in'); });
    document.body.appendChild(s);
    return s;
  };
  var REQUIRED = ['apitil_title', 'desitsm_subscriptionpurposeaz', 'apitil_contact_name', 'desitsm_subscriptiontypes', 'desitsm_subscriptionowner', 'desitsm_eslabs_projectlevel', 'desitsm_monthlyspend', 'desitsm_timezonelist', 'desitsm_tenanttypes', 'desitsm_tenantlicensing', 'desitsm_tenantdisplayname'];
  if (C.extraRequired) REQUIRED.push(C.extraRequired);
  if (C.dup) REQUIRED.push(C.dup.id);
  // Live shape: a RequiredFieldValidator per control, message naming the label as rendered at load (or, with
  // drift.validatorLabel, the label the portal's validator still carries after a relabel).
  window.Page_Validators = REQUIRED.filter(function (id) { return !!$id(id); }).map(function (id) {
    var label = (C.validatorLabel && C.validatorLabel[id]) || ($id(id + '_label') || {}).textContent || id;
    return { controltovalidate: id, enabled: true, isvalid: true, errormessage: "<a href='#" + id + "_label' onclick='javascript:scrollToAndFocus(\"" + id + "_label\",\"" + id + "\");return false;' referenceControlId=" + id + ">" + label + " is a required field. </a>", _id: id };
  });
  window.Page_ClientValidate = function () {
    var msgs = [];
    window.Page_Validators.forEach(function (v) { var e = $id(v._id); v.isvalid = !(e && visible(v._id) && !String(e.value || '').trim()); if (!v.isvalid) msgs.push(v.errormessage); });
    var sum = $id('ValidationSummaryEntityFormView');
    sum.querySelector('ul').innerHTML = msgs.map(function (m) { return '<li>' + m + '</li>'; }).join('');
    sum.style.display = msgs.length ? '' : 'none';
    window.Page_IsValid = msgs.length === 0;
    return window.Page_IsValid;
  };
  window.entityFormClientValidate = function () { return true; };
  window.WebForm_OnSubmit = function () {
    // Hostile: page script rewrites the owner at serialization time (after every client-side check).
    if (C.tamperOwner) $id('itserv_businessmanageruserid').value = C.tamperOwner;
    // Hostile: a click-time script writes a business field nothing binds by id.
    if (C.clickTamper) $id(C.clickTamper.name).value = C.clickTamper.value;
    return window.Page_IsValid !== false;
  };
  window.WebForm_PostBackOptions = function (t, a, v) { this.eventTarget = t; this.validation = v; };
  window.WebForm_DoPostBackWithOptions = function (o) {
    if (o.validation && !window.Page_ClientValidate('')) return;
    var f = $id('liquid_form'); $id('__EVENTTARGET').value = o.eventTarget;
    if (f.onsubmit() !== false) f.submit();
  };
  window.checkUserTenantRequestForSubscriptionOnwer = function (guid, type) {
    return api("/_api/apitil_servicerequests?$filter=" + encodeURIComponent("statecode eq 0 and desitsm_subscriptiontypes eq " + type + " and (itserv_BusinessManagerContact/adx_identity_username eq '" + guid + "')"));
  };
  var clearOwner = function () { ['desitsm_subscriptionowner', 'itserv_businessmanageruserid', 'itserv_businessmanager', 'desitsm_eslabs_projectlevel', 'desitsm_eslabs_projectlevelemailid', 'desitsm_aduserguid'].forEach(function (i) { $id(i).value = ''; }); };
  var eligibility = function () {
    var guid = $id('itserv_businessmanageruserid').value, upn = $id('itserv_businessmanager').value;
    if (!guid) return Promise.resolve();
    return window.checkUserTenantRequestForSubscriptionOnwer(guid, $id('desitsm_subscriptiontypes').value).then(function (d) {
      if (d.value && d.value.length) { clearOwner(); modal('Alert', 'The subscription owner (' + upn + ') currently has active service requests in progress. Please wait for the existing requests to complete or close them before submitting a new one.'); }
    });
  };
  var purposeSel = $id('desitsm_subscriptionpurposeaz');
  [].slice.call(purposeSel.options).forEach(function (o) { if (o.value) { subscriptionPurposeOptions += o.outerHTML + '\n'; o.remove(); } });
  purposeSel.classList.add('ui-autocomplete-loading');
  setTimeout(function () { $id('pageLoaderOverlay').style.display = 'none'; }, C.loadDelayMs);
  setTimeout(function () {
    api('/_api/desitsm_billinginvoicesections').then(function (d) {
      purposeSel.classList.remove('ui-autocomplete-loading');
      if (!d.value.length) modal('Alert', 'No subscription purpose is available for your organization. Please contact the MCAPS Services team.');
      d.value.forEach(function (p) { var o = document.createElement('option'); o.value = p[0]; o.textContent = p[1]; purposeSel.appendChild(o); });
    });
  }, C.loadDelayMs + C.purposeDelayMs);
  $id('desitsm_subscriptionpurposeaz').addEventListener('change', function () {
    window.McapsResponse = 'True';
    var on = !!this.value;
    show('desitsm_subscriptiontypes', on); show('desitsm_subscriptionowner', on); show('desitsm_eslabs_projectlevel', on);
    $id('desitsm_subscriptionowner').value = on ? $id('apitil_contact_name').value : '';
    if (on) api('/AdGraphGroups/GetUserGroupMemberDetails').then(function (d) {
      if (!C.mcaps) { window.McapsResponse = 'False'; modal('Alert', 'You are not a member of the MCAPS security group.'); }
      else { $id('desitsm_eslabs_projectlevel').value = d.manager; }
    });
  });
  $id('desitsm_subscriptiontypes').addEventListener('change', function () {
    var t = this.value, internal = t === '444350000', external = t === '444350001';
    ['desitsm_monthlyspend', 'desitsm_timezonelist'].forEach(function (i) { show(i, internal); });
    ['desitsm_tenanttypes', 'desitsm_tenantlicensing', 'desitsm_tenantdisplayname'].forEach(function (i) { show(i, external); });
    if (C.extraRequired) show(C.extraRequired, internal);
    if (C.dup) show(C.dup.id, visible(C.dup.of));
    if (external) modal('Note', 'This section is for a dedicated tenant environment with trial licensing.');
    eligibility();
  });
  if ($id('desitsm_monthlyspend')) $id('desitsm_monthlyspend').addEventListener('change', function () { $id('desitsm_estimatedmonthlyspend').value = this.value; });
  var owner = $id('desitsm_subscriptionowner'), timer = null, menu = null;
  owner.addEventListener('input', function () {
    clearTimeout(timer);
    var q = owner.value;
    $id('itserv_businessmanageruserid').value = '';
    if (q.length < 3) return;
    timer = setTimeout(function () {
      api('/AdGraphUsers?displayName=' + encodeURIComponent(q)).then(function (d) {
        if (menu) menu.remove();
        menu = document.createElement('ul'); menu.className = 'ui-autocomplete ui-menu'; menu.style.display = 'block';
        d.value.forEach(function (u) {
          var li = document.createElement('li'); li.className = 'ui-menu-item';
          li.innerHTML = "<div class='ui-menu-item-wrapper'></div>"; li.firstChild.textContent = u.displayName + ';' + u.userPrincipalName;
          li.addEventListener('click', function () {
            owner.value = u.displayName; $id('itserv_businessmanageruserid').value = u.id; $id('itserv_businessmanager').value = u.userPrincipalName;
            menu.style.display = 'none';
            setTimeout(function () {
              api('/HeadTrax/?upn=' + encodeURIComponent(u.userPrincipalName)).then(function (h) {
                $id('desitsm_eslabs_projectlevel').value = h.manager; $id('desitsm_eslabs_projectlevelemailid').value = h.managerUpn;
                $id('desitsm_aduserguid').value = h.managerGuid; $id('desitsm_treeview').value = h.tree;
                if ($id('desitsm_subscriptiontypes').value === '444350000') eligibility();
              });
            }, 50);
          });
          menu.appendChild(li);
        });
        document.body.appendChild(menu);
      });
    }, 300);
  });
  $id('InsertButton').addEventListener('click', function (e) {
    if (owner.value && !$id('itserv_businessmanageruserid').value) { e.preventDefault(); e.stopImmediatePropagation(); modal('Alert', 'Subscription Owner must be selected from the suggested list.'); }
  });
  // Like live: the terms modal is a DETACHED element held in a global lexical const (agreeTermsModalPopup) and
  // only inserted into the DOM when shown; Accept is disabled until ticked.
  var terms = modal('Terms and Conditions', '<p>' + C.termsText + ' See <a href="https://aka.ms/mock-terms">policy</a>.</p><div class="form-check"><input type="checkbox" id="desitsm_agreetothetermsandconditionsOne" onclick="checkAgreeCheckBox(this);"><label for="desitsm_agreetothetermsandconditionsOne">I agree</label></div>', 'myAgreeTermsModalPopup');
  terms.style.display = 'none'; terms.classList.remove('in'); terms.remove(); window.__mockTerms = terms;
  var acceptBtn = terms.querySelector('#btnftrClose'); acceptBtn.textContent = 'Accept'; acceptBtn.disabled = true; acceptBtn.setAttribute('onclick', 'showHideSubmitButton()');
  window.showTermsAndConditionModal = function () { if (!terms.isConnected) document.body.appendChild(terms); terms.style.display = 'block'; terms.classList.add('in'); };
  window.checkAgreeCheckBox = function () { var on = $id('desitsm_agreetothetermsandconditionsOne').checked; $id('desitsm_agreetothetermsandconditions').checked = on; acceptBtn.disabled = !on; if (!on) $id('InsertButton').disabled = true; };
  window.showHideSubmitButton = function () {
    var ok = $id('desitsm_agreetothetermsandconditionsOne').checked && window.McapsResponse === 'True';
    $id('InsertButton').disabled = !ok; $id('desitsm_agreetothetermsandconditions').checked = ok;
  };
})();
const agreeTermsModalPopup = { 0: window.__mockTerms, length: 1 };
delete window.__mockTerms;
`;

export async function startMockPortal(overrides = {}) {
  const cfg = { ...DEFAULTS, ...overrides, drift: { ...DEFAULTS.drift, ...(overrides.drift ?? {}) } };
  const state = { submissions: [], records: [...(overrides.records ?? [])], writes: [], requests: 0, config: cfg };
  let seq = 170000;
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  const json = (res, obj, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  const html = (res, body, status = 200, headers = {}) => { res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers }); res.end(body); };
  const authed = (req) => !cfg.auth || /mockauth=1/.test(req.headers.cookie ?? '');
  const userBy = (pred) => cfg.users.find(pred);
  const activeFor = (guid) => (cfg.activeOwners.includes(userBy((u) => u.guid === guid)?.upn) ? [{ apitil_requestnumber: 'REQ-111111-2026', statuscode: 345550000 }] : []);
  const isApi = (p) => /^\/(_api|AdGraph|HeadTrax|AzureSubscription)/.test(p);

  const server = http.createServer(async (req, res) => {
    state.requests++;
    if (cfg.hangPages) return;
    const u = new URL(req.url, 'http://x');
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) state.writes.push({ method: req.method, path: u.pathname });
    if (u.pathname === '/mock-portal.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(renameIds(cfg.drift, PAGE_JS)); }
    if (u.pathname === '/SignIn') return html(res, `<html><body><form method="post" action="/Account/Login/ExternalLogin?returnUrl=${encodeURIComponent(u.searchParams.get('returnUrl') ?? '/')}"><button name="provider" type="submit" value="https://login.example/">Sign in</button></form></body></html>`);
    if (u.pathname === '/Account/Login/ExternalLogin') { res.writeHead(302, { 'set-cookie': 'mockauth=1; Path=/; HttpOnly', location: u.searchParams.get('returnUrl') || '/' }); return res.end(); }
    if (!authed(req)) {
      if (isApi(u.pathname)) return json(res, { error: 'unauthorized' }, 401);
      res.writeHead(302, { location: `/SignIn?returnUrl=${encodeURIComponent(u.pathname + u.search)}` }); return res.end();
    }
    if (isApi(u.pathname)) await delay(cfg.apiDelayMs);
    if (u.pathname === '/_api/desitsm_billinginvoicesections') return json(res, { value: cfg.purposes });
    if (u.pathname === '/AzureSubscription/CheckPortalAccess') { await delay(cfg.vpnDelayMs); return cfg.vpnFail ? json(res, { error: 'vpn' }, 403) : json(res, { ok: true }); }
    if (u.pathname === '/VPNRequired/') return html(res, '<html><body><h1>VPN Required</h1><p>Please connect to the corporate network.</p></body></html>');
    if (u.pathname === '/AdGraphGroups/GetUserGroupMemberDetails') return json(res, { Message: cfg.mcaps ? 'True' : 'False', manager: userBy((x) => x.upn === cfg.me.upn)?.manager.display ?? '' });
    if (u.pathname === '/AdGraphUsers') {
      const q = (u.searchParams.get('displayName') ?? '').toLowerCase();
      return json(res, { value: cfg.users.filter((x) => x.display.toLowerCase().includes(q) || x.upn.toLowerCase().startsWith(q)).map((x) => ({ id: x.guid, displayName: x.display, userPrincipalName: x.upn })) });
    }
    if (u.pathname === '/HeadTrax/') {
      const x = userBy((y) => y.upn === u.searchParams.get('upn'));
      return json(res, { manager: x?.manager.display ?? '', managerUpn: x?.manager.upn ?? '', managerGuid: `mgr-${x?.manager.upn ?? 'none'}`, tree: `CEO==>${x?.manager.display}` });
    }
    if (u.pathname === '/_api/apitil_servicerequests' && req.method === 'GET') {
      const f = u.searchParams.get('$filter') ?? '';
      const owner = f.match(/adx_identity_username eq '([^']+)'/);
      if (owner) return json(res, { value: activeFor(owner[1]) });
      if (cfg.apiFailAfterPost && state.submissions.length) return json(res, { error: { message: 'service unavailable' } }, 503);
      const contact = f.match(/_apitil_contact_value eq ([0-9a-f-]{36})/);
      const num = f.match(/apitil_requestnumber eq '([^']+)'/);
      const top = Number(u.searchParams.get('$top')) || 5000;
      return json(res, { value: state.records.filter((r) => (!contact || r._apitil_contact_value === contact[1]) && (!num || r.apitil_requestnumber === num[1]) && !(cfg.hideCreated && r._fields)).slice(0, top).map(({ _fields, ...r }) => r) });
    }
    if (u.pathname === '/' && req.method === 'GET') return html(res, `<html><body><script>window.Microsoft={Dynamic365:{Portal:{User:{contactId:'${cfg.me.contactId}',email:'${cfg.me.upn}',userName:'${cfg.me.upn}'}}}};</script>Home</body></html>`);
    if (u.pathname === FORM_PATH && u.searchParams.get('ServiceId') === SERVICE) {
      if (req.method === 'GET') return html(res, page(cfg));
      if (req.method === 'POST') {
        const fd = await new Response(body, { headers: { 'content-type': req.headers['content-type'] ?? '' } }).formData();
        const fields = Object.fromEntries([...fd.entries()].map(([k, v]) => [k.startsWith(P) ? k.slice(P.length) : k, typeof v === 'string' ? v : '<file>']));
        state.submissions.push(fields);
        // Posted fields keep their (possibly renamed) names; the oracle reads them through the rename.
        const get = (k) => fields[cfg.drift.rename?.[k] ?? k];
        const problems = [];
        if (fields.__EVENTTARGET !== INSERT) problems.push('bad event target');
        if (!get('apitil_title')) problems.push('Title is a required field.');
        if (!get('itserv_businessmanageruserid')) problems.push('Subscription Owner is a required field.');
        if (get('desitsm_agreetothetermsandconditions') !== 'on') problems.push('You must agree to the terms.');
        if (Object.entries(fields).some(([k, v]) => k.startsWith('frm_pref_') && v)) problems.push('honeypot');
        if (cfg.submitMode === 'reject' || problems.length) { state.lastProblems = problems; return html(res, page(cfg, { error: problems[0] ?? 'Subscription Owner is invalid.' })); }
        if (cfg.submitMode === 'drop-norecord') { req.socket.destroy(); return; }
        const num = `REQ-${++seq}-2026`;
        state.records.unshift({ apitil_servicerequestid: randomUUID(), apitil_requestnumber: num, apitil_name: `${num} - ${fields.apitil_title}`, statuscode: 345550000, 'statuscode@OData.Community.Display.V1.FormattedValue': 'Awaiting Approval', statecode: 0, createdon: new Date().toISOString(), _apitil_contact_value: cfg.me.contactId, _fields: fields });
        if (cfg.submitMode === 'error500') return html(res, '<h1>Server Error</h1>', 500);
        if (cfg.submitMode === 'drop') { req.socket.destroy(); return; }
        res.writeHead(302, { location: `/support/request/?id=${randomInt(1e6)}&num=${num}` }); return res.end();
      }
    }
    if (u.pathname === '/support/request/') return html(res, `<html><body><h1>Thank you</h1><p>Your request ${u.searchParams.get('num')} has been submitted.</p></body></html>`);
    html(res, 'not found', 404);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, formUrl: `${origin}${FORM_PATH}?ServiceId=${SERVICE}`, state, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}

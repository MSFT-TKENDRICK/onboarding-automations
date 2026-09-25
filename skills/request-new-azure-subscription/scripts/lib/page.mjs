// In-page primitives. Every export is a SELF-CONTAINED function (no module-scope references): it is
// serialized with Function.prototype.toString and evaluated inside the portal page via CDP.
// Rules: native DOM events only (the portal reloads jQuery, so jQuery(...).trigger reaches a stale
// instance with no handlers); never call postback / submit functions from here.

// Installed with Page.addScriptToEvaluateOnNewDocument: records every modal that becomes visible.
export function installRecorder() {
  if (window.__mcaps) return;
  const rec = { modals: [], visible: new Set(), scheduled: false };
  window.__mcaps = rec;
  const txt = (s) => (s || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  const scan = () => {
    rec.scheduled = false;
    const now = new Set();
    for (const m of document.querySelectorAll('section.modal, div.modal')) {
      if (getComputedStyle(m).display === 'none') continue;
      const title = txt(m.querySelector('.modal-title')?.textContent);
      const body = txt(m.querySelector('.modal-body')?.textContent);
      if (!title && !body) continue;
      const key = `${m.id}|${title}|${body.slice(0, 400)}`;
      now.add(key);
      if (!rec.visible.has(key)) rec.modals.push({ id: m.id || null, title, body: body.slice(0, 2000), t: Math.round(performance.now()) });
    }
    rec.visible = now;
  };
  const schedule = () => { if (!rec.scheduled) { rec.scheduled = true; setTimeout(scan, 0); } };
  rec.scan = scan;
  new MutationObserver(schedule).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['style', 'class'] });
}

export function pageState() {
  const txt = (s) => (s || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  const form = document.getElementById('liquid_form');
  const overlay = document.getElementById('pageLoaderOverlay');
  // Expected id first; otherwise the unique form select labelled as the subscription purpose (renamed control).
  let purpose = document.getElementById('desitsm_subscriptionpurposeaz');
  if (!purpose && form) {
    const hits = [...form.querySelectorAll('select')].filter((s) => s.id && /subscription purpose/i.test(txt((document.getElementById(`${s.id}_label`) || document.querySelector(`label[for="${s.id}"]`))?.textContent)));
    purpose = hits.length === 1 ? hits[0] : null;
  }
  return {
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    signIn: !!document.querySelector('button[name="provider"]'),
    hasForm: !!form,
    overlay: !!overlay && getComputedStyle(overlay).display !== 'none',
    purposeOptions: purpose ? [...purpose.options].filter((o) => o.value).length : 0,
    purposeId: purpose?.id ?? null,
    // Portal init strips the server-rendered purposes (capturing them in a global) and marks the select loading
    // until the allowed ones are re-added (~5 s later). null = marker unavailable (portal changed).
    // eslint-disable-next-line no-undef
    purposeInit: typeof subscriptionPurposeOptions === 'undefined' ? null : String(subscriptionPurposeOptions).length > 0,
    purposeLoading: !!purpose && purpose.classList.contains('ui-autocomplete-loading'),
    contactId: document.getElementById('apitil_contact')?.value || window.Microsoft?.Dynamic365?.Portal?.User?.contactId || null,
    userEmail: window.Microsoft?.Dynamic365?.Portal?.User?.email || window.Microsoft?.Dynamic365?.Portal?.User?.userName || null,
    insertEnabled: !!document.getElementById('InsertButton') && !document.getElementById('InsertButton').disabled,
    mcaps: typeof McapsResponse === 'undefined' ? null : String(McapsResponse),
    summary: txt(document.querySelector('.validation-summary')?.offsetParent ? document.querySelector('.validation-summary').textContent : ''),
    bodyText: form ? '' : txt(document.body?.innerText).slice(0, 1500),
  };
}

// verify: what Microsoft.Dynamic365.Portal.User exposes (the owner default reads email, else userName). Read-only.
export function portalUser() {
  const portal = window.Microsoft?.Dynamic365?.Portal;
  const u = portal?.User;
  const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  return { portal: !!portal, object: !!u && typeof u === 'object', email: str(u?.email), userName: str(u?.userName) };
}

// verify: per control id, how many elements carry it and the label the driver would read for it. `associated` is
// true only when a label is found and every label pointing at the control (<id>_label, label[for]) reads the same.
export function controlEvidence(ids) {
  const txt = (s) => (s || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  const out = {};
  for (const id of ids) {
    const esc = window.CSS?.escape ? CSS.escape(id) : id;
    const exact = document.querySelectorAll(`[id="${esc}"]`).length;
    const count = exact || (document.querySelector(`input[type="radio"][id^="${esc}_"]`) ? 1 : 0);
    const labels = [...new Set([document.getElementById(`${id}_label`), ...document.querySelectorAll(`label[for="${esc}"]`)].filter(Boolean))];
    const texts = [...new Set(labels.map((l) => txt(l.textContent)))];
    out[id] = { count, label: texts[0] ?? null, associated: labels.length > 0 && texts.length === 1 };
  }
  return out;
}

export function clickSignIn() {
  const b = document.querySelector('button[name="provider"]');
  if (!b) return false;
  b.click();
  return true;
}

// Visible form contract: fields with labels, values, options, required flags.
export function snapshotFields() {
  const txt = (s) => (s || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  const vis = (el) => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const required = new Set();
  for (const v of window.Page_Validators || []) {
    if (v.enabled === false) continue;
    if (v.controltovalidate) required.add(v.controltovalidate);
    const m = /setFocusAndScrollPosition\(\s*['"]?([\w-]+)/.exec(v.errormessage || '');
    if (m) required.add(m[1]);
  }
  const fields = [];
  const seen = new Set();
  for (const el of document.querySelectorAll('#liquid_form input, #liquid_form select, #liquid_form textarea')) {
    if (!el.id || ['hidden', 'submit', 'button', 'image', 'file'].includes(el.type)) continue;
    const id = el.type === 'radio' ? el.id.replace(/_\d+$/, '') : el.id;
    if (seen.has(id) || /^frm_pref_/.test(id)) continue;
    seen.add(id);
    const labelEl = document.getElementById(`${id}_label`) || document.querySelector(`label[for="${id}"]`);
    const f = { id, name: el.name || '', tag: el.tagName.toLowerCase(), type: el.type, label: txt(labelEl?.textContent), visible: vis(el), readonly: !!(el.readOnly || el.disabled), required: required.has(id), value: el.type === 'radio' ? (document.querySelector(`input[name="${el.name}"]:checked`)?.value ?? '') : el.value };
    if (el.tagName === 'SELECT') { f.options = [...el.options].map((o) => ({ value: o.value, label: txt(o.text) })); f.text = txt(el.selectedOptions[0]?.text); }
    if (el.type === 'radio') f.options = [...document.querySelectorAll(`input[name="${el.name}"]`)].map((r) => ({ value: r.value, label: txt(document.querySelector(`label[for="${r.id}"]`)?.textContent) }));
    if (el.type === 'checkbox') f.value = el.checked ? 'true' : 'false';
    fields.push(f);
  }
  return fields;
}

export function readValues(ids) {
  const out = {};
  for (const id of ids) {
    const el = document.getElementById(id);
    if (!el) { out[id] = null; continue; }
    out[id] = el.type === 'checkbox' ? el.checked : el.value;
  }
  return out;
}

// Set a select/text/radio value and dispatch native events the portal's (fresh) jQuery listens to.
export function setField(id, value) {
  // Power Pages radio lists wrap the options (`${id}_<n>`) in a container that carries the synthetic id itself.
  let el = document.getElementById(id);
  if (el && !['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName)) el = null;
  el = el || [...document.querySelectorAll('#liquid_form input[type=radio]')].find((r) => r.id.startsWith(`${id}_`) && /^\d+$/.test(r.id.slice(id.length + 1)));
  if (!el) return { ok: false, error: 'not_found' };
  if (el.type === 'radio') {
    const r = [...document.querySelectorAll('#liquid_form input[type=radio]')].find((x) => x.name === el.name && x.value === value);
    if (!r) return { ok: false, error: 'no_option' };
    r.click();
    return { ok: r.checked, value: r.value };
  }
  if (el.tagName === 'SELECT' && ![...el.options].some((o) => o.value === value)) return { ok: false, error: 'no_option' };
  const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  el.focus?.();
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  el.dispatchEvent(new Event('blur', { bubbles: false }));
  el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  return { ok: el.value === value, value: el.value };
}

// Re-dispatch change for a field without altering its value (re-runs portal eligibility handlers).
export function redispatch(id) {
  const el = document.getElementById(id);
  if (!el || !el.value) return false;
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}

// Type into the owner autocomplete and wait for visible suggestions.
export async function ownerSuggestions(id, term, timeoutMs) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const el = document.getElementById(id);
  if (!el) return { ok: false, error: 'not_found' };
  for (const li of document.querySelectorAll('ul.ui-autocomplete li.ui-menu-item')) li.setAttribute('data-mcaps-stale', '1');
  el.focus();
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, term);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'a', keyCode: 65 }));
  const t0 = performance.now();
  while (performance.now() - t0 < timeoutMs) {
    await sleep(50);
    const items = [...document.querySelectorAll('ul.ui-autocomplete li.ui-menu-item')].filter((li) => li.offsetParent !== null && !li.hasAttribute('data-mcaps-stale'));
    if (items.length) {
      await sleep(60);
      const settled = [...document.querySelectorAll('ul.ui-autocomplete li.ui-menu-item')].filter((li) => li.offsetParent !== null && !li.hasAttribute('data-mcaps-stale'));
      return { ok: true, ms: Math.round(performance.now() - t0), items: settled.map((li) => (li.innerText || li.textContent).replace(/\s+/g, ' ').trim()) };
    }
  }
  return { ok: false, error: 'no_suggestions', ms: Math.round(performance.now() - t0) };
}

export async function pickSuggestion(text, guidId, timeoutMs) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const li = [...document.querySelectorAll('ul.ui-autocomplete li.ui-menu-item')].find((x) => x.offsetParent !== null && !x.hasAttribute('data-mcaps-stale') && (x.innerText || x.textContent).replace(/\s+/g, ' ').trim() === text);
  if (!li) return { ok: false, error: 'suggestion_gone' };
  const target = li.querySelector('.ui-menu-item-wrapper') || li;
  for (const type of ['mouseover', 'mouseenter', 'mousemove']) target.dispatchEvent(new MouseEvent(type, { bubbles: true }));
  target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  const t0 = performance.now();
  while (performance.now() - t0 < timeoutMs) {
    const g = document.getElementById(guidId)?.value;
    if (g) return { ok: true, guid: g, ms: Math.round(performance.now() - t0) };
    await sleep(40);
  }
  return { ok: false, error: 'owner_not_bound' };
}

// Portal eligibility check (active requests for owner+type). Uses the page's own query when present.
export async function checkEligibility(guid, type) {
  try {
    if (typeof checkUserTenantRequestForSubscriptionOnwer !== 'function') return { ok: false, error: 'eligibility_function_missing' };
    // eslint-disable-next-line no-undef
    const d = await checkUserTenantRequestForSubscriptionOnwer(guid, type);
    const rows = (d && d.value) || [];
    return { ok: true, active: rows.map((r) => ({ number: r.apitil_requestnumber || null, name: r.apitil_name || null, status: r.statuscode ?? null })) };
  } catch (e) {
    return { ok: false, error: String(e && (e.statusText || e.message) || e) };
  }
}

export function takeModals() {
  const rec = window.__mcaps;
  if (!rec || typeof rec.scan !== 'function') return [];
  rec.scan();
  const out = rec.modals.splice(0);
  return out;
}

// Cosmetically dismiss visible non-terms modals without invoking any of their handlers.
export function hideModals() {
  let n = 0;
  for (const m of document.querySelectorAll('section.modal, div.modal')) {
    if (m.id === 'myAgreeTermsModalPopup' || getComputedStyle(m).display === 'none') continue;
    m.style.display = 'none'; m.classList.remove('in', 'show'); n++;
  }
  document.querySelectorAll('.modal-backdrop').forEach((b) => b.remove());
  document.body.classList.remove('modal-open');
  window.__mcaps?.scan();
  return n;
}

export function readTerms() {
  // Live portal keeps the modal detached (global lexical const) until it is first shown.
  // eslint-disable-next-line no-undef
  const detached = typeof agreeTermsModalPopup !== 'undefined' ? agreeTermsModalPopup[0] : null;
  const m = document.getElementById('myAgreeTermsModalPopup') || detached || document.querySelector('[id*=AgreeTerms i]');
  if (!m) return { ok: false, error: 'terms_not_found' };
  const body = m.querySelector('.modal-body') || m;
  const text = (body.innerText && body.offsetParent ? body.innerText : body.textContent).replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
  const links = [...body.querySelectorAll('a[href]')].map((a) => a.href).filter((h) => /^https?:/.test(h));
  return { ok: true, text: body.textContent.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim(), display: text, links };
}

// Page_Validators as {control, message, enabled}. Read-only: no clicks, no writes, no network. Messages are the
// complete plain text (never truncated: a proof must see every label a message names).
export function validatorIndex() {
  const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  const text = (s) => String(s ?? '').replace(/<[^>]*>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
      if (e[0] !== '#') return ENT[e.toLowerCase()] ?? m;
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    })
    .replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  const off = (v) => v.enabled === false || /^(false|0)$/i.test(String(v.enabled ?? '').trim());
  const out = [];
  for (const v of window.Page_Validators || []) {
    if (!v || typeof v.controltovalidate !== 'string' || !v.controltovalidate) continue;
    out.push({ control: v.controltovalidate, message: text(v.errormessage), enabled: !off(v) });
  }
  return out;
}

// Client-side validation dry run. Never posts.
export function validate() {
  const txt = (s) => (s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  let efv = null;
  let pcv = null;
  try { efv = typeof entityFormClientValidate === 'function' ? !!entityFormClientValidate() : null; } catch (e) { efv = `error: ${e.message}`; }
  try { pcv = typeof Page_ClientValidate === 'function' ? !!Page_ClientValidate('') : null; } catch (e) { pcv = `error: ${e.message}`; }
  const failures = (window.Page_Validators || []).filter((v) => v.isvalid === false).map((v) => {
    const m = /setFocusAndScrollPosition\(\s*['"]?([\w-]+)/.exec(v.errormessage || '');
    return { id: v.controltovalidate || (m && m[1]) || null, message: txt(v.errormessage) };
  });
  return { ok: efv === true && pcv === true && failures.length === 0, efv, pcv, failures };
}

// Terms acceptance through the real UI controls (link -> checkbox -> Accept). Submit flow only.
export async function acceptTerms() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const link = [...document.querySelectorAll('a')].find((a) => /showTermsAndConditionModal/.test(a.getAttribute('onclick') || ''));
  if (!link) return { ok: false, error: 'terms_link_missing' };
  link.click();
  const find = () => document.getElementById('myAgreeTermsModalPopup');
  let modal = find();
  for (let i = 0; i < 60 && !(modal && getComputedStyle(modal).display !== 'none'); i++) { await sleep(50); modal = find(); }
  if (!modal || getComputedStyle(modal).display === 'none') return { ok: false, error: 'terms_modal_not_shown' };
  await sleep(250);
  const cb = modal.querySelector('#desitsm_agreetothetermsandconditionsOne') || document.getElementById('desitsm_agreetothetermsandconditionsOne');
  if (!cb) return { ok: false, error: 'terms_checkbox_missing' };
  if (!cb.checked) cb.click();
  if (!cb.checked) return { ok: false, error: 'terms_checkbox_unchecked' };
  const accept = modal.querySelector('#btnftrClose') || [...modal.querySelectorAll('button')].find((b) => /accept/i.test(b.textContent));
  if (!accept) return { ok: false, error: 'terms_accept_missing' };
  if (accept.disabled) return { ok: false, error: 'terms_accept_disabled' };
  accept.click();
  await sleep(100);
  const insert = document.getElementById('InsertButton');
  const hiddenCb = document.getElementById('desitsm_agreetothetermsandconditions');
  return { ok: !!insert && !insert.disabled && (!hiddenCb || hiddenCb.checked), insertEnabled: !!insert && !insert.disabled, agreed: hiddenCb ? hiddenCb.checked : null };
}

export function insertButtonInfo() {
  const b = document.getElementById('InsertButton');
  return b ? { name: b.getAttribute('name'), disabled: b.disabled, onclickPostback: /WebForm_DoPostBackWithOptions/.test(b.getAttribute('onclick') || '') } : null;
}

// Native click on the real submit button. Called ONLY after the one-shot gate is armed.
export function clickInsert() {
  const b = document.getElementById('InsertButton');
  if (!b || b.disabled) return false;
  setTimeout(() => b.click(), 0);
  return true;
}

// Name/value pairs the browser will serialize for these field ids (mirrors HTML form serialization: controls outside
// the form, disabled controls, unchecked boxes and selects without a selection are never posted; newlines are CRLF).
// A radio group is addressed by its synthetic id (the option ids are `${id}_<n>` and must share one name).
export function formBinding(ids) {
  const out = [];
  const form = document.getElementById('liquid_form');
  for (const id of ids) {
    let el = document.getElementById(id);
    if (el && !['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName)) el = null;
    if (!el && form) {
      const group = [...form.querySelectorAll('input[type=radio]')].filter((r) => r.id.startsWith(`${id}_`) && /^\d+$/.test(r.id.slice(id.length + 1)));
      if (!group.length || new Set(group.map((r) => r.name)).size !== 1) continue;
      el = group.find((r) => r.checked);
      if (!el) continue;
    }
    if (!el || !el.name || el.disabled || (form && el.form !== form)) continue;
    if (el.type === 'checkbox' || el.type === 'radio') { if (el.checked) out.push([el.name, el.value || 'on']); continue; }
    if (el.tagName === 'SELECT' && el.selectedIndex < 0) continue;
    out.push([el.name, String(el.value).replace(/\r?\n|\r/g, '\r\n')]);
  }
  return out;
}

// Everything the browser would serialize for #liquid_form right now (submitter excluded), in document order.
// Any non-empty file control is flagged: this skill never uploads files, so the caller refuses to submit.
export function serializeForm() {
  const form = document.getElementById('liquid_form');
  if (!form) return { ok: false, error: 'no_form' };
  const pairs = [];
  let files = false;
  for (const [name, value] of new FormData(form)) {
    if (typeof value !== 'string') { if (value.name || value.size) files = true; pairs.push([name, '']); continue; }
    pairs.push([name, value.replace(/\r?\n|\r/g, '\r\n')]);
  }
  return { ok: true, pairs, files };
}

// Parse a post-submit page for case ids, validation errors and modals.
export function parseOutcome() {
  const txt = (s) => (s || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  const body = txt(document.body?.innerText || '');
  const ids = [...new Set(body.match(/REQ-\d{6}-\d{4}/g) || [])];
  const summaryEl = document.querySelector('.validation-summary');
  const shown = summaryEl && getComputedStyle(summaryEl).display !== 'none';
  const summary = shown ? txt(summaryEl.textContent) : '';
  // Field-level messages: one per summary entry, plus visible per-field validators.
  const errors = [];
  if (shown) for (const li of summaryEl.querySelectorAll('li')) { const m = txt(li.textContent); if (m) errors.push({ field: li.querySelector('a[href^="#"]')?.getAttribute('href').slice(1) || null, message: m }); }
  for (const v of document.querySelectorAll('span.validator, span[id$="Validator"]')) {
    const m = txt(v.textContent);
    if (m && getComputedStyle(v).display !== 'none' && getComputedStyle(v).visibility !== 'hidden' && !errors.some((e) => e.message === m)) errors.push({ field: v.getAttribute('controltovalidate') || null, message: m });
  }
  if (summary && !errors.length) errors.push({ field: null, message: summary });
  return { url: location.href, title: document.title, caseIds: ids, validationSummary: summary, errors, hasForm: !!document.getElementById('liquid_form'), excerpt: body.slice(0, 600) };
}

// Own service requests via the Power Pages Web API (session cookie). Filtered by the caller's contact id.
export async function listOwnRequests(contactId, sinceIso, top, caseId) {
  if (!/^[0-9a-f-]{36}$/i.test(contactId || '')) return { ok: false, error: 'bad_contact' };
  if (caseId && !/^REQ-\d{6}-\d{4}$/.test(caseId)) return { ok: false, error: 'bad_case' };
  const filter = `_apitil_serviceid_value eq 78b2e66c-42f2-e811-a96a-000d3a30da4f and _apitil_contact_value eq ${contactId}${sinceIso ? ` and createdon ge ${sinceIso}` : ''}${caseId ? ` and apitil_requestnumber eq '${caseId}'` : ''}`;
  const q = `$select=apitil_name,statuscode,statecode,apitil_requestnumber,createdon,apitil_servicerequestid&$filter=${filter}&$orderby=createdon desc&$top=${top || 10}`;
  try {
    const r = await fetch(`/_api/apitil_servicerequests?${encodeURI(q)}`, { headers: { Accept: 'application/json', Prefer: 'odata.include-annotations="OData.Community.Display.V1.FormattedValue"' }, credentials: 'same-origin' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, status: r.status, error: j?.error?.message || r.statusText };
    return { ok: true, rows: (j.value || []).map((v) => ({ caseId: v.apitil_requestnumber, name: v.apitil_name, status: v['statuscode@OData.Community.Display.V1.FormattedValue'] || String(v.statuscode), active: v.statecode === 0, createdOn: v.createdon, id: v.apitil_servicerequestid })) };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

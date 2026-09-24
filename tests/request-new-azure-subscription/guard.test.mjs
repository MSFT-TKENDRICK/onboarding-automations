import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGuard } from '../../skills/request-new-azure-subscription/scripts/lib/guard.mjs';

const FORM = 'https://portal.example.com/support/eslabs-newazuresubscription/?ServiceId=abc';
const g = () => createGuard({ formUrl: FORM });
const req = (method, url, resourceType = 'XHR') => ({ method, url, resourceType });

test('GETs to portal are allowed', () => {
  assert.equal(g().classify(req('GET', 'https://portal.example.com/_api/contacts')).action, 'continue');
});

test('portal writes are blocked by default', () => {
  const guard = g();
  const r = guard.classify(req('POST', FORM, 'Document'));
  assert.equal(r.action, 'fail');
  assert.equal(r.reason, 'blocked-write');
  assert.equal(guard.stats().blockedWrites.length, 1);
});

test('auth endpoints are allowed to write', () => {
  const guard = g();
  for (const p of ['/_services/auth/token', '/Account/Login/ExternalLogin?returnUrl=x', '/', '/signin-openid_1']) {
    assert.equal(guard.classify(req('POST', `https://portal.example.com${p}`)).action, 'continue', p);
  }
});

test('writes to unknown hosts are blocked; identity hosts allowed', () => {
  const guard = g();
  assert.equal(guard.classify(req('POST', 'https://westus-0.in.applicationinsights.azure.com/v2/track')).action, 'fail');
  assert.equal(guard.classify(req('POST', 'https://api.example.net/AdGraphUsers')).action, 'fail');
  assert.equal(guard.classify(req('POST', 'https://login.microsoftonline.com/common/GetCredentialType')).action, 'continue');
  assert.equal(guard.classify(req('OPTIONS', 'https://api.example.net/AdGraphUsers')).action, 'continue');
});

test('armed submit gate lets exactly one form POST through', () => {
  const guard = g();
  guard.armSubmit();
  assert.equal(guard.classify(req('POST', FORM, 'Document')).action, 'continue');
  const second = guard.classify(req('POST', FORM, 'Document'));
  assert.equal(second.action, 'fail');
  assert.equal(second.reason, 'blocked-write');
  assert.equal(guard.stats().submitsSent, 1);
});

test('submit gate only matches the form path', () => {
  const guard = g();
  guard.armSubmit();
  assert.equal(guard.classify(req('POST', 'https://portal.example.com/_api/apitil_servicerequests', 'Document')).action, 'fail');
  assert.equal(guard.classify(req('POST', 'https://evil.example.com/support/eslabs-newazuresubscription/', 'Document')).action, 'fail');
  assert.equal(guard.classify(req('POST', FORM, 'Document')).action, 'continue');
});

test('disarm closes the gate', () => {
  const guard = g();
  guard.armSubmit();
  guard.disarm();
  assert.equal(guard.classify(req('POST', FORM, 'Document')).action, 'fail');
});

test('armed gate verifies the body carries the planned markers', () => {
  const guard = g();
  guard.armSubmit({ mustContain: ['InsertButton', 'My Title'] });
  const wrong = guard.classify({ ...req('POST', FORM, 'Document'), postData: '__EVENTTARGET=Other&title=My Title' });
  assert.equal(wrong.action, 'fail');
  assert.equal(wrong.reason, 'submit-body-mismatch');
  const missing = guard.classify(req('POST', FORM, 'Document'));
  assert.equal(missing.reason, 'submit-body-unverified');
  const good = guard.classify({ ...req('POST', FORM, 'Document'), postData: 'x=InsertButton&t=My Title' });
  assert.equal(good.action, 'continue');
  assert.equal(good.reason, 'submit');
  assert.equal(guard.classify({ ...req('POST', FORM, 'Document'), postData: 'x=InsertButton&t=My Title' }).action, 'fail');
});

test('gate markers match decoded field names/values of a urlencoded body', () => {
  const guard = g();
  const btn = 'ctl00$ContentContainer$InsertButton';
  guard.armSubmit({ mustContain: [btn], mustEqual: [['t', 'a$b']] });
  const body = new URLSearchParams([['__EVENTTARGET', btn], ['t', 'a$b']]).toString();
  assert.ok(!body.includes(btn), 'precondition: $ is percent-encoded');
  const r = guard.classify({ ...req('POST', FORM, 'Document'), postData: body, contentType: 'application/x-www-form-urlencoded' });
  assert.equal(r.reason, 'submit');
});

test('gate rejects non-document or subframe submits', () => {
  const guard = g();
  guard.armSubmit();
  assert.equal(guard.classify({ ...req('POST', FORM, 'XHR') }).action, 'fail');
  assert.equal(guard.classify({ ...req('POST', FORM, 'Document'), isMainFrame: false }).action, 'fail');
  assert.equal(guard.classify(req('POST', FORM, 'Document')).action, 'continue');
});

test('images, fonts, media and telemetry are blocked for speed', () => {
  const guard = g();
  assert.equal(guard.classify(req('GET', 'https://portal.example.com/logo.png', 'Image')).reason, 'blocked-resource');
  assert.equal(guard.classify(req('GET', 'https://cdn.example.com/x.woff2', 'Font')).reason, 'blocked-resource');
  assert.equal(guard.classify(req('GET', 'https://www.clarity.ms/tag/abc', 'Script')).reason, 'blocked-resource');
  // Application Insights SDK loader and every CDN fallback host it retries (live: ~4 s script load).
  for (const h of ['js.cdn.applicationinsights.io', 'js0.cdn.applicationinsights.io', 'js.monitor.azure.com', 'js2.cdn.monitor.azure.com', 'az416426.vo.msecnd.net']) {
    assert.equal(guard.classify(req('GET', `https://${h}/scripts/b/ai.3.gbl.min.js`, 'Script')).reason, 'blocked-resource', h);
  }
  assert.equal(guard.classify(req('GET', 'https://other.vo.msecnd.net/lib.js', 'Script')).action, 'continue');
  assert.equal(guard.classify(req('GET', 'https://portal.example.com/app.css', 'Stylesheet')).action, 'continue');
  assert.equal(guard.classify(req('GET', 'https://portal.example.com/app.js', 'Script')).action, 'continue');
});

test('resource blocking can be disabled', () => {
  const guard = createGuard({ formUrl: FORM, blockResources: false });
  assert.equal(guard.classify(req('GET', 'https://portal.example.com/logo.png', 'Image')).action, 'continue');
});

test('non-http schemes are ignored', () => {
  assert.equal(g().classify(req('POST', 'data:text/plain,hi')).action, 'continue');
});

test('stats never include request bodies', () => {
  const guard = g();
  guard.classify({ ...req('POST', FORM, 'Document'), postData: 'secret' });
  assert.equal(JSON.stringify(guard.stats()).includes('secret'), false);
});

test('armed gate requires every bound field to be posted with exactly the verified value', () => {
  const body = (o) => new URLSearchParams(o).toString();
  const bind = [['p$owner', '1111-guid'], ['p$type', '1'], ['p$title', 'My Title']];
  const guard = g();
  guard.armSubmit({ mustEqual: bind });
  const swapped = guard.classify({ ...req('POST', FORM, 'Document'), postData: body({ 'p$owner': '2222-guid', 'p$type': '1', 'p$title': 'My Title' }) });
  assert.equal(swapped.action, 'fail');
  assert.equal(swapped.reason, 'submit-body-mismatch');
  assert.deepEqual(guard.stats().blockedWrites.at(-1).fields, ['p$owner']);
  assert.ok(!JSON.stringify(guard.stats()).includes('2222'), 'values are never recorded');
  const dropped = guard.classify({ ...req('POST', FORM, 'Document'), postData: body({ 'p$type': '1', 'p$title': 'My Title' }) });
  assert.equal(dropped.reason, 'submit-body-mismatch');
  const doubled = guard.classify({ ...req('POST', FORM, 'Document'), postData: `${body({ 'p$owner': '1111-guid', 'p$type': '1', 'p$title': 'My Title' })}&p%24type=2` });
  assert.equal(doubled.reason, 'submit-body-mismatch');
  const good = guard.classify({ ...req('POST', FORM, 'Document'), postData: body({ 'p$owner': '1111-guid', 'p$type': '1', 'p$title': 'My Title', other: 'x' }) });
  assert.equal(good.reason, 'submit');
});

test('bound fields are checked in multipart/form-data bodies (the portal form enctype)', () => {
  const B = '----WebKitFormBoundaryAbC123';
  const part = (n, v) => `--${B}\r\nContent-Disposition: form-data; name="${n}"\r\n\r\n${v}\r\n`;
  const file = `--${B}\r\nContent-Disposition: form-data; name="att"; filename=""\r\nContent-Type: application/octet-stream\r\n\r\n\r\n`;
  const mp = (o) => `${Object.entries(o).map(([n, v]) => part(n, v)).join('')}${file}--${B}--\r\n`;
  const contentType = `multipart/form-data; boundary=${B}`;
  const bind = [['p$owner', '1111-guid'], ['p$title', 'Line one\r\nline & two=3']];
  const guard = g();
  guard.armSubmit({ mustEqual: bind });
  const bad = guard.classify({ ...req('POST', FORM, 'Document'), contentType, postData: mp({ 'p$owner': '2222-guid', 'p$title': 'Line one\r\nline & two=3' }) });
  assert.equal(bad.reason, 'submit-body-mismatch');
  const unknownType = guard.classify({ ...req('POST', FORM, 'Document'), contentType: 'text/plain', postData: 'p$owner=1111-guid' });
  assert.equal(unknownType.reason, 'submit-body-mismatch');
  const good = guard.classify({ ...req('POST', FORM, 'Document'), contentType, postData: mp({ 'p$owner': '1111-guid', 'p$title': 'Line one\r\nline & two=3', other: '' }) });
  assert.equal(good.reason, 'submit');
});

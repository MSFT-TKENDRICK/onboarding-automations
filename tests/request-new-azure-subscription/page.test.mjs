// In-page primitives that are pure enough to run in node against a fake window.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validatorIndex } from '../../skills/request-new-azure-subscription/scripts/lib/page.mjs';

const withValidators = (list, fn) => {
  const prev = globalThis.window;
  globalThis.window = { Page_Validators: list };
  try { return fn(); } finally { globalThis.window = prev; }
};
const live = (id, text) => `<a href='#${id}_label' onclick='javascript:scrollToAndFocus("${id}_label","${id}");return false;' referenceControlId=${id}>${text} </a>`;

test('validatorIndex: control and plain-text message of every validator, with its enabled state', () => {
  const out = withValidators([
    { controltovalidate: 'apitil_title', errormessage: live('apitil_title', 'Title is a required field.') },
    { controltovalidate: 'desitsm_tz', errormessage: live('desitsm_tz', 'Time&nbsp;Zone &amp; <b>region</b> &#39;x&#39; &#x41;'), enabled: true },
    { controltovalidate: 'a', errormessage: 'A is required', enabled: false },
    { controltovalidate: 'b', errormessage: 'B is required', enabled: 'False' },
    { controltovalidate: 'c', errormessage: 'C is required', enabled: 'false' },
    { controltovalidate: 'd', errormessage: 'D is required', enabled: '0' },
  ], validatorIndex);
  assert.deepEqual(out, [
    { control: 'apitil_title', message: 'Title is a required field.', enabled: true },
    { control: 'desitsm_tz', message: "Time Zone & region 'x' A", enabled: true },
    { control: 'a', message: 'A is required', enabled: false },
    { control: 'b', message: 'B is required', enabled: false },
    { control: 'c', message: 'C is required', enabled: false },
    { control: 'd', message: 'D is required', enabled: false },
  ]);
});

test('validatorIndex: never truncates, skips validators without a control, tolerates a missing array', () => {
  const long = `Time Zone ${'x'.repeat(600)} Monthly Allowance`;
  const out = withValidators([{ controltovalidate: 'tz', errormessage: long }, { controltovalidate: '', errormessage: 'X' }, { errormessage: 'Y' }, null], validatorIndex);
  assert.deepEqual(out, [{ control: 'tz', message: long, enabled: true }]);
  assert.deepEqual(withValidators(undefined, validatorIndex), []);
});

const withDom = (list, ids, fn) => {
  const prevW = globalThis.window;
  const prevD = globalThis.document;
  const form = { id: 'liquid_form', contains: (el) => !!el && el.inForm };
  const els = Object.fromEntries(Object.entries(ids).map(([id, inForm]) => [id, { id, inForm }]));
  globalThis.window = { Page_Validators: list };
  globalThis.document = { getElementById: (id) => (id === 'liquid_form' ? form : els[id] || null) };
  try { return fn(); } finally { globalThis.window = prevW; globalThis.document = prevD; }
};
const focus = (id, label) => `<a href='#!' onclick='setFocusAndScrollPosition(${id})'>\n        ${label} is a required field.</a>`;

test('validatorIndex: a live required validator without controltovalidate is indexed by its focus control', () => {
  const out = withDom([
    { id: 'RequiredFieldValidatorapitil_contact', errormessage: focus('apitil_contact_name', 'Requester') },
    { id: 'RequiredFieldValidatordesitsm_monthlyspend', errormessage: focus('desitsm_monthlyspend', 'Monthly Allowance') },
    { id: 'MaximumLengthValidatorapitil_title', controltovalidate: 'apitil_title', errormessage: live('apitil_title', 'Title exceeds the maximum length of 256 characters.') },
  ], { apitil_contact_name: true, desitsm_monthlyspend: true, apitil_title: true }, validatorIndex);
  assert.deepEqual(out, [
    { control: 'apitil_contact_name', message: 'Requester is a required field.', enabled: true },
    { control: 'desitsm_monthlyspend', message: 'Monthly Allowance is a required field.', enabled: true },
    { control: 'apitil_title', message: 'Title exceeds the maximum length of 256 characters.', enabled: true },
  ]);
});

test('validatorIndex: a focus id that is missing or outside liquid_form is never indexed (fail-closed)', () => {
  const out = withDom([
    { errormessage: focus('ghost', 'Ghost') },
    { errormessage: focus('outside', 'Outside') },
    { errormessage: "<a onclick='setFocusAndScrollPosition()'>Empty is a required field.</a>" },
  ], { outside: false }, validatorIndex);
  assert.deepEqual(out, []);
  assert.deepEqual(withValidators([{ errormessage: focus('x', 'X') }], validatorIndex), [], 'no document: skip, never throw');
});

test('validatorIndex: controltovalidate wins over a focus id in the message', () => {
  const out = withDom([{ controltovalidate: 'a', errormessage: focus('b', 'B') }], { a: true, b: true }, validatorIndex);
  assert.deepEqual(out, [{ control: 'a', message: 'B is a required field.', enabled: true }]);
});

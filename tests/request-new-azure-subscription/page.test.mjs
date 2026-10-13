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

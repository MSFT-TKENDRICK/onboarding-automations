import { test } from 'node:test';
import assert from 'node:assert/strict';
import { highestAmount, onlyOption, defaultTitle, systemTimeZone, DEFAULT_TYPE } from '../../skills/request-new-azure-subscription/scripts/lib/defaults.mjs';

const opts = (...pairs) => [{ value: '', label: 'Select' }, ...pairs.map(([value, label]) => ({ value, label }))];

test('highestAmount picks the largest amount regardless of order or formatting', () => {
  assert.equal(highestAmount(opts(['500', '$500'], ['1500', '$1,500'], ['1000', '$1000'])).value, '1500');
  assert.equal(highestAmount(opts(['a', 'USD 2,000/month'], ['b', 'USD 750/month'])).value, 'a');
});

test('highestAmount refuses when amounts are unreadable or tied', () => {
  assert.equal(highestAmount(opts(['x', 'Low'], ['y', 'High'])), null);
  assert.equal(highestAmount(opts(['x', '$500'], ['y', '500'])), null);
  assert.equal(highestAmount(opts()), null);
});

test('onlyOption returns the single real option, otherwise null', () => {
  assert.equal(onlyOption(opts(['1', 'Hybrid'])).label, 'Hybrid');
  assert.equal(onlyOption(opts(['1', 'A'], ['2', 'B'])), null);
  assert.equal(onlyOption(opts()), null);
});

test('defaultTitle uses the owner alias and the local date', () => {
  assert.equal(defaultTitle('Jane.Doe@microsoft.com', new Date(2026, 8, 4)), 'jane.doe Azure subscription 2026-09-04');
  assert.equal(defaultTitle(null), null);
});

test('systemTimeZone honors MCAPS_TIMEZONE and falls back to the OS zone', () => {
  assert.equal(systemTimeZone({ MCAPS_TIMEZONE: 'Europe/London' }), 'Europe/London');
  assert.equal(systemTimeZone({}), Intl.DateTimeFormat().resolvedOptions().timeZone);
});

test('the default subscription type is internal', () => {
  assert.equal(DEFAULT_TYPE, 'internal');
});

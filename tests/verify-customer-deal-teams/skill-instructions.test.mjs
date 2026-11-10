import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('skill requires name selection before exact account confirmation', async () => {
  const skill = await readFile(new URL(
    '../../skills/verify-customer-deal-teams/SKILL.md', import.meta.url), 'utf8');
  const procedure = await readFile(new URL(
    '../../skills/verify-customer-deal-teams/references/CRM-PROCEDURE.md', import.meta.url), 'utf8');
  assert.match(skill, /Always run `scripts\/plan\.mjs --customers`[\s\S]*even when every CRM match is unambiguous/);
  assert.match(skill, /preliminary[\s\S]*name-level selection is not this confirmation/i);
  assert.doesNotMatch(skill, /if no preliminary review was necessary/i);
  assert.match(procedure, /Always review the discovered customer names before exact-account ranking/);
  assert.match(procedure, /Do not use the exact-account ranking or planner until the user has answered/);
  assert.match(procedure, /hashes[\s\S]*do not authenticate responses/i);
  assert.match(procedure, /do not retrieve denied data[\s\S]*another tool, account, or transport/i);
});

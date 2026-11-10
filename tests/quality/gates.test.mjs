import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { exactFunctionExecutions, isolatedTestExitCode, mergedFunctionCoverage, mutationGateFailed } from '../../scripts/quality-lib.mjs';

test('CRAP coverage never attributes an overlapping outer range to a nested function', () => {
  const entries = new Map([
    ['0:100', [[{ startOffset: 0, endOffset: 100, count: 1 }]]],
    ['20:80', [[{ startOffset: 20, endOffset: 80, count: 1 }]]],
  ]);
  assert.equal(exactFunctionExecutions(entries, { start: 30, end: 60 }), null);
  assert.deepEqual(exactFunctionExecutions(entries, { start: 20, end: 80 }),
    [[{ startOffset: 20, endOffset: 80, count: 1 }]]);
});

test('CRAP coverage matches exact V8 method ranges without guessing static methods', () => {
  const executions = [[{ startOffset: 9, endOffset: 25, count: 1 }]];
  const entries = new Map([['9:25', executions], ['0:40', executions]]);
  const value = { start: 12, end: 25 };
  assert.equal(exactFunctionExecutions(entries, value), null);
  assert.equal(exactFunctionExecutions(entries, value, { type: 'Property', method: true, start: 9 }), executions);
  assert.equal(exactFunctionExecutions(entries, value, { type: 'Property', kind: 'get', start: 9 }), executions);
  assert.equal(exactFunctionExecutions(entries, value, { type: 'MethodDefinition', static: false, start: 9 }), executions);
  assert.equal(exactFunctionExecutions(entries, value, { type: 'MethodDefinition', static: true, start: 9 }), null);
});

test('CRAP coverage excludes nested functions from the enclosing function', () => {
  const executions = [[
    { startOffset: 0, endOffset: 100, count: 1 },
    { startOffset: 20, endOffset: 80, count: 0 },
  ]];
  assert.equal(mergedFunctionCoverage(executions, 0, 100), 40);
  assert.equal(mergedFunctionCoverage(executions, 0, 100, [{ start: 20, end: 80 }]), 100);
  assert.equal(mergedFunctionCoverage(executions, 0, 100, [{ start: 0, end: 100 }]), null);
});

test('CRAP coverage merges independent executions at the source-range level', () => {
  const executions = [
    [{ startOffset: 0, endOffset: 100, count: 1 }, { startOffset: 50, endOffset: 100, count: 0 }],
    [{ startOffset: 0, endOffset: 100, count: 1 }, { startOffset: 0, endOffset: 50, count: 0 }],
  ];
  assert.equal(mergedFunctionCoverage(executions, 0, 100), 100);
});

test('mutation gate fails closed for invalid, timed-out, or infrastructure-failed mutants', () => {
  const passing = { score: 100, threshold: 70, invalid: 0, timeouts: 0, infrastructureErrors: 0 };
  assert.equal(mutationGateFailed(passing), false);
  for (const field of ['invalid', 'timeouts', 'infrastructureErrors']) {
    assert.equal(mutationGateFailed({ ...passing, [field]: 1 }), true);
  }
  assert.equal(mutationGateFailed({ ...passing, score: 69.99 }), true);
});

test('isolated test runner preserves test failures and separately fails leaked temp cleanup', () => {
  assert.equal(isolatedTestExitCode(0, false), 0);
  assert.equal(isolatedTestExitCode(0, true), 2);
  assert.equal(isolatedTestExitCode(1, false), 1);
  assert.equal(isolatedTestExitCode(1, true), 1);
});

test('isolated test runner rejects unmatched selectors even alongside a valid test', () => {
  const runner = fileURLToPath(new URL('../../scripts/run-tests.mjs', import.meta.url));
  const valid = fileURLToPath(new URL('../request-new-azure-subscription/intent.test.mjs', import.meta.url));
  for (const selector of ['missing.test.mjs', 'missing-*.test.mjs']) {
    const missing = fileURLToPath(new URL(`./fixtures/${selector}`, import.meta.url));
    const result = spawnSync(process.execPath, [runner, valid, missing], { encoding: 'utf8', timeout: 10000 });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /No test files matched selector/);
  }
});

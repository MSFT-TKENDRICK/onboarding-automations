#!/usr/bin/env node

import { globSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { isolatedTestExitCode } from './quality-lib.mjs';

const patterns = process.argv.slice(2);
if (!patterns.length) patterns.push('tests/**/*.test.mjs');
for (const selector of patterns.filter((value) => !value.startsWith('-') && value.endsWith('.mjs'))) {
  if (!globSync(selector).length) throw new Error(`No test files matched selector: ${selector}`);
}

const root = mkdtempSync(join(tmpdir(), 'onboarding-tests-'));
const env = { ...process.env, TEMP: root, TMP: root, TMPDIR: root };
const child = spawn(process.execPath, ['--test', '--test-concurrency=1', ...patterns], {
  stdio: 'inherit',
  env,
  windowsHide: true,
});

const outcome = await new Promise((resolve) => {
  child.once('error', (error) => resolve({ code: 1, error }));
  child.once('close', (value, signal) => resolve({
    code: typeof value === 'number' ? value : 1,
    ...(signal ? { error: new Error(`test runner terminated by ${signal}`) } : {}),
  }));
});

let cleanupError;
for (let attempt = 0; attempt < 30; attempt++) {
  try {
    rmSync(root, { recursive: true, force: true });
    cleanupError = undefined;
    break;
  } catch (error) {
    cleanupError = error;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
if (outcome.error) console.error(`Test runner failed: ${outcome.error.message}`);
if (cleanupError) {
  console.error(`Tests completed with exit code ${outcome.code}, but isolated temp cleanup failed.`);
  console.error(`Could not remove isolated test temp root ${root}: ${cleanupError.message}`);
}
process.exitCode = isolatedTestExitCode(outcome.code, Boolean(cleanupError));

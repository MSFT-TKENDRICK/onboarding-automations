#!/usr/bin/env node

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parse } from 'acorn';
import { exactFunctionExecutions, mergedFunctionCoverage } from './quality-lib.mjs';

const thresholdIndex = process.argv.indexOf('--threshold');
const threshold = thresholdIndex === -1 ? 30 : Number(process.argv[thresholdIndex + 1]);
if (!Number.isFinite(threshold) || threshold <= 0) throw new Error('CRAP threshold must be positive.');

function filesUnder(root) {
  const found = [];
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    if (statSync(path).isDirectory()) found.push(...filesUnder(path));
    else if (name.endsWith('.mjs')) found.push(relative(process.cwd(), path).replaceAll('\\', '/'));
  }
  return found;
}

const targets = filesUnder(resolve('skills')).filter((path) => path.includes('/scripts/')).sort();
const coverageRoot = mkdtempSync(join(tmpdir(), 'onboarding-v8-coverage-'));
const temporaryRoots = [coverageRoot];
process.once('exit', () => {
  for (const root of temporaryRoots) {
    try { rmSync(root, { recursive: true, force: true, maxRetries: 60, retryDelay: 1000 }); } catch (error) {
      console.error(`Could not remove isolated CRAP temp root ${root}: ${error.message}`);
      process.exitCode = 1;
    }
  }
});
const testRoot = mkdtempSync(join(tmpdir(), 'onboarding-crap-tests-'));
temporaryRoots.push(testRoot);
const run = spawnSync(process.execPath, ['--test', '--test-concurrency=1', 'tests/**/!(*.integration).test.mjs'], {
  encoding: 'utf8',
  windowsHide: true,
  timeout: 240000,
  maxBuffer: 4 * 1024 * 1024,
  env: { ...process.env, NODE_V8_COVERAGE: coverageRoot, TEMP: testRoot, TMP: testRoot, TMPDIR: testRoot },
});
if (run.error || typeof run.status !== 'number' || run.status !== 0) {
  process.stderr.write(run.stdout ?? '');
  process.stderr.write(run.stderr ?? '');
  const reason = run.error ? `${run.error.code ?? 'spawn_error'}: ${run.error.message}` : `test exit ${run.status ?? run.signal ?? 'unknown'}`;
  throw new Error(`CRAP coverage baseline failed (${reason}).`);
}

const coverage = new Map();
for (const name of readdirSync(coverageRoot)) {
  if (!name.startsWith('coverage-') || !name.endsWith('.json')) continue;
  const data = JSON.parse(readFileSync(join(coverageRoot, name), 'utf8'));
  for (const script of data.result ?? []) {
    if (!script.url?.startsWith('file:')) continue;
    const path = resolve(fileURLToPath(script.url));
    if (!targets.some((target) => path === resolve(target))) continue;
    const byFunction = coverage.get(path) ?? new Map();
    for (const entry of script.functions ?? []) {
      const root = entry.ranges?.[0];
      if (!root) continue;
      const key = `${root.startOffset}:${root.endOffset}`;
      const executions = byFunction.get(key) ?? [];
      executions.push(entry.ranges);
      byFunction.set(key, executions);
    }
    coverage.set(path, byFunction);
  }
}

const isFunction = (node) => ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node?.type);
function children(node) {
  const result = [];
  for (const [key, value] of Object.entries(node)) {
    if (['start', 'end', 'loc'].includes(key)) continue;
    if (Array.isArray(value)) result.push(...value.filter((item) => item?.type));
    else if (value?.type) result.push(value);
  }
  return result;
}
function functionName(node, parent, index) {
  if (node.id?.name) return node.id.name;
  if (parent?.type === 'VariableDeclarator' && parent.id?.name) return parent.id.name;
  if ((parent?.type === 'Property' || parent?.type === 'MethodDefinition') && parent.key) {
    return parent.key.name ?? parent.key.value ?? `<function-${index}>`;
  }
  return `<function-${index}>`;
}
function complexity(node) {
  let score = 1;
  const visit = (current, root = false) => {
    if (!root && isFunction(current)) return;
    if (['IfStatement', 'ForStatement', 'ForInStatement', 'ForOfStatement', 'WhileStatement',
      'DoWhileStatement', 'CatchClause', 'ConditionalExpression'].includes(current.type)) score++;
    if (current.type === 'SwitchCase' && current.test !== null) score++;
    if (current.type === 'LogicalExpression' && ['&&', '||', '??'].includes(current.operator)) score++;
    for (const child of children(current)) visit(child);
  };
  visit(node, true);
  return score;
}
function collectFunctions(ast) {
  const found = [];
  const visit = (node, parent) => {
    if (isFunction(node)) found.push({ node, parent, name: functionName(node, parent, found.length + 1) });
    for (const child of children(node)) visit(child, node);
  };
  visit(ast, null);
  return found;
}
function nestedFunctions(node) {
  const found = [];
  const visit = (current) => {
    if (isFunction(current)) { found.push(current); return; }
    for (const child of children(current)) visit(child);
  };
  for (const child of children(node)) visit(child);
  return found;
}

const functions = [];
const unmeasured = [];
for (const target of targets) {
  const path = resolve(target);
  const source = readFileSync(path, 'utf8');
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true, locations: true });
  const entries = coverage.get(path);
  if (!entries) {
    unmeasured.push({ file: target, reason: 'module was not loaded by the unit-test coverage baseline' });
    continue;
  }
  const astFunctions = collectFunctions(ast);
  if (!astFunctions.length) {
    unmeasured.push({ file: target, reason: 'parser found no functions' });
    continue;
  }
  for (const { node, parent, name } of astFunctions) {
    const executions = exactFunctionExecutions(entries, node, parent);
    if (!executions) {
      unmeasured.push({ file: target, function: name, line: node.loc.start.line, reason: 'no exact V8 function range' });
      continue;
    }
    const coveragePercent = mergedFunctionCoverage(executions, node.start, node.end, nestedFunctions(node));
    if (coveragePercent === null) {
      unmeasured.push({ file: target, function: name, line: node.loc.start.line, reason: 'no non-nested function source to measure' });
      continue;
    }
    const cc = complexity(node);
    const crap = cc ** 2 * (1 - coveragePercent / 100) ** 3 + cc;
    functions.push({
      file: target,
      function: name,
      line: node.loc.start.line,
      complexity: cc,
      coverage: Number(coveragePercent.toFixed(2)),
      crap: Number(crap.toFixed(2)),
    });
  }
}

functions.sort((a, b) => b.crap - a.crap);
const overThreshold = functions.filter((fn) => fn.crap > threshold);
const report = {
  threshold,
  formula: 'CC^2 * (1 - coverage/100)^3 + CC',
  coverage: 'V8 precise source-range coverage in UTF-16 code units, excluding nested functions and merged across isolated test processes',
  complexity: 'Acorn AST cyclomatic complexity (base path plus decisions; nested functions measured separately)',
  targetFiles: targets.length,
  measuredFunctions: functions.length,
  max: functions[0] ?? null,
  overThreshold,
  unmeasured,
  functions,
};
mkdirSync('quality-reports', { recursive: true });
writeFileSync('quality-reports/crap.json', `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
if (overThreshold.length || unmeasured.length) process.exitCode = 1;

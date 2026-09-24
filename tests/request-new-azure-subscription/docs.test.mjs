// Documentation consistency: SKILL.md and references/*.md against the scripts they describe.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HELP } from '../../skills/request-new-azure-subscription/scripts/mcaps-subscription.mjs';

const SKILL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../skills/request-new-azure-subscription');
const read = (p) => readFileSync(join(SKILL_DIR, p), 'utf8');
const SKILL = read('SKILL.md');
const CLI = read('references/CLI.md');
const DOCS = { 'SKILL.md': SKILL, ...Object.fromEntries(readdirSync(join(SKILL_DIR, 'references')).filter((f) => f.endsWith('.md')).map((f) => [`references/${f}`, read(`references/${f}`)])) };
const SCRIPTS = [join('scripts', 'mcaps-subscription.mjs'), ...readdirSync(join(SKILL_DIR, 'scripts', 'lib')).filter((f) => f.endsWith('.mjs')).map((f) => join('scripts', 'lib', f))];
const SRC = Object.fromEntries(SCRIPTS.map((p) => [basename(p), read(p)]));
// Producing code only: HELP and nextHint quote codes they read, which must not make a stale doc row pass.
const cli = SRC['mcaps-subscription.mjs'];
const PRODUCING = { ...SRC, 'mcaps-subscription.mjs': cli.slice(0, cli.indexOf('export const HELP')) + cli.slice(cli.indexOf('export async function run')) };
const ALL_SRC = Object.values(PRODUCING).join('\n');

function frontmatter(md) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(md);
  assert.ok(m, 'SKILL.md starts with YAML frontmatter');
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([a-z-]+):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].replace(/^"(.*)"$/, '$1');
  }
  return out;
}

const tableRows = (md) => md.split(/\r?\n/).filter((l) => /^\|/.test(l) && !/^\|[\s|:-]+\|$/.test(l));
const backticked = (text) => [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
const quoted = (code) => new RegExp(`['"\`]${code}['"\`]`).test(ALL_SRC);
const word = (w) => new RegExp(`\\b${w.replace(/[$]/g, '\\$&')}\\b`).test(ALL_SRC);

// Codes the CLI can put in front of the agent (statuses, outcomes, reasons, error/missing/errors/blockers/warnings codes).
function emittedCodes() {
  const codes = new Set(['ready', 'needs_input', 'invalid', 'blocked']);
  const grab = (src, re) => { for (const m of src.matchAll(re)) codes.add(m[1]); };
  for (const f of ['mcaps-subscription.mjs', 'portal.mjs', 'cdp.mjs']) {
    grab(PRODUCING[f], /\bcode: '([a-z_]+)'/g);
    grab(PRODUCING[f], /SkillError\('([a-z_]+)'/g);
  }
  grab(PRODUCING['mcaps-subscription.mjs'], /\berror: '([a-z_]+)'/g);
  grab(PRODUCING['portal.mjs'], /notSent\('([a-z_]+)'/g);
  grab(PRODUCING['portal.mjs'], /outcome: '([a-z_]+)'/g);
  grab(PRODUCING['portal.mjs'], /outcome: 'not_submitted', reason: '([a-z_]+)'/g);
  // Modal blockers are chosen by a ternary: code: /…/ ? 'active_request' : /…/ ? 'limit_reached' : 'portal_alert'.
  for (const line of PRODUCING['portal.mjs'].split('\n').filter((l) => l.includes('out.blockers.push({ code: /'))) grab(line, /'([a-z_]+)'/g);
  // Option and owner errors too: code: m.error === 'ambiguous' ? 'ambiguous_option' : 'invalid_option'.
  for (const m of PRODUCING['portal.mjs'].matchAll(/code: m\.error === '[a-z_]+' \? '([a-z_]+)' : '([a-z_]+)'/g)) { codes.add(m[1]); codes.add(m[2]); }
  codes.add('error'); // run()'s fallback for unexpected exceptions
  return codes;
}

describe('SKILL.md frontmatter', () => {
  const fm = frontmatter(SKILL);

  it('name matches the directory and the naming rules', () => {
    assert.equal(fm.name, basename(SKILL_DIR));
    assert.match(fm.name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
    assert.ok(fm.name.length <= 64);
  });

  it('description says what it does and when to use it, within 1024 characters', () => {
    assert.ok(fm.description.length > 50 && fm.description.length <= 1024, `${fm.description.length} characters`);
    assert.match(fm.description, /Use when/);
    assert.match(fm.description, /Azure subscription/);
  });

  it('allowed-tools pre-approves only the read-only commands', () => {
    const tools = fm['allowed-tools'];
    assert.ok(tools && !tools.startsWith('['), 'space-separated string, not a YAML list');
    assert.doesNotMatch(tools, /submit/);
    for (const c of ['plan', 'options', 'status']) assert.match(tools, new RegExp(`mcaps-subscription\\.mjs ${c}`));
  });

  it('metadata version is a quoted string', () => {
    assert.match(SKILL, /^ {2}version: "\d+\.\d+\.\d+"$/m);
  });
});

describe('SKILL.md size', () => {
  it('stays well under 500 lines and 5k tokens', () => {
    assert.ok(SKILL.split('\n').length < 250, `${SKILL.split('\n').length} lines`);
    assert.ok(SKILL.length < 16000, `${SKILL.length} characters (~4 per token)`);
  });
});

describe('decision tables name only real codes, fields and flags', () => {
  for (const [name, md] of [['SKILL.md', SKILL], ['references/CLI.md', CLI]]) {
    it(name, () => {
      const bad = [];
      for (const row of tableRows(md)) {
        for (const t of backticked(row)) {
          for (const f of t.match(/--[a-z][a-z-]*/g) ?? []) if (!HELP.includes(f)) bad.push(`${t}: ${f} is not in --help`);
          if (/^--/.test(t) || /\s|</.test(t)) continue;
          if (/^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(t)) { if (!quoted(t)) bad.push(`${t}: no such string literal in the scripts`); continue; }
          if (/^[A-Z][A-Z0-9_]+(=1)?$/.test(t)) { if (!word(t.replace(/=1$/, ''))) bad.push(`${t}: variable not read by the scripts`); continue; }
          if (/^[a-z][A-Za-z0-9]*([.[\]]+[A-Za-z0-9]+)*$/.test(t)) for (const seg of t.split(/[.[\]]+/).filter(Boolean)) if (!word(seg)) bad.push(`${t}: ${seg} not found in the scripts`);
        }
      }
      assert.deepEqual(bad, []);
    });
  }
});

describe('every code the CLI emits is documented', () => {
  const codes = emittedCodes();

  it('finds the emitted codes', () => {
    for (const c of ['field_drift', 'field_absent', 'possible_duplicate', 'systemone_refused', 'already_submitted', 'plan_mismatch', 'limit_reached', 'portal_alert', 'ambiguous_option', 'invalid_option', 'ambiguous_owner', 'cdp_timeout', 'not_delivered', 'duplicate_active', 'plan_no_longer_ready']) assert.ok(codes.has(c), c);
  });

  for (const [name, md, cells] of [['SKILL.md (a row of its own, with an action)', SKILL, (row) => row.split('|')[1]], ['references/CLI.md', CLI, (row) => row]]) {
    it(name, () => {
      const documented = new Set(tableRows(md).map(cells).flatMap(backticked));
      assert.deepEqual([...codes].filter((c) => !documented.has(c)).sort(), []);
    });
  }
});

describe('links', () => {
  const slug = (h) => h.trim().toLowerCase().replace(/[`*]/g, '').replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
  const anchors = (md) => new Set([...md.matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => slug(m[1])));

  for (const [name, md] of Object.entries(DOCS)) {
    it(`${name}: relative links and anchors resolve`, () => {
      const bad = [];
      for (const [, target] of md.matchAll(/\]\(([^)\s]+)\)/g)) {
        if (/^[a-z]+:/i.test(target)) continue;
        const [path, anchor] = target.split('#');
        const file = path ? join(SKILL_DIR, dirname(name), path) : join(SKILL_DIR, name);
        if (!existsSync(file)) { bad.push(`${target}: no such file`); continue; }
        if (anchor && file.endsWith('.md') && !anchors(readFileSync(file, 'utf8')).has(anchor)) bad.push(`${target}: no such heading`);
      }
      assert.deepEqual(bad, []);
    });
  }
});

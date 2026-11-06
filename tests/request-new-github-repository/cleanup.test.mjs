import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { removeWhenFree, PREFIX } from '../../skills/request-new-github-repository/scripts/lib/cleanup.mjs';

test('removeWhenFree only deletes throwaway profile directories', async () => {
  const other = mkdtempSync(join(tmpdir(), 'not-a-profile-'));
  try {
    await assert.rejects(removeWhenFree(other), /refusing/);
    assert.ok(existsSync(other));
    const prof = mkdtempSync(join(tmpdir(), PREFIX));
    writeFileSync(join(prof, 'x'), 'y');
    assert.equal(await removeWhenFree(prof, { timeoutMs: 1000 }), true);
    assert.ok(!existsSync(prof));
  } finally { rmSync(other, { recursive: true, force: true }); }
});

test('cleanup leaves other similarly named profiles untouched', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cleanup-root-'));
  try {
    const owned = join(root, `${PREFIX}owned`); const sibling = join(root, `${PREFIX}sibling`);
    for (const d of [owned, sibling]) { mkdirSync(d); writeFileSync(join(d, 'f'), '1'); }
    assert.equal(await removeWhenFree(owned, { timeoutMs: 1000 }), true);
    assert.ok(!existsSync(owned)); assert.ok(existsSync(sibling));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('cleanup helper refuses an unscoped sweep', () => {
  const root = mkdtempSync(join(tmpdir(), 'cleanup-root-'));
  try {
    const sibling = join(root, `${PREFIX}sibling`);
    mkdirSync(sibling);
    const helper = fileURLToPath(new URL('../../skills/request-new-github-repository/scripts/lib/cleanup.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [helper, '--sweep'], {
      env: { ...process.env, TEMP: root, TMP: root, TMPDIR: root }, encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Expected exactly one/);
    assert.ok(existsSync(sibling));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

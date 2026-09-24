import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeWhenFree, sweepStaleProfiles, PREFIX } from '../../skills/request-new-azure-subscription/scripts/lib/cleanup.mjs';

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

test('sweep removes only old, unused profiles under the prefix', () => {
  const root = mkdtempSync(join(tmpdir(), 'sweep-root-'));
  try {
    const old = join(root, `${PREFIX}old`); const fresh = join(root, `${PREFIX}fresh`); const foreign = join(root, 'foreign-old');
    for (const d of [old, fresh, foreign]) { mkdirSync(d); writeFileSync(join(d, 'f'), '1'); }
    const past = new Date(Date.now() - 2 * 3600 * 1000);
    utimesSync(old, past, past); utimesSync(foreign, past, past);
    assert.equal(sweepStaleProfiles({ root }), 1);
    assert.ok(!existsSync(old)); assert.ok(existsSync(fresh)); assert.ok(existsSync(foreign));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

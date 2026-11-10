import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const readJson = async (path) => JSON.parse(await readFile(join(root, path), 'utf8'));

async function assertContained(path, pluginRoot, visited = new Set()) {
  const resolved = await realpath(path);
  const remainder = relative(pluginRoot, resolved);
  assert.ok(remainder !== '..' && !remainder.startsWith(`..${sep}`) && !isAbsolute(remainder),
    `${path} resolves outside the plugin`);
  if (!(await stat(resolved)).isDirectory() || visited.has(resolved)) return;
  visited.add(resolved);
  for (const entry of await readdir(resolved)) {
    await assertContained(join(resolved, entry), pluginRoot, visited);
  }
}

test('marketplace exposes the portable onboarding plugin', async () => {
  const manifest = await readJson('plugin.json');
  const catalog = await readJson('.github/plugin/marketplace.json');
  assert.equal(manifest.$schema, 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
  assert.equal(manifest.name, 'onboarding-skills');
  assert.equal(catalog.name, 'microsoft-onboarding');
  assert.deepEqual(catalog.plugins.map(({ name }) => name), [manifest.name]);
  const [onboarding] = catalog.plugins;
  assert.equal(onboarding.source, './');
  assert.equal(onboarding.version, manifest.version);
});

test('all onboarding skills are contained and catalogued without duplicates', async () => {
  const pluginRoot = await realpath(root);
  await assertContained(join(root, 'plugin.json'), pluginRoot);
  await assertContained(join(root, 'skills'), pluginRoot);
  const expected = [
    'check-github-access',
    'check-msx-access',
    'new-hire-readiness',
    'request-new-azure-subscription',
    'request-new-github-repository',
    'verify-customer-deal-teams',
  ];
  const entries = await readdir(join(root, 'skills'), { withFileTypes: true });
  const names = entries.map(({ name }) => name).sort();
  assert.deepEqual(names, expected);
  const legacy = await readJson('.claude-plugin/marketplace.json');
  assert.deepEqual(legacy.plugins.flatMap(({ skills }) => skills).sort(),
    expected.map((name) => `./skills/${name}`).sort());
  for (const name of names) {
    const skill = await readFile(join(root, 'skills', name, 'SKILL.md'), 'utf8');
    assert.match(skill, new RegExp(`^name: ${name}$`, 'm'));
  }
  for (const sibling of ['check-github-access', 'check-msx-access']) {
    await stat(join(root, 'skills', sibling, 'scripts', sibling === 'check-github-access'
      ? 'github-access.mjs' : 'msx-access.mjs'));
  }
});

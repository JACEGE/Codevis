const test = require('node:test');
const assert = require('node:assert/strict');

test('re-init reads editable fields from an existing public config', async () => {
  const { existingSetup } = await import('../lib/commands/init.mjs');
  assert.deepEqual(existingSetup({
    extractors: { ros: true }, autoUpdate: { enabled: true }, locking: { enabled: true },
    knowledge: { paths: ['./docs/knowledge', './adr'] },
    workspaces: { project_db: { sourceDir: ['./src', './tests'], exclude: ['**/generated/**'] } },
  }), {
    sourceDirs: ['./src', './tests'], exclude: ['**/generated/**'],
    knowledgePaths: ['./docs/knowledge', './adr'], autoUpdate: true, locking: true, ros: true,
    workMode: 'code',
  });
});

test('re-init supports the legacy target workspace alias', async () => {
  const { existingSetup } = await import('../lib/commands/init.mjs');
  const setup = existingSetup({ workspaces: { target: { sourceDir: './app', extractors: { ros: true } } } });
  assert.deepEqual(setup.sourceDirs, ['./app']);
  assert.equal(setup.ros, true);
  assert.equal(setup.workMode, 'code');
});

test('re-init preserves an explicit planning work mode', async () => {
  const { existingSetup } = await import('../lib/commands/init.mjs');
  const setup = existingSetup({ workMode: 'planning', workspaces: { project_db: { sourceDir: [] } } });
  assert.equal(setup.workMode, 'planning');
  assert.deepEqual(setup.sourceDirs, []);
});

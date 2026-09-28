const test = require('node:test');
const assert = require('node:assert/strict');
const ladybug = require('../server/ladybug-driver.cjs');

test('embedded workspaces select distinct databases without URI or auth configuration', () => {
  for (const name of ['project_db', 'project', 'target', 'tool']) {
    assert.equal(ladybug.workspace(name).session().workspace, 'project_db');
  }
  for (const name of ['codevis_db', 'codevis', 'meta']) {
    assert.equal(ladybug.workspace(name).session().workspace, 'codevis_db');
  }
  assert.equal(ladybug.workspace().session().workspace, 'project_db');
});

test('unknown workspace names fail before any query or daemon startup', () => {
  for (const name of ['production', 'neo4j', 'bolt://localhost:7688']) {
    assert.throws(() => ladybug.workspace(name), /Unknown workspace/);
  }
});

test('legacy URI integrations retain their original database mapping', () => {
  assert.equal(ladybug.driver('bolt://localhost:7687').session().workspace, 'project_db');
  assert.equal(ladybug.driver('bolt://localhost:7688').session().workspace, 'codevis_db');
  const legacyAuth = ladybug.auth.basic('unused', 'legacy-meta');
  assert.equal(ladybug.driver('legacy-address', legacyAuth).session().workspace, 'codevis_db');
  assert.equal(ladybug.workspace('project_db').session().workspace, 'project_db');
});

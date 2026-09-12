const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('codevis start launches the MCP server without a nested npx shell', () => {
  const root = path.resolve(__dirname, '..');
  const result = spawnSync(process.execPath, [path.join(root, 'bin', 'codevis.mjs'), 'start'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 15000,
    env: { ...process.env, CODEVIS_PROJECT_DIR: root, CODEVIS_LOCK_SWEEP_MS: '0' },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stderr, /CodeVis MCP Server running/);
});

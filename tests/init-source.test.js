const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');

test('init source choices normalize all and planning-only values', async () => {
  const { normalizeSourceDirs } = await import('../lib/commands/init.mjs');
  assert.deepEqual(normalizeSourceDirs('all'), ['.']);
  assert.deepEqual(normalizeSourceDirs('.'), ['.']);
  assert.deepEqual(normalizeSourceDirs('none'), []);
  assert.deepEqual(normalizeSourceDirs('src, lib'), ['src', 'lib']);
});

test('init detects conventional source directories only when present', async () => {
  const { detectedSourceDirs } = await import('../lib/commands/init.mjs');
  const root = mkdtempSync(join(tmpdir(), 'codevis-init-source-'));
  try {
    mkdirSync(join(root, 'src'));
    mkdirSync(join(root, 'server'));
    mkdirSync(join(root, 'random'));
    assert.deepEqual(detectedSourceDirs(root), ['src', 'server']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

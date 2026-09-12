const test = require('node:test');
const assert = require('node:assert/strict');
const { join } = require('node:path');

test('watch path filter accepts source and rejects generated/dependency files', async () => {
  const { shouldWatchPath } = await import('../lib/commands/watch.mjs');
  const root = join('C:', 'project');
  assert.equal(shouldWatchPath(root, join(root, 'src', 'app.py')), true);
  assert.equal(shouldWatchPath(root, join(root, 'viewer', 'src', 'App.tsx')), true);
  assert.equal(shouldWatchPath(root, join(root, 'node_modules', 'pkg', 'index.js')), false);
  assert.equal(shouldWatchPath(root, join(root, 'outputs', 'frame.xml')), false);
  assert.equal(shouldWatchPath(root, join(root, 'README.md')), false);
  assert.equal(shouldWatchPath(root, join(root, 'docs', 'knowledge', 'rule.md'), {
    knowledgeRoots: [join(root, 'docs', 'knowledge')],
  }), true);
});

test('build queue coalesces saves and runs once more after changes during a build', async () => {
  const { BuildQueue } = await import('../lib/commands/watch.mjs');
  let runs = 0;
  let release;
  const modes = [];
  const queue = new BuildQueue({
    debounceMs: 5,
    maxWaitMs: 30,
    runBuild: async (mode) => {
      runs++;
      modes.push(mode);
      if (runs === 1) await new Promise((resolve) => { release = resolve; });
    },
    onError: (error) => { throw error; },
  });
  queue.change();
  queue.change('diff');
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(runs, 1);
  queue.change('diff');
  queue.change('full');
  release();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(runs, 2);
  assert.deepEqual(modes, ['diff', 'full']);
  queue.close();
});

test('watcher uses configured roots/excludes and never drops an event without filename', async () => {
  const { shouldWatchPath, handleWatchEvent } = await import('../lib/commands/watch.mjs');
  const root = join('C:', 'project');
  const options = { sourceRoots: [join(root, 'src')], excludeMatchers: [/^src\/generated\//] };
  assert.equal(shouldWatchPath(root, join(root, 'tests', 'outside.py'), options), false);
  assert.equal(shouldWatchPath(root, join(root, 'src', 'generated', 'api.py'), options), false);
  assert.equal(shouldWatchPath(root, join(root, 'src', 'main.py'), options), true);
  let changes = 0;
  assert.equal(handleWatchEvent({ filename: null, root, projectRoot: root, ...options, queue: { change: () => changes++ } }), true);
  assert.equal(changes, 1);
});

test('watcher accepts configured external code and Knowledge paths, but not other siblings', async () => {
  const { shouldWatchPath } = await import('../lib/commands/watch.mjs');
  const { resolve } = require('node:path');
  const root = resolve('watch-project'), external = resolve('external-source');
  const options = { sourceRoots: [external], knowledgeRoots: [join(external, 'knowledge')] };
  assert.equal(shouldWatchPath(root, join(external, 'main.js'), options), true);
  assert.equal(shouldWatchPath(root, join(external, 'api.hh'), options), true);
  assert.equal(shouldWatchPath(root, join(external, 'knowledge', 'rule.md'), options), true);
  assert.equal(shouldWatchPath(root, resolve('unconfigured', 'main.js'), options), false);
  assert.equal(shouldWatchPath(root, join(external, 'node_modules', 'pkg', 'main.js'), options), false);
});

test('concurrent watcher startups have one owner and preserve its PID marker', async t => {
  const { acquireWatcher } = await import('../lib/commands/watch.mjs');
  const fs = require('node:fs'), path = require('node:path');
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'codevis-watch-lock-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const marker = path.join(dir, 'watcher.pid');
  const results = await Promise.allSettled([acquireWatcher(marker, 20), acquireWatcher(marker, 20)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(JSON.parse(fs.readFileSync(marker, 'utf8')).pid, process.pid);
  results.find(r => r.status === 'fulfilled').value();
  assert.equal(fs.existsSync(marker), false);
  const again = await acquireWatcher(marker, 20);
  results.find(r => r.status === 'fulfilled').value();
  assert.equal(fs.existsSync(marker), true);
  again();
});

test('directory-only rename events schedule a build for moved and removed source trees', async t => {
  const { handleWatchEvent } = await import('../lib/commands/watch.mjs');
  const fs = require('node:fs'), path = require('node:path');
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'codevis-watch-rename-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src/new'), { recursive: true });
  fs.mkdirSync(path.join(root, 'docs/knowledge/new'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src/generated'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/notes.txt'), 'not source');
  let changes = 0;
  const options = { root, projectRoot: root, sourceRoots: [path.join(root, 'src')],
    knowledgeRoots: [path.join(root, 'docs/knowledge')], excludeMatchers: [/^src\/generated\//],
    queue: { change: () => changes++ }, event: 'rename' };
  for (const filename of ['src/old', 'src/new', 'docs/knowledge/old', 'docs/knowledge/new']) {
    assert.equal(handleWatchEvent({ ...options, filename }), true, filename);
  }
  for (const filename of ['src/generated', 'src/node_modules/pkg', 'unrelated', 'src/notes.txt']) {
    assert.equal(handleWatchEvent({ ...options, filename }), false, filename);
  }
  assert.equal(changes, 4);
});

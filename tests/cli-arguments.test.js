const test = require('node:test');
const assert = require('node:assert/strict');

test('CLI parsers reject unknown and incomplete options before doing work', async () => {
  const [{ parseFlags }, { parseArgs: parseImpact }, { parseArgs: parseQuality }, { parseArgs: parseDiff }, { validateKanbanArgs }] = await Promise.all([
    import('../lib/commands/init.mjs'),
    import('../lib/commands/impact.mjs'),
    import('../lib/commands/quality.mjs'),
    import('../lib/commands/diff-graph.mjs'),
    import('../lib/commands/kanban.mjs'),
  ]);

  assert.throws(() => parseFlags(['--soruce', 'src']), /Unknown option/);
  assert.throws(() => parseFlags(['--source']), /needs a value/);
  assert.equal(parseFlags(['new']).workMode, 'planning');
  assert.equal(parseFlags(['code']).workMode, 'code');
  assert.throws(() => parseFlags(['new', '--source', './src']), /cannot be combined/);
  assert.throws(() => parseFlags(['new', '--watch']), /cannot enable/);
  assert.throws(() => parseFlags(['new', 'code']), /either 'new' or 'code'/);
  assert.throws(() => parseImpact(['save', '--file']), /needs a value/);
  assert.throws(() => parseQuality(['--baseline']), /needs a value/);
  assert.throws(() => parseDiff(['main', '--base']), /needs a value/);
  assert.throws(() => validateKanbanArgs(['--web', '--watch']), /Unknown option/);
});

test('impact bounds the number of retained paths', async () => {
  const { parseArgs } = await import('../lib/commands/impact.mjs');
  assert.equal(parseArgs(['save', '--max-paths', '10']).maxPathsPerNode, 10);
  assert.throws(() => parseArgs(['save', '--max-paths', '0']), /1 to 10/);
  assert.throws(() => parseArgs(['save', '--max-paths', 'many']), /1 to 10/);
});

test('diff-graph accepts public workspace names and retains internal compatibility', async () => {
  const { parseArgs } = await import('../lib/commands/diff-graph.mjs');
  assert.equal(parseArgs(['main']).ws, 'target');
  assert.equal(parseArgs(['main', '--ws', 'codevis_db']).ws, 'meta');
  assert.equal(parseArgs(['main', '--ws', 'meta']).ws, 'meta');
  assert.throws(() => parseArgs(['main', '--limit', '0']), /positive integer/);
});

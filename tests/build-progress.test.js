const test = require('node:test');
const assert = require('node:assert');
const { __testing__ } = require('../scripts/graph_builder.js');

test('build progress bars represent real completion ratios', () => {
  assert.strictEqual(__testing__.formatProgressBar(0, 4, 8), '░░░░░░░░');
  assert.strictEqual(__testing__.formatProgressBar(1, 4, 8), '██░░░░░░');
  assert.strictEqual(__testing__.formatProgressBar(4, 4, 8), '████████');
  assert.strictEqual(__testing__.formatProgressBar(8, 4, 8), '████████');
});

test('language summaries are counted and sorted deterministically', () => {
  assert.deepStrictEqual(
    __testing__.summarizeExtensions(['a.ts', 'b.js', 'c.ts', 'README']),
    [['ts', 2], ['js', 1], ['other', 1]],
  );
});

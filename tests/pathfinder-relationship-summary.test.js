const test = require('node:test');
const assert = require('node:assert/strict');

test('summarizes visible relationship types and directions for Pathfinder', async () => {
  const { summarizeVisibleRelations, countRelations } = await import('../frontend/src/pathfinder/relationshipSummary.js');
  const graph = {
    nodes: [{ id: 'center', name: 'pathlib', labels: ['Function'] }],
    links: [
      { source: 'caller-a', target: 'center', relType: 'CALLS' },
      { source: { id: 'caller-b' }, target: { id: 'center' }, relType: 'CALLS' },
      { source: 'center', target: 'file', relType: 'IMPORTS' },
    ],
  };
  const summary = summarizeVisibleRelations(graph, 'center');
  assert.deepStrictEqual(summary.incoming, [{ type: 'CALLS', count: 2 }]);
  assert.deepStrictEqual(summary.outgoing, [{ type: 'IMPORTS', count: 1 }]);
  assert.strictEqual(summary.node.labels[0], 'Function');
  assert.strictEqual(countRelations(summary.incoming, new Set(['CALLS', 'RENDERS'])), 2);
});

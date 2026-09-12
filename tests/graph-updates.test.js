const test = require('node:test');
const assert = require('node:assert/strict');

test('lock diffs update only matching graph nodes', async () => {
    const { applyLockChanges } = await import('../frontend/src/graph/graphUpdates.js');
    const untouched = { id: 'b', name: 'B' };
    const graph = { nodes: [{ id: 'a', locked: false }, untouched], links: [{ id: 'edge' }] };
    const next = applyLockChanges(graph, [{ id: 'a', locked: true, lockedBy: 'worker', lockStatus: 'active' }]);
    assert.deepEqual(next.nodes[0], { id: 'a', locked: true, lockedBy: 'worker', lockStatus: 'active' });
    assert.equal(next.nodes[1], untouched);
    assert.equal(next.links, graph.links);
});

const test = require('node:test');
const assert = require('node:assert/strict');

test('growth links become visible only after both endpoints exist', async () => {
    const { partitionVisibleLinks } = await import('../frontend/src/graph/growthModel.js');
    const links = [
        { id: 'ready', source: 'a', target: 'b' },
        { id: 'missing', source: 'a', target: 'c' },
        { id: 'objects', source: { id: 'b' }, target: { id: 'a' } },
    ];
    const result = partitionVisibleLinks(links, new Set(['a', 'b']));
    assert.deepEqual(result.visible.map((link) => link.id), ['ready', 'objects']);
    assert.deepEqual(result.pending.map((link) => link.id), ['missing']);
});

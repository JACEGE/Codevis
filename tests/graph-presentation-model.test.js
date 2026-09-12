const test = require('node:test');
const assert = require('node:assert/strict');

test('graph tooltip values are HTML escaped', async () => {
    const { buildLinkLabel, escapeHtml } = await import('../frontend/src/graph/presentationModel.js');
    assert.equal(escapeHtml('<img onerror="x">'), '&lt;img onerror=&quot;x&quot;&gt;');
    const label = buildLinkLabel({ source: { name: '<script>' }, target: 'safe', relType: 'CALLS' });
    assert.doesNotMatch(label, /<script>/);
    assert.match(label, /&lt;script&gt;/);
});

test('link width prioritizes debug, live and hover state', async () => {
    const { getLinkWidth } = await import('../frontend/src/graph/presentationModel.js');
    const link = { source: 'a', target: 'b', relType: 'RETURNS' };
    const empty = new Set();
    assert.equal(getLinkWidth(link, { activeLinks: empty, debugEdges: empty }), 0.7);
    assert.equal(getLinkWidth(link, { activeLinks: new Set(['a->b']), debugEdges: empty }), 4);
    assert.equal(getLinkWidth(link, { activeLinks: empty, debugEdges: new Set(['a->b']) }), 5);
    assert.equal(getLinkWidth(link, { activeLinks: empty, debugEdges: empty, hoverEdges: new Set(['a->b']) }), 2.5);
});

test('node labels expose hidden degree without trusting graph content', async () => {
    const { buildNodeLabel } = await import('../frontend/src/graph/presentationModel.js');
    const label = buildNodeLabel({
        id: 'n', name: '<img onerror=x>', labels: ['Function'], file: 'src/<bad>.js',
        dbDegree: 5, locked: true, lockedBy: '<agent>',
    }, {
        getAgentColor: () => '#123456',
        visibleDegree: { in: 1, out: 2 },
    });
    assert.doesNotMatch(label, /<img onerror=x>/);
    assert.match(label, /&lt;img onerror=x&gt;/);
    assert.match(label, /\+2 hidden/);
    assert.match(label, /&lt;agent&gt;/);
});

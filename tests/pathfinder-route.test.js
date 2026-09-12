const test = require('node:test');
const assert = require('node:assert/strict');

const { findPath, findShortestRoutes, normalizeRelations } = require('../server/pathfinder-route.cjs');

const record = (values) => ({ get: (key) => values[key] });
const nodeFields = (prefix, id, name) => ({
    [`${prefix}Id`]: id,
    [`${prefix}Name`]: name,
    [`${prefix}File`]: `${name}.js`,
    [`${prefix}Labels`]: ['Function'],
    [`${prefix}Signature`]: `${name}()`,
});

test('bounded BFS returns only equally shortest routes and preserves actual edge direction', () => {
    const adjacency = new Map([
        ['a', [
            { next: 'b', source: 'a', target: 'b', relType: 'CALLS' },
            { next: 'c', source: 'a', target: 'c', relType: 'CALLS' },
            { next: 'slow', source: 'a', target: 'slow', relType: 'CALLS' },
        ]],
        ['b', [{ next: 'z', source: 'b', target: 'z', relType: 'CALLS' }]],
        ['c', [{ next: 'z', source: 'c', target: 'z', relType: 'RENDERS' }]],
        ['slow', [{ next: 'later', source: 'slow', target: 'later', relType: 'CALLS' }]],
        ['later', [{ next: 'z', source: 'later', target: 'z', relType: 'CALLS' }]],
    ]);

    const routes = findShortestRoutes(adjacency, 'a', 'z', 8, 5);
    assert.deepEqual(routes.map((route) => route.nodeIds), [['a', 'b', 'z'], ['a', 'c', 'z']]);
    assert.deepEqual(routes[0].edges.map((edge) => [edge.source, edge.target]), [['a', 'b'], ['b', 'z']]);
});

test('findPath returns a dashboard graph and a linear tree for the primary route', async () => {
    const endpointRecords = [
        record(nodeFields('node', 'a', 'Start')),
        record(nodeFields('node', 'z', 'End')),
    ];
    const edges = [
        record({ ...nodeFields('source', 'a', 'Start'), ...nodeFields('target', 'b', 'Middle'), relType: 'CALLS', resolvedBy: 'module' }),
        record({ ...nodeFields('source', 'b', 'Middle'), ...nodeFields('target', 'z', 'End'), relType: 'RENDERS', resolvedBy: null }),
    ];
    const session = {
        run: async (query) => ({ records: query.includes('type(rel)') ? edges : endpointRecords }),
    };

    const result = await findPath(session, { startNode: 'a', targetNode: 'z', maxHops: 4 });
    assert.equal(result.status, 'OK');
    assert.equal(result.paths[0].hops, 2);
    assert.deepEqual(result.graph.nodes.map((node) => node.id), ['a', 'b', 'z']);
    assert.deepEqual(result.graph.links.map((edge) => edge.relType), ['CALLS', 'RENDERS']);
    assert.equal(result.tree.id, 'a');
    assert.equal(result.tree.children[0].id, 'b');
    assert.equal(result.tree.children[0].children[0].id, 'z');
});

test('incoming traversal walks from a callee to its callers without flipping rendered links', async () => {
    const endpointRecords = [record(nodeFields('node', 'z', 'Callee')), record(nodeFields('node', 'a', 'Caller'))];
    const edges = [record({
        ...nodeFields('source', 'a', 'Caller'), ...nodeFields('target', 'z', 'Callee'),
        relType: 'CALLS', resolvedBy: 'same-file',
    })];
    const session = { run: async (query) => ({ records: query.includes('type(rel)') ? edges : endpointRecords }) };

    const result = await findPath(session, { startNode: 'z', targetNode: 'a', direction: 'in' });
    assert.deepEqual(result.paths[0].nodes.map((node) => node.id), ['z', 'a']);
    assert.deepEqual(result.graph.links[0], { source: 'a', target: 'z', relType: 'CALLS', resolvedBy: 'same-file' });
});

test('relation allowlist rejects arbitrary relationship injection', () => {
    assert.deepEqual(normalizeRelations(['CALLS', 'CALLS']), ['CALLS']);
    assert.throws(() => normalizeRelations(['CALLS]->(x) DELETE x //']), /relations must contain/);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const { searchNodes, parseSearchQuery, registerNodeSearch } = require('../server/node-search.cjs');
const { openTestDb } = require('./helpers/ladybug-session.cjs');

test('database search finds code and work, ranks names, preserves exact identities and bounds results', async t => {
    const { session, cleanup } = await openTestDb();
    t.after(cleanup);
    const create = async (label, fields) => {
        const props = Object.keys(fields).map(key => `${key}: $${key}`).join(', ');
        const result = await session.run(`CREATE (n:${label} {${props}}) RETURN elementId(n) AS id`, fields);
        return String(result.records[0].get('id'));
    };
    const id = await create('Function', { name: 'renderText', file: 'src/diff & #1.js', startLine: 17 });
    await create('Function', { name: 'renderTextExtra', file: 'src/other.js' });
    await create('File', { path: 'src/deep/diff & #1.js' });
    await create('Task', { title: 'Review renderText', taskId: 'task-search-test' });
    await create('Knowledge', { name: 'Rendering convention', sourcePath: 'docs/rendering.md' });
    await create('ASTNode', { name: 'renderText', file: 'src/diff & #1.js' });
    const names = await searchNodes(session, 'RENDERTEXT');
    assert.equal(names.items.length, 3);
    assert.equal(names.items[0].id, id);
    assert.equal(names.items[0].startLine, 17);
    assert.deepEqual(names.items[0].labels, ['Function']);
    assert.equal(names.items[1].name, 'renderTextExtra');
    const file = await searchNodes(session, 'src\\deep\\diff & #1.js');
    assert.equal(file.items.length, 1);
    assert.equal(file.items[0].file, 'src/deep/diff & #1.js');
    assert.equal((await searchNodes(session, 'docs/rendering')).items.length, 1);
    assert.deepEqual((await searchNodes(session, "' OR 1=1 DELETE n //")).items, []);
    const oddName = "O'Brien $(literal)";
    await create('Function', { name: oddName, file: 'src/odd.js' });
    assert.equal((await searchNodes(session, oddName)).items[0].name, oddName);
    for (let index = 0; index < 52; index++) await create('Function', { name: `common${index}`, file: 'src/common.js' });
    const bounded = await searchNodes(session, 'common');
    assert.equal(bounded.items.length, 50);
    assert.equal(bounded.hasMore, true);
    assert.equal(new Set(bounded.items.map(item => item.id)).size, 50);
});

test('search route validates input and workspace before opening a session; failures close it', async () => {
    let handler, selectedDb, closed = 0;
    registerNodeSearch({ get: (_, callback) => { handler = callback; } }, {
        getActiveDb: () => 'meta',
        getDriver: db => {
            selectedDb = db;
            return { session: () => ({ run: async () => { throw new Error('Database unavailable'); }, close: async () => { closed++; } }) };
        },
    });
    const response = { status(code) { this.code = code; return this; }, json(body) { this.body = body; } };
    await handler({ query: { db: 'typo', q: 'render' } }, response);
    assert.equal(response.code, 400);
    assert.equal(selectedDb, undefined);
    await handler({ query: { db: 'project_db', q: '' } }, response);
    assert.equal(response.code, 400);
    assert.equal(selectedDb, undefined);
    await handler({ query: { db: 'project_db', q: 'render' } }, response);
    assert.equal(selectedDb, 'target');
    assert.equal(response.code, 500);
    assert.equal(closed, 1);
    assert.match(response.body.error, /unavailable/);
    for (const value of [null, [], {}, '', ' ', 'a'.repeat(201)]) assert.throws(() => parseSearchQuery(value), /between 1 and 200/);
});

test('Explore hides identifiers without losing the data needed for exact navigation', async () => {
    const { resultColumns } = await import('../frontend/src/explore/resultColumns.js');
    const row = { uid: 'Function||file=a.js||name=run', ipv6: 'duplicate-address', score: 10, file: 'a.js', entryPoint: 'run' };
    assert.deepEqual(resultColumns(row).columns, ['entryPoint', 'file', 'score']);
    assert.deepEqual(resultColumns(row, true).columns, ['entryPoint', 'file', 'score', 'uid', 'ipv6']);
    assert.equal(row.uid, 'Function||file=a.js||name=run');
    assert.deepEqual(resultColumns({ uid: 'only-identity' }).columns, ['uid']);
    assert.deepEqual(resultColumns({ count: 8 }).columns, ['count']);
});

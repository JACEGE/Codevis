const test = require('node:test');
const assert = require('node:assert/strict');
const { openTestDb } = require('./helpers/ladybug-session.cjs');
const builder = require('../scripts/graph_builder.js');

// C importiert B, B importiert das geänderte A. Der inkrementelle Build parst
// A und B neu, C aber nicht — C's Kanten in B gingen mit B's Knoten verloren.
test('incremental rebuild re-attaches edges from files that are not reparsed', async () => {
    const { backupIncomingCodeEdges, restoreIncomingCodeEdges, removeFileDerivedNodes } = builder.__testing__;
    const d = await openTestDb();
    const session = d.session;
    try {
        const createB = async () => {
            await session.run(`MERGE (f:File {path: 'src/b.js'})`);
            await session.run(`MERGE (f:Function {uid: 'fn:beta'}) SET f.name = 'beta', f.file = 'src/b.js'`);
        };
        await session.run(`MERGE (f:File {path: 'src/c.js'})`);
        await session.run(`MERGE (f:Function {uid: 'fn:gamma'}) SET f.name = 'gamma', f.file = 'src/c.js'`);
        await createB();
        await session.run(`MATCH (c:File {path: 'src/c.js'}), (b:File {path: 'src/b.js'}) MERGE (c)-[:IMPORTS]->(b)`);
        await session.run(`MATCH (g:Function {name: 'gamma'}), (b:Function {name: 'beta'})
                           MERGE (g)-[r:CALLS]->(b) SET r.resolvedBy = 'import', r.\`order\` = 2`);

        const saved = await backupIncomingCodeEdges(session, ['src/b.js']);
        assert.equal(saved.length, 2);
        await removeFileDerivedNodes(session, ['src/b.js']);
        await createB();
        assert.equal(await restoreIncomingCodeEdges(session, saved), 2);
        // Idempotent: a second pass merges onto the existing edges.
        await restoreIncomingCodeEdges(session, saved);

        const imports = await session.run(`MATCH (:File {path: 'src/c.js'})-[r:IMPORTS]->(:File {path: 'src/b.js'}) RETURN count(r) AS c`);
        assert.equal(Number(imports.records[0].get('c')), 1);
        const calls = await session.run(`MATCH (:Function {name: 'gamma'})-[r:CALLS]->(:Function {name: 'beta'})
                                         RETURN r.resolvedBy AS resolvedBy, r.\`order\` AS o`);
        assert.equal(calls.records.length, 1);
        assert.equal(calls.records[0].get('resolvedBy'), 'import');
        assert.equal(Number(calls.records[0].get('o')), 2);
    } finally {
        await d.cleanup();
    }
});

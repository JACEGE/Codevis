const test = require('node:test');
const assert = require('node:assert/strict');
const { isWriteQuery } = require('../server/query-security.cjs');
const { runReadOnlyQuery } = require('../server/read-only-query.cjs');

const unsafe = [
    '// "\nMATCH (n) SET n.name = \'changed\' RETURN n.name // "',
    '/* " */ MATCH (n) DETACH DELETE n // "',
    'ALTER TABLE CodeNode ADD reviewProbe STRING',
    "COPY CodeNode FROM 'probe.csv'", "COPY (MATCH (n) RETURN n) TO 'probe.csv'",
    'INSTALL httpfs', 'LOAD EXTENSION httpfs', "ATTACH 'other.db' AS other",
    'CALL arbitrary_procedure()', "CALL `arbitrary_procedure`()",
    'RETURN 1; RETURN 2', 'RETURN 1; COMMIT', 'CALL {RETURN 1}',
    "RETURN 'unterminated", 'RETURN 1 /* unterminated',
];

test('read-only validation rejects comment/quote bypasses and privileged statements', () => {
    for (const query of unsafe) assert.equal(isWriteQuery(query), true, query);
    for (const query of [
        '/* quotes: " \' */ MATCH (n) RETURN n;',
        'RETURN "// SET /* DELETE */" AS text',
        "RETURN 'it\\'s CREATE' AS text", 'RETURN 1 AS `DELETE`',
        'CALL show_tables() RETURN *', 'CALL db.labels() YIELD label RETURN label',
    ]) assert.equal(isWriteQuery(query), false, query);
});

test('guarded native reads leave data/schema unchanged and recover after query errors', async () => {
    const kuzu = require('@ladybugdb/core');
    const db = new kuzu.Database(':memory:');
    const conn = new kuzu.Connection(db);
    try {
        await conn.query('CREATE NODE TABLE CodeNode(uid STRING, name STRING, PRIMARY KEY(uid))');
        await conn.query("CREATE (:CodeNode {uid:'probe', name:'original'})");
        for (const query of unsafe) await assert.rejects(runReadOnlyQuery(conn, query), /read-only/);
        await assert.rejects(runReadOnlyQuery(conn, 'MATCH (n) RETURN n.noSuchProperty'));
        const result = await runReadOnlyQuery(conn, 'MATCH (n) WHERE n.uid = $id RETURN n.name AS name', { id: 'probe' });
        assert.deepEqual(result.rows, [{ name: 'original' }]);
        await assert.rejects(conn.query('MATCH (n) RETURN n.reviewProbe'));
        // Exercise the engine boundary independently of the lexical guard.
        await conn.query('BEGIN TRANSACTION READ ONLY');
        await assert.rejects(conn.query("MATCH (n) SET n.name = 'changed'"), /read-only transaction/);
        try { await conn.query('ROLLBACK'); } catch (_) {}
        assert.deepEqual((await runReadOnlyQuery(conn, 'MATCH (n) RETURN n.name AS name')).rows, [{ name: 'original' }]);
    } finally { await conn.close(); await db.close(); }
});

/**
 * explore-queries.test.js
 *
 * Tests for the shared write-protection and query-execution services used by
 * POST /api/graph/query. The bridge itself starts a server on load, so route
 * mechanics stay thin and these services are tested directly.
 */

'use strict';

const assert = require('node:assert/strict');
const { test, describe } = require('node:test');
const { isWriteQuery } = require('../server/query-security.cjs');

// ── Reproduce the exact sanitiser from bridge.js ──────────────────────────────
// ── Write-keyword tests ───────────────────────────────────────────────────────

describe('isWriteQuery — plaintext write clauses', () => {
    const writeClauses = [
        'CREATE (n:Node) RETURN n',
        'MERGE (n:Node {id: 1}) RETURN n',
        'MATCH (n) SET n.x = 1',
        'MATCH (n) DELETE n',
        'MATCH (n) DETACH DELETE n',
        'MATCH (n) REMOVE n.x',
        'DROP INDEX ON :Node(id)',
        'CALL { CREATE (n) RETURN n }',
    ];

    for (const q of writeClauses) {
        test(`blocks: ${q.slice(0, 60)}`, () => {
            assert.equal(isWriteQuery(q), true, `Expected write: "${q}"`);
        });
    }
});

describe('isWriteQuery — keyword hidden in string literal (safe query, must NOT be blocked)', () => {
    const safeWithKeyword = [
        'MATCH (n) WHERE n.name = "CREATE" RETURN n',
        "MATCH (n) WHERE n.name = 'DELETE' RETURN n",
        'MATCH (n) WHERE n.code = "SET x = 1" RETURN n',
        'MATCH (n) WHERE n.description CONTAINS "MERGE" RETURN n',
        'MATCH (n) WHERE n.label = "REMOVE" RETURN n',
    ];

    for (const q of safeWithKeyword) {
        test(`allows: ${q.slice(0, 70)}`, () => {
            assert.equal(isWriteQuery(q), false, `Expected safe: "${q}"`);
        });
    }
});

describe('isWriteQuery — write keyword after comment (must still be blocked)', () => {
    // /* comment */ before a write clause is dangerous: the DB sees the clause.
    test('blocks /* comment */ CREATE', () => {
        assert.equal(isWriteQuery('/* harmless */ CREATE (n) RETURN n'), true);
    });

    test('blocks /* x */DELETE (n)', () => {
        assert.equal(isWriteQuery('MATCH (n)/*x*/DELETE (n)'), true);
    });

    test('blocks // comment on its own line, then SET on next line', () => {
        assert.equal(isWriteQuery('MATCH (n)\n// set x\nSET n.x = 1'), true);
    });

    test('keyword only inside comment is safe', () => {
        // After stripping the comment, only MATCH remains.
        assert.equal(isWriteQuery('/* CREATE (n) */ MATCH (n) RETURN n'), false);
    });

    test('line-comment-only keyword is safe', () => {
        assert.equal(isWriteQuery('MATCH (n) RETURN n // CREATE (n)'), false);
    });
});

describe('isWriteQuery — case insensitivity', () => {
    test('blocks cReAtE', () => {
        assert.equal(isWriteQuery('cReAtE (n) RETURN n'), true);
    });

    test('blocks delete lowercase', () => {
        assert.equal(isWriteQuery('MATCH (n) delete n'), true);
    });
});

describe('isWriteQuery — keyword as part of identifier (must NOT be blocked)', () => {
    // setStatus, createUser, etc. are identifiers, not clauses.
    test('allows function named setStatus', () => {
        assert.equal(isWriteQuery('MATCH (f:Function {name: "setStatus"}) RETURN f'), false);
    });

    test('allows property named created_at', () => {
        assert.equal(isWriteQuery('MATCH (n) WHERE n.created_at > 0 RETURN n'), false);
    });

    test('allows node label DeletedItem (not a clause)', () => {
        // "DeletedItem" starts with Delete but \b anchors at the end of "Delete" before "d" — no match
        // because the following character 'd' is still a word char so \b does NOT fire.
        assert.equal(isWriteQuery('MATCH (n:DeletedItem) RETURN n'), false);
    });
});

describe('isWriteQuery — plain read queries allowed', () => {
    const readQueries = [
        'MATCH (n) RETURN n LIMIT 10',
        'MATCH (f:Function)-[:CALLS]->(g) RETURN f.name, g.name',
        'MATCH (n) WHERE n.name = "foo" RETURN count(n)',
        'CALL db.labels() YIELD label RETURN label',
        'MATCH (f:File) OPTIONAL MATCH (f)-[:CONTAINS]->(func) RETURN f.path, count(func)',
    ];

    for (const q of readQueries) {
        test(`allows: ${q.slice(0, 70)}`, () => {
            assert.equal(isWriteQuery(q), false, `Expected safe: "${q}"`);
        });
    }
});

// ── Row limit tests ───────────────────────────────────────────────────────────

describe('Explore query execution', () => {
    test('returns every requested row and converts Ladybug integers', async () => {
        const { executeExploreQuery } = require('../server/explore-routes.cjs');
        let closed = false;
        const records = Array.from({ length: 600 }, (_, index) => ({
            keys: ['n'],
            get: () => ({ toNumber: () => index }),
        }));
        const driver = { session: () => ({
            runReadOnly: async () => ({ records }),
            close: async () => { closed = true; },
        }) };

        const result = await executeExploreQuery(driver, 'MATCH (n) RETURN n');
        assert.equal(result.rows.length, 600);
        assert.equal(result.rows[599].n, 599);
        assert.equal(result.rowCount, 600);
        assert.equal(result.truncated, false);
        assert.equal(result.limit, null);
        assert.equal(closed, true);
    });

    test('closes the session when query execution fails', async () => {
        const { executeExploreQuery } = require('../server/explore-routes.cjs');
        let closed = false;
        const driver = { session: () => ({
            runReadOnly: async () => { throw new Error('bad query'); },
            close: async () => { closed = true; },
        }) };

        await assert.rejects(executeExploreQuery(driver, 'broken'), /bad query/);
        assert.equal(closed, true);
    });
});

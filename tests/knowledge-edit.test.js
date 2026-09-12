const test = require('node:test');
const assert = require('node:assert/strict');
const { openTestDb } = require('./helpers/ladybug-session.cjs');
const { updateKnowledge } = require('../server/knowledge-edit.cjs');

test('Knowledge saves use exact identities; ambiguous names and Markdown cannot be overwritten', async () => {
    const db = await openTestDb();
    try {
        const ids = [];
        for (const content of ['First', 'Second']) {
            const result = await db.session.run("CREATE (k:Knowledge {name:'Shared', content:$content, category:'general'}) RETURN elementId(k) AS id", { content });
            ids.push(result.records[0].get('id'));
        }
        await assert.rejects(updateKnowledge(db.session, { name: 'Shared', content: 'Wrong' }), { status: 409 });
        const saved = await updateKnowledge(db.session, { nodeId: ids[0], content: 'Only first' });
        assert.equal(saved.nodeId, ids[0]);
        const untouched = await db.session.run('MATCH (k:Knowledge) WHERE elementId(k)=$id RETURN k.content AS content', { id: ids[1] });
        assert.equal(untouched.records[0].get('content'), 'Second');
        await db.session.run("MATCH (k:Knowledge) WHERE elementId(k)=$id SET k.kind='markdown', k.sourcePath='docs/rule.md'", { id: ids[1] });
        await assert.rejects(updateKnowledge(db.session, { nodeId: ids[1], content: 'Transient edit' }), error => error.status === 409 && /docs\/rule.md/.test(error.message));
        await assert.rejects(updateKnowledge(db.session, { nodeId: 'missing', content: '' }), { status: 404 });
        await assert.rejects(updateKnowledge(db.session, { nodeId: ids[0], content: null }), { status: 400 });
        await db.session.run("CREATE (k:Knowledge {name:'Unique', content:'Before'})");
        assert.equal((await updateKnowledge(db.session, { name: 'Unique', content: 'After' })).content, 'After');
    } finally { await db.cleanup(); }
});

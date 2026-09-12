const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openTestDb } = require('./helpers/ladybug-session.cjs');
const { syncKnowledgeMarkdown } = require('../scripts/knowledge_markdown.cjs');

test('Markdown sync preserves exact IDs, incoming links and unambiguous outgoing references', async () => {
    const db = await openTestDb();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codevis-knowledge-links-'));
    try {
        fs.writeFileSync(path.join(root, 'a.md'), '---\nid: first\ntitle: Shared\n---\nA');
        fs.writeFileSync(path.join(root, 'b.md'), '---\nid: second\ntitle: Shared\n---\nB');
        fs.writeFileSync(path.join(root, 'c.md'), '---\nid: referrer\ntitle: first\n---\nSee [[first]] and [[Shared]].');
        const config = { knowledge: { paths: ['.'] } }, quiet = { log() {}, warn() {} };
        const result = await syncKnowledgeMarkdown(db.session, root, config, quiet);
        const ids = await db.session.run('MATCH (k:Knowledge) RETURN elementId(k) AS id ORDER BY id');
        assert.deepEqual(ids.records.map(row => row.get('id')), ['knowledge-doc:first', 'knowledge-doc:referrer', 'knowledge-doc:second']);
        assert.equal(result.unresolved.length, 1);
        assert.match(result.unresolved[0], /Shared/);
        const linked = await db.session.run('MATCH (a:Knowledge)-[:REFERENCES]->(b:Knowledge) RETURN a.docId AS fromDoc, b.docId AS toDoc');
        assert.equal(linked.records.length, 1); assert.equal(linked.records[0].get('toDoc'), 'first');
        await db.session.run("CREATE (t:Task {taskId:'incoming'})");
        await db.session.run("MATCH (t:Task {taskId:'incoming'}), (k:Knowledge {docId:'first'}) CREATE (t)-[:REFERENCES]->(k)");
        fs.writeFileSync(path.join(root, 'a.md'), '---\nid: first\ntitle: Shared\n---\nUpdated A');
        await syncKnowledgeMarkdown(db.session, root, config, quiet);
        const kept = await db.session.run("MATCH (t:Task {taskId:'incoming'})-[:REFERENCES]->(k:Knowledge) RETURN elementId(k) AS id, k.content AS content");
        assert.equal(kept.records.length, 1); assert.equal(kept.records[0].get('id'), 'knowledge-doc:first');
        assert.equal(kept.records[0].get('content'), 'Updated A');
        // Old imports have generated immutable IDs. Keep their identity and
        // incoming relationships while synchronizing by stable document ID.
        fs.writeFileSync(path.join(root, 'legacy.md'), '---\nid: legacy\n---\nUpdated legacy');
        const legacy = await db.session.run("CREATE (k:Knowledge {name:'Legacy', docId:'legacy', kind:'markdown', content:'Before'}) RETURN elementId(k) AS id");
        const legacyId = legacy.records[0].get('id');
        await db.session.run("MATCH (t:Task {taskId:'incoming'}), (k:Knowledge {docId:'legacy'}) CREATE (t)-[:REFERENCES]->(k)");
        await syncKnowledgeMarkdown(db.session, root, config, quiet);
        const repaired = await db.session.run("MATCH (t:Task {taskId:'incoming'})-[:REFERENCES]->(k:Knowledge {docId:'legacy'}) RETURN elementId(k) AS id, k.content AS content");
        assert.equal(repaired.records[0].get('id'), legacyId);
        assert.equal(repaired.records[0].get('content'), 'Updated legacy');
    } finally { await db.cleanup(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('failed Markdown replacement preserves deleted notes, content, and authored incoming links', async t => {
    const db = await openTestDb();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codevis-knowledge-atomic-'));
    t.after(async () => { await db.cleanup(); fs.rmSync(root, { recursive: true, force: true }); });
    const config = { knowledge: { paths: ['.'] } }, quiet = { log() {}, warn() {} };
    fs.writeFileSync(path.join(root, 'old.md'), '---\nid: old\n---\nOld content');
    await syncKnowledgeMarkdown(db.session, root, config, quiet);
    await db.session.run("CREATE (:Task {taskId:'incoming'})");
    await db.session.run("MATCH (t:Task {taskId:'incoming'}), (k:Knowledge {docId:'old'}) CREATE (t)-[:REFERENCES]->(k)");
    fs.unlinkSync(path.join(root, 'old.md'));
    fs.writeFileSync(path.join(root, 'new.md'), '---\nid: new\n---\nReplacement');
    const run = db.session.run.bind(db.session);
    const mock = t.mock.method(db.session, 'run', async (q, p) => {
        if (q.includes('ON CREATE SET')) throw new Error('injected write failure');
        return run(q, p);
    });
    await assert.rejects(syncKnowledgeMarkdown(db.session, root, config, quiet), /injected write failure/);
    mock.mock.restore();
    const preserved = await db.session.run("MATCH (:Task {taskId:'incoming'})-[:REFERENCES]->(k:Knowledge) RETURN k.content AS content");
    assert.equal(preserved.records.length, 1);
    assert.equal(preserved.records[0].get('content'), 'Old content');
    await syncKnowledgeMarkdown(db.session, root, config, quiet);
    const replaced = await db.session.run('MATCH (k:Knowledge) RETURN k.docId AS id');
    assert.deepEqual(replaced.records.map(r => r.get('id')), ['new']);
});

test('an unavailable configured Markdown root cannot erase the last synchronized notes', async t => {
    const db = await openTestDb();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codevis-knowledge-missing-'));
    t.after(async () => { await db.cleanup(); fs.rmSync(root, { recursive: true, force: true }); });
    const docs = path.join(root, 'docs');
    fs.mkdirSync(docs);
    fs.writeFileSync(path.join(docs, 'rule.md'), '---\nid: rule\n---\nKeep me');
    const config = { knowledge: { paths: ['docs'] } }, quiet = { log() {}, warn() {} };
    await syncKnowledgeMarkdown(db.session, root, config, quiet);
    fs.renameSync(docs, path.join(root, 'unavailable'));
    await assert.rejects(syncKnowledgeMarkdown(db.session, root, config, quiet), /ENOENT/);
    const result = await db.session.run('MATCH (k:Knowledge) RETURN k.content AS content');
    assert.deepEqual(result.records.map(r => r.get('content')), ['Keep me']);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const vm = require('node:vm');
const { transformSync } = require('esbuild');
const { openTestDb } = require('./helpers/ladybug-session.cjs');
const filename = path.resolve(__dirname, '../tools/handlers/knowledge-tools.ts');
const mod = { exports: {} };
vm.runInNewContext(transformSync(fs.readFileSync(filename, 'utf8'), {
    loader: 'ts', format: 'cjs', define: { 'import.meta.url': JSON.stringify(pathToFileURL(filename).href) },
}).code, { module: mod, exports: mod.exports, require: name => name === '../lib/graph.js'
    ? { pickDbDriver: ctx => ctx.targetDriver } : require(name) });
const { handlers, definitions } = mod.exports.knowledgeTools;

test('knowledge lookup supports Files and keeps same-named Knowledge nodes distinct', async t => {
    const db = await openTestDb();
    t.after(() => db.cleanup());
    const ctx = { targetDriver: { session: () => db.session } };
    const call = async args => JSON.parse((await handlers.get_knowledge_for_node(args, ctx)).content[0].text);
    await db.session.run("CREATE (f:File {path:'src/file.js'}) CREATE (t:Task {taskId:'task'}) CREATE (a:Knowledge {name:'Rules',content:'First rule'}) CREATE (b:Knowledge {name:'Rules',content:'Second rule'}) CREATE (a)-[:APPLIES_TO]->(f) CREATE (b)-[:APPLIES_TO]->(f) CREATE (t)-[:AFFECTS]->(f) CREATE (a)-[:APPLIES_TO]->(t)");
    assert.equal((await call({ nodeName: 'src/file.js' })).knowledge.length, 2);
    const task = await call({ taskId: 'task' });
    assert.equal(task.knowledge.length, 2);
    assert.equal(new Set(task.knowledge.map(k => k.nodeId)).size, 2);
});

test('concurrent create_knowledge calls update one node instead of creating ambiguous duplicates', async t => {
    const db = await openTestDb();
    t.after(() => db.cleanup());
    const run = db.session.run.bind(db.session);
    let queue = Promise.resolve();
    db.session.run = (...args) => {
        const result = queue.then(() => run(...args));
        queue = result.catch(() => {});
        return result;
    };
    const ctx = { targetDriver: { session: () => db.session } };
    const results = await Promise.all(['first', 'second'].map(content => handlers.create_knowledge({ name: 'Concurrent', content }, ctx)));
    const values = results.map(result => JSON.parse(result.content[0].text));
    assert.equal(values[0].nodeId, values[1].nodeId);
    const stored = await db.session.run("MATCH (k:Knowledge {name:'Concurrent'}) RETURN k.content AS content");
    assert.equal(stored.records.length, 1);
    assert.equal(stored.records[0].get('content'), 'second');
});

test('MCP Knowledge writes and listings distinguish duplicate names and preserve Markdown authority', async () => {
    const db = await openTestDb();
    const ctx = { targetDriver: { session: () => db.session } };
    const call = async (name, args) => JSON.parse((await handlers[name](args, ctx)).content[0].text);
    try {
        const first = await call('create_knowledge', { name: 'Shared', content: 'First' });
        assert.equal(typeof first.nodeId, 'string');
        const result = await db.session.run("CREATE (k:Knowledge {name:'Shared', content:'Second', category:'general'}) RETURN elementId(k) AS id");
        const second = result.records[0].get('id');
        await assert.rejects(call('create_knowledge', { name: 'Shared', content: 'Wrong' }), { status: 409 });
        assert.equal((await call('create_knowledge', { nodeId: first.nodeId, name: 'Shared', content: 'Only first' })).status, 'UPDATED');
        await db.session.run("CREATE (f:File {path:'src/shared.js'}) CREATE (t:Task {taskId:'task-linked'})");
        await assert.rejects(call('link_knowledge', { knowledgeName: 'Shared', targetNodes: ['src/shared.js'] }), { status: 409 });
        const linked = await call('link_knowledge', { nodeId: first.nodeId, targetNodes: ['src/shared.js'], taskId: 'task-linked' });
        assert.equal(linked.edgesCreated, 2);
        const listing = await call('list_knowledge', {});
        assert.equal(listing.knowledge.length, 2);
        const firstRow = listing.knowledge.find(item => item.nodeId === first.nodeId);
        assert.ok(firstRow.linkedTo.some(node => node.type === 'File' && node.file === 'src/shared.js' && typeof node.id === 'string'));
        assert.ok(firstRow.linkedTo.some(node => node.type === 'Task' && node.name === 'task-linked'));
        assert.equal(listing.knowledge.find(item => item.nodeId === second).content, 'Second');
        const otherLinks = await db.session.run('MATCH (k:Knowledge)-[:APPLIES_TO]->(n) WHERE elementId(k)=$id RETURN count(n) AS c', { id: second });
        assert.equal(Number(otherLinks.records[0].get('c')), 0);
        await db.session.run("MATCH (k:Knowledge {name:'Shared'}) SET k.content='Identical content', k.createdAt=1");
        assert.equal((await call('list_knowledge', {})).knowledge.length, 2, 'equal display fields must not aggregate distinct Knowledge nodes');
        await db.session.run("MATCH (k:Knowledge) WHERE elementId(k)=$id SET k.name='Markdown', k.kind='markdown', k.sourcePath='docs/rule.md'", { id: second });
        await assert.rejects(call('create_knowledge', { name: 'Markdown', content: 'Transient' }), { status: 409 });
        await assert.rejects(call('link_knowledge', { nodeId: second, taskId: 'task-linked' }), { status: 409 });
        const markdown = (await call('list_knowledge', {})).knowledge.find(item => item.nodeId === second);
        assert.equal(markdown.sourcePath, 'docs/rule.md'); assert.equal(markdown.kind, 'markdown');
        assert.ok(definitions.find(tool => tool.name === 'link_knowledge').inputSchema.properties.nodeId);
    } finally { await db.cleanup(); }
});

const test = require('node:test');
const assert = require('node:assert/strict');
const { openTestDb } = require('./helpers/ladybug-session.cjs');
const { appendTaskComment, editTaskComment, deleteTaskComment } = require('../tools/lib/task-comments.cjs');

// Same per-query serialization as the daemon, with a deterministic interleave
// of two clients reading the same version before either attempts to write.
function clients(session) {
    let queue=Promise.resolve(), reads=0, release;
    const gate=new Promise(resolve=>{release=resolve;});
    return { run: async (query, params) => {
        const pending=queue.then(()=>session.run(query,params));
        queue=pending.then(()=>{},()=>{});
        const result=await pending;
        if (query.includes('RETURN t.comments AS c') && reads < 2) { if (++reads===2) release(); await gate; }
        return result;
    } };
}

for (const operation of ['append', 'edit', 'delete']) test(`concurrent append + ${operation} never loses another client's comment`, async () => {
    const { session, cleanup } = await openTestDb();
    try {
        await session.run("CREATE (:Task {taskId:'comments'})");
        const initial=await appendTaskComment(session,'comments',{text:'initial'});
        const transport=clients(session);
        const other = operation==='append'
            ? appendTaskComment(transport,'comments',{text:'other'})
            : operation==='edit' ? editTaskComment(transport,'comments',initial.value.id,'edited')
            : deleteTaskComment(transport,'comments',initial.value.id);
        await Promise.all([other, appendTaskComment(transport,'comments',{text:'concurrent',author:'agent'})]);
        const stored=await session.run("MATCH (t:Task {taskId:'comments'}) RETURN t.comments AS c");
        const comments=stored.records[0].get('c').map(JSON.parse);
        assert.ok(comments.some(c=>c.text==='concurrent'));
        assert.equal(comments.length, operation==='append'?3:operation==='edit'?2:1);
        if (operation==='edit') assert.ok(comments.some(c=>c.text==='edited'));
        assert.equal(new Set(comments.map(c=>c.id)).size,comments.length);
        await assert.rejects(deleteTaskComment(session,'comments','missing'), {status:404});
        await assert.rejects(appendTaskComment(session,'missing',{text:'x'}), {status:404});
    } finally { await cleanup(); }
});

test('bridge and MCP both use the cross-process comment mutation helper', () => {
    const fs=require('node:fs'), path=require('node:path');
    for(const file of ['server/bridge.js','tools/handlers/task-tools.ts']) {
        const source=fs.readFileSync(path.join(__dirname,'..',file),'utf8');
        assert.match(source,/await appendTaskComment\(session/);
        assert.doesNotMatch(source,/SET t.comments = \$list/);
    }
});

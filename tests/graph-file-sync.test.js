const test = require('node:test');
const assert = require('node:assert/strict');
const { openTestDb } = require('./helpers/ladybug-session.cjs');
const { syncGraphFile } = require('../server/graph-file-sync.cjs');

const fn = (name, calls = []) => ({ name, calls, startLine:1, endLine:1, snippet:`function ${name}() {}` });
const snapshot = (functions, extras = {}) => ({ file:'c.js', mtime:100, mode:'sync', functions, ...extras });
async function fixture(t) {
    const db = await openTestDb();
    t.after(db.cleanup);
    await syncGraphFile(db.session, snapshot([fn('targetD', ['helper']), fn('helper')]));
    await db.session.run(`MATCH (d:Function {name:'targetD'})
        CREATE (b:Function {name:'callerB',file:'a.js'}) CREATE (b)-[:CALLS]->(d)
        CREATE (t:Task {taskId:'task'}) CREATE (t)-[:AFFECTS]->(d)
        CREATE (k:Knowledge {name:'invariant'}) CREATE (k)-[:APPLIES_TO]->(d)`);
    return db;
}
async function calls(session) {
    const result = await session.run('MATCH (a:Function)-[:CALLS]->(b:Function) RETURN a.name AS caller,b.name AS callee ORDER BY caller,callee');
    return result.records.map(r => [r.get('caller'),r.get('callee')]);
}

test('batched replacement preserves incoming calls, exact identity and authored links', async t => {
    const { session } = await fixture(t);
    const id = async () => (await session.run("MATCH (d:Function {name:'targetD'}) RETURN elementId(d) AS id")).records[0].get('id');
    const before = await id();
    const result = await syncGraphFile(session, snapshot([fn('targetD'),fn('helper'),fn('added')], { mtime:200, mode:'commit', taskId:'task' }));
    assert.deepEqual(result.created, ['added']);
    assert.equal(await id(), before);
    assert.deepEqual(await calls(session), [['callerB','targetD']]);
    const links = await session.run(`MATCH (t:Task {taskId:'task'})-[:AFFECTS]->(d:Function {name:'targetD'})
        MATCH (:Knowledge {name:'invariant'})-[:APPLIES_TO]->(d)
        MATCH (t)-[:CREATED]->(:Function {name:'added'}) RETURN count(d) AS c`);
    assert.equal(Number(links.records[0].get('c')),1);
});

test('a failed batch rolls back metadata, new nodes, deleted calls and freshness together', async t => {
    const { session } = await fixture(t);
    const original = await calls(session);
    let reached = false;
    const faulty = {
        withTransaction: operation => session.withTransaction(() => operation(faulty)),
        run(query, params) {
            if (query.includes('MERGE (caller)-[:CALLS]')) { reached = true; throw new Error('write fault'); }
            return session.run(query, params);
        },
    };
    await assert.rejects(syncGraphFile(faulty, snapshot([
        {...fn('targetD',['added']), snippet:'changed'}, fn('helper'),fn('added'),
    ], { mtime:200, mode:'commit', taskId:'task' })), /write fault/);
    assert.equal(reached, true);
    assert.deepEqual(await calls(session), original);
    const state = await session.run(`MATCH (f:File {path:'c.js'}),(d:Function {name:'targetD'})
        RETURN f.lastSeenMtime AS mtime,d.bodySnippet AS snippet`);
    assert.equal(Number(state.records[0].get('mtime')),100);
    assert.equal(state.records[0].get('snippet'),fn('targetD').snippet);
    assert.equal((await session.run("MATCH (n:Function {name:'added'}) RETURN n.name AS name")).records.length,0);
});

test('batching retains sync versus commit import-resolution behavior', async t => {
    const { session } = await fixture(t);
    await session.run("CREATE (:Function {name:'externalTarget',file:'external.js'})");
    await syncGraphFile(session, snapshot([fn('targetD',['externalTarget']),fn('helper')]));
    assert.ok((await calls(session)).some(([a,b]) => a==='targetD' && b==='externalTarget'));
    await syncGraphFile(session, snapshot([fn('targetD',['externalTarget']),fn('helper')], { mode:'commit', taskId:'task' }));
    assert.deepEqual(await calls(session), [['callerB','targetD']]);
    await session.run("MATCH (f:File {path:'c.js'}) CREATE (e:File {path:'external.js'}) CREATE (f)-[:IMPORTS]->(e)");
    await syncGraphFile(session, snapshot([fn('targetD',['externalTarget']),fn('helper')], { mode:'commit', taskId:'task' }));
    assert.ok((await calls(session)).some(([a,b]) => a==='targetD' && b==='externalTarget'));
});

test('call batches retain relationships beyond the chunk boundary', async t => {
    const { session } = await fixture(t);
    const targets = Array.from({length:1001}, (_,i) => `missing${i}`);
    targets.push('helper');
    await syncGraphFile(session, snapshot([fn('targetD',targets),fn('helper')]));
    assert.deepEqual(await calls(session), [['callerB','targetD'],['targetD','helper']]);
});

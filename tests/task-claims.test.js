const test = require('node:test');
const assert = require('node:assert/strict');
const { openTestDb } = require('./helpers/ladybug-session.cjs');
const { taskClaimOperation, scopePath } = require('../server/task-claims.cjs');
const root = require('node:path').resolve(__dirname, '..');

async function fixture(t) {
    const db = await openTestDb();
    t.after(() => db.cleanup());
    const s = db.session;
    await s.run("CREATE (:Task {taskId:'a',status:'todo'}) CREATE (:Task {taskId:'b',status:'backlog'})");
    const op = (operation, taskId, files, extra = {}) => taskClaimOperation(s,
        { operation, taskId, agentId: `worker-${taskId}`, files, ...extra }, root);
    return { s, op };
}

test('planned scopes overlap without ownership; the losing claim changes nothing', async t => {
    const { s, op } = await fixture(t);
    await op('plan', 'a', ['new/shared.js']);
    await op('plan', 'b', ['new/shared.js', 'new/free.js']);
    assert.equal((await op('claim', 'a')).status, 'OK');
    const result = await op('claim', 'b');
    assert.equal(result.status, 'LOCK_CONFLICT');
    assert.equal(result.conflicts[0].taskId, 'a');
    assert.equal(result.retryable, false);
    const b = await s.run("MATCH (t:Task {taskId:'b'}) RETURN t.status AS status,t.assignedTo AS owner");
    assert.equal(b.records[0].get('status'), 'backlog');
    assert.equal(b.records[0].get('owner'), null);
    const free = await s.run("MATCH (n:TaskScope {file:'new/free.js'}) RETURN n.locked AS locked");
    assert.equal(free.records[0].get('locked'), null);
});

test('mutual expansion conflicts preserve existing claims and do not partially take free files', async t => {
    const { s, op } = await fixture(t);
    await op('plan', 'a', ['new/a.js']);
    await op('plan', 'b', ['new/b.js']);
    await op('claim', 'a');
    await op('claim', 'b');
    for (const [taskId, file] of [['a', 'new/b.js'], ['b', 'new/a.js']]) {
        const result = await op('expand', taskId, [file, 'new/free.js']);
        assert.equal(result.status, 'LOCK_CONFLICT');
        assert.equal(result.action, 'COORDINATE_SCOPE');
    }
    const locks = await s.run('MATCH (n:TaskScope) WHERE n.locked=true RETURN n.file AS file,n.lockGroup AS owner');
    assert.deepEqual(locks.records.map(r => [r.get('file'),r.get('owner')]).sort(), [['new/a.js','a'],['new/b.js','b']]);
    const free = await s.run("MATCH (n:TaskScope {file:'new/free.js'}) RETURN n.file AS file");
    assert.equal(free.records.length, 0);
});

test('file-backed node claims protect sibling functions and preserve exact IDs', async t => {
    const { s, op } = await fixture(t);
    await s.run("CREATE (f:Function {name:'one',file:'new/shared.js'}) CREATE (:Function {name:'two',file:'new/shared.js'}) WITH f MATCH (t:Task {taskId:'a'}) CREATE (t)-[:AFFECTS]->(f)");
    const one = await s.run("MATCH (n:Function {name:'two'}) RETURN elementId(n) AS id");
    await op('plan','b',undefined,{nodeIds:[one.records[0].get('id')]});
    assert.equal((await op('claim','a')).status, 'OK');
    assert.equal((await op('claim','b')).status, 'LOCK_CONFLICT');
});

test('an explicit release permits handoff and wrong-owner expansion fails', async t => {
    const { op } = await fixture(t);
    await op('plan','a',['new/shared.js']);
    await op('plan','b',['new/shared.js']);
    await op('claim','a');
    assert.equal((await op('expand','a',['new/extra.js'],{agentId:'worker-b'})).status,'NOT_OWNER');
    assert.equal((await op('transition','a',undefined,{newStatus:'todo'})).status,'OK');
    assert.equal((await op('claim','b')).status,'OK');
});

test('invalid scopes roll back without creating partial plans', async t => {
    const { s, op } = await fixture(t);
    await assert.rejects(op('plan','a',['new/okay.js','../outside.js']), /inside the project/);
    const result = await s.run('MATCH (n:TaskScope) RETURN n.name AS name');
    assert.equal(result.records.length,0);
    assert.throws(() => scopePath('src/**',root), /not globs/);
});

test('a failure after acquisition rolls back scope and assignment together', async t => {
    const { s, op } = await fixture(t);
    await op('plan','a',['new/a.js']);
    const run = s.run.bind(s);
    s.run = async (query, params) => {
        if (query.includes("SET t.status='in_progress'")) throw new Error('injected assignment failure');
        return run(query, params);
    };
    await assert.rejects(op('claim','a'), /injected assignment failure/);
    s.run = run;
    const result = await s.run('MATCH (n:TaskScope) RETURN n.locked AS locked');
    assert.equal(result.records[0].get('locked'),null);
    assert.equal((await op('claim','a')).status,'OK');
});

test('an expired scope cannot be expanded over a new owner', async t => {
    const { s, op } = await fixture(t);
    await op('plan','a',['new/shared.js']);
    await op('plan','b',['new/shared.js']);
    await op('claim','a');
    await s.run("MATCH (n) WHERE n.lockGroup='a' SET n.lockExpires=1");
    await op('claim','b');
    assert.equal((await op('expand','a',['new/free.js'])).status,'LOCK_CONFLICT');
});

test('creation plans overlapping files and preserves impact separately from edit scope', async t => {
    const { s, op } = await fixture(t);
    await s.run("CREATE (:Function {name:'affected',file:'new/indirect.js'})");
    const spec = { title:'Implement explicit scope',
        description:'Implement the requested change in its explicit file scope while preserving separate links to code that is affected indirectly by this work.',
        workInstructions:'Edit only the planned file, verify the resulting behavior, and leave indirect impact links unchanged.' };
    for (const taskId of ['created-a','created-b']) {
        const result = await op('create', taskId, ['new/shared.js'], {...spec,targetNodes:['affected']});
        assert.equal(result.status,'OK');
    }
    assert.equal((await op('claim','created-a')).status,'OK');
    assert.equal((await op('claim','created-b')).status,'LOCK_CONFLICT');
    const indirect = await s.run("MATCH (f:Function {name:'affected'}) RETURN f.locked AS locked");
    assert.equal(indirect.records[0].get('locked'),null);
});

test('edit checks protect newly created files and reject a lease that expired before writing', async t => {
    require('../lib/tsx-userinfo-preload.cjs');
    const unregister = require('tsx/cjs/api').register();
    t.after(unregister);
    const { withScopeGuard, assertFileScope } = require('../tools/lib/scope-guard.ts');
    const { s, op } = await fixture(t);
    await op('plan','a',['new/a.js']);
    await op('claim','a');
    const driver = {session:()=>s};
    await withScopeGuard({driver,root,agentId:'worker-a',taskId:'a'}, async () => {
        await assertFileScope('new/a.js');
        await assert.rejects(assertFileScope('new/unclaimed.js'), /Scope required/);
        await s.run("MATCH (n) WHERE n.lockGroup='a' SET n.lockExpires=1");
        await assert.rejects(assertFileScope('new/a.js'), /Scope required/);
    });
    await op('expand','a',['new/a.js']);
    await op('plan','b',['new/b.js']);
    await op('claim','b');
    await withScopeGuard({driver,root,agentId:'worker-b',taskId:'b'}, async () => {
        await assert.rejects(assertFileScope('new/a.js'), /Scope conflict/);
    });
});

test('file scopes survive incremental and full code rebuilds', async t => {
    require('../lib/tsx-userinfo-preload.cjs');
    const unregister = require('tsx/cjs/api').register();
    t.after(unregister);
    const { withScopeGuard, assertFileScope } = require('../tools/lib/scope-guard.ts');
    const { PRESERVED_LABELS, __testing__: { removeFileDerivedNodes } } = require('../scripts/graph_builder.js');
    const { s, op } = await fixture(t);
    await s.run("CREATE (:Function {name:'before',file:'new/rebuilt.js'})");
    await op('plan','a',['new/rebuilt.js']);
    await op('claim','a');
    await removeFileDerivedNodes(s,['new/rebuilt.js']);
    await s.run("CREATE (:Function {name:'incremental',file:'new/rebuilt.js'})");
    await s.run('MATCH (n) WHERE ' + PRESERVED_LABELS.map(label => `NOT n:${label}`).join(' AND ') + ' DETACH DELETE n');
    await s.run("CREATE (:Function {name:'rebuilt',file:'new/rebuilt.js'})");
    const scopes = await s.run("MATCH (:Task {taskId:'a'})-[:RESERVES]->(s:TaskScope) RETURN s.lockedBy AS owner");
    assert.equal(scopes.records[0].get('owner'),'worker-a');
    await withScopeGuard({driver:{session:()=>s},root,agentId:'worker-a',taskId:'a'},
        () => assertFileScope('new/rebuilt.js'));
    await op('plan','b',['new/rebuilt.js']);
    assert.equal((await op('claim','b')).status,'LOCK_CONFLICT');
});

test('standalone acquisition protects a file without requiring a task row', async t => {
    const { op } = await fixture(t);
    assert.equal((await op('acquire','standalone',['new/a.js'])).status,'OK');
    await op('plan','a',['new/a.js']);
    assert.equal((await op('claim','a')).status,'LOCK_CONFLICT');
});

test('Strict rejects expansion and active mode changes without altering scope', async t => {
    const { op } = await fixture(t);
    assert.equal((await op('set_policy','a',undefined,{scopeMode:'strict'})).status,'OK');
    await op('plan','a',['new/a.js']);
    await op('claim','a');
    assert.equal((await op('expand','a',['new/b.js'])).status,'SCOPE_FIXED');
    assert.equal((await op('set_policy','a',undefined,{scopeMode:'open'})).status,'INVALID_STATE');
    await op('plan','b',['new/b.js']);
    assert.equal((await op('claim','b')).status,'OK');
});

test('Epic defaults are inherited at claim time and cannot change active task policy', async t => {
    const { s, op } = await fixture(t);
    await s.run("CREATE (e:Epic {taskId:'epic-a',scopeMode:'strict'}) WITH e MATCH (t:Task {taskId:'a'}) CREATE (e)-[:FULFILLED_BY]->(t)");
    await op('plan','a',['new/a.js']);
    assert.equal((await op('claim','a')).scopeMode,'strict');
    await op('set_policy','epic-a',undefined,{scopeMode:'open'});
    assert.equal((await op('expand','a',['new/b.js'])).status,'SCOPE_FIXED');
    await op('transition','a',undefined,{newStatus:'todo'});
    assert.equal((await op('claim','a')).scopeMode,'open');
});

test('Open allows free files but never overwrites another task claim', async t => {
    require('../lib/tsx-userinfo-preload.cjs');
    const unregister = require('tsx/cjs/api').register(); t.after(unregister);
    const { withScopeGuard, assertFileScope } = require('../tools/lib/scope-guard.ts');
    const { s, op } = await fixture(t);
    await op('set_policy','a',undefined,{scopeMode:'open'});
    await op('claim','a');
    await op('plan','b',['new/b.js']); await op('claim','b');
    await withScopeGuard({driver:{session:()=>s},root,agentId:'worker-a',taskId:'a'}, async () => {
        await assertFileScope('new/free.js');
        await assert.rejects(assertFileScope('new/b.js'), /Scope conflict/);
    });
});

test('review completion releases scope and restarting work reacquires it', async t => {
    const { op } = await fixture(t);
    await op('plan','a',['new/shared.js']);
    await op('plan','b',['new/shared.js']);
    await op('claim','a');
    await op('complete','a');
    assert.equal((await op('claim','b')).status,'OK');
    assert.equal((await op('transition','a',undefined,{newStatus:'in_progress'})).status,'LOCK_CONFLICT');
    await op('complete','b');
    assert.equal((await op('transition','a',undefined,{newStatus:'in_progress'})).status,'OK');
});

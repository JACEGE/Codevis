const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
require('../lib/tsx-userinfo-preload.cjs');
require('tsx/cjs/api').register();
const { taskTools, clusterByFile } = require('../tools/handlers/task-tools.ts');
const { commitSyncWave } = require('../tools/lib/graph-sync.ts');
const { openTestDb } = require('./helpers/ladybug-session.cjs');

async function fixture(t) {
    const db = await openTestDb();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codevis-task-sync-'));
    fs.mkdirSync(path.join(root, '.claude'));
    const previous = process.env.CODEVIS_PROJECT_DIR;
    process.env.CODEVIS_PROJECT_DIR = root;
    t.after(async () => {
        if (previous === undefined) delete process.env.CODEVIS_PROJECT_DIR;
        else process.env.CODEVIS_PROJECT_DIR = previous;
        await db.cleanup(); fs.rmSync(root, { recursive: true, force: true });
    });
    const driver = { session: () => db.session };
    // Match the daemon driver's integer wrappers for count/wave columns.
    const runQuery = db.session.run.bind(db.session);
    db.session.run = async (...args) => {
        const result = await runQuery(...args);
        return { ...result, records: result.records.map(row => ({ ...row, get: key => {
            const value = row.get(key);
            return Number.isInteger(value) ? { toNumber: () => value, valueOf: () => value, toJSON: () => value } : value;
        } })) };
    };
    db.session.taskClaimAtomic = options => require('../server/task-claims.cjs').taskClaimOperation(db.session, options, root);
    const ctx = { targetDriver: driver, metaDriver: driver, defaultAgentId: 'audit', lockingEnabled: false };
    const run = async (name, args) => {
        const result = await taskTools.handlers[name](args, ctx);
        return { ...JSON.parse(result.content[0].text), isError: result.isError };
    };
    await db.session.run("CREATE (:Task {taskId:'task', status:'review', wave:1, waveStatus:'active'})");
    return { ...db, root, driver, run };
}

test('standalone synchronization reports unreadable files as failures', async t => {
    const h = await fixture(t);
    await h.session.run("MATCH (t:Task {taskId:'task'}) CREATE (n:Function {name:'missing', file:'missing.js'}) CREATE (t)-[:AFFECTS]->(n)");
    const result = await h.run('sync_task', { taskId: 'task' });
    assert.equal(result.status, 'SYNC_FAILED');
    assert.equal(result.isError, true);
    assert.deepEqual(result.failedFiles, ['missing.js']);
});

for (const mode of ['task', 'wave']) {
    test(`${mode} synchronization includes File paths, actual touches, and explicit file scope`, async t => {
        const h = await fixture(t);
        for (const [file, label, property, relation] of [
            ['file.js', 'File', 'path', 'AFFECTS'],
            ['touched.js', 'Function', 'file', 'TOUCHED'],
            ['reserved.js', 'TaskScope', 'file', 'RESERVES'],
        ]) {
            fs.writeFileSync(path.join(h.root, file), `function ${file.split('.')[0]}() { return 1; }`);
            await h.session.run(`MATCH (t:Task {taskId:'task'}) CREATE (n:${label} {${property}:$file}) CREATE (t)-[:${relation}]->(n)`, { file });
        }
        const result = mode === 'task' ? await h.run('sync_task', { taskId: 'task' }) : await commitSyncWave(1, h.driver);
        assert.equal(result.status, 'OK');
        const files = await h.session.run('MATCH (n:Function) WHERE n.name IS NOT NULL RETURN n.file AS file');
        assert.deepEqual(files.records.map(r => r.get('file')).sort(), ['file.js', 'reserved.js', 'touched.js']);
    });
}

test('synchronizing an unknown task reports not found', async t => {
    const h = await fixture(t);
    assert.equal((await h.run('sync_task', { taskId: 'missing' })).status, 'NOT_FOUND');
});

test('completing a nonexistent wave cannot activate the following wave', async t => {
    const h = await fixture(t);
    await h.session.run("MATCH (t:Task {taskId:'task'}) SET t.wave=2, t.status='backlog', t.waveStatus='pending'");
    assert.equal((await h.run('complete_wave', { waveId: 1 })).status, 'NOT_FOUND');
    const task = await h.session.run("MATCH (t:Task {taskId:'task'}) RETURN t.status AS status");
    assert.equal(task.records[0].get('status'), 'backlog');
});

test('task completion reports graph failure while preserving its review transition, then permits sync retry', async t => {
    const h = await fixture(t);
    await h.session.run("MATCH (t:Task {taskId:'task'}) SET t.status='in_progress', t.assignedTo='audit' CREATE (n:File {path:'new.js'}) CREATE (t)-[:TOUCHED]->(n)");
    const completed = await h.run('complete_task', { taskId: 'task', agentId: 'audit', summary: 'Completed work' });
    assert.equal(completed.status, 'SYNC_FAILED');
    assert.equal(completed.isError, true);
    assert.equal(completed.newStatus, 'review');
    assert.deepEqual(completed.failedFiles, ['new.js']);
    fs.writeFileSync(path.join(h.root, 'new.js'), 'function recovered() {}');
    assert.equal((await h.run('sync_task', { taskId: 'task' })).status, 'OK');
});

test('wave planning supports dependency chains longer than twenty waves', async t => {
    const h = await fixture(t);
    await h.session.run("MATCH (t:Task {taskId:'task'}) DELETE t");
    for (let i = 1; i <= 21; i++) {
        await h.session.run("CREATE (:Task {taskId:$id, title:$id, status:'backlog'})", { id: `task-${i}` });
        if (i > 1) await h.session.run("MATCH (a:Task {taskId:$a}), (b:Task {taskId:$b}) CREATE (a)-[:DEPENDS_ON {kind:'manual'}]->(b)", { a: `task-${i-1}`, b: `task-${i}` });
    }
    const plan = await h.run('plan_task_waves', { commit: false });
    assert.equal(plan.status, 'OK');
    assert.equal(plan.totalWaves, 21);
    assert.equal(plan.waves[0], undefined);
    assert.equal(plan.waves[21][0].taskId, 'task-21');
});

test('wave preview preserves previously stored derived dependencies', async t => {
    const h = await fixture(t);
    await h.session.run("MATCH (t:Task {taskId:'task'}) SET t.status='backlog' CREATE (b:Task {taskId:'other', status:'backlog'}) CREATE (t)-[:DEPENDS_ON {kind:'derived'}]->(b)");
    assert.equal((await h.run('plan_task_waves', { commit: false })).status, 'OK');
    const edges = await h.session.run("MATCH (a:Task)-[:DEPENDS_ON]->(b:Task) RETURN a.taskId AS a, b.taskId AS b");
    assert.equal(edges.records.length, 1);
});

test('committing a valid preview persists its dependency order and derived edges', async t => {
    const h = await fixture(t);
    await h.session.run("MATCH (a:Task {taskId:'task'}) SET a.status='backlog' CREATE (b:Task {taskId:'dependency', status:'backlog'}) CREATE (f:Function {name:'caller', file:'a.js'}) CREATE (g:Function {name:'callee', file:'b.js'}) CREATE (a)-[:AFFECTS]->(f) CREATE (b)-[:AFFECTS]->(g) CREATE (f)-[:CALLS]->(g)");
    const preview = await h.run('plan_task_waves', { commit: false });
    const saved = await h.run('plan_task_waves', { commit: true });
    assert.equal(saved.status, 'OK');
    assert.equal(saved.committed, true);
    assert.deepEqual(saved.waves, preview.waves);
    const edge = await h.session.run("MATCH (a:Task)-[r:DEPENDS_ON]->(b:Task) RETURN a.taskId AS a, b.taskId AS b, r.kind AS kind");
    assert.equal(edge.records.length, 1);
    assert.equal(edge.records[0].get('a'), 'dependency');
    assert.equal(edge.records[0].get('b'), 'task');
    assert.equal(edge.records[0].get('kind'), 'derived');
    const tasks = await h.session.run('MATCH (t:Task) RETURN t.taskId AS id, t.wave AS wave');
    assert.deepEqual(Object.fromEntries(tasks.records.map(r => [r.get('id'), Number(r.get('wave'))])), { task: 2, dependency: 1 });
});

test('cyclic wave dependencies are reported without committing an unsafe wave', async t => {
    const h = await fixture(t);
    await h.session.run("MATCH (t:Task {taskId:'task'}) SET t.status='backlog', t.wave=7 CREATE (b:Task {taskId:'other', status:'backlog', wave:7}) CREATE (t)-[:DEPENDS_ON {kind:'manual'}]->(b) CREATE (b)-[:DEPENDS_ON {kind:'manual'}]->(t)");
    const result = await h.run('plan_task_waves', { commit: true });
    assert.equal(result.status, 'CYCLE');
    assert.equal(result.isError, true);
    const waves = await h.session.run('MATCH (t:Task) RETURN t.wave AS wave');
    assert.deepEqual(waves.records.map(r => Number(r.get('wave'))), [7, 7]);
});

test('Windows drive letters do not merge unrelated workflow execution groups', () => {
    const groups = clusterByFile([
        { taskId: 'a', targetNodes: ['C:/project/a.cpp:Thing::work'] },
        { taskId: 'b', targetNodes: ['C:/project/b.cpp:Thing::work'] },
        { taskId: 'c', targetNodes: ['C:/project/a.cpp:Thing::other'] },
    ]);
    assert.deepEqual(groups.map(group => group.map(task => task.taskId).sort()).sort(), [['a', 'c'], ['b']]);
});

test('a failed wave sync leaves the next wave pending and succeeds after file repair', async t => {
    const h = await fixture(t);
    await h.session.run("MATCH (t:Task {taskId:'task'}) CREATE (n:File {path:'repair.js'}) CREATE (t)-[:AFFECTS]->(n) CREATE (:Task {taskId:'next', wave:2, status:'backlog', waveStatus:'pending'})");
    assert.equal((await h.run('complete_wave', { waveId: 1 })).status, 'SYNC_FAILED');
    const nextStatus = async () => (await h.session.run("MATCH (t:Task {taskId:'next'}) RETURN t.status AS status")).records[0].get('status');
    assert.equal(await nextStatus(), 'backlog');
    fs.writeFileSync(path.join(h.root, 'repair.js'), 'function repaired() {}');
    assert.equal((await h.run('complete_wave', { waveId: 1 })).status, 'OK');
    assert.equal(await nextStatus(), 'todo');
});

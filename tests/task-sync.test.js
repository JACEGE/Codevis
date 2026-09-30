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

test('standalone synchronization reports deleted and unsupported files as skipped warnings, not errors', async t => {
    const h = await fixture(t);
    fs.writeFileSync(path.join(h.root, 'notes.md'), '# notes');
    await h.session.run("MATCH (t:Task {taskId:'task'}) CREATE (n:Function {name:'missing', file:'missing.js'}) CREATE (d:File {path:'notes.md'}) CREATE (t)-[:AFFECTS]->(n) CREATE (t)-[:TOUCHED]->(d)");
    const result = await h.run('sync_task', { taskId: 'task' });
    assert.equal(result.status, 'OK_WITH_WARNINGS');
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.failedFiles, []);
    assert.deepEqual(result.skippedFiles.map(f => f.file).sort(), ['missing.js', 'notes.md']);
    assert.ok(result.skippedFiles.every(f => /skipped/.test(f.reason)));
    assert.match(result.note, /status is unchanged/);
});

test('standalone synchronization reports syntax errors per file without an error result', async t => {
    const h = await fixture(t);
    fs.writeFileSync(path.join(h.root, 'broken.js'), 'function {');
    await h.session.run("MATCH (t:Task {taskId:'task'}) CREATE (n:File {path:'broken.js'}) CREATE (t)-[:TOUCHED]->(n)");
    const result = await h.run('sync_task', { taskId: 'task' });
    assert.equal(result.status, 'OK_WITH_WARNINGS');
    assert.equal(result.isError, undefined);
    assert.equal(result.failedFiles[0].file, 'broken.js');
    assert.match(result.failedFiles[0].reason, /syntax errors/);
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

test('task completion never fails on graph sync problems and tells the agent it is finished', async t => {
    const h = await fixture(t);
    fs.writeFileSync(path.join(h.root, 'broken.js'), 'function {');
    fs.writeFileSync(path.join(h.root, 'README.md'), '# docs');
    await h.session.run("MATCH (t:Task {taskId:'task'}) SET t.status='in_progress', t.assignedTo='audit' CREATE (n:File {path:'new.js'}) CREATE (b:File {path:'broken.js'}) CREATE (d:File {path:'README.md'}) CREATE (t)-[:TOUCHED]->(n) CREATE (t)-[:TOUCHED]->(b) CREATE (t)-[:TOUCHED]->(d)");
    const completed = await h.run('complete_task', { taskId: 'task', agentId: 'audit', summary: 'Completed work' });
    assert.equal(completed.status, 'OK_WITH_WARNINGS');
    assert.equal(completed.isError, undefined);
    assert.equal(completed.newStatus, 'review');
    assert.equal(completed.taskComplete, true);
    assert.match(completed.note, /No further action is required/);
    assert.deepEqual(completed.skippedFiles.map(f => f.file).sort(), ['README.md', 'new.js']);
    assert.deepEqual(completed.failedFiles.map(f => f.file), ['broken.js']);
    const stored = await h.session.run("MATCH (t:Task {taskId:'task'}) RETURN t.status AS status");
    assert.equal(stored.records[0].get('status'), 'review');
    fs.writeFileSync(path.join(h.root, 'broken.js'), 'function recovered() {}');
    fs.writeFileSync(path.join(h.root, 'new.js'), 'function created() {}');
    const retried = await h.run('sync_task', { taskId: 'task' });
    assert.equal(retried.graphSynced, 2);
    assert.deepEqual(retried.failedFiles, []);
});

test('the task creator and lead agents may complete a task; strangers may not', async t => {
    const h = await fixture(t);
    await h.session.run("MATCH (t:Task {taskId:'task'}) SET t.status='in_progress', t.assignedTo='worker-gone', t.createdBy='creator' CREATE (:Task {taskId:'led', status:'in_progress', assignedTo:'worker-gone', createdBy:'someone'})");
    const denied = await h.run('complete_task', { taskId: 'task', agentId: 'stranger' });
    assert.equal(denied.status, 'NOT_OWNER');
    assert.equal(denied.isError, true);
    assert.match(denied.message, /task creator/);
    const byCreator = await h.run('complete_task', { taskId: 'task', agentId: 'creator' });
    assert.equal(byCreator.status, 'OK');
    assert.equal(byCreator.newStatus, 'review');
    assert.equal((await h.run('complete_task', { taskId: 'led', agentId: 'lead-agent' })).status, 'OK');
});

test('agents are told that review is terminal when they try to mark a task done', async t => {
    const h = await fixture(t);
    const result = await h.run('update_task_status', { taskId: 'task', status: 'done', agentId: 'worker-a' });
    assert.equal(result.status, 'FORBIDDEN');
    assert.match(result.hint, /review' is the terminal state/);
});

test('a blocked wave gate names the open tasks and treats review as finished', async t => {
    const h = await fixture(t);
    await h.session.run("CREATE (:Task {taskId:'open', title:'Open work', status:'in_progress', assignedTo:'worker-a', wave:1})");
    const result = await h.run('complete_wave', { waveId: 1 });
    assert.equal(result.status, 'GATE_BLOCKED');
    assert.deepEqual(result.openTasks.map(task => task.taskId), ['open']);
    assert.match(result.hint, /\(open\)/);
    assert.match(result.hint, /review counts as finished/);
    await h.session.run("MATCH (t:Task {taskId:'open'}) SET t.status='review'");
    assert.equal((await h.run('complete_wave', { waveId: 1 })).status, 'OK');
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
    fs.writeFileSync(path.join(h.root, 'repair.js'), 'function {');
    await h.session.run("MATCH (t:Task {taskId:'task'}) CREATE (n:File {path:'repair.js'}) CREATE (t)-[:AFFECTS]->(n) CREATE (:Task {taskId:'next', wave:2, status:'backlog', waveStatus:'pending'})");
    assert.equal((await h.run('complete_wave', { waveId: 1 })).status, 'SYNC_FAILED');
    const nextStatus = async () => (await h.session.run("MATCH (t:Task {taskId:'next'}) RETURN t.status AS status")).records[0].get('status');
    assert.equal(await nextStatus(), 'backlog');
    fs.writeFileSync(path.join(h.root, 'repair.js'), 'function repaired() {}');
    assert.equal((await h.run('complete_wave', { waveId: 1 })).status, 'OK');
    assert.equal(await nextStatus(), 'todo');
});

test('wave synchronization skips deleted and unsupported files instead of blocking the wave', async t => {
    const h = await fixture(t);
    fs.writeFileSync(path.join(h.root, 'config.json'), '{}');
    await h.session.run("MATCH (t:Task {taskId:'task'}) CREATE (a:File {path:'gone.js'}) CREATE (b:File {path:'config.json'}) CREATE (t)-[:AFFECTS]->(a) CREATE (t)-[:AFFECTS]->(b)");
    const result = await commitSyncWave(1, h.driver);
    assert.equal(result.status, 'OK');
    assert.deepEqual(result.skippedFiles.map(f => f.file).sort(), ['config.json', 'gone.js']);
});

test('synchronization picks up files the touch-recorder journaled and attributes their functions', async t => {
    const h = await fixture(t);
    const source = 'function helper() { return 1; }\n\nfunction renewLimit(loan) {\n  return loan.renewCount < 2;\n}\n';
    fs.writeFileSync(path.join(h.root, 'fresh.js'), source);
    const { appendJournal, withSnippets, readJournal } = require('../lib/touch-journal.cjs');
    appendJournal(h.root, { taskId: 'task', file: 'fresh.js', kind: 'Write', ranges: withSnippets([{ start: 3, end: 5 }], source) });

    const result = await h.run('sync_task', { taskId: 'task' });
    assert.equal(result.status, 'OK');
    assert.equal(result.attributedEdits.edits, 1);
    const touched = await h.session.run("MATCH (:Task {taskId:'task'})-[:TOUCHED]->(f:Function) RETURN f.name AS name");
    assert.deepEqual(touched.records.map(r => r.get('name')), ['renewLimit']);
    assert.equal(readJournal(h.root, 'task').length, 1, 'sync_task keeps the journal for complete_task');
});

test('a field inserted above a method is credited to its class, not to the method', async t => {
    const h = await fixture(t);
    const source = 'class Loan {\n  returnedAt = null;\n  renewCount = 0;\n  close(at) { this.returnedAt = at; }\n}\n';
    fs.writeFileSync(path.join(h.root, 'loan.js'), source);
    // Class nodes come from the full build; the per-file sync only re-parses functions.
    await h.session.run("CREATE (:Class {name:'Loan', file:'loan.js', startLine:1, endLine:5})");
    const { appendJournal, withSnippets } = require('../lib/touch-journal.cjs');
    appendJournal(h.root, { taskId: 'task', file: 'loan.js', kind: 'Edit', ranges: withSnippets([{ start: 3, end: 3 }], source) });

    await h.run('sync_task', { taskId: 'task' });
    const touched = await h.session.run("MATCH (:Task {taskId:'task'})-[:TOUCHED]->(n) WHERE n:Function OR n:Class RETURN n.name AS name");
    assert.deepEqual(touched.records.map(r => r.get('name')).sort(), ['Loan']);
});

test('TOUCHED records who changed what and when, and whether the task created it', async t => {
    const h = await fixture(t);
    const before = 'function renewLimit(loan) {\n  return loan.renewCount < 2;\n}\n';
    fs.writeFileSync(path.join(h.root, 'loan.js'), before);
    // renewLimit existed long before the task started.
    await h.session.run("CREATE (:Function {name:'renewLimit', file:'loan.js', startLine:1, endLine:3, createdAt:1000})");
    const after = before + '\nfunction overdueFee(loan) {\n  return loan.daysLate * 2;\n}\n';
    fs.writeFileSync(path.join(h.root, 'loan.js'), after);
    const { appendJournal, withSnippets } = require('../lib/touch-journal.cjs');
    const firstEdit = Date.now() - 60000;
    appendJournal(h.root, { taskId: 'task', agentId: 'worker-a', at: firstEdit, file: 'loan.js', kind: 'Edit', ranges: withSnippets([{ start: 2, end: 2 }], after) });
    appendJournal(h.root, { taskId: 'task', agentId: 'worker-b', at: firstEdit + 1000, file: 'loan.js', kind: 'Edit', ranges: withSnippets([{ start: 5, end: 7 }], after) });

    await h.run('sync_task', { taskId: 'task' });
    const rows = await h.session.run(`MATCH (:Task {taskId:'task'})-[r:TOUCHED]->(f:Function)
        RETURN f.name AS name, r.agentId AS agentId, r.change AS change, r.firstAt AS firstAt, r.at AS at ORDER BY name`);
    const got = rows.records.map(r => ({ name: r.get('name'), agentId: r.get('agentId'), change: r.get('change'), firstAt: Number(r.get('firstAt')), at: Number(r.get('at')) }));
    assert.deepEqual(got, [
        { name: 'overdueFee', agentId: 'worker-b', change: 'created', firstAt: firstEdit + 1000, at: firstEdit + 1000 },
        { name: 'renewLimit', agentId: 'worker-a', change: 'modified', firstAt: firstEdit, at: firstEdit },
    ]);
});

test('with locking off, planned files are still recorded and plan_task_scope works', async t => {
    const h = await fixture(t);
    await h.session.run("MATCH (t:Task {taskId:'task'}) SET t.status='todo'");
    fs.writeFileSync(path.join(h.root, 'existing.js'), 'export const a = 1;\n');
    const created = await h.run('create_task', {
        title: 'Build the launcher plugin loader',
        description: 'Load launcher plugins from the configured directory and register them with the physics engine.',
        workInstructions: 'Create loader.py with discovery and registration, then add tests for missing and duplicate plugins.',
        files: ['src/new_loader.py'],
    });
    assert.equal(created.status, 'OK');
    assert.equal(created.locking, 'disabled');
    assert.deepEqual(created.files, ['src/new_loader.py'], 'a file that does not exist yet is the plan');
    assert.match(created.note, /recorded for planning and sync, not locked/);
    const planned = await h.run('plan_task_scope', { taskId: 'task', files: ['existing.js'] });
    assert.equal(planned.status, 'OK');
    const reserved = await h.session.run("MATCH (:Task {taskId:'task'})-[:RESERVES]->(s) RETURN s.file AS f");
    assert.deepEqual(reserved.records.map(r => r.get('f')), ['existing.js']);
    // Nothing was locked.
    const locked = await h.session.run('MATCH (n) WHERE n.locked = true RETURN count(n) AS c');
    assert.equal(Number(locked.records[0].get('c')), 0);
});

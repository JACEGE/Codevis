const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openTestDb } = require('./helpers/ladybug-session.cjs');
const { __testing__: { backupFileLinks, restoreLocksAndAffects, removeFileDerivedNodes } } = require('../scripts/graph_builder.js');

const FILE = 'src/a.js';
const rebuild = async session => {
    await removeFileDerivedNodes(session, [FILE]);
    await session.run("CREATE (:Function {name:'work', file:$file, owner:''}) CREATE (:Function {name:'other', file:$file, owner:''})", { file: FILE });
};

test('restore skips locks released while the build ran and keeps renewed leases', async () => {
    const { session, cleanup } = await openTestDb();
    try {
        await session.run(`CREATE (:Task {taskId:'done-task', status:'in_progress', assignedTo:'w1'})
            CREATE (:Task {taskId:'live-task', status:'in_progress', assignedTo:'w2'})
            CREATE (:TaskScope {name:'src/b.js', file:'src/b.js', locked:true, lockedBy:'w2', lockGroup:'live-task', lockExpires:1000})
            CREATE (:Function {name:'work', file:$file, owner:'', locked:true, lockedBy:'w1', lockGroup:'done-task', lockExpires:1000})
            CREATE (:Function {name:'other', file:$file, owner:'', locked:true, lockedBy:'w2', lockGroup:'live-task', lockExpires:1000})`, { file: FILE });
        const backup = await backupFileLinks(session, [FILE]);
        assert.equal(backup.locks.length, 2);
        await rebuild(session);
        // Concurrent MCP activity during the build window.
        await session.run("MATCH (t:Task {taskId:'done-task'}) SET t.status='review'");
        await session.run("MATCH (n) WHERE n.lockGroup='live-task' SET n.lockExpires=999999");
        const restored = await restoreLocksAndAffects(session, backup);
        assert.equal(restored.lockRestored, 1);
        assert.equal(restored.lockSkipped, 1);
        const rows = await session.run('MATCH (f:Function) WHERE f.locked = true RETURN f.name AS name, f.lockExpires AS expires');
        assert.deepEqual(rows.records.map(r => [r.get('name'), Number(r.get('expires'))]), [['other', 999999]]);
    } finally { await cleanup(); }
});

test('restore skips locks whose task was handed to another agent', async () => {
    const { session, cleanup } = await openTestDb();
    try {
        await session.run(`CREATE (:Task {taskId:'t', status:'in_progress', assignedTo:'w1'})
            CREATE (:Function {name:'work', file:$file, owner:'', locked:true, lockedBy:'w1', lockGroup:'t'})`, { file: FILE });
        const backup = await backupFileLinks(session, [FILE]);
        await rebuild(session);
        await session.run("MATCH (t:Task {taskId:'t'}) SET t.assignedTo='w2'");
        assert.equal((await restoreLocksAndAffects(session, backup)).lockSkipped, 1);
    } finally { await cleanup(); }
});

test('an edit flag is restored only while the edit has not written its file', async () => {
    const { session, cleanup } = await openTestDb();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codevis-edit-flag-'));
    try {
        fs.mkdirSync(path.join(root, 'src'));
        fs.writeFileSync(path.join(root, FILE), 'function work() {}');
        const mtime = fs.statSync(path.join(root, FILE)).mtimeMs;
        await session.run(`CREATE (:Task {taskId:'t', status:'in_progress', assignedTo:'w1'})
            CREATE (:Function {name:'work', file:$file, owner:'', locked:true, lockedBy:'w1', lockGroup:'t', editInProgress:true, editInProgressSince:$before})
            CREATE (:Function {name:'other', file:$file, owner:'', locked:true, lockedBy:'w1', lockGroup:'t', editInProgress:true, editInProgressSince:$after})`,
        { file: FILE, before: Math.floor(mtime) - 5000, after: Math.ceil(mtime) + 5000 });
        const backup = await backupFileLinks(session, [FILE]);
        await rebuild(session);
        await restoreLocksAndAffects(session, backup, { baseDir: root });
        const rows = await session.run('MATCH (f:Function) RETURN f.name AS name, f.editInProgress AS flag, f.locked AS locked ORDER BY name');
        assert.deepEqual(rows.records.map(r => [r.get('name'), r.get('flag'), r.get('locked')]),
            [['other', true, true], ['work', null, true]]);
    } finally { await cleanup(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('task CREATED and REMOVED provenance survives an incremental rebuild', async () => {
    const { session, cleanup } = await openTestDb();
    try {
        await session.run(`CREATE (t:Task {taskId:'t', status:'review'})
            CREATE (c:Function {name:'work', file:$file, owner:''})
            CREATE (r:Function {name:'gone', file:$file, owner:'', removedFromDisk:true, removedAt:5})
            CREATE (t)-[:CREATED]->(c) CREATE (t)-[:REMOVED]->(r)`, { file: FILE });
        const backup = await backupFileLinks(session, [FILE]);
        assert.equal(backup.provenance.length, 2);
        await rebuild(session);
        const restored = await restoreLocksAndAffects(session, backup);
        assert.equal(restored.provenanceRestored, 2);
        const created = await session.run("MATCH (:Task {taskId:'t'})-[:CREATED]->(n) RETURN n.name AS name");
        assert.deepEqual(created.records.map(r => r.get('name')), ['work']);
        const removed = await session.run("MATCH (:Task {taskId:'t'})-[:REMOVED]->(n) RETURN n.name AS name, n.removedFromDisk AS removed");
        assert.deepEqual(removed.records.map(r => [r.get('name'), r.get('removed')]), [['gone', true]]);
        // A second rebuild must not duplicate the tombstone.
        const again = await backupFileLinks(session, [FILE]);
        await rebuild(session);
        await restoreLocksAndAffects(session, again);
        const count = await session.run("MATCH (n:Function {name:'gone'}) RETURN count(n) AS c");
        assert.equal(Number(count.records[0].get('c')), 1);
    } finally { await cleanup(); }
});

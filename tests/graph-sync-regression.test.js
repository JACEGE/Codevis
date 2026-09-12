const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
require('../lib/tsx-userinfo-preload.cjs');
require('tsx/cjs/api').register();
const { syncFileToGraph, checkAndResyncIfChanged, commitSyncFile, liveSyncFile } = require('../tools/lib/graph-sync.ts');
const { openTestDb } = require('./helpers/ladybug-session.cjs');

async function fixture(t) {
    const db = await openTestDb();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codevis-sync-'));
    t.after(async () => { await db.cleanup(); fs.rmSync(root, { recursive: true, force: true }); });
    const file = path.join(root, 'app.js');
    const driver = { session: () => db.session };
    const sync = async content => {
        fs.writeFileSync(file, content);
        const result = await syncFileToGraph(file, 'app.js', '.js', driver);
        assert.ok(result, 'production sync should complete');
        return result;
    };
    return { ...db, file, driver, sync };
}

test('removing the last call removes its stale CALLS edge', async t => {
    const h = await fixture(t);
    await h.sync('function target() { return 1; }\nfunction work() { return target(); }');
    const count = async () => Number((await h.session.run('MATCH (:Function {name:"work"})-[r:CALLS]->() RETURN count(r) AS c')).records[0].get('c'));
    assert.equal(await count(), 1);
    await h.sync('function target() { return 1; }\nfunction work() { return 2; }');
    assert.equal(await count(), 0);
});

test('restoring a removed function clears its removedFromDisk flag', async t => {
    const h = await fixture(t);
    await h.sync('function work() { return 1; }');
    await h.sync('// removed');
    const removed = async () => (await h.session.run('MATCH (n:Function {name:"work"}) RETURN n.removedFromDisk AS removed')).records[0].get('removed');
    assert.equal(await removed(), true);
    await h.sync('function work() { return 2; }');
    assert.equal(await removed(), false);
});

test('failed call synchronization does not mark the file as synchronized', async t => {
    const h = await fixture(t);
    await h.sync('function target() { return 1; }\nfunction work() { return target(); }');
    await h.session.run('MATCH (f:File {path:"app.js"}) SET f.lastSeenMtime = 1');
    fs.writeFileSync(h.file, 'function target() { return 2; }\nfunction work() { return target() + 1; }');
    let reachedWrite = false;
    const faultSession = {
        run: (q, p) => { if (q.includes('DELETE r')) { reachedWrite = true; throw new Error('injected graph failure'); } return h.session.run(q, p); },
        close: async () => {},
        withTransaction: operation => h.session.withTransaction(() => operation(faultSession)),
    };
    const driver = { session: () => faultSession };
    assert.equal(await syncFileToGraph(h.file, 'app.js', '.js', driver), null);
    assert.equal(reachedWrite, true);
    const stored = await h.session.run('MATCH (f:File {path:"app.js"}) RETURN f.lastSeenMtime AS mtime');
    assert.equal(Number(stored.records[0].get('mtime')), 1);
    const retried = await checkAndResyncIfChanged(h.file, 'app.js', '.js', h.driver);
    assert.equal(retried.changed, true);
    assert.equal(retried.resynced, true);
});

for (const delta of [1000, -1000]) {
    test(`external changes with a ${delta}ms timestamp difference trigger resynchronization`, async t => {
        const h = await fixture(t);
        await h.sync('function work() { return 1; }');
        const oldTime = fs.statSync(h.file).mtimeMs;
        fs.writeFileSync(h.file, 'function work() { return 2; }');
        fs.utimesSync(h.file, new Date(oldTime + delta), new Date(oldTime + delta));
        const result = await checkAndResyncIfChanged(h.file, 'app.js', '.js', h.driver);
        assert.equal(result.changed, true);
        assert.equal(result.resynced, true);
        assert.equal((await checkAndResyncIfChanged(h.file, 'app.js', '.js', h.driver)).changed, false);
    });
}

test('a syntax error preserves the previous graph and synchronization timestamp', async t => {
    const h = await fixture(t);
    await h.sync('function work() { return 1; }');
    await h.session.run('MATCH (f:File {path:"app.js"}) SET f.lastSeenMtime = 1');
    fs.writeFileSync(h.file, 'function {');
    assert.equal(await syncFileToGraph(h.file, 'app.js', '.js', h.driver), null);
    const result = await h.session.run('MATCH (n:Function {name:"work"}), (f:File {path:"app.js"}) RETURN n.removedFromDisk AS removed, f.lastSeenMtime AS mtime');
    assert.notEqual(result.records[0].get('removed'), true);
    assert.equal(Number(result.records[0].get('mtime')), 1);
});

test('task commit synchronization clears calls even when none remain', async t => {
    const h = await fixture(t);
    await h.session.run('CREATE (:Task {taskId:"audit"})');
    await h.sync('function target() { return 1; }\nfunction work() { return target(); }');
    fs.writeFileSync(h.file, 'function target() { return 1; }\nfunction work() { return 2; }');
    assert.ok(await commitSyncFile(h.file, 'app.js', '.js', h.driver, 'audit'));
    const result = await h.session.run('MATCH (:Function {name:"work"})-[r:CALLS]->() RETURN count(r) AS c');
    assert.equal(Number(result.records[0].get('c')), 0);
});

test('task commit synchronization restores the original function identity', async t => {
    const h = await fixture(t);
    await h.session.run('CREATE (:Task {taskId:"audit"})');
    await h.sync('function work() { return 1; }');
    const lookup = () => h.session.run('MATCH (n:Function {name:"work"}) RETURN elementId(n) AS id, n.removedFromDisk AS removed');
    const originalId = (await lookup()).records[0].get('id');
    fs.writeFileSync(h.file, '// removed');
    assert.ok(await commitSyncFile(h.file, 'app.js', '.js', h.driver, 'audit'));
    fs.writeFileSync(h.file, 'function work() { return 2; }');
    assert.ok(await commitSyncFile(h.file, 'app.js', '.js', h.driver, 'audit'));
    const restored = await lookup();
    assert.equal(restored.records.length, 1);
    assert.equal(restored.records[0].get('id'), originalId);
    assert.equal(restored.records[0].get('removed'), false);
});

test('task commit synchronization refuses syntax errors before changing the graph', async t => {
    const h = await fixture(t);
    await h.session.run('CREATE (:Task {taskId:"audit"})');
    await h.sync('function work() { return 1; }');
    fs.writeFileSync(h.file, 'function {');
    assert.equal(await commitSyncFile(h.file, 'app.js', '.js', h.driver, 'audit'), null);
    const result = await h.session.run('MATCH (n:Function {name:"work"}) RETURN n.removedFromDisk AS removed');
    assert.notEqual(result.records[0].get('removed'), true);
});

test('live sync refuses malformed source instead of publishing a partial snippet', async t => {
    const h = await fixture(t);
    const original = 'function work() { return 1; }';
    await h.sync(original);
    fs.writeFileSync(h.file, 'function work() { return');
    assert.equal(await liveSyncFile(h.file, 'app.js', '.js', h.driver), null);
    const result = await h.session.run('MATCH (n:Function {name:"work"}) RETURN n.bodySnippet AS snippet');
    assert.equal(result.records[0].get('snippet'), original);
});

test('exported declarations synchronize once and create one task provenance edge', async t => {
    const h = await fixture(t);
    await h.session.run('CREATE (:Task {taskId:"audit"})');
    fs.writeFileSync(h.file, 'export function work() { return 1; }');
    assert.ok(await commitSyncFile(h.file, 'app.js', '.js', h.driver, 'audit'));
    const result = await h.session.run('MATCH (t:Task {taskId:"audit"})-[:CREATED]->(n:Function) RETURN elementId(n) AS id');
    assert.equal(result.records.length, 1);
    assert.ok(await syncFileToGraph(h.file, 'app.js', '.js', h.driver));
});

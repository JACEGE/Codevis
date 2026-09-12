const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'codevis-logger-runtime-'));
process.env.CODEVIS_PROJECT_DIR = root;
process.env.LOG_TO_GRAPH = 'true';
delete process.env.CODEVIS_SPEC_DB;
delete process.env.CODEVIS_AGENT_ID;
require('../lib/tsx-userinfo-preload.cjs');
require('tsx/cjs/api').register();
const { logOperation, mcpSessionId } = require('../tools/lib/logger.ts');
after(() => fs.rmSync(root, { recursive: true, force: true }));

function entries(operation) {
    const dir = path.join(root, '.claude', 'logs');
    return fs.readdirSync(dir).filter(name => name.endsWith('.jsonl'))
        .flatMap(name => fs.readFileSync(path.join(dir, name), 'utf8').trim().split('\n').map(JSON.parse))
        .filter(entry => entry.operation === operation);
}
const ok = { content: [{ type: 'text', text: 'done' }], _meta: { existing: true } };

test('operation logging preserves output, redacts params, and assigns one identity per call', async () => {
    const args = { taskId: 'task-1', assignedTo: 'subject', items: [{ password: 'dummy' }] };
    const handler = logOperation('identity-test', async actual => {
        assert.strictEqual(actual, args);
        return ok;
    });
    const first = await handler(args, { defaultAgentId: 'caller' });
    const second = await handler(args, { defaultAgentId: 'caller' });
    assert.strictEqual(first.content, ok.content);
    assert.equal(first._meta.existing, true);
    assert.equal(ok._meta.codevisOperation, undefined);
    assert.notEqual(first._meta.codevisOperation.operationId, second._meta.codevisOperation.operationId);
    const logged = entries('identity-test');
    assert.equal(logged.length, 2);
    for (const [i, response] of [first, second].entries()) {
        assert.equal(logged[i].operationId, response._meta.codevisOperation.operationId);
        assert.equal(logged[i].mcpSessionId, mcpSessionId);
        assert.equal(logged[i].pid, process.pid);
        assert.equal(logged[i].db, 'project_db');
        assert.equal(logged[i].agent, 'caller');
        assert.equal(logged[i].taskId, 'task-1');
        assert.equal(logged[i].params.items[0].password, '[REDACTED]');
        assert.equal(logged[i].result, 'ok');
    }
    assert.equal(args.items[0].password, 'dummy');
});

test('returned and thrown errors are logged once without replacing their meaning', async () => {
    const response = { content: [{ type: 'text', text: 'invalid request' }], isError: true };
    assert.equal((await logOperation('returned-error', async () => response)({}, {})).isError, true);
    const failure = new Error('handler failed');
    await assert.rejects(logOperation('thrown-error', async () => { throw failure; })({}, {}), err => err === failure);
    for (const [name, message] of [['returned-error', 'invalid request'], ['thrown-error', 'handler failed']]) {
        assert.equal(entries(name).length, 1);
        assert.equal(entries(name)[0].result, 'error');
        assert.equal(entries(name)[0].error, message);
    }
});

test('logging cannot intercept invalid database arguments before the handler validates them', async () => {
    const response = { content: [{ type: 'text', text: 'unknown database' }], isError: true };
    let calls = 0;
    const result = await logOperation('invalid-db', async () => { calls++; return response; })({ db: 'invalid' }, {});
    assert.equal(calls, 1);
    assert.equal(result.isError, true);
    assert.equal(entries('invalid-db')[0].db, 'unknown');
});

test('file serialization and graph failures do not replace success or thrown handler errors', async () => {
    let closed = 0;
    const driver = { session: () => ({ run: async () => { throw new Error('graph unavailable'); }, close: async () => { closed++; } }) };
    const ctx = { targetDriver: driver };
    assert.deepEqual((await logOperation('sink-failure', async () => ok)({ value: 1n }, ctx)).content, ok.content);
    const failure = new Error('original failure');
    await assert.rejects(logOperation('sink-throw', async () => { throw failure; })({ value: 1n }, ctx), err => err === failure);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(closed, 2);
    const broken = { targetDriver: { session() { throw new Error('session unavailable'); } } };
    assert.deepEqual((await logOperation('session-failure', async () => ok)({}, broken)).content, ok.content);
});

test('graph history persists with and without a task and uses the requested database', async () => {
    const { openTestDb } = require('./helpers/ladybug-session.cjs');
    const { session, cleanup } = await openTestDb();
    const pending = [];
    const driver = { session: () => ({
        run(query, params) { const result = session.run(query, params); pending.push(result); return result; },
        close: async () => {},
    }) };
    const unexpectedDriver = { session() { assert.fail('wrong database selected'); } };
    try {
        await session.run("CREATE (:Task {uid: 'logger-task', taskId: 'task-1'})");
        const ctx = { targetDriver: unexpectedDriver, metaDriver: driver };
        for (const taskId of ['task-1', 'missing-task', undefined]) {
            await logOperation('meta_db', async () => ok)({ taskId, db: 'project_db' }, ctx);
            await Promise.all(pending);
        }
        const logs = await session.run('MATCH (l:LogEntry) RETURN l.uid AS uid, l.sessionId AS sessionId, l.timestamp AS timestamp');
        assert.equal(logs.records.length, 3);
        assert.equal(new Set(logs.records.map(record => record.get('uid'))).size, 3);
        for (const record of logs.records) {
            assert.equal(record.get('sessionId'), mcpSessionId);
            assert.ok(Number(record.get('timestamp')) > 0);
        }
        const links = await session.run('MATCH (:LogEntry)-[:LOG_OF]->(t:Task) RETURN t.taskId AS taskId');
        assert.equal(links.records.length, 1);
        assert.equal(links.records[0].get('taskId'), 'task-1');
    } finally {
        await Promise.allSettled(pending);
        await cleanup();
    }
});

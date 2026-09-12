const test = require('node:test');
const assert = require('node:assert/strict');
require('../lib/tsx-userinfo-preload.cjs');
require('tsx/cjs/api').register();
const { ideaTools } = require('../tools/handlers/idea-tools.ts');
const { taskTools } = require('../tools/handlers/task-tools.ts');
const { openTestDb } = require('./helpers/ladybug-session.cjs');
const sourceCallback = require('./helpers/source-callback.cjs');
const ids = require('../tools/lib/task-id.cjs');
const spec = { title: 'Implement a useful feature', description: 'Describe the desired behavior and constraints of this feature so that the implementation can be verified.',
    workInstructions: 'Implement the feature and verify its behavior using the documented acceptance criteria.' };

async function fixture(t) {
    const db = await openTestDb();
    t.after(() => db.cleanup());
    // The daemon serializes statements, but requests may interleave between them.
    const run = db.session.run.bind(db.session);
    let queue = Promise.resolve();
    db.session.run = (...args) => {
        const result = queue.then(() => run(...args));
        queue = result.catch(() => {});
        return result;
    };
    db.session.epicMembershipAtomic = options => require('../server/epic-membership.cjs').epicMembershipOperation(db.session, options);
    const driver = { session: () => db.session };
    const ctx = { metaDriver: driver, targetDriver: driver, defaultAgentId: 'tester' };
    const mcp = async (name, args) => {
        const result = await (ideaTools.handlers[name] || taskTools.handlers[name])(args, ctx);
        return { ...JSON.parse(result.content[0].text), isError: result.isError };
    };
    const globals = { Date, process, ...ids, ...require('../tools/lib/task-rules.cjs'),
        TASK_PRIORITIES: ['critical', 'high', 'medium', 'low'], getTaskDriver: () => driver, io: null };
    for (const name of ['normalizeIntent', 'normalizePriority', 'intentToList']) {
        globals[name] = sourceCallback('server/bridge.js', name, globals);
    }
    const rest = async (path, method, body = {}, params = {}) => {
        let result;
        const res = { code: 200, status(code) { this.code = code; return this; }, json(value) { result = { ...value, code: this.code }; } };
        await sourceCallback('server/bridge.js', path, globals, method)({ body, params, query: {} }, res);
        return result;
    };
    return { s: db.session, mcp, rest };
}

for (const transport of ['mcp', 'rest']) {
    for (const kind of ['idea', 'epic']) {
        test(`${transport}: concurrent ${kind} creation in one millisecond keeps identities distinct`, async t => {
            const { s, mcp, rest } = await fixture(t);
            t.mock.method(Date, 'now', () => 1775318400000);
            const create = () => transport === 'mcp'
                ? mcp(`create_${kind}`, { ...spec, content: 'An idea' })
                : rest(`/api/${kind}s`, 'post', { ...spec, content: 'An idea' });
            const results = await Promise.all([create(), create()]);
            for (const result of results) assert.ok(!result.error && !result.isError, JSON.stringify(result));
            assert.notEqual(results[0][`${kind}Id`], results[1][`${kind}Id`]);
            const rows = await s.run(`MATCH (n:${kind === 'idea' ? 'Idea' : 'Epic'}) RETURN n.taskId AS id`);
            assert.equal(new Set(rows.records.map(r => r.get('id'))).size, 2);
        });
    }

    test(`${transport}: adding an existing epic member is idempotent`, async t => {
        const { s, mcp, rest } = await fixture(t);
        await s.run("CREATE (e:Epic {taskId:'epic'}) CREATE (a:Task {taskId:'a'}) CREATE (b:Task {taskId:'b'}) CREATE (e)-[:FULFILLED_BY]->(a) CREATE (e)-[:FULFILLED_BY]->(b) CREATE (a)-[:DEPENDS_ON {kind:'manual'}]->(b)");
        const result = transport === 'mcp'
            ? await mcp('add_task_to_epic', { epicId: 'epic', taskId: 'a' })
            : await rest('/api/epics/:epicId/tasks/:taskId', 'put', {}, { epicId: 'epic', taskId: 'a' });
        assert.ok(!result.error && !result.isError, JSON.stringify(result));
        const edges = await s.run('MATCH (a:Task)-[:DEPENDS_ON]->(b:Task) RETURN a.taskId AS a,b.taskId AS b');
        assert.deepEqual(edges.records.map(r => [r.get('a'), r.get('b')]), [['a', 'b']]);
    });

    test(`${transport}: moving a task repairs its old chain and preserves derived dependencies`, async t => {
        const { s, mcp, rest } = await fixture(t);
        await s.run("CREATE (e:Epic {taskId:'old'}) CREATE (f:Epic {taskId:'new'}) CREATE (a:Task {taskId:'a'}) CREATE (b:Task {taskId:'b'}) CREATE (c:Task {taskId:'c'}) CREATE (d:Task {taskId:'d'}) CREATE (e)-[:FULFILLED_BY]->(a) CREATE (e)-[:FULFILLED_BY]->(b) CREATE (e)-[:FULFILLED_BY]->(c) CREATE (f)-[:FULFILLED_BY]->(d) CREATE (a)-[:DEPENDS_ON {kind:'manual'}]->(b) CREATE (b)-[:DEPENDS_ON {kind:'manual'}]->(c) CREATE (b)-[:DEPENDS_ON {kind:'derived'}]->(c)");
        const params = { epicId: 'new', taskId: 'b' };
        const result = transport === 'mcp' ? await mcp('add_task_to_epic', params)
            : await rest('/api/epics/:epicId/tasks/:taskId', 'put', {}, params);
        assert.ok(!result.error && !result.isError, JSON.stringify(result));
        const edges = await s.run('MATCH (a:Task)-[r:DEPENDS_ON]->(b:Task) RETURN a.taskId AS a,b.taskId AS b,r.kind AS kind');
        assert.deepEqual(edges.records.map(r => [r.get('a'), r.get('b'), r.get('kind')]).sort(),
            [['a', 'c', 'manual'], ['b', 'c', 'derived'], ['d', 'b', 'manual']]);
    });
}

test('MCP: promoting two ideas in one millisecond creates separate tasks and provenance', async t => {
    const { s, mcp } = await fixture(t);
    await s.run("CREATE (:Idea {taskId:'i1',status:'open'}) CREATE (:Idea {taskId:'i2',status:'open'})");
    t.mock.method(Date, 'now', () => 1775318400000);
    const results = await Promise.all(['i1', 'i2'].map(ideaId => mcp('promote_idea_to_task', { ...spec, ideaId })));
    assert.notEqual(results[0].taskId, results[1].taskId);
    const edges = await s.run('MATCH (i:Idea)-[:PROMOTED_TO]->(t:Task) RETURN i.taskId AS idea,t.taskId AS task');
    assert.equal(edges.records.length, 2);
});

test('MCP: concurrent promotion of the same idea creates one task', async t => {
    const { s, mcp } = await fixture(t);
    await s.run("CREATE (:Idea {taskId:'idea',status:'open'})");
    const results = await Promise.all([1, 2].map(() => mcp('promote_idea_to_task', { ...spec, ideaId: 'idea' })));
    assert.ok(results.every(r => !r.isError));
    const tasks = await s.run('MATCH (t:Task) RETURN t.taskId AS id');
    assert.equal(tasks.records.length, 1);
    assert.equal(results[0].taskId, results[1].taskId);
});

test('REST: removing a nonmember does not delete external dependencies', async t => {
    const { s, rest } = await fixture(t);
    await s.run("CREATE (e:Epic {taskId:'epic'}) CREATE (a:Task {taskId:'a'}) CREATE (b:Task {taskId:'outside'}) CREATE (e)-[:FULFILLED_BY]->(a) CREATE (a)-[:DEPENDS_ON {kind:'manual'}]->(b)");
    const result = await rest('/api/epics/:epicId/tasks/:taskId', 'delete', {}, { epicId: 'epic', taskId: 'outside' });
    assert.equal(result.code, 404);
    const edges = await s.run('MATCH (:Task)-[r:DEPENDS_ON]->(:Task) RETURN r.kind AS kind');
    assert.equal(edges.records.length, 1);
});

test('failed epic moves and reorder writes roll back membership and the complete previous chain', async t => {
    const { s } = await fixture(t);
    await s.run("CREATE (e:Epic {taskId:'old'}) CREATE (:Epic {taskId:'new'}) CREATE (a:Task {taskId:'a'}) CREATE (b:Task {taskId:'b'}) CREATE (e)-[:FULFILLED_BY]->(a) CREATE (e)-[:FULFILLED_BY]->(b) CREATE (a)-[:DEPENDS_ON {kind:'manual'}]->(b)");
    const run = s.run.bind(s);
    for (const options of [
        { operation: 'add', epicId: 'new', taskId: 'b' },
        { operation: 'order', epicId: 'old', taskIds: ['b', 'a'] },
    ]) {
        s.run = (query, params) => {
            if (query.includes('MERGE') || query.includes('CREATE')) throw new Error('injected write failure');
            return run(query, params);
        };
        await assert.rejects(s.epicMembershipAtomic(options), /injected write failure/);
        s.run = run;
        const membership = await s.run('MATCH (e:Epic)-[:FULFILLED_BY]->(t:Task) RETURN e.taskId AS e,t.taskId AS t');
        assert.deepEqual(membership.records.map(r => [r.get('e'), r.get('t')]).sort(), [['old', 'a'], ['old', 'b']]);
        const edges = await s.run('MATCH (a:Task)-[:DEPENDS_ON]->(b:Task) RETURN a.taskId AS a,b.taskId AS b');
        assert.deepEqual(edges.records.map(r => [r.get('a'), r.get('b')]), [['a', 'b']]);
    }
});

test('epic order validates exact membership and keeps derived dependencies on reorder and removal', async t => {
    const { s, mcp, rest } = await fixture(t);
    await s.run("CREATE (e:Epic {taskId:'epic'}) CREATE (a:Task {taskId:'a'}) CREATE (b:Task {taskId:'b'}) CREATE (e)-[:FULFILLED_BY]->(a) CREATE (e)-[:FULFILLED_BY]->(b) CREATE (a)-[:DEPENDS_ON {kind:'manual'}]->(b) CREATE (a)-[:DEPENDS_ON {kind:'derived'}]->(b)");
    for (const taskIds of [['a'], ['a', 'a'], ['a', 'foreign']]) {
        const result = await rest('/api/epics/:epicId/order', 'put', { taskIds }, { epicId: 'epic' });
        assert.equal(result.code, 400);
    }
    assert.ok(!(await mcp('set_epic_task_order', { epicId: 'epic', taskIds: ['a', 'b'] })).isError);
    assert.ok(!(await mcp('remove_task_from_epic', { epicId: 'epic', taskId: 'a' })).isError);
    const edges = await s.run('MATCH (:Task)-[r:DEPENDS_ON]->(:Task) RETURN r.kind AS kind');
    assert.deepEqual(edges.records.map(r => r.get('kind')), ['derived']);
});

test('manual reordering cannot introduce a cycle through a derived dependency', async t => {
    const { s } = await fixture(t);
    await s.run("CREATE (e:Epic {taskId:'epic'}) CREATE (a:Task {taskId:'a'}) CREATE (b:Task {taskId:'b'}) CREATE (e)-[:FULFILLED_BY]->(a) CREATE (e)-[:FULFILLED_BY]->(b) CREATE (a)-[:DEPENDS_ON {kind:'manual'}]->(b) CREATE (a)-[:DEPENDS_ON {kind:'derived'}]->(b)");
    await assert.rejects(s.epicMembershipAtomic({ operation: 'order', epicId: 'epic', taskIds: ['b', 'a'] }), /cycle/);
    const edges = await s.run('MATCH (a:Task)-[r:DEPENDS_ON]->(b:Task) RETURN a.taskId AS a,b.taskId AS b,r.kind AS kind');
    assert.deepEqual(edges.records.map(r => [r.get('a'), r.get('b'), r.get('kind')]).sort(), [['a', 'b', 'derived'], ['a', 'b', 'manual']]);
});

test('cycle detection includes dependencies more than thirty hops outside the epic', async t => {
    const { s } = await fixture(t);
    await s.run("CREATE (e:Epic {taskId:'epic'}) CREATE (a:Task {taskId:'a'}) CREATE (b:Task {taskId:'b'}) CREATE (e)-[:FULFILLED_BY]->(a) CREATE (e)-[:FULFILLED_BY]->(b)");
    let predecessor = 'b';
    for (let i = 0; i < 40; i++) {
        const id = `outside-${i}`;
        await s.run('MATCH (a:Task {taskId:$predecessor}) CREATE (b:Task {taskId:$id}) CREATE (a)-[:DEPENDS_ON {kind:\'derived\'}]->(b)', { predecessor, id });
        predecessor = id;
    }
    await s.run("MATCH (a:Task {taskId:$predecessor}),(b:Task {taskId:'a'}) CREATE (a)-[:DEPENDS_ON {kind:'derived'}]->(b)", { predecessor });
    await assert.rejects(s.epicMembershipAtomic({ operation: 'order', epicId: 'epic', taskIds: ['a', 'b'] }), /cycle/);
});

test('MCP epic status and filters reflect members, matching the dashboard', async t => {
    const { s, mcp } = await fixture(t);
    await s.run("CREATE (e:Epic {taskId:'epic',status:'backlog'}) CREATE (a:Task {taskId:'a',status:'done'}) CREATE (e)-[:FULFILLED_BY]->(a)");
    const epic = await mcp('get_epic', { epicId: 'epic' });
    assert.equal(epic.status, 'done');
    assert.equal(epic.storedStatus, 'backlog');
    // mcp() spreads the result; array entries retain their numeric keys.
    const listed = await mcp('list_epics', { status: 'done' });
    assert.equal(listed[0]?.epicId, 'epic');
    assert.equal((await mcp('list_epics', { status: 'backlog' }))[0], undefined);
});

test('MCP epic edits cannot bypass the specification gate', async t => {
    const { s, mcp } = await fixture(t);
    const gate = process.env.CODEVIS_TASK_GATE;
    delete process.env.CODEVIS_TASK_GATE;
    t.after(() => { if (gate === undefined) delete process.env.CODEVIS_TASK_GATE; else process.env.CODEVIS_TASK_GATE = gate; });
    const created = await mcp('create_epic', spec);
    const result = await mcp('update_epic', { epicId: created.epicId, title: 'x' });
    assert.ok(result.isError);
    const stored = await s.run('MATCH (e:Epic {taskId:$epicId}) RETURN e.title AS title', { epicId: created.epicId });
    assert.equal(stored.records[0].get('title'), spec.title);
});

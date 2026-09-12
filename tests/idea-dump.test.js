const test = require('node:test');
const assert = require('node:assert/strict');
require('../lib/tsx-userinfo-preload.cjs');
require('tsx/cjs/api').register();
const { ideaTools } = require('../tools/handlers/idea-tools.ts');
const { openTestDb } = require('./helpers/ladybug-session.cjs');

async function fixture(t) {
    const db = await openTestDb();
    t.after(() => db.cleanup());
    const driver = { session: () => db.session };
    const ctx = { metaDriver: driver, targetDriver: driver, defaultAgentId: 'tester' };
    return { s: db.session, async call(name, args) {
        const result = await ideaTools.handlers[name](args, ctx);
        return { value: JSON.parse(result.content[0].text), isError: result.isError };
    } };
}

const spec = { title: 'Implement the requested change',
    description: 'Describe the problem, desired behavior, and constraints of the requested change so that the resulting feature can be verified.',
    workInstructions: 'Implement the feature, exercise its acceptance criteria, and verify the resulting behavior.' };

test('idea capture accepts short content, rejects empty content, and updates only the requested idea', async t => {
    const { call } = await fixture(t);
    assert.ok((await call('create_idea', { content: '  ' })).isError);
    const first = (await call('create_idea', { content: 'hi', priority: 'high' })).value;
    const second = (await call('create_idea', { content: 'leave me alone' })).value;
    assert.ok(first.ideaId);
    await call('update_idea', { ideaId: first.ideaId, content: 'revised', intent: ['task', 'knowledge'] });
    const ideas = (await call('list_ideas', {})).value;
    assert.equal(ideas.find(i => i.ideaId === first.ideaId).content, 'revised');
    assert.equal(ideas.find(i => i.ideaId === first.ideaId).priority, 'high');
    assert.deepEqual(ideas.find(i => i.ideaId === first.ideaId).intent, ['task', 'knowledge']);
    assert.equal(ideas.find(i => i.ideaId === second.ideaId).content, 'leave me alone');
});

test('promotion applies the production spec gate without writing a partial task', async t => {
    const { s, call } = await fixture(t);
    const gate = process.env.CODEVIS_TASK_GATE;
    delete process.env.CODEVIS_TASK_GATE;
    t.after(() => { if (gate === undefined) delete process.env.CODEVIS_TASK_GATE; else process.env.CODEVIS_TASK_GATE = gate; });
    const ideaId = (await call('create_idea', { content: 'hi' })).value.ideaId;
    for (const field of ['title', 'description', 'workInstructions']) {
        const result = await call('promote_idea_to_task', { ...spec, ideaId, [field]: 'x' });
        assert.ok(result.isError);
        assert.equal(result.value.status, 'UNDERSPECIFIED');
    }
    assert.equal((await s.run('MATCH (t:Task) RETURN t.taskId AS id')).records.length, 0);
    assert.equal((await call('list_ideas', {})).value.length, 1);
});

test('promotion archives the idea, inherits priority, and deletion removes provenance without deleting the task', async t => {
    const { s, call } = await fixture(t);
    const ideaId = (await call('create_idea', { content: 'hi', priority: 'critical' })).value.ideaId;
    const promoted = await call('promote_idea_to_task', { ...spec, ideaId });
    assert.ok(!promoted.isError);
    assert.equal(promoted.value.priority, 'critical');
    assert.equal((await call('list_ideas', {})).value.length, 0);
    assert.equal((await call('list_ideas', { status: 'all' })).value[0].status, 'promoted');
    assert.equal((await s.run('MATCH (:Idea)-[r:PROMOTED_TO]->(:Task) RETURN r')).records.length, 1);
    await call('delete_idea', { ideaId });
    assert.equal((await call('list_ideas', { status: 'all' })).value.length, 0);
    assert.equal((await s.run('MATCH (:Idea)-[r:PROMOTED_TO]->(:Task) RETURN r')).records.length, 0);
    assert.equal((await s.run('MATCH (t:Task) RETURN t.taskId AS id')).records[0].get('id'), promoted.value.taskId);
});

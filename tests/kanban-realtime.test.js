const test = require('node:test');
const assert = require('node:assert/strict');

test('Kanban realtime reducers insert, patch and remove without duplicate entities', async () => {
  const { upsertById, removeById } = await import('../frontend/src/kanban/realtimeModel.js');
  const inserted = upsertById([{ taskId: 'a', status: 'todo' }], { taskId: 'b', status: 'backlog' }, 'taskId');
  assert.deepEqual(inserted.map((item) => item.taskId), ['a', 'b']);
  const patched = upsertById(inserted, { taskId: 'a', status: 'done' }, 'taskId');
  assert.equal(patched.length, 2);
  assert.deepEqual(patched[0], { taskId: 'a', status: 'done' });
  assert.deepEqual(removeById(patched, 'a', 'taskId'), [{ taskId: 'b', status: 'backlog' }]);
});

for (const event of ['idea:created', 'idea:updated', 'idea:deleted']) {
  test(`a delayed idea snapshot cannot undo ${event}`, async t => {
    const { subscribeKanbanWorkspace } = await import('../frontend/src/kanban/workspaceSubscription.js');
    const handlers = {}, sent = [];
    let ideas = event === 'idea:created' ? [] : [{ ideaId: 'a', content: 'original' }];
    const socket = { connected: true, on: (name, handler) => { handlers[name] = handler; }, off() {}, emit: (name, data) => sent.push({ name, data }) };
    const subscription = subscribeKanbanWorkspace({ db: 'project_db', socket, setConnected() {}, setTasks() {}, setTaskDetail() {},
      setIdeas: value => { ideas = typeof value === 'function' ? value(ideas) : value; }, fetchTasks: async () => [] });
    t.after(() => subscription.dispose());
    const initial = sent.find(item => item.name === 'ideas:request').data;
    handlers[event]({ db: 'project_db', ideaId: 'a', content: 'updated' });
    const expected = [...ideas];
    handlers['ideas:init']([{ ideaId: 'a', content: 'old snapshot' }], initial);
    assert.deepEqual(ideas, expected);
    const refreshed = sent.filter(item => item.name === 'ideas:request').at(-1).data;
    assert.notEqual(refreshed.requestId, initial.requestId);
    handlers['ideas:init'](expected, refreshed);
    assert.deepEqual(ideas, expected);
  });
}

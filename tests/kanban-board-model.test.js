const test = require('node:test');
const assert = require('node:assert/strict');

test('Kanban status indexing keeps known statuses and falls unknown statuses back', async () => {
    const { indexTasksByStatus } = await import('../frontend/src/kanban/boardModel.js');
    const tasks = [
        { taskId: 'todo', status: 'todo' },
        { taskId: 'unknown', status: 'retired' },
    ];
    const indexed = indexTasksByStatus(tasks, ['backlog', 'todo']);
    assert.deepEqual(indexed.todo, [tasks[0]]);
    assert.deepEqual(indexed.backlog, [tasks[1]]);
});

test('Kanban epic grouping preserves free tasks and sorts epic sequence', async () => {
    const { groupTasksByEpic } = await import('../frontend/src/kanban/boardModel.js');
    const free = { taskId: 'free' };
    const result = groupTasksByEpic([
        { taskId: 'second', epicId: 'epic', epicTitle: 'E', seqIndex: 2 },
        free,
        { taskId: 'first', epicId: 'epic', epicTitle: 'E', seqIndex: 1 },
    ]);
    assert.deepEqual(result.free, [free]);
    assert.deepEqual(result.groups[0].taskIds, ['first', 'second']);
});

test('Kanban epic selection distinguishes partial and complete selection', async () => {
    const { getEpicSelection } = await import('../frontend/src/kanban/boardModel.js');
    const tasks = [{ taskId: 'a', epicId: 'e' }, { taskId: 'b', epicId: 'e' }];
    assert.deepEqual(getEpicSelection(tasks, 'e', new Set(['a'])), { all: false, some: true });
    assert.deepEqual(getEpicSelection(tasks, 'e', new Set(['a', 'b'])), { all: true, some: false });
});

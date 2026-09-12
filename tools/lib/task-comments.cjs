'use strict';

const { randomUUID } = require('node:crypto');
const missing = message => Object.assign(new Error(message), { status: 404 });

// A process-local mutex cannot coordinate bridge + multiple MCP processes.
// Compare-and-swap the exact raw list in one daemon-serialized statement and
// reapply the operation to the latest list if another writer won the race.
async function mutateComments(session, taskId, mutate) {
    for (let attempt = 0; attempt < 20; attempt++) {
        const read = await session.run('MATCH (t:Task {taskId:$taskId}) RETURN t.comments AS c', { taskId });
        if (!read.records.length) throw missing(`Task ${taskId} not found`);
        const expected = read.records[0].get('c') || [];
        const comments = expected.map(JSON.parse);
        const value = mutate(comments);
        const result = await session.run(
            `MATCH (t:Task {taskId:$taskId})
             WHERE coalesce(t.comments, []) = $expected
             SET t.comments = $list, t.updatedAt = timestamp()
             RETURN t.taskId AS taskId`,
            { taskId, expected, list: comments.map(comment => JSON.stringify(comment)) }
        );
        if (result.records.length) return { value, comments };
    }
    throw Object.assign(new Error('Comments changed too frequently; retry this operation.'), { status: 409 });
}

function appendTaskComment(session, taskId, { text, author = 'user' }) {
    const comment = { id: `c-${randomUUID()}`, text: text.trim(), author, ts: Date.now() };
    return mutateComments(session, taskId, comments => { comments.push(comment); return comment; });
}

function editTaskComment(session, taskId, commentId, text) {
    const editedAt = Date.now();
    return mutateComments(session, taskId, comments => {
        const index = comments.findIndex(comment => comment.id === commentId);
        if (index < 0) throw missing('Comment not found');
        return comments[index] = { ...comments[index], text: text.trim(), editedAt };
    });
}

function deleteTaskComment(session, taskId, commentId) {
    return mutateComments(session, taskId, comments => {
        const index = comments.findIndex(comment => comment.id === commentId);
        if (index < 0) throw missing('Comment not found');
        comments.splice(index, 1);
    });
}

module.exports = { appendTaskComment, editTaskComment, deleteTaskComment };

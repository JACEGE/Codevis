'use strict';

async function members(session, epicId) {
    const rows = await session.run('MATCH (e:Epic {taskId:$epicId})-[:FULFILLED_BY]->(t:Task) RETURN t.taskId AS id', { epicId });
    return rows.records.map(r => r.get('id'));
}

async function manualEdges(session) {
    const rows = await session.run("MATCH (a:Task)-[r:DEPENDS_ON]->(b:Task) WHERE r.kind='manual' RETURN a.taskId AS a,b.taskId AS b");
    return rows.records.map(r => [r.get('a'), r.get('b')]);
}

async function connect(session, a, b) {
    if (a === b) throw new Error('An epic order cannot depend on itself');
    // Ladybug's unbounded path syntax still has a default hop limit. Traverse
    // the edge set explicitly so long paths through other epics also count.
    const rows = await session.run('MATCH (a:Task)-[:DEPENDS_ON]->(b:Task) RETURN a.taskId AS a,b.taskId AS b');
    const next = new Map();
    for (const r of rows.records) {
        if (!next.has(r.get('a'))) next.set(r.get('a'), []);
        next.get(r.get('a')).push(r.get('b'));
    }
    const pending = [b], seen = new Set();
    while (pending.length) {
        const id = pending.pop();
        if (id === a) throw new Error('This epic order would create a dependency cycle');
        if (seen.has(id)) continue;
        seen.add(id);
        pending.push(...(next.get(id) || []));
    }
    await session.run(
        `MATCH (a:Task {taskId:$a}),(b:Task {taskId:$b})
         WHERE NOT EXISTS { MATCH (a)-[r:DEPENDS_ON]->(b) WHERE r.kind='manual' }
         CREATE (a)-[:DEPENDS_ON {kind:'manual'}]->(b)`, { a, b });
}

async function detach(session, epicId, taskId) {
    const memberSet = new Set(await members(session, epicId));
    const edges = await manualEdges(session);
    const predecessors = edges.filter(([a, b]) => b === taskId && memberSet.has(a)).map(([a]) => a);
    const successors = edges.filter(([a, b]) => a === taskId && memberSet.has(b)).map(([, b]) => b);
    const bridgeEdges = [];
    for (const a of new Set(predecessors)) for (const b of new Set(successors)) {
        await connect(session, a, b);
        bridgeEdges.push({ from: a, to: b, kind: 'manual' });
    }
    // Only the old epic's manual ordering belongs to this membership. Derived
    // dependencies and links to tasks outside the epic remain meaningful.
    for (const [a, b] of edges) {
        if (!((a === taskId && memberSet.has(b)) || (b === taskId && memberSet.has(a)))) continue;
        await session.run("MATCH (a:Task {taskId:$a})-[r:DEPENDS_ON]->(b:Task {taskId:$b}) WHERE r.kind='manual' DELETE r", { a, b });
    }
    await session.run('MATCH (e:Epic {taskId:$epicId})-[m:FULFILLED_BY]->(t:Task {taskId:$taskId}) DELETE m', { epicId, taskId });
    return bridgeEdges;
}

// The daemon holds its database mutex for this whole native transaction.
// Keeping checks and writes together also makes retries of add/remove safe.
async function epicMembershipOperation(session, { operation, epicId, taskId, taskIds }) {
    if (!['add', 'remove', 'order'].includes(operation)) throw new Error('Unknown epic membership operation');
    return session.withTransaction(async () => {
        const epic = await session.run('MATCH (e:Epic {taskId:$epicId}) RETURN e.taskId AS id', { epicId });
        if (!epic.records.length) return { status: 'NOT_FOUND', error: 'Epic not found' };
        const current = await members(session, epicId);
        if (operation === 'order') {
            if (!Array.isArray(taskIds) || !taskIds.length || new Set(taskIds).size !== taskIds.length) {
                return { status: 'INVALID', error: 'taskIds must be a non-empty array without duplicates' };
            }
            const memberSet = new Set(current);
            const foreign = taskIds.filter(id => !memberSet.has(id));
            const requested = new Set(taskIds);
            const missing = current.filter(id => !requested.has(id));
            if (foreign.length || missing.length) return { status: 'INVALID', error: 'taskIds must list exactly the tasks of this epic', foreign, missing };
            for (const [a, b] of await manualEdges(session)) {
                if (memberSet.has(a) && memberSet.has(b)) {
                    await session.run("MATCH (a:Task {taskId:$a})-[r:DEPENDS_ON]->(b:Task {taskId:$b}) WHERE r.kind='manual' DELETE r", { a, b });
                }
            }
            const chain = [];
            for (let i = 1; i < taskIds.length; i++) {
                await connect(session, taskIds[i - 1], taskIds[i]);
                chain.push({ from: taskIds[i - 1], to: taskIds[i] });
            }
            return { status: 'OK', epicId, taskIds, chain };
        }
        if (operation === 'remove') {
            if (!current.includes(taskId)) return { status: 'NOT_FOUND', error: 'Epic/task membership not found' };
            return { status: 'OK', epicId, taskId, bridgeEdges: await detach(session, epicId, taskId) };
        }
        const task = await session.run('MATCH (t:Task {taskId:$taskId}) RETURN t.taskId AS id', { taskId });
        if (!task.records.length) return { status: 'NOT_FOUND', error: 'Task not found' };
        if (current.includes(taskId)) return { status: 'OK', epicId, taskId, appendedAfter: null };
        const old = await session.run('MATCH (e:Epic)-[:FULFILLED_BY]->(t:Task {taskId:$taskId}) RETURN e.taskId AS id', { taskId });
        for (const r of old.records) await detach(session, r.get('id'), taskId);
        const memberSet = new Set(current);
        const hasSuccessor = new Set((await manualEdges(session))
            .filter(([a, b]) => memberSet.has(a) && memberSet.has(b)).map(([a]) => a));
        const tails = current.filter(id => !hasSuccessor.has(id)).sort();
        if (current.length && !tails.length) throw new Error('Repair the cyclic epic order before adding a task');
        const appendedAfter = tails.at(-1) || null;
        await session.run('MATCH (e:Epic {taskId:$epicId}),(t:Task {taskId:$taskId}) MERGE (e)-[:FULFILLED_BY]->(t)', { epicId, taskId });
        if (appendedAfter) await connect(session, appendedAfter, taskId);
        return { status: 'OK', epicId, taskId, appendedAfter };
    });
}

module.exports = { epicMembershipOperation };

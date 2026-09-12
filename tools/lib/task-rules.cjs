'use strict';

const TASK_PRIORITIES = Object.freeze(['critical', 'high', 'medium', 'low']);
const TASK_STATUSES = Object.freeze(['backlog', 'todo', 'in_progress', 'review', 'blocked', 'needs_info', 'done']);

function deriveEpicStatus(statuses) {
    if (!statuses.length) return 'backlog';
    if (statuses.every(s => s === 'done')) return 'done';
    if (statuses.some(s => s === 'blocked')) return 'blocked';
    if (statuses.some(s => s === 'needs_info')) return 'needs_info';
    if (statuses.some(s => s === 'in_progress')) return 'in_progress';
    const open = statuses.some(s => s === 'todo' || s === 'backlog');
    if (!open && statuses.some(s => s === 'review')) return 'review';
    if (statuses.some(s => s === 'todo' || s === 'review' || s === 'done')) return 'todo';
    return 'backlog';
}

function codeTargetPredicate(nodeVariable = 'n', nameParameter = '$name') {
    if (!/^[A-Za-z_]\w*$/.test(nodeVariable) || !/^\$?[A-Za-z_]\w*$/.test(nameParameter)) {
        throw new TypeError('Invalid Cypher identifier passed to codeTargetPredicate');
    }
    return `((${nodeVariable}:Function OR ${nodeVariable}:Class OR ${nodeVariable}:Component)`
        + ` AND ${nodeVariable}.name = ${nameParameter})`
        + ` OR (${nodeVariable}:File AND ${nodeVariable}.path = ${nameParameter})`;
}

function taskSpecProblems(spec, { subject = 'task' } = {}) {
    const title = String(spec?.title || '').trim();
    const description = String(spec?.description || '').trim();
    const workInstructions = String(spec?.workInstructions || '').trim();
    const problems = [];
    if (title.length < 8) {
        problems.push(`title is too short (${title.length} chars, need >= 8): say what this ${subject} changes.`);
    }
    if (description.length < 80) {
        problems.push(`description is too short (${description.length} chars, need >= 80): describe the problem, desired outcome, and constraints.`);
    }
    if (workInstructions.length < 50) {
        problems.push(`workInstructions is too short (${workInstructions.length} chars, need >= 50): provide exact steps and measurable acceptance criteria.`);
    }
    return problems;
}

function mergeTaskSpec(current, patch) {
    return {
        title: patch?.title === undefined ? current?.title : patch.title,
        description: patch?.description === undefined ? current?.description : patch.description,
        workInstructions: patch?.workInstructions === undefined
            ? current?.workInstructions
            : patch.workInstructions,
    };
}

async function releaseTaskLocks(session, taskId) {
    const result = await session.run(
        `MATCH (n)
         WHERE n.lockGroup = $taskId
         SET n.locked = null, n.lockedBy = null, n.lockGroup = null,
             n.lockExpires = null, n.lockOrigin = null, n.lockStatus = null,
             n.plannedBy = null
         RETURN count(n) AS released`,
        { taskId },
    );
    return result.records[0]?.get('released')?.toNumber?.() ?? 0;
}

async function transitionTaskLocks(session, taskId, oldStatus, newStatus, agentId, lockingEnabled = true, metadata = {}) {
    if (session.taskClaimAtomic) {
        return session.taskClaimAtomic({ ...metadata, operation: 'transition', taskId, agentId, newStatus, lockingEnabled });
    }
    if (!lockingEnabled) {
        return { status: 'DISABLED', activatedCount: 0, releasedCount: 0 };
    }
    const activating = ['in_progress', 'review', 'blocked', 'needs_info'].includes(newStatus);
    const deactivating = newStatus === 'backlog' || newStatus === 'todo' || newStatus === 'open';

    if (newStatus === 'done') {
        const released = await releaseTaskLocks(session, taskId);
        console.error(`[lock-release] Task ${taskId}: status ${oldStatus}->${newStatus}, released ${released} locks`);
        return { status: 'OK', releasedCount: released };
    }

    if (deactivating) {
        await session.run(
            `MATCH (n)
             WHERE n.lockGroup = $taskId AND n.locked = true
             SET n.locked = false, n.lockedBy = null, n.lockStatus = 'planned'`,
            { taskId },
        );
        console.error(`[lock-transition] Task ${taskId}: status ${oldStatus}->${newStatus}, deactivated to planned`);
        return { status: 'OK', activatedCount: 0 };
    }

    if (activating) {
        const alreadyActive = ['in_progress', 'review', 'blocked', 'needs_info'].includes(oldStatus);
        if (alreadyActive) return { status: 'NOOP', message: 'Locks already active, no transition needed.' };

        const activateResult = await session.run(
            `MATCH (n)
             WHERE n.lockGroup = $taskId AND n.lockStatus = 'planned'
               AND NOT EXISTS {
                   MATCH (other)
                   WHERE other.ipv6 = n.ipv6
                     AND other.locked = true
                     AND other.lockedBy <> $agentId
               }
             SET n.locked = true, n.lockedBy = $agentId, n.lockStatus = null
             RETURN count(n) AS activated`,
            { taskId, agentId },
        );
        const activated = activateResult.records[0]?.get('activated')?.toNumber?.() ?? 0;
        const conflictResult = await session.run(
            `MATCH (n)
             WHERE n.lockGroup = $taskId AND n.lockStatus = 'planned'
             MATCH (other)
             WHERE other.ipv6 = n.ipv6 AND other.locked = true AND other.lockedBy <> $agentId
             RETURN n.name AS name, other.lockedBy AS lockedBy, other.lockGroup AS lockGroup
             LIMIT 1`,
            { taskId, agentId },
        );

        if (conflictResult.records.length > 0) {
            const record = conflictResult.records[0];
            const conflictNode = record.get('name');
            const conflictAgent = record.get('lockedBy');
            const conflictGroup = record.get('lockGroup');
            await session.run(
                `MATCH (n)
                 WHERE n.lockGroup = $taskId AND n.locked = true AND n.lockedBy = $agentId
                 SET n.locked = false, n.lockedBy = null, n.lockStatus = 'planned'`,
                { taskId, agentId },
            );
            return {
                status: 'LOCK_CONFLICT',
                conflictNode,
                conflictAgent,
                conflictGroup,
                message: `LOCK_CONFLICT: ${conflictNode} is actively locked by task ${conflictGroup} (agent: ${conflictAgent})`,
            };
        }

        console.error(`[lock-activate] Task ${taskId}: activated ${activated} locks for agent ${agentId}`);
        return { status: 'OK', activatedCount: activated };
    }

    return { status: 'NOOP', message: `No lock transition needed for ${oldStatus}->${newStatus}` };
}

module.exports = {
    deriveEpicStatus,
    TASK_PRIORITIES,
    TASK_STATUSES,
    codeTargetPredicate,
    mergeTaskSpec,
    releaseTaskLocks,
    taskSpecProblems,
    transitionTaskLocks,
};

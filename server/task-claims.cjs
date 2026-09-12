'use strict';

// These operations run under the daemon's database mutex AND a native
// transaction. Never split a check and its writes across HTTP requests.
const path = require('node:path');
const fs = require('node:fs');
const { validateScopeMode, readScopePolicy } = require('./task-scope-policy.cjs');
const ACTIVE = new Set(['in_progress', 'review', 'blocked', 'needs_info']);
const PENDING = new Set(['open', 'backlog', 'todo']);
const number = value => Number(value?.toNumber?.() ?? value ?? 0);

function scopePath(value, root) {
    if (typeof value !== 'string' || !value.trim() || value.includes('\0') || /[*?]/.test(value)) {
        throw new Error('Scope files must be exact file paths, not globs or directories.');
    }
    const absolute = path.resolve(root, value);
    let existing = absolute;
    const suffix = [];
    while (!fs.existsSync(existing)) {
        const parent = path.dirname(existing);
        if (parent === existing) break;
        suffix.unshift(path.basename(existing));
        existing = parent;
    }
    const canonical = path.resolve(fs.realpathSync(existing), ...suffix);
    const canonicalRoot = fs.realpathSync(root);
    const relative = path.relative(canonicalRoot, canonical);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error('Scope files must stay inside the project root.');
    }
    if (fs.existsSync(canonical) && fs.statSync(canonical).isDirectory()) {
        throw new Error('Reserve exact files; directory-wide claims are not supported.');
    }
    const normalized = relative.replaceAll('\\', '/');
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

async function taskRow(session, taskId) {
    const result = await session.run(`MATCH (t:Task {taskId:$taskId})
        RETURN t.status AS status, t.assignedTo AS assignedTo, t.title AS title`, { taskId });
    const r = result.records[0];
    return r && { status: r.get('status'), assignedTo: r.get('assignedTo'), title: r.get('title') };
}

async function targets(session, taskId, options, root) {
    const nodes = new Map();
    const files = new Set((options.files || []).map(file => scopePath(file, root)));
    const add = r => {
        const id = r.get('id');
        if (!id) return;
        const file = r.get('file');
        if (file) files.add(scopePath(file, root));
        else nodes.set(id, { id, name: r.get('name') });
    };
    if (options.initial) {
        const explicit = await session.run(`MATCH (t:Task {taskId:$taskId})-[:RESERVES]->(n)
            RETURN DISTINCT elementId(n) AS id, coalesce(n.file,n.path) AS file, n.name AS name`, { taskId });
        explicit.records.forEach(add);
        if (!explicit.records.length) {
            const planned = await session.run(`MATCH (t:Task {taskId:$taskId})-[:AFFECTS]->(n)
                RETURN DISTINCT elementId(n) AS id, coalesce(n.file,n.path) AS file, n.name AS name`, { taskId });
            planned.records.forEach(add);
        }
        // Retain legacy explicitly widened plans when upgrading a task.
        const legacy = await session.run(`MATCH (n) WHERE n.lockGroup=$taskId
            RETURN elementId(n) AS id, coalesce(n.file,n.path) AS file, n.name AS name`, { taskId });
        if (!explicit.records.length) legacy.records.forEach(add);
    }
    const ids = [...new Set(options.nodeIds || [])];
    for (const id of ids) {
        if (typeof id !== 'string') throw new Error('nodeIds must contain elementId strings.');
        const found = await session.run(`MATCH (n) WHERE elementId(n)=$id
            AND NOT n:Task AND NOT n:Epic AND NOT n:Knowledge
            RETURN elementId(n) AS id, coalesce(n.file,n.path) AS file, n.name AS name`, { id });
        if (!found.records.length) throw new Error(`Scope node '${id}' does not exist or is not a code target.`);
        found.records.forEach(add);
    }
    return { nodes, files };
}

async function reserve(session, taskId, scope) {
    for (const file of scope.files) {
        await session.run(`MERGE (s:TaskScope {name:$file}) SET s.file=$file
            WITH s MATCH (t:Task {taskId:$taskId}) MERGE (t)-[:RESERVES]->(s)`, { file, taskId });
    }
    for (const id of scope.nodes.keys()) {
        await session.run(`MATCH (t:Task {taskId:$taskId}), (n) WHERE elementId(n)=$id
            MERGE (t)-[:RESERVES]->(n)`, { taskId, id });
    }
}

async function acquire(session, taskId, agentId, scope, root, now, ttlMs) {
    const pathCache = new Map();
    const storedPath = file => {
        if (!pathCache.has(file)) {
            // Another configured source tree may be outside this task's root.
            // It cannot overlap an in-project scope and must not break the scan.
            try { pathCache.set(file, scopePath(file, root)); }
            catch { pathCache.set(file, null); }
        }
        return pathCache.get(file);
    };
    const live = await session.run(`MATCH (n) WHERE n.locked=true
        AND (n.lockExpires IS NULL OR n.lockExpires > $now)
        RETURN elementId(n) AS id, coalesce(n.file,n.path) AS file,
            n.name AS name, n.lockGroup AS taskId, n.lockedBy AS agentId`, { now });
    const conflicts = [];
    for (const r of live.records) {
        if (r.get('taskId') === taskId && r.get('agentId') === agentId) continue;
        const file = r.get('file');
        if (scope.nodes.has(r.get('id')) || (file && scope.files.has(storedPath(file)))) {
            conflicts.push({ nodeId: r.get('id'), file, name: r.get('name'), taskId: r.get('taskId'), agentId: r.get('agentId') });
        }
    }
    if (conflicts.length) return {
        status: 'LOCK_CONFLICT', taskId, conflicts,
        conflictNode: conflicts[0].name, conflictAgent: conflicts[0].agentId, conflictGroup: conflicts[0].taskId,
        retryable: false, action: 'COORDINATE_SCOPE',
        message: 'Scope is owned by another task. No claims changed. Do not wait or retry while holding competing claims; coordinate a safe checkpoint and explicit handoff.',
    };
    await reserve(session, taskId, scope);
    // Scan once, filter with Sets; avoid large elementId IN query plans.
    const all = await session.run(`MATCH (n) WHERE NOT n:Task AND NOT n:Epic AND NOT n:Knowledge
        RETURN elementId(n) AS id, coalesce(n.file,n.path) AS file`);
    const ids = [];
    for (const r of all.records) {
        const id = r.get('id');
        const file = r.get('file');
        if (scope.nodes.has(id) || (file && scope.files.has(storedPath(file)))) ids.push(id);
    }
    if (ids.length) await session.run(`UNWIND $ids AS id MATCH (n) WHERE elementId(n)=id
        SET n.locked=true, n.lockedBy=$agentId, n.lockGroup=$taskId,
            n.lockExpires=$expires, n.lockStatus=null, n.plannedBy=null, n.lockOrigin=$taskId`,
    { ids, agentId, taskId, expires: now + ttlMs });
    return { status: 'OK', taskId, activatedCount: ids.length, files: [...scope.files], nodeIds: [...scope.nodes.keys()] };
}

async function taskClaimOperation(session, options, root) {
    if (!session.withTransaction) throw new Error('Atomic task claims require a daemon-local transaction.');
    return session.withTransaction(async () => {
        const { taskId, agentId, operation } = options;
        if (typeof taskId !== 'string' || !taskId || typeof agentId !== 'string' || !agentId) {
            throw new Error('taskId and agentId are required.');
        }
        const now = Date.now();
        const ttlMs = Math.max(1, Math.min(300000, number(options.ttlMs) || 300000));
        let enabled = options.lockingEnabled !== false;
        if (operation === 'set_policy') {
            const mode = validateScopeMode(options.scopeMode);
            const policy = await readScopePolicy(session, taskId);
            if (!policy) return { status: 'NOT_FOUND' };
            const activeTask = await session.run(`MATCH (t:Task {taskId:$taskId})
                WHERE NOT t.status IN ['backlog','todo','open','done'] RETURN t.taskId AS id`, { taskId });
            if (activeTask.records.length) return { status: 'INVALID_STATE', message: 'Checkpoint and return the task to To Do before changing its edit mode.' };
            await session.run(`MATCH (t) WHERE (t:Task OR t:Epic) AND t.taskId=$taskId
                SET t.scopeMode=$mode,t.activeScopeMode=null`, { taskId, mode });
            return { status: 'OK', policy: await readScopePolicy(session, taskId) };
        }
        if (operation === 'create') {
            const scopeMode = validateScopeMode(options.scopeMode || 'inherit');
            const { codeTargetPredicate, taskSpecProblems } = require('../tools/lib/task-rules.cjs');
            if (process.env.CODEVIS_TASK_GATE !== 'off') {
                const problems = taskSpecProblems(options);
                if (problems.length) return { status: 'UNDERSPECIFIED', problems };
            }
            const initialStatus = options.initialStatus || 'todo';
            if (![...PENDING, 'in_progress'].includes(initialStatus)) throw new Error('Create tasks in backlog, todo or in_progress.');
            if (await taskRow(session, taskId)) throw new Error('Task ID already exists.');
            await session.run(`CREATE (:Task {taskId:$taskId,title:$title,description:$description,
                workInstructions:$workInstructions,scopeMode:$scopeMode,status:'todo',priority:$priority,createdBy:$agentId,createdAt:$now})`,
            { taskId, agentId, now, scopeMode, title: options.title, description: options.description,
                workInstructions: options.workInstructions || null, priority: options.priority || 'medium' });
            const originIds = new Set(options.targetNodeIds || []);
            for (const name of options.targetNodes || []) {
                const found = await session.run(`MATCH (n) WHERE ${codeTargetPredicate('n', '$name')}
                    RETURN elementId(n) AS id`, { name });
                found.records.forEach(r => originIds.add(r.get('id')));
            }
            for (const ipv6 of options.targetIpv6s || []) {
                const found = await session.run('MATCH (n) WHERE n.ipv6=$ipv6 RETURN elementId(n) AS id', { ipv6 });
                found.records.forEach(r => originIds.add(r.get('id')));
            }
            for (const id of originIds) await session.run(`MATCH (t:Task {taskId:$taskId}), (n)
                WHERE elementId(n)=$id MERGE (t)-[:AFFECTS]->(n)`, { taskId, id });
            let knowledgeLinked = 0;
            for (const name of options.knowledgeLinks || []) {
                const linked = await session.run(`MATCH (t:Task {taskId:$taskId}),(k:Knowledge {name:$name})
                    MERGE (k)-[:APPLIES_TO]->(t) RETURN k.name AS name`, { taskId, name });
                knowledgeLinked += linked.records.length;
            }
            let scope = { nodes: new Map(), files: new Set() };
            let claim = { status: 'OK', activatedCount: 0 };
            if (enabled) {
                const ids = new Set(originIds);
                const depth = require('../tools/lib/lock-depth.cjs').normalizeDepth(options.lockRadius ?? options.lockDepth, 0);
                const edges = options.lockEdgeTypes || ['CALLS'];
                if (!Array.isArray(edges) || !edges.length || edges.some(e => typeof e !== 'string' || !/^[A-Z_]+$/.test(e) || e === 'RESERVES')) throw new Error('Invalid lock edge types.');
                if (depth) for (const id of originIds) {
                    const found = await session.run(`MATCH (n) WHERE elementId(n)=$id
                        MATCH (n)-[${edges.map(e => ':' + e).join('|')}*1..${depth}]-(other)
                        WHERE NOT other:Task AND NOT other:Knowledge AND NOT other:Epic
                        RETURN DISTINCT elementId(other) AS id`, { id });
                    found.records.forEach(r => ids.add(r.get('id')));
                }
                // Explicit files take precedence over inferred impact. Old node
                // and subnet requests conservatively become whole-file claims.
                scope = await targets(session, taskId, options.files?.length
                    ? { files: options.files } : { nodeIds: [...ids] }, root);
                await reserve(session, taskId, scope);
                if (initialStatus === 'in_progress' && scopeMode !== 'open') claim = await acquire(session, taskId, agentId, scope, root, now, ttlMs);
            }
            const status = claim.status === 'OK' ? initialStatus : 'backlog';
            await session.run(`MATCH (t:Task {taskId:$taskId}) SET t.status=$status,
                t.assignedTo=$owner, t.claimedAt=$claimedAt,t.activeScopeMode=$activeMode`, { taskId, status,
                activeMode: status === 'in_progress' ? (scopeMode === 'inherit' ? 'flexible' : scopeMode) : null,
                owner: status === 'in_progress' ? agentId : null, claimedAt: status === 'in_progress' ? now : null });
            return { status: 'OK', taskId, title: options.title, priority: options.priority || 'medium',
                locking: enabled ? 'enabled' : 'disabled', files: [...scope.files],
                plannedNodes: scope.files.size + scope.nodes.size, activatedLocks: claim.activatedCount || 0,
                knowledgeLinked, lockConflict: claim.status === 'OK' ? undefined : claim,
                note: status === 'backlog' && claim.status !== 'OK' ? 'Created in backlog; scope conflict prevented activation.' : 'Task scope is planned until work starts.' };
        }
        if (operation === 'acquire') {
            if (!enabled) return { status: 'LOCKING_DISABLED' };
            const scope = await targets(session, taskId, options, root);
            return acquire(session, taskId, agentId, scope, root, now, ttlMs);
        }
        const task = await taskRow(session, taskId);
        if (!task) return { status: 'NOT_FOUND', taskId };
        const policy = await readScopePolicy(session, taskId);
        if (policy.effectiveMode === 'open') enabled = false;
        if (operation === 'claim') {
            if (!PENDING.has(task.status) || (task.assignedTo && task.assignedTo !== agentId)) {
                return { status: 'ALREADY_CLAIMED', currentStatus: task.status, assignedTo: task.assignedTo };
            }
            let result = { status: 'OK', activatedCount: 0 };
            if (enabled) {
                const scope = await targets(session, taskId, { initial: true }, root);
                result = await acquire(session, taskId, agentId, scope, root, now, ttlMs);
                if (result.status !== 'OK') return result;
            }
            await session.run(`MATCH (t:Task {taskId:$taskId})
                SET t.status='in_progress', t.assignedTo=$agentId, t.claimedAt=$now,t.activeScopeMode=$mode`,
                { taskId, agentId, now, mode: policy.effectiveMode });
            return { ...result, taskId, title: task.title, assignedTo: agentId, scopeMode: policy.effectiveMode };
        }
        if (operation === 'plan' || operation === 'expand') {
            if (operation === 'expand' && policy.effectiveMode === 'strict') return { status: 'SCOPE_FIXED', message: 'Strict mode does not allow scope expansion. Checkpoint and return the task to To Do before replanning.' };
            if (!enabled) return { status: 'LOCKING_DISABLED', taskId };
            if (operation === 'plan' && !PENDING.has(task.status)) return { status: 'INVALID_STATE', message: 'Plan scope before claiming; use expand_task_scope for active work.' };
            if (operation === 'expand' && (!ACTIVE.has(task.status) || task.assignedTo !== agentId)) {
                return { status: 'NOT_OWNER', taskId, assignedTo: task.assignedTo };
            }
            if (!(options.files?.length || options.nodeIds?.length)) throw new Error('Provide files or nodeIds.');
            const scope = await targets(session, taskId, options, root);
            if (operation === 'plan') {
                await reserve(session, taskId, scope);
                return { status: 'OK', taskId, files: [...scope.files], nodeIds: [...scope.nodes.keys()], active: false };
            }
            // Revalidate the complete scope: an expired prior claim must not be
            // silently treated as owned when another task acquired it.
            const complete = await targets(session, taskId, { ...options, initial: true }, root);
            return acquire(session, taskId, agentId, complete, root, now, ttlMs);
        }
        if (operation === 'transition' || operation === 'complete') {
            const status = operation === 'complete' ? 'review' : options.newStatus;
            if (![...PENDING, ...ACTIVE, 'done'].includes(status)) throw new Error('Invalid task status.');
            if (task.assignedTo && task.assignedTo !== agentId && agentId !== 'user' && !agentId.startsWith('lead-')) {
                return { status: 'NOT_OWNER', taskId, assignedTo: task.assignedTo };
            }
            if (operation === 'complete' && task.assignedTo !== agentId) return { status: 'NOT_OWNER', taskId, assignedTo: task.assignedTo };
            let result = { status: enabled ? 'NOOP' : 'DISABLED', activatedCount: 0, releasedCount: 0 };
            if (enabled && (status === 'done' || PENDING.has(status) || operation === 'complete')) {
                const released = await session.run(`MATCH (n) WHERE n.lockGroup=$taskId
                    SET n.locked=null, n.lockedBy=null, n.lockGroup=null, n.lockExpires=null,
                        n.lockStatus=null, n.lockOrigin=null, n.plannedBy=null RETURN count(n) AS count`, { taskId });
                result = { status: 'OK', activatedCount: 0, releasedCount: number(released.records[0]?.get('count')) };
            } else if (enabled && (!ACTIVE.has(task.status) || status === 'in_progress')) {
                const scope = await targets(session, taskId, { initial: true }, root);
                result = await acquire(session, taskId, task.assignedTo || agentId, scope, root, now, ttlMs);
                if (result.status !== 'OK') return result;
            }
            await session.run(`MATCH (t:Task {taskId:$taskId}) SET t.status=$status,
                t.updatedAt=$now, t.updatedBy=$agentId, t.lastComment=$comment`,
            { taskId, status, now, agentId, comment: options.comment || null });
            if (PENDING.has(status)) await session.run(`MATCH (t:Task {taskId:$taskId})
                SET t.assignedTo=null, t.claimedAt=null,t.activeScopeMode=null`, { taskId });
            else if (ACTIVE.has(status) && !ACTIVE.has(task.status)) await session.run(`MATCH (t:Task {taskId:$taskId}) SET t.activeScopeMode=$mode`, { taskId, mode: policy.effectiveMode });
            if (!task.assignedTo && ACTIVE.has(status)) await session.run(`MATCH (t:Task {taskId:$taskId})
                SET t.assignedTo=$agentId, t.claimedAt=$now`, { taskId, agentId, now });
            if (operation === 'complete') await session.run(`MATCH (t:Task {taskId:$taskId}) SET t.summary=$summary`, { taskId, summary: options.summary || null });
            if (status === 'done') await session.run(`MATCH (t:Task {taskId:$taskId}) SET t.completedAt=$now`, { taskId, now });
            return { ...result, taskId, title: task.title, oldStatus: task.status, newStatus: status };
        }
        throw new Error('Unknown task claim operation.');
    });
}

module.exports = { taskClaimOperation, scopePath };

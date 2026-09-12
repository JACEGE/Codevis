import { AsyncLocalStorage } from 'node:async_hooks';
import { createRequire } from 'node:module';
const { scopePath } = createRequire(import.meta.url)('../../server/task-claims.cjs');
const { readScopePolicy } = createRequire(import.meta.url)('../../server/task-scope-policy.cjs');

type Guard = { driver: any; root: string; agentId: string; taskId?: string };
const activeGuard = new AsyncLocalStorage<Guard>();

export function withScopeGuard<T>(guard: Guard, operation: () => Promise<T>): Promise<T> {
    return activeGuard.run(guard, operation);
}

/** Validate while holding the physical file mutex, including newly created files. */
export async function assertFileScope(file: string): Promise<void> {
    const guard = activeGuard.getStore();
    if (!guard) return;
    const canonical = scopePath(file, guard.root);
    const session = guard.driver.session();
    try {
        const policy = guard.taskId ? await readScopePolicy(session, guard.taskId) : null;
        if (guard.taskId && (!policy || policy.agentId !== guard.agentId || !['in_progress','review','blocked','needs_info'].includes(policy.status))) {
            throw new Error('Claim the task before editing its files.');
        }
        const result = await session.run(`MATCH (s:TaskScope {file:$file})
            WHERE s.locked=true AND s.lockExpires > timestamp()
            RETURN s.lockedBy AS agentId,s.lockGroup AS taskId`, { file: canonical });
        const claim = result.records[0];
        // Open removes the task's own scope requirement, but cannot override
        // another worker's protected claim. Mixing modes must remain safe.
        if (policy?.effectiveMode === 'open' && !claim) return;
        if (!claim || claim.get('agentId') !== guard.agentId || (guard.taskId && claim.get('taskId') !== guard.taskId)) {
            const error: any = new Error(claim
                ? `Scope conflict: '${canonical}' belongs to task '${claim.get('taskId')}' (agent '${claim.get('agentId')}'). Coordinate an explicit handoff; do not retry while holding competing claims.`
                : `Scope required: claim '${canonical}' with plan_task_scope / claim_task or expand_task_scope before editing.`);
            error.code = claim ? 'LOCK_CONFLICT' : 'SCOPE_REQUIRED';
            throw error;
        }
    } finally { await session.close(); }
}

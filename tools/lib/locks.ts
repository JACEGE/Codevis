/**
 * Shared lock primitives for IPv6-subnet-based locking and cross-lock checks.
 *
 * IPv6 address layout used by CodeVis:
 *   /48  — file segment (all functions in the same file share the same /48)
 *   /64  — function scope (origin node)
 *   /80+ — children (inner functions, states, etc.)
 *
 * Subnet lock = lock the origin node + every node whose ipv6 STARTS WITH the
 * origin's /64 prefix (i.e. first 64 bits = first 16 hex chars including colons).
 */

import { createRequire } from "module";

const {
    releaseTaskLocks: releaseTaskLocksShared,
    transitionTaskLocks,
} = createRequire(import.meta.url)("./task-rules.cjs");

/**
 * Locks are leases, not reservations. Five minutes is long enough to tolerate
 * a temporarily busy worker and short enough that a crashed worker does not
 * stall the team for an hour. Only extend_locks renews the lease.
 *
 * CODEVIS_LOCK_TTL_MS is primarily useful for integration tests and unusually
 * slow environments; production callers should normally use the default.
 */
export const DEFAULT_LOCK_TTL_MS = 5 * 60 * 1000;
export const MAX_LOCK_TTL_MS = DEFAULT_LOCK_TTL_MS;

export function lockTtlMs(override?: unknown): number {
    const configured = override ?? process.env.CODEVIS_LOCK_TTL_MS ?? DEFAULT_LOCK_TTL_MS;
    const parsed = Number(configured);
    if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LOCK_TTL_MS;
    return Math.min(Math.floor(parsed), MAX_LOCK_TTL_MS);
}

/**
 * Validate edge-type names before they are interpolated into a variable-length
 * path pattern. Cypher cannot parameterize rel-type lists or var-length bounds,
 * so these names go into the query string directly — restricting them to
 * [A-Z_]+ is the injection defense. Returns the first invalid name, or null if
 * all are valid. (Single audited copy — used by lock_subgraph and create_task.)
 */
export function invalidEdgeType(edgeTypes: string[]): string | null {
    for (const et of edgeTypes) {
        if (!/^[A-Z_]+$/.test(et)) return et;
    }
    return null;
}

/**
 * Release every active lock whose TTL has passed. Idempotent; safe to call
 * often. Returns how many locks it expired.
 *
 * A lock is a promise that a node won't be edited under another agent. If the
 * agent holding it dies (crash, killed terminal, lost connection), nothing else
 * releases the lock — so without a sweep the node is frozen forever and no other
 * task can ever touch it. Every acquisition stamps lockExpires; this is what
 * actually enforces it. Runs on both the periodic MCP timer and the bridge, so
 * it fires whether or not the dashboard is open.
 *
 * Covers BOTH active (locked=true) and planned (lockStatus='planned') locks.
 * Planned locks also carry lockExpires (create_task stamps it), and an abandoned
 * todo/backlog task holds lockGroup on its nodes: create_task's planning guard
 * (lockGroup IS NULL OR = this task) then refuses to let any *other* task plan
 * those nodes until the stale one is released. Without expiring planned locks,
 * the nodes stay un-plannable long past their TTL.
 */
export async function expireStaleLocks(session: any): Promise<number> {
    const result = await session.run(
        `MATCH (n)
         WHERE (n.locked = true OR n.lockStatus = 'planned')
           AND n.lockExpires IS NOT NULL AND n.lockExpires <= timestamp()
         SET n.locked = null, n.lockedBy = null, n.lockGroup = null,
             n.lockExpires = null, n.lockOrigin = null, n.lockStatus = null,
             n.plannedBy = null
         RETURN count(n) AS expired`
    );
    return result.records[0]?.get("expired")?.toNumber?.() ?? 0;
}

/**
 * Release every lock belonging to one task, regardless of active/planned state.
 *
 * Deliberately without the `locked = true OR lockStatus = 'planned'` guard that
 * the done-transition used to carry: a node whose lease already expired keeps
 * its lockGroup, and leaving that behind is what makes create_task's planning
 * guard refuse the node to every later task.
 */
export async function releaseTaskLocks(session: any, taskId: string): Promise<number> {
    return releaseTaskLocksShared(session, taskId);
}

/** Extract the /64 subnet prefix from an IPv6 address (first 4 groups). */
export function ipv6SubnetPrefix(ipv6: string): string {
    // Take first 4 colon-separated groups (each group = 16 bits → 64 bits total)
    const groups = ipv6.split(":");
    return groups.slice(0, 4).join(":") + ":";
}

/** Extract the /48 file prefix from an IPv6 address (first 3 groups). */
export function ipv6FilePrefix(ipv6: string): string {
    const groups = ipv6.split(":");
    return groups.slice(0, 3).join(":") + ":";
}

/**
 * Cross-lock check: returns true if any node in the given IPv6 subnet is
 * actively locked by a different agent.
 *
 * Uses `locked = true` semantics (active locks only, not planned ones).
 */
export async function checkCrossLocks(
    session: any,
    ipv6Prefix: string,
    agentId: string,
): Promise<{ conflict: boolean; conflictNode?: string; conflictAgent?: string; conflictGroup?: string }> {
    const result = await session.run(
        `MATCH (n)
         WHERE n.ipv6 STARTS WITH $prefix
           AND n.locked = true
           AND n.lockedBy <> $agentId
         RETURN n.name AS name, n.lockedBy AS lockedBy, n.lockGroup AS lockGroup
         LIMIT 1`,
        { prefix: ipv6Prefix, agentId }
    );

    if (result.records.length === 0) {
        return { conflict: false };
    }

    const r = result.records[0];
    return {
        conflict: true,
        conflictNode: r.get("name"),
        conflictAgent: r.get("lockedBy"),
        conflictGroup: r.get("lockGroup"),
    };
}

/**
 * Transition locks for a task when its status changes.
 *
 * → in_progress/review/blocked/needs_info : activate planned locks (conflict-checked)
 * → todo/backlog                          : keep (or revert) locks PLANNED, non-blocking
 * → done                                  : release all locks fully
 *
 * Locks arm only when work actually STARTS (in_progress). A task sitting in
 * todo/backlog holds planned (non-blocking) locks, so it never blocks other
 * tasks before a worker picks it up.
 *
 * Returns OK or LOCK_CONFLICT with details.
 */
export async function transitionLocks(
    session: any,
    taskId: string,
    oldStatus: string,
    newStatus: string,
    agentId: string,
    lockingEnabled: boolean = true,
    metadata: Record<string, any> = {},
): Promise<{
    status: "OK" | "LOCK_CONFLICT" | "NOOP" | "DISABLED";
    activatedCount?: number;
    releasedCount?: number;
    conflictNode?: string;
    conflictAgent?: string;
    conflictGroup?: string;
    message?: string;
}> {
    return transitionTaskLocks(session, taskId, oldStatus, newStatus, agentId, lockingEnabled, metadata);
}

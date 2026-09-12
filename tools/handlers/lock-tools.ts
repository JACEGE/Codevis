import { createRequire } from "module";
// Only `int()` is needed here; the embedded compat client provides it.
const ladybug: any = createRequire(import.meta.url)("../../server/ladybug-driver.cjs");
const { normalizeDepth } = createRequire(import.meta.url)("../lib/lock-depth.cjs");
import type { ServerContext, ToolHandler, ToolModule } from "../lib/graph.js";
import { graphInt, pickDbDriver, pickDbName } from "../lib/graph.js";
import { syncLockManifest, syncFileToGraph } from "../lib/graph-sync.js";
import { invalidEdgeType, expireStaleLocks, lockTtlMs, DEFAULT_LOCK_TTL_MS, MAX_LOCK_TTL_MS } from "../lib/locks.js";
import { resolve, extname, dirname } from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";

// This file runs as an ES module, where `__dirname` does not exist. Two handlers
// used it as a fallback for CODEVIS_PROJECT_DIR and therefore threw
// "__dirname is not defined" the moment that env var was unset — which is the
// normal case for a worker. release_node was the visible casualty: a worker
// could take locks but never hand them back, so finished workers kept holding
// files and blocked every other agent until a lead force-unlocked them.
const __dirname_locks = dirname(fileURLToPath(import.meta.url));

// Shared session pattern: one session per invocation, auto-expire stale locks, then dispatch
async function withLockSession<T>(
    args: Record<string, any>,
    ctx: ServerContext,
    fn: (session: any, driver: any) => Promise<T>
): Promise<T> {
    const dbKey = pickDbName(args, "codevis_db");
    const driver = pickDbDriver(ctx, args, "codevis_db");
    if (!driver) {
        return { content: [{ type: "text", text: `Database '${dbKey}' not configured.` }], isError: true } as any;
    }
    const session = driver.session();
    try {
        await expireStaleLocks(session);
        return await fn(session, driver);
    } finally {
        await session.close();
    }
}

const handlers: Record<string, ToolHandler> = {
    lock_subgraph: async (args, ctx) => {
        args.agentId = args.agentId || ctx.defaultAgentId;
        if (!ctx.lockingEnabled) {
            return { content: [{ type: "text", text: JSON.stringify({
                status: "LOCKING_DISABLED",
                error: "Multi-agent locking is disabled for this project. Set locking.enabled=true in codevis.config.cjs and restart the MCP server to enable it.",
            }, null, 2) }] };
        }
        return withLockSession(args, ctx, async (session, driver) => {
            let result: any;

            if (!args.nodeId && !args.nodeName && !args.ipv6) {
                return { content: [{ type: "text", text: JSON.stringify({ error: "Provide nodeId, nodeName or ipv6." }) }] };
            }
            // depth 0 means "this node and nothing else" and must survive the
            // parse — see tools/lib/lock-depth.cjs for what the old inline
            // `|| 2` did to it.
            // Default 0 selects one origin; acquisition protects its whole file. Depth 2
            // pulled in half the neighbourhood and blocked other workers on
            // nodes nobody was editing, so wider locking is opt-in.
            const depth = normalizeDepth(args.depth, 0);
            const edgeTypes = args.edgeTypes || ["CALLS"];
            const badEdge = invalidEdgeType(edgeTypes) || (edgeTypes.includes("RESERVES") ? "RESERVES" : null);
            if (badEdge) {
                result = { status: "ERROR", error: `Invalid edge type '${badEdge}' — only uppercase letters and underscores allowed.` };
            }
            if (!result) {
                const edgePattern = edgeTypes.map((e: string) => `:${e}`).join("|");
                const originPred = args.nodeId ? "elementId(origin) = $nodeId"
                    : args.nodeName ? "origin.name = $nodeName" : "origin.ipv6 = $ipv6";
                const candidates = await session.run(
                    `MATCH (origin) WHERE ${originPred}
                     MATCH (origin)-[${edgePattern}*0..${depth}]-(dep)
                     WHERE NOT dep:Knowledge AND NOT dep:Task AND NOT dep:Epic
                     RETURN DISTINCT elementId(dep) AS id`,
                    { nodeId: args.nodeId, nodeName: args.nodeName, ipv6: args.ipv6 }
                );
                const nodeIds = candidates.records.map(r => r.get("id"));
                if (!nodeIds.length) result = { status: "NO_NODES", error: "No matching code nodes." };
                else {
                    const groupId = `${args.agentId}-${randomUUID()}`;
                    result = await session.taskClaimAtomic({
                        operation: "acquire", taskId: groupId, agentId: args.agentId,
                        nodeIds, ttlMs: lockTtlMs(args.ttlMs),
                    });
                    result.lockGroup = result.status === "OK" ? groupId : undefined;
                    result.lockedCount = result.activatedCount;
                }
            } // end if (!result) — edgeType validation passed

            // Sync lock manifest for fast hook lookups
            await syncLockManifest(driver);

            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        });
    },

    unlock_subgraph: async (args, ctx) => {
        args.agentId = args.agentId || ctx.defaultAgentId;
        return withLockSession(args, ctx, async (session, driver) => {
            const whereClause = args.lockGroup
                ? `n.lockedBy = $agentId AND n.lockGroup = $lockGroup`
                : `n.lockedBy = $agentId`;

            const unlockResult = await session.run(
                `MATCH (n) WHERE n.locked = true AND ${whereClause}
                 SET n.locked = null, n.lockedBy = null, n.lockGroup = null, n.lockExpires = null, n.lockOrigin = null
                 RETURN count(n) AS unlocked`,
                { agentId: args.agentId, lockGroup: args.lockGroup }
            );

            const result = {
                status: "OK",
                unlockedCount: graphInt(unlockResult.records[0].get("unlocked"))
            };

            // Sync lock manifest for fast hook lookups
            await syncLockManifest(driver);

            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        });
    },

    check_lock: async (args, ctx) => {
        return withLockSession(args, ctx, async (session, _driver) => {
            if (!args.nodeName && !args.ipv6) {
                return { content: [{ type: "text", text: JSON.stringify({ error: "Either nodeName or ipv6 is required" }) }] };
            }
            const matchClause = args.nodeName
                ? `MATCH (n) WHERE n.name = $nodeName`
                : `MATCH (n) WHERE n.ipv6 = $ipv6`;

            const checkResult = await session.run(
                `${matchClause}
                 RETURN n.name AS name, n.ipv6 AS ipv6, n.locked AS locked,
                        n.lockedBy AS lockedBy, n.lockGroup AS lockGroup,
                        n.lockExpires AS lockExpires, n.lockOrigin AS lockOrigin`,
                { nodeName: args.nodeName, ipv6: args.ipv6 }
            );

            let result: any;
            if (checkResult.records.length === 0) {
                result = { status: "NOT_FOUND" };
            } else {
                const r = checkResult.records[0];
                result = {
                    status: r.get("locked") ? "LOCKED" : "FREE",
                    name: r.get("name"),
                    ipv6: r.get("ipv6"),
                    lockedBy: r.get("lockedBy"),
                    lockGroup: r.get("lockGroup"),
                    lockOrigin: r.get("lockOrigin")
                };
            }

            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        });
    },

    list_locks: async (args, ctx) => {
        return withLockSession(args, ctx, async (session, _driver) => {
            // SINGLE aggregate per query: mixing collect(DISTINCT …) with other
            // aggregates (count, a second collect) makes Kuzu return 0/null for
            // the sibling aggregates. Origins and the count are derived in JS.
            const listResult = await session.run(
                `MATCH (n) WHERE n.locked = true
                 RETURN n.lockedBy AS agentId, n.lockGroup AS lockGroup,
                        collect({name: n.name, ipv6: n.ipv6, label: labels(n)[0], origin: n.lockOrigin}) AS nodes
                 ORDER BY lockGroup`
            );

            const result = listResult.records.map(r => {
                const raw: any[] = r.get("nodes") || [];
                return {
                    agentId: r.get("agentId"),
                    lockGroup: r.get("lockGroup"),
                    origins: [...new Set(raw.map((n) => n.origin).filter(Boolean))],
                    nodeCount: raw.length,
                    nodes: raw.map((n) => ({ name: n.name, ipv6: n.ipv6, label: n.label })),
                };
            });

            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        });
    },

    inspect_locked_node: async (args, ctx) => {
        return withLockSession(args, ctx, async (session, _driver) => {
            if (!args.nodeName && !args.ipv6) {
                return { content: [{ type: "text", text: JSON.stringify({ error: "Either nodeName or ipv6 is required" }) }] };
            }
            // Edge Membrane: read-only interface view of a locked node
            const matchClause = args.nodeName
                ? `MATCH (n) WHERE n.name = $nodeName`
                : `MATCH (n) WHERE n.ipv6 = $ipv6`;

            // ONE aggregate per WITH stage: sibling collect(DISTINCT …) aggregates
            // in the same projection silently null each other out on Kuzu.
            const inspectResult = await session.run(
                `${matchClause}
                 OPTIONAL MATCH (n)-[:CALLS]->(callee)
                 WITH n, collect(DISTINCT callee.name) AS calls
                 OPTIONAL MATCH (caller)-[:CALLS]->(n)
                 WITH n, calls, collect(DISTINCT caller.name) AS calledBy
                 OPTIONAL MATCH (n)-[:READS_STATE]->(state)
                 WITH n, calls, calledBy, collect(DISTINCT state.name) AS readsState
                 OPTIONAL MATCH (n)-[:WRITES_STATE]->(wstate)
                 WITH n, calls, calledBy, readsState, collect(DISTINCT wstate.name) AS writesState
                 OPTIONAL MATCH (n)-[:RETURNS]->(ret)
                 WITH n, calls, calledBy, readsState, writesState, collect(DISTINCT ret.name) AS returns
                 RETURN n.name AS name, labels(n)[0] AS label, n.ipv6 AS ipv6,
                        n.file AS file, n.params AS params, n.async AS async,
                        n.locked AS locked, n.lockedBy AS lockedBy,
                        calls, calledBy, readsState, writesState, returns`,
                { nodeName: args.nodeName, ipv6: args.ipv6 }
            );

            let result: any;
            if (inspectResult.records.length === 0) {
                result = { status: "NOT_FOUND" };
            } else {
                const r = inspectResult.records[0];
                result = {
                    status: "OK",
                    interface: {
                        name: r.get("name"),
                        label: r.get("label"),
                        ipv6: r.get("ipv6"),
                        file: r.get("file"),
                        params: r.get("params"),
                        async: r.get("async"),
                        calls: (r.get("calls") || []).filter(Boolean),
                        calledBy: (r.get("calledBy") || []).filter(Boolean),
                        readsState: (r.get("readsState") || []).filter(Boolean),
                        writesState: (r.get("writesState") || []).filter(Boolean),
                        returns: (r.get("returns") || []).filter(Boolean)
                    },
                    locked: r.get("locked") || false,
                    lockedBy: r.get("lockedBy"),
                    note: r.get("locked") ? "READ-ONLY: This node is locked. You can see its interface but cannot modify it." : null
                };
            }

            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        });
    },

    extend_locks: async (args, ctx) => {
        args.agentId = args.agentId || ctx.defaultAgentId;
        return withLockSession(args, ctx, async (session, driver) => {
            const ttlMs = lockTtlMs(args.ttlMs);
            const extendResult = await session.run(
                `MATCH (n) WHERE n.locked = true AND n.lockedBy = $agentId
                 SET n.lockExpires = $newExpires
                 RETURN count(n) AS extended`,
                { agentId: args.agentId, newExpires: ladybug.int(Date.now() + ttlMs) }
            );

            const result = {
                status: "OK",
                agentId: args.agentId,
                extendedCount: graphInt(extendResult.records[0].get("extended")),
                newExpiresAt: new Date(Date.now() + ttlMs).toISOString(),
            };

            // Sync lock manifest for fast hook lookups
            await syncLockManifest(driver);

            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        });
    },

    force_unlock: async (args, ctx) => {
        args.callerAgentId = args.callerAgentId || ctx.defaultAgentId;
        return withLockSession(args, ctx, async (session, driver) => {
            let result: any;

            // Authorization: only lead agents can force-unlock
            if (!args.callerAgentId?.startsWith("lead-")) {
                result = { status: "UNAUTHORIZED", error: `force_unlock is restricted to lead agents. Agent '${args.callerAgentId}' does not have the 'lead-' prefix.` };
            } else {
                // Check for active edits (with 5-minute stale detection)
                const EDIT_STALE_MS = 300000; // 5 minutes
                const editCheck = await session.run(
                    `MATCH (n) WHERE n.lockedBy = $targetAgent AND n.editInProgress = true
                     RETURN n.name AS name, n.editInProgressSince AS since LIMIT 1`,
                    { targetAgent: args.targetAgentId }
                );
                let editBlocked = false;
                if (editCheck.records.length > 0) {
                    const since = editCheck.records[0].get("since");
                    const sinceMs = graphInt(since);
                    if (sinceMs && Date.now() - sinceMs < EDIT_STALE_MS) {
                        result = { status: "EDIT_IN_PROGRESS", error: `Cannot force-unlock: agent '${args.targetAgentId}' has an active edit (started ${Math.round((Date.now() - sinceMs) / 1000)}s ago). Wait for it to finish or try again after 5 minutes.` };
                        editBlocked = true;
                    }
                    // else: stale edit, proceed with force unlock and clear editInProgress
                }
                if (!editBlocked) {
                    // Check how many locks the target agent holds
                    const countResult = await session.run(
                        `MATCH (n) WHERE n.locked = true AND n.lockedBy = $targetAgentId
                         RETURN count(n) AS count`,
                        { targetAgentId: args.targetAgentId }
                    );
                    const lockCount = graphInt(countResult.records[0].get("count"));

                    if (lockCount === 0) {
                        result = { status: "NO_LOCKS", targetAgentId: args.targetAgentId, message: "Agent has no active locks." };
                    } else {
                        // Force-release all locks
                        await session.run(
                            `MATCH (n) WHERE n.locked = true AND n.lockedBy = $targetAgentId
                             SET n.locked = null, n.lockedBy = null, n.lockGroup = null, n.lockExpires = null, n.lockOrigin = null, n.editInProgress = null, n.editInProgressSince = null`,
                            { targetAgentId: args.targetAgentId }
                        );

                        // Also reset any in_progress tasks assigned to this agent
                        await session.run(
                            `MATCH (t:Task {assignedTo: $targetAgentId, status: 'in_progress'})
                             SET t.status = 'todo', t.assignedTo = null, t.lastComment = $reason, t.updatedBy = $callerAgentId`,
                            { targetAgentId: args.targetAgentId, reason: `Force-unlocked by ${args.callerAgentId}: ${args.reason}`, callerAgentId: args.callerAgentId }
                        );

                        result = {
                            status: "OK",
                            targetAgentId: args.targetAgentId,
                            unlockedCount: lockCount,
                            reason: args.reason,
                            forcedBy: args.callerAgentId,
                        };
                    }
                } // end if (!editBlocked)
            } // end else (lead-agent auth check passed)

            // Sync lock manifest for fast hook lookups
            await syncLockManifest(driver);

            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        });
    },

    // ── Reactive Node Release ─────────────────────────────────────

    release_node: async (args, ctx) => {
        args.agentId = args.agentId || ctx.defaultAgentId;
        return withLockSession(args, ctx, async (session, driver) => {
            const { nodeName, agentId, summary } = args;
            if (!nodeName || !agentId || !summary) {
                return { content: [{ type: "text", text: JSON.stringify({ status: "ERROR", error: "nodeName, agentId, and summary are required." }) }], isError: true } as any;
            }

            // Verify the node is locked by this agent
            const check = await session.run(
                `MATCH (n {name: $nodeName}) WHERE n.locked = true AND n.lockedBy = $agentId
                 RETURN n.name AS name, n.file AS file, n.lockGroup AS lockGroup`,
                { nodeName, agentId }
            );

            if (check.records.length === 0) {
                return { content: [{ type: "text", text: JSON.stringify({ status: "NOT_FOUND", error: `Node '${nodeName}' is not locked by '${agentId}'.` }) }] };
            }

            const file = check.records[0].get("file");
            const lockGroup = check.records[0].get("lockGroup");

            // Sync this file's graph data before marking for release
            // This ensures the lead reviews with up-to-date CALLS edges
            const projectDir = process.env.CODEVIS_PROJECT_DIR || resolve(__dirname_locks, "../..");
            const absolutePath = resolve(projectDir, file);
            const ext = extname(file);
            const syncResult = await syncFileToGraph(absolutePath, file, ext, driver);

            // Set pendingRelease — node stays locked but marked for review
            await session.run(
                `MATCH (n {name: $nodeName}) WHERE n.locked = true AND n.lockedBy = $agentId
                 SET n.pendingRelease = true, n.releaseSummary = $summary, n.releaseRequestedAt = timestamp(), n.releaseRequestedBy = $agentId`,
                { nodeName, agentId, summary }
            );

            return { content: [{ type: "text", text: JSON.stringify({
                status: "PENDING_REVIEW",
                message: `Node '${nodeName}' (${file}) marked for release. Graph synced. Waiting for lead approval.`,
                nodeName, file, lockGroup, summary,
                graphSync: syncResult,
            }) }] };
        });
    },

    approve_release: async (args, ctx) => {
        args.callerAgentId = args.callerAgentId || ctx.defaultAgentId;
        return withLockSession(args, ctx, async (session, driver) => {
            const { nodeName, callerAgentId } = args;
            if (!nodeName) {
                return { content: [{ type: "text", text: JSON.stringify({ status: "ERROR", error: "nodeName is required." }) }], isError: true } as any;
            }

            // Only lead agents can approve (prefix check)
            if (callerAgentId && !callerAgentId.startsWith("lead")) {
                return { content: [{ type: "text", text: JSON.stringify({ status: "DENIED", error: "Only lead agents can approve releases." }) }] };
            }

            // Check node is pending release
            const check = await session.run(
                `MATCH (n {name: $nodeName}) WHERE n.pendingRelease = true
                 RETURN n.name AS name, n.file AS file, n.lockedBy AS lockedBy, n.lockGroup AS lockGroup, n.releaseSummary AS summary`,
                { nodeName }
            );

            if (check.records.length === 0) {
                return { content: [{ type: "text", text: JSON.stringify({ status: "NOT_FOUND", error: `Node '${nodeName}' has no pending release.` }) }] };
            }

            const file = check.records[0].get("file");
            const lockedBy = check.records[0].get("lockedBy");
            const lockGroup = check.records[0].get("lockGroup");

            // Release the node — clear all lock properties
            await session.run(
                `MATCH (n {name: $nodeName}) WHERE n.pendingRelease = true
                 SET n.locked = null, n.lockedBy = null, n.lockGroup = null, n.lockExpires = null, n.lockOrigin = null,
                     n.pendingRelease = null, n.releaseSummary = null, n.releaseRequestedAt = null, n.releaseRequestedBy = null,
                     n.releasedAt = timestamp(), n.releasedBy = $callerAgentId`,
                { nodeName, callerAgentId: callerAgentId || "lead-agent" }
            );

            // Sync lock manifest
            await syncLockManifest(driver);

            // Check if any blocked tasks can now proceed
            const unblockedTasks = await session.run(
                `MATCH (t:Task {status: 'blocked'})-[:AFFECTS]->(dep)
                 WHERE dep.locked = true
                 WITH t, collect(dep.name) AS stillLocked
                 WHERE size(stillLocked) = 0
                 RETURN t.taskId AS taskId, t.title AS title`
            );

            const nowUnblocked = unblockedTasks.records.map(r => ({
                taskId: r.get("taskId"),
                title: r.get("title"),
            }));

            return { content: [{ type: "text", text: JSON.stringify({
                status: "RELEASED",
                message: `Node '${nodeName}' (${file}) released. Previously locked by '${lockedBy}'.`,
                nodeName, file, previousOwner: lockedBy, lockGroup,
                tasksNowUnblocked: nowUnblocked,
            }) }] };
        });
    },

    reject_release: async (args, ctx) => {
        args.callerAgentId = args.callerAgentId || ctx.defaultAgentId;
        return withLockSession(args, ctx, async (session) => {
            const { nodeName, reason, callerAgentId } = args;
            if (!nodeName || !reason) {
                return { content: [{ type: "text", text: JSON.stringify({ status: "ERROR", error: "nodeName and reason are required." }) }], isError: true } as any;
            }

            if (callerAgentId && !callerAgentId.startsWith("lead")) {
                return { content: [{ type: "text", text: JSON.stringify({ status: "DENIED", error: "Only lead agents can reject releases." }) }] };
            }

            // Clear pendingRelease, keep lock active
            const check = await session.run(
                `MATCH (n {name: $nodeName}) WHERE n.pendingRelease = true
                 SET n.pendingRelease = null, n.releaseSummary = null, n.releaseRequestedAt = null, n.releaseRequestedBy = null,
                     n.releaseRejectedReason = $reason, n.releaseRejectedAt = timestamp()
                 RETURN n.name AS name, n.file AS file, n.lockedBy AS lockedBy`,
                { nodeName, reason }
            );

            if (check.records.length === 0) {
                return { content: [{ type: "text", text: JSON.stringify({ status: "NOT_FOUND", error: `Node '${nodeName}' has no pending release.` }) }] };
            }

            const lockedBy = check.records[0].get("lockedBy");

            return { content: [{ type: "text", text: JSON.stringify({
                status: "REJECTED",
                message: `Release of '${nodeName}' rejected. Node stays locked by '${lockedBy}'. Reason: ${reason}`,
                nodeName, lockedBy, reason,
            }) }] };
        });
    },

    list_pending_releases: async (args, ctx) => {
        return withLockSession(args, ctx, async (session) => {
            const result = await session.run(
                `MATCH (n) WHERE n.pendingRelease = true
                 RETURN n.name AS name, n.file AS file, n.lockedBy AS lockedBy, n.lockGroup AS lockGroup,
                        n.releaseSummary AS summary, n.releaseRequestedAt AS requestedAt
                 ORDER BY n.releaseRequestedAt`
            );

            const pending = result.records.map(r => ({
                name: r.get("name"),
                file: r.get("file"),
                lockedBy: r.get("lockedBy"),
                lockGroup: r.get("lockGroup"),
                summary: r.get("summary"),
                requestedAt: r.get("requestedAt") ? new Date(graphInt(r.get("requestedAt"))).toISOString() : null,
            }));

            return { content: [{ type: "text", text: JSON.stringify({
                status: "OK",
                count: pending.length,
                pendingReleases: pending,
            }, null, 2) }] };
        });
    },

    recover_stale_edit: async (args, ctx) => {
        args.callerAgentId = args.callerAgentId || ctx.defaultAgentId;
        return withLockSession(args, ctx, async (session, driver) => {
            const { nodeName, callerAgentId } = args;
            if (!nodeName) {
                return { content: [{ type: "text", text: JSON.stringify({ status: "ERROR", error: "nodeName is required." }) }], isError: true } as any;
            }

            // Only lead agents can invoke recovery
            if (callerAgentId && !callerAgentId.startsWith("lead")) {
                return { content: [{ type: "text", text: JSON.stringify({ status: "DENIED", error: "Only lead agents can invoke recover_stale_edit." }) }] };
            }

            const EDIT_STALE_MS = 300000; // 5 minutes

            // Find the node — must have a stale editInProgress flag
            const nodeResult = await session.run(
                `MATCH (n {name: $nodeName})
                 RETURN n.name AS name, n.file AS file, n.lockedBy AS lockedBy,
                        n.lockGroup AS lockGroup, n.editInProgress AS editInProgress,
                        n.editInProgressSince AS editInProgressSince`,
                { nodeName }
            );

            if (nodeResult.records.length === 0) {
                return { content: [{ type: "text", text: JSON.stringify({ status: "NOT_FOUND", error: `Node '${nodeName}' not found.` }) }] };
            }

            const r = nodeResult.records[0];
            const nodeFile = r.get("file");
            const lockedBy = r.get("lockedBy");
            const editInProgress = r.get("editInProgress");
            const editInProgressSince = r.get("editInProgressSince");
            const sinceMs = editInProgressSince ? graphInt(editInProgressSince) : null;
            const ageMs = sinceMs ? Date.now() - sinceMs : null;

            // Check if editInProgress is actually stale (or set at all)
            if (!editInProgress) {
                return { content: [{ type: "text", text: JSON.stringify({ status: "NO_STALE_EDIT", message: `Node '${nodeName}' has no editInProgress flag. No recovery needed.` }) }] };
            }
            if (sinceMs && ageMs !== null && ageMs < EDIT_STALE_MS) {
                return { content: [{ type: "text", text: JSON.stringify({
                    status: "EDIT_STILL_ACTIVE",
                    message: `editInProgress on '${nodeName}' is only ${Math.round(ageMs / 1000)}s old (threshold: ${EDIT_STALE_MS / 1000}s). Wait or use force_unlock if the agent is confirmed dead.`,
                    ageSeconds: Math.round(ageMs / 1000),
                }) }] };
            }

            // Attempt file recovery from latest backup
            let fileRestored = false;
            let fileCorrupt = false;
            let backupUsed: string | null = null;
            const projectDir = process.env.CODEVIS_PROJECT_DIR || resolve(__dirname_locks, "../..");

            if (nodeFile) {
                const absoluteFilePath = resolve(projectDir, nodeFile);
                const backupDir = resolve(projectDir, ".claude/backups");

                try {
                    const { existsSync, readdirSync, readFileSync: readFS, writeFileSync: writeFS, renameSync: renameFS } = await import("fs");

                    // Check if current file has syntax errors (using tree-sitter)
                    if (existsSync(absoluteFilePath)) {
                        const { getLanguageAndQuery, getParserInstance } = await import("../lib/treesitter.js");
                        const { extname } = await import("path");
                        const ext = extname(nodeFile);
                        try {
                            const { lang } = await getLanguageAndQuery(ext);
                            getParserInstance().setLanguage(lang);
                            const currentContent = readFS(absoluteFilePath, "utf-8");
                            const tree = getParserInstance().parse(currentContent);
                            fileCorrupt = tree.rootNode.hasError;
                        } catch (_) {
                            // Unknown extension — cannot syntax check, attempt restore anyway
                            fileCorrupt = true;
                        }
                    }

                    // Find most recent backup for this agent + file
                    if (existsSync(backupDir)) {
                        const escapedFile = nodeFile.replace(/[^a-zA-Z0-9._-]/g, "_");
                        const agentPrefix = lockedBy || "";
                        const candidates = readdirSync(backupDir)
                            .filter(f => f.endsWith(".bak") && f.includes(agentPrefix) && f.includes(escapedFile))
                            .sort()
                            .reverse();

                        if (candidates.length > 0) {
                            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                            /* candidates.length > 0 is checked above — index 0 is always defined */
                            // @ts-ignore: noUncheckedIndexedAccess — guarded by length check
                            const backupPath = resolve(backupDir, candidates[0]);
                            if (fileCorrupt) {
                                // Restore atomically
                                const backupContent = readFS(backupPath, "utf-8");
                                const tmpPath = absoluteFilePath + ".recovery_tmp";
                                writeFS(tmpPath, backupContent, "utf-8");
                                renameFS(tmpPath, absoluteFilePath);
                                fileRestored = true;
                                // @ts-ignore: noUncheckedIndexedAccess — guarded by length check
                                backupUsed = candidates[0];
                            } else {
                                // @ts-ignore: noUncheckedIndexedAccess — guarded by length check
                                backupUsed = candidates[0]; // note it exists even though not needed
                            }
                        }
                    }
                } catch (fsErr: any) {
                    console.warn(`[recovery] File check/restore failed for '${nodeName}': ${fsErr.message}`);
                }
            }

            // Clear editInProgress flag
            await session.run(
                `MATCH (n {name: $nodeName})
                 SET n.editInProgress = null, n.editInProgressSince = null`,
                { nodeName }
            );

            // Release the lock
            await session.run(
                `MATCH (n {name: $nodeName}) WHERE n.locked = true
                 SET n.locked = null, n.lockedBy = null, n.lockGroup = null,
                     n.lockExpires = null, n.lockOrigin = null`,
                { nodeName }
            );

            // Sync lock manifest
            await syncLockManifest(driver);

            // Mark assigned tasks as needs_info
            if (lockedBy) {
                await session.run(
                    `MATCH (t:Task {assignedTo: $agentId, status: 'in_progress'})
                     SET t.status = 'needs_info',
                         t.lastComment = $comment,
                         t.updatedBy = $callerAgentId`,
                    {
                        agentId: lockedBy,
                        comment: fileRestored
                            ? `Auto-recovered from crashed worker: backup restored for '${nodeName}' (${backupUsed}). Please re-verify and re-claim.`
                            : `Stale editInProgress cleared for '${nodeName}'. File appears intact. Please re-verify.`,
                        callerAgentId: callerAgentId || "lead-agent",
                    }
                );
            }

            const message = fileRestored
                ? `Recovery complete: backup restored for '${nodeName}' (${backupUsed}), lock released, task marked needs_info.`
                : fileCorrupt
                    ? `WARNING: File appears corrupt but no backup found. Lock released. Manual recovery required.`
                    : `File intact, stale editInProgress cleared, lock released.`;

            console.error(`[recovery] Agent ${lockedBy} crashed with edit on node '${nodeName}' — ${fileRestored ? `backup restored (${backupUsed})` : 'no restore needed'}, lock released`);

            return { content: [{ type: "text", text: JSON.stringify({
                status: "OK",
                nodeName,
                file: nodeFile,
                lockedBy,
                fileCorrupt,
                fileRestored,
                backupUsed,
                message,
            }, null, 2) }] };
        });
    },

};

const definitions = [
    {
        name: "lock_subgraph",
        description: "Atomically claim files containing a code node and its dependencies within N hops. " +
            "Available only when locking.enabled=true. Sets locked=true, lockedBy, lockGroup directly on graph nodes. " +
            "Traverses edges bidirectionally (CALLS, IMPORTS, RENDERS, etc.). " +
            "Prefer nodeId (elementId) to identify the origin node. Use task scopes for task-owned work. " +
            "IPv6 addresses on locked nodes enable subnet-based range queries later.",
        inputSchema: {
            type: "object",
            properties: {
                agentId: { type: "string", description: "Unique agent identifier (e.g. 'claude-1', 'cursor-2')." },
                nodeId: { type: "string", description: "Exact elementId of the origin node (preferred). File-backed code reserves its entire file." },
                nodeName: { type: "string", description: "Legacy origin name. Prefer nodeId for exact identity." },
                ipv6: { type: "string", description: "IPv6 address of the origin node. Use this OR nodeName." },
                depth: { type: "number", description: "Max hops to traverse. Default: 0 selects the origin; file-backed targets claim their whole file." },
                edgeTypes: { type: "array", items: { type: "string" }, description: "Edge types to follow. Default: ['CALLS']. Options: CALLS, RENDERS, IMPORTS, DATA_FLOWS_TO, READS_STATE, WRITES_STATE." },
                ttlMs: { type: "number", description: `Lock TTL in ms. Default: ${DEFAULT_LOCK_TTL_MS} (5 minutes); max: ${MAX_LOCK_TTL_MS}.` },
                db: { type: "string", description: "Database: 'project_db' or 'codevis_db'.", enum: ["project_db", "codevis_db"] }
            },
            required: ["agentId"]
        }
    },
    {
        name: "unlock_subgraph",
        description: "Release all locks held by an agent. Optionally specify a lockGroup to release only that group.",
        inputSchema: {
            type: "object",
            properties: {
                agentId: { type: "string", description: "Agent ID whose locks to release." },
                lockGroup: { type: "string", description: "Specific lock group to release. Omit to release all." },
                db: { type: "string", description: "Database: 'project_db' or 'codevis_db'.", enum: ["project_db", "codevis_db"] }
            },
            required: ["agentId"]
        }
    },
    {
        name: "check_lock",
        description: "Check if a code node is currently locked. Accepts nodeName or ipv6.",
        inputSchema: {
            type: "object",
            properties: {
                nodeName: { type: "string", description: "Name of the node to check." },
                ipv6: { type: "string", description: "IPv6 address to check." },
                db: { type: "string", description: "Database: 'project_db' or 'codevis_db'.", enum: ["project_db", "codevis_db"] }
            }
        }
    },
    {
        name: "list_locks",
        description: "List all currently locked nodes grouped by agent and lockGroup.",
        inputSchema: {
            type: "object",
            properties: {
                db: { type: "string", description: "Database: 'project_db' or 'codevis_db'.", enum: ["project_db", "codevis_db"] }
            }
        }
    },
    {
        name: "inspect_locked_node",
        description: "Edge Membrane: read-only view of a locked node. Returns only the interface (name, params, return type, " +
            "imports, edges) without the implementation. Use this to understand what a locked function does without needing write access.",
        inputSchema: {
            type: "object",
            properties: {
                nodeName: { type: "string", description: "Name of the node to inspect." },
                ipv6: { type: "string", description: "IPv6 address of the node. Use this OR nodeName." },
                db: { type: "string", description: "Database: 'project_db' or 'codevis_db'.", enum: ["project_db", "codevis_db"] }
            }
        }
    },
    {
        name: "extend_locks",
        description: "Heartbeat: extend all locks held by an agent by another TTL period. " +
            "Call this before the current five-minute lease expires to prevent lock expiry. " +
            "Returns the number of locks extended.",
        inputSchema: {
            type: "object",
            properties: {
                agentId: { type: "string", description: "Agent ID whose locks to extend." },
                ttlMs: { type: "number", description: `New TTL in ms from now. Default: ${DEFAULT_LOCK_TTL_MS} (5 minutes); max: ${MAX_LOCK_TTL_MS}.` },
                db: { type: "string", description: "Database: 'project_db' or 'codevis_db'.", enum: ["project_db", "codevis_db"] }
            },
            required: ["agentId"]
        }
    },
    {
        name: "force_unlock",
        description: "Lead-only: force-release all locks held by a specific agent. " +
            "Use when an agent has crashed or is unresponsive. " +
            "Requires a reason for audit trail.",
        inputSchema: {
            type: "object",
            properties: {
                targetAgentId: { type: "string", description: "Agent ID whose locks to force-release." },
                reason: { type: "string", description: "Why this force-unlock is needed (audit trail)." },
                callerAgentId: { type: "string", description: "Lead agent ID performing the force-unlock." },
                db: { type: "string", description: "Database: 'project_db' or 'codevis_db'.", enum: ["project_db", "codevis_db"] }
            },
            required: ["targetAgentId", "reason", "callerAgentId"]
        }
    },
    {
        name: "release_node",
        description: "Worker requests release of a single node they are done with. " +
            "The node is marked as pendingRelease — it stays locked until the lead agent approves via approve_release. " +
            "The worker can still read the node but should not edit it after requesting release. " +
            "Include a summary of what was implemented so the lead can review.",
        inputSchema: {
            type: "object",
            properties: {
                nodeName: { type: "string", description: "Name of the node to release." },
                agentId: { type: "string", description: "Worker agent ID requesting the release." },
                summary: { type: "string", description: "What was implemented/changed on this node. The lead will review this." },
                db: { type: "string", description: "Database: 'project_db' or 'codevis_db'.", enum: ["project_db", "codevis_db"] }
            },
            required: ["nodeName", "agentId", "summary"]
        }
    },
    {
        name: "approve_release",
        description: "Lead-only: approve a pending node release. The node is unlocked and becomes available for other agents. " +
            "Also checks if any blocked tasks can now proceed (all their dependencies are released).",
        inputSchema: {
            type: "object",
            properties: {
                nodeName: { type: "string", description: "Name of the node to approve release for." },
                callerAgentId: { type: "string", description: "Lead agent ID approving the release." },
                db: { type: "string", description: "Database: 'project_db' or 'codevis_db'.", enum: ["project_db", "codevis_db"] }
            },
            required: ["nodeName"]
        }
    },
    {
        name: "reject_release",
        description: "Lead-only: reject a pending node release. The node stays locked by the worker. " +
            "Include a reason so the worker knows what to fix.",
        inputSchema: {
            type: "object",
            properties: {
                nodeName: { type: "string", description: "Name of the node whose release is rejected." },
                reason: { type: "string", description: "Why the release was rejected. Worker will see this." },
                callerAgentId: { type: "string", description: "Lead agent ID rejecting the release." },
                db: { type: "string", description: "Database: 'project_db' or 'codevis_db'.", enum: ["project_db", "codevis_db"] }
            },
            required: ["nodeName", "reason"]
        }
    },
    {
        name: "list_pending_releases",
        description: "List all nodes with pending release requests. The lead uses this to see what needs review.",
        inputSchema: {
            type: "object",
            properties: {
                db: { type: "string", description: "Database: 'project_db' or 'codevis_db'.", enum: ["project_db", "codevis_db"] }
            }
        }
    },
    {
        name: "recover_stale_edit",
        description: "Lead-only: recover from a crashed worker that left an editInProgress flag. " +
            "Checks if the file has syntax errors — if so, restores from the latest backup. " +
            "Clears the editInProgress flag, releases the lock, and marks the assigned task as needs_info. " +
            "Safe to call even if the agent is still alive (will refuse if edit is less than 5 minutes old).",
        inputSchema: {
            type: "object",
            properties: {
                nodeName: { type: "string", description: "Name of the node with a stale editInProgress flag." },
                callerAgentId: { type: "string", description: "Lead agent ID invoking recovery." },
                db: { type: "string", description: "Database: 'project_db' or 'codevis_db'.", enum: ["project_db", "codevis_db"] }
            },
            required: ["nodeName"]
        }
    },

];

export const lockTools: ToolModule = { definitions, handlers };

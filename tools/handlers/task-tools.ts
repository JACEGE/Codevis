import { createRequire } from "module";
const { reserveUniqueTaskId, generateWorkItemId } = createRequire(import.meta.url)("../lib/task-id.cjs");
const { getTouchedNodes, getSyncFiles } = createRequire(import.meta.url)("../lib/task-context.cjs");
const { taskSpecProblems, mergeTaskSpec, deriveEpicStatus } = createRequire(import.meta.url)("../lib/task-rules.cjs");
const { readScopePolicy } = createRequire(import.meta.url)("../../server/task-scope-policy.cjs");
const { appendTaskComment } = createRequire(import.meta.url)("../lib/task-comments.cjs");
import type { ServerContext, ToolHandler, ToolModule } from "../lib/graph.js";
import { graphInt, pickDbDriver, pickDbName } from "../lib/graph.js";
import { commitSyncWave, commitSyncFile } from "../lib/graph-sync.js";
import { syncLockManifest, syncFileToGraph } from "../lib/graph-sync.js";
import { transitionLocks, lockTtlMs } from "../lib/locks.js";
import { resolve, extname, dirname } from "path";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";

const __filename_task = fileURLToPath(import.meta.url);
const __dirname_task = dirname(__filename_task);
const TASK_PROJECT_ROOT = process.env.CODEVIS_PROJECT_DIR || resolve(__dirname_task, "../..");

// ── Wave → Workflow script generation ────────────────────────────────────────
// plan_task_waves computes a dependency-ordered plan; with emitWorkflow it also
// writes that plan out as an executable Claude Code Workflow script. The mapping
// is exact: a wave is a barrier (wave N+1 must not start before N finishes), and
// tasks inside a wave run concurrently — which is parallel() between phases.
//
// The one refinement over "everything in a wave runs at once": tasks whose
// target nodes live in the SAME FILE cannot safely run concurrently, since two
// agents editing one file collide regardless of node-level locks. Those tasks
// are grouped into a cluster and run sequentially, while separate clusters still
// run in parallel to each other. plan_task_waves already detects this overlap
// for its own risk report (canParallel/sharedFileWarning); here it decides the
// generated control flow instead of only warning about it.

/**
 * Group a wave's tasks so that any two tasks touching the same file end up in
 * the same cluster. Union-find over files; clusters run sequentially inside,
 * concurrently between.
 */
function targetFile(target: string): string {
    const start = /^[a-z]:[\\/]/i.test(target) ? 2 : 0;
    const separator = target.indexOf(':', start);
    return separator < 0 ? target : target.slice(0, separator);
}

export function clusterByFile(waveTasks: any[]): any[][] {
    const parent = new Map<string, string>();
    const find = (x: string): string => {
        if (parent.get(x) !== x) parent.set(x, find(parent.get(x)!));
        return parent.get(x)!;
    };
    const union = (a: string, b: string) => { parent.set(find(a), find(b)); };

    for (const t of waveTasks) parent.set(t.taskId, t.taskId);

    const ownersByFile = new Map<string, string[]>();
    for (const t of waveTasks) {
        for (const node of (t.targetNodes as string[])) {
            const file = targetFile(node);
            if (!ownersByFile.has(file)) ownersByFile.set(file, []);
            ownersByFile.get(file)!.push(t.taskId);
        }
    }
    for (const owners of ownersByFile.values()) {
        for (let i = 1; i < owners.length; i++) union(owners[0], owners[i]);
    }

    const byRoot = new Map<string, any[]>();
    for (const t of waveTasks) {
        const root = find(t.taskId);
        if (!byRoot.has(root)) byRoot.set(root, []);
        byRoot.get(root)!.push(t);
    }
    return [...byRoot.values()];
}

/** The instruction a single worker agent receives for one task. */
function taskPrompt(task: any, dbKey: string): string {
    const nodes = (task.targetNodes as string[]);
    return [
        `You are executing CodeVis task ${task.taskId}: ${task.title}`,
        ``,
        `Database: '${dbKey}'. Priority: ${task.priority}.`,
        nodes.length ? `Target nodes:\n${nodes.map((n) => `  - ${n}`).join("\n")}` : `No target nodes recorded on this task.`,
        ``,
        `Procedure:`,
        `  1. get_task({ taskId: '${task.taskId}', db: '${dbKey}' }) to read the full description and workInstructions.`,
        `  2. claim_task to atomically take ownership. With locking enabled, use expand_task_scope before editing additional files. On conflict coordinate a safe handoff; never spin while holding claims.`,
        `  3. Do the work. Prefer edit_code_patch for targeted changes and rewrite_function only for major function rewrites.`,
        `  4. complete_task with a summary. If you acquired optional locks, release them when finished.`,
        ``,
        `If the task turns out to be blocked or its instructions are unusable, do NOT guess:`,
        `set status 'blocked' with a reason via update_task_status and return what you found.`,
        ``,
        `Return a one-paragraph summary of what you changed.`,
    ].join("\n");
}

/**
 * Render the whole wave plan as a Workflow script.
 *
 * Note the script must not call Date.now()/Math.random() — the Workflow runtime
 * forbids them so runs stay resumable — so the timestamp is baked in here as a
 * literal at generation time.
 */
export function renderWaveWorkflow(waves: Record<number, any[]>, dbKey: string, generatedAt: string): string {
    const waveNums = Object.keys(waves).map(Number).sort((a, b) => a - b);
    const totalTasks = waveNums.reduce((n, w) => n + waves[w].length, 0);

    const phaseMeta = waveNums.map((w) => {
        const clusters = clusterByFile(waves[w]);
        const seq = clusters.filter((c) => c.length > 1).length;
        const detail = `${waves[w].length} task(s)` + (seq ? `, ${seq} sequential group(s) sharing files` : ``);
        return `    { title: ${JSON.stringify(`Wave ${w}`)}, detail: ${JSON.stringify(detail)} },`;
    }).join("\n");

    const body = waveNums.map((w) => {
        const clusters = clusterByFile(waves[w]);
        const phaseName = `Wave ${w}`;
        const agentThunk = (t: any, pad: string) =>
            `${pad}() => agent(${JSON.stringify(taskPrompt(t, dbKey))}, {\n` +
            `${pad}  label: ${JSON.stringify(`${t.taskId} ${t.title}`.slice(0, 60))},\n` +
            `${pad}  phase: ${JSON.stringify(phaseName)},\n` +
            `${pad}  agentType: 'CodeVis Worker',\n` +
            `${pad}}),`;

        const thunks = clusters.map((cluster) => {
            if (cluster.length === 1) return agentThunk(cluster[0], "    ");
            // Same-file cluster: sequential, so two agents never edit one file at once.
            const inner = cluster.map((t) => agentThunk(t, "      ")).join("\n");
            return `    () => runSequential([\n${inner}\n    ]),`;
        }).join("\n");

        return [
            `phase(${JSON.stringify(phaseName)})`,
            `log(${JSON.stringify(`Wave ${w}: ${waves[w].length} task(s), ${clusters.length} independent group(s)`)})`,
            `results.push(...(await parallel([`,
            thunks,
            `])).flat())`,
            ``,
        ].join("\n");
    }).join("\n");

    return `export const meta = {
  name: 'codevis-wave-plan',
  description: ${JSON.stringify(`Execute ${totalTasks} CodeVis task(s) across ${waveNums.length} dependency wave(s)`)},
  phases: [
${phaseMeta}
  ],
}

// ---------------------------------------------------------------------------
// GENERATED by CodeVis plan_task_waves on ${generatedAt} — db '${dbKey}'.
// Regenerate with plan_task_waves({ emitWorkflow: true }) rather than editing:
// the wave order is derived from the CALLS graph and goes stale as tasks change.
//
// Each wave is a barrier. Tasks within a wave run concurrently, EXCEPT tasks
// whose targets share a file — those run one after another inside a group.
// ---------------------------------------------------------------------------

/** Run thunks one after another (used for tasks that share a file). */
const runSequential = async (thunks) => {
  const out = []
  for (const t of thunks) out.push(await t())
  return out
}

const results = []

${body}
return { tasksRun: results.filter(Boolean).length, summaries: results.filter(Boolean) }
`;
}


// Shared session pattern: one session per invocation, then dispatch
async function withTaskSession<T>(
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
        return await fn(session, driver);
    } finally {
        await session.close();
    }
}

/**
 * Das Diagramm hinter dem Code, den ein Task anfasst.
 *
 * Drei Wege führen vom Task zur Spezifikation, und alle drei werden gebraucht:
 *
 *   1. AFFECTS auf einen Knoten, den ein Spec-Knoten realisiert — der direkte
 *      Fall, wenn der Task eine ganze Klasse betrifft.
 *   2. AFFECTS auf eine Funktion, deren CONTAINER realisiert ist. Tasks zeigen
 *      meist auf Funktionen, gebunden ist aber die Klasse; ohne diesen Hop
 *      bliebe der Kontext bei fast jedem echten Task leer.
 *   3. Eine Kante vom Spec-Knoten direkt auf den Task. Für Code, den es noch
 *      NICHT gibt, ist das der einzige Weg — ein Knoten, der erst gebaut werden
 *      soll, kann per Definition kein REALIZED_BY tragen.
 *
 * Zurück kommt, was ein Worker braucht, um die Struktur einzuhalten: Methoden
 * und Felder der Klasse laut Diagramm, ihre Beziehungen zu anderen Klassen in
 * beide Richtungen, und woher das stammt (Diagrammtitel + Quelldatei).
 */
function truncate(text: any, max: number): string | undefined {
    if (!text) return undefined;
    const s = String(text);
    return s.length <= max ? s : `${s.slice(0, max)}\n… (${s.length - max} weitere Zeichen)`;
}

async function getSpecContext(session: any, taskId: string): Promise<any[]> {
    let anchors: any[] = [];
    try {
        const res = await session.run(
            `MATCH (t:Task {taskId: $taskId})-[:AFFECTS]->(n)
             MATCH (p)-[:REALIZED_BY]->(n)
             RETURN DISTINCT p.uid AS specUid, n.name AS via, 'direct' AS how
             UNION
             MATCH (t:Task {taskId: $taskId})-[:AFFECTS]->(n)
             MATCH (owner)-[:CONTAINS]->(n)
             MATCH (p)-[:REALIZED_BY]->(owner)
             RETURN DISTINCT p.uid AS specUid, n.name AS via, 'container' AS how
             UNION
             MATCH (p)-[:APPLIES_TO]->(t:Task {taskId: $taskId})
             WHERE p.label STARTS WITH 'Spec'
             RETURN DISTINCT p.uid AS specUid, '' AS via, 'linked' AS how`,
            { taskId }
        );
        anchors = res.records.map((r: any) => ({
            specUid: r.get("specUid"), via: r.get("via"), how: r.get("how"),
        }));
    } catch (err: any) {
        // Eine DB ohne Spec-Ebene hat die REALIZED_BY-Tabelle nicht. Das ist
        // kein Fehler des Tasks — dann gibt es eben keinen Diagrammkontext.
        // Alles andere fliegt weiter: ein stiller catch hier hat den Kontext
        // schon einmal wortlos leer gemeldet, obwohl die Query kaputt war.
        if (isMissingTable(err, "REALIZED_BY") || isMissingTable(err, "APPLIES_TO")) return [];
        throw err;
    }
    if (anchors.length === 0) return [];

    const out: any[] = [];
    const seen = new Set<string>();
    for (const a of anchors) {
        if (!a.specUid || seen.has(a.specUid)) continue;
        seen.add(a.specUid);

        const head = await session.run(
            `MATCH (s)-[:DERIVES]->(p) WHERE p.uid = $uid
             RETURN p.name AS name, p.label AS label, p.kind AS kind,
                    s.name AS specId, s.title AS diagramTitle,
                    s.sourceFile AS sourceFile, s.label AS diagramKind,
                    s.text AS diagramSource`,
            { uid: a.specUid }
        );
        if (head.records.length === 0) continue;
        const h = head.records[0];

        const members = await session.run(
            `MATCH (p)-[:DECLARES]->(m) WHERE p.uid = $uid
             RETURN m.label AS label, m.name AS name, m.kind AS visibility,
                    m.signature AS signature, m.params AS params,
                    m.return_type AS returns, m.declaredType AS declaredType`,
            { uid: a.specUid }
        );
        // Beide Richtungen: wer von dieser Klasse erbt, ist genauso Teil des
        // Vertrags wie das, von dem sie erbt.
        const relations = await session.run(
            `MATCH (p)-[r]->(b) WHERE p.uid = $uid AND b.label = 'SpecClass'
             RETURN type(r) AS edge, r.name AS uml, b.name AS other, 'out' AS direction,
                    r.umlLabel AS label, r.multiplicityFrom AS multFrom, r.multiplicityTo AS multTo
             UNION
             MATCH (b)-[r]->(p) WHERE p.uid = $uid AND b.label = 'SpecClass'
             RETURN type(r) AS edge, r.name AS uml, b.name AS other, 'in' AS direction,
                    r.umlLabel AS label, r.multiplicityFrom AS multFrom, r.multiplicityTo AS multTo`,
            { uid: a.specUid }
        );

        // Welche Methoden es im Code schon GIBT. Gebunden ist die Klasse, nicht
        // die Methode — die Zuordnung läuft über den Namen der Funktionen, die
        // der realisierende Knoten enthält. Ohne das ist die erste Frage eines
        // Workers ("was fehlt noch?") aus dem Payload nicht zu beantworten.
        const implemented = new Set<string>();
        let realizedBy: string | null = null;
        const codeSide = await session.run(
            `MATCH (p)-[:REALIZED_BY]->(c) WHERE p.uid = $uid
             OPTIONAL MATCH (c)-[:CONTAINS]->(fn)
             RETURN c.name AS codeName, fn.name AS fnName, fn.label AS fnLabel`,
            { uid: a.specUid }
        );
        for (const r of codeSide.records) {
            realizedBy = realizedBy || r.get("codeName");
            const fn = r.get("fnName");
            if (fn && r.get("fnLabel") === "Function") implemented.add(String(fn));
        }

        // Der Vertrag der Elternklasse: was ich erbe statt es nachzubauen.
        const inherited = await session.run(
            `MATCH (p)-[:INHERITS]->(parent) WHERE p.uid = $uid
             MATCH (parent)-[:DECLARES]->(m)
             RETURN parent.name AS parent, m.name AS name,
                    m.signature AS signature, m.label AS label`,
            { uid: a.specUid }
        );
        const inheritedFrom: Record<string, string[]> = {};
        for (const r of inherited.records) {
            const parent = String(r.get("parent"));
            (inheritedFrom[parent] = inheritedFrom[parent] || [])
                .push(r.get("signature") || r.get("name"));
        }

        // Sequenzdiagramm: wer ruft mich womit, in welcher Reihenfolge, und was
        // rufe ich weiter. Steht komplett mit Argumenten im Graphen und war
        // vorher der größte blinde Fleck des Payloads.
        const messages = await session.run(
            `MATCH (s)-[:DERIVES]->(p) WHERE p.uid = $uid
             MATCH (s)-[:DERIVES]->(m)
             WHERE m.label = 'SpecMessage' AND (m.scope = p.name OR m.value = p.name)
             RETURN m.ts AS ord, m.scope AS from, m.value AS to,
                    m.text AS call, m.kind AS guard
             ORDER BY m.ts`,
            { uid: a.specUid }
        );

        const memberList = members.records.map((r: any) => {
            const isField = r.get("label") === "SpecField";
            const name = r.get("name");
            return {
                kind: isField ? "field" : "method",
                name,
                signature: r.get("signature") || name,
                params: r.get("params") || undefined,
                returns: r.get("returns") || r.get("declaredType") || undefined,
                visibility: r.get("visibility") || undefined,
                // Nur für Methoden aussagekraeftig; Felder tauchen im Graphen
                // nicht als eigene Knoten auf, "fehlt" wäre dort geraten.
                implemented: isField ? undefined : implemented.has(String(name)),
            };
        });

        out.push({
            specNode: h.get("name"),
            specLabel: h.get("label"),
            kind: h.get("kind") || undefined,
            diagram: {
                specId: h.get("specId"), title: h.get("diagramTitle"),
                sourceFile: h.get("sourceFile"), kind: h.get("diagramKind"),
                // Der Diagrammtext selbst, gedeckelt. Was der Parser nicht in
                // Knoten auflöst (Kommentare, Gruppierungen, Reihenfolge im
                // Original), steht nur hier — und die Datei liegt im Zielprojekt,
                // nicht dort, wo der Worker gerade arbeitet.
                source: truncate(h.get("diagramSource"), 2000),
            },
            reachedVia: a.how === "linked" ? "linked to the task" : `${a.how}: ${a.via}`,
            realizedBy: realizedBy || null,
            members: memberList,
            missingMembers: memberList.filter(m => m.implemented === false).map(m => m.signature),
            inheritedFrom: Object.keys(inheritedFrom).length ? inheritedFrom : undefined,
            relations: relations.records.map((r: any) => ({
                direction: r.get("direction"),
                type: r.get("uml") || r.get("edge"),
                other: r.get("other"),
                label: r.get("label") || undefined,
                multiplicity: r.get("multFrom") || r.get("multTo")
                    ? `${r.get("multFrom") || "?"} → ${r.get("multTo") || "?"}`
                    : undefined,
            })),
            messages: messages.records.map((r: any) => ({
                step: graphInt(r.get("ord")),
                from: r.get("from"), to: r.get("to"),
                call: r.get("call"),
                guard: r.get("guard") || undefined,
            })),
        });
    }
    return out;
}

const handlers: Record<string, ToolHandler> = {
    create_task: async (args, ctx) => {
        args.createdBy = args.createdBy || ctx.defaultAgentId || "user";
        const lockingEnabled = ctx.lockingEnabled === true;

        // ── Specification gate ──────────────────────────────────────────────
        // Tasks are worker prompts: an under-specified task produces an
        // under-specified result. Reject creation until the task says WHAT to
        // do (description with enough substance) and HOW to verify it
        // (workInstructions with acceptance criteria). Disable for throwaway
        // experiments with CODEVIS_TASK_GATE=off.
        if (process.env.CODEVIS_TASK_GATE !== "off") {
            const problems: string[] = taskSpecProblems(args, { subject: "task" });
            if (problems.length > 0) {
                return { content: [{ type: "text", text: JSON.stringify({
                    status: "UNDERSPECIFIED",
                    error: "Task rejected by the specification gate. Fix the following and call create_task again:",
                    problems,
                    hint: "A good task names the affected code (targetNodes), the desired behaviour, and measurable acceptance criteria in workInstructions.",
                }) }], isError: true } as any;
            }
        }

        return withTaskSession(args, ctx, async (session, driver) => {
            const taskId = await reserveUniqueTaskId(session);
            const result = await session.taskClaimAtomic({
                ...args, operation: "create", taskId, agentId: args.createdBy,
                lockingEnabled, ttlMs: lockTtlMs(),
            });
            if (lockingEnabled) await syncLockManifest(driver);
            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        });
    },

    plan_task_scope: async (args, ctx) => {
        return withTaskSession(args, ctx, async (session) => {
            const result = await session.taskClaimAtomic({
                ...args, operation: "plan", agentId: args.agentId || ctx.defaultAgentId,
                lockingEnabled: ctx.lockingEnabled === true,
            });
            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        });
    },

    expand_task_scope: async (args, ctx) => {
        return withTaskSession(args, ctx, async (session, driver) => {
            const result = await session.taskClaimAtomic({
                ...args, operation: "expand", agentId: args.agentId || ctx.defaultAgentId,
                lockingEnabled: ctx.lockingEnabled === true, ttlMs: lockTtlMs(),
            });
            if (result.status === "OK") await syncLockManifest(driver);
            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        });
    },

    claim_task: async (args, ctx) => {
        args.agentId = args.agentId || ctx.defaultAgentId;
        const lockingEnabled = ctx.lockingEnabled === true;
        return withTaskSession(args, ctx, async (session, driver) => {
            let result: any;

            const claim = await session.taskClaimAtomic({
                operation: "claim", taskId: args.taskId, agentId: args.agentId,
                lockingEnabled, ttlMs: lockTtlMs(),
            });
            if (claim.status !== "OK") {
                result = claim;
            } else {
                const transferResult = { records: [{ get: (_key: string) => claim.activatedCount || 0 }] };

                // Fetch task details (workInstructions, affected nodes) so worker has everything in one call
                const detailResult = await session.run(
                    `MATCH (t:Task {taskId: $taskId})
                     OPTIONAL MATCH (t)-[:AFFECTS]->(n)
                     RETURN t.workInstructions AS workInstructions, t.description AS description,
                            t.priority AS priority,
                            collect({id: elementId(n), name: coalesce(n.name, n.path, elementId(n)), file: coalesce(n.file, n.path), ipv6: n.ipv6, startLine: n.startLine, endLine: n.endLine}) AS affectedNodes`,
                    { taskId: args.taskId }
                );
                const detail = detailResult.records[0];

                // Fetch linked knowledge so worker doesn't need a separate get_knowledge_for_node call.
                // Auch die Knowledge an den betroffenen CODE-Knoten, nicht nur die
                // am Task: wer eine Funktion anfasst, braucht was über sie
                // bekannt ist — und niemand hängt dieselbe Notiz an jeden Task,
                // der die Datei je beruehrt. get_task liest schon beides.
                const knowledgeResult = await session.run(
                    `MATCH (k:Knowledge)-[:APPLIES_TO]->(t:Task {taskId: $taskId})
                     RETURN k.name AS name, k.content AS content, k.category AS category
                     UNION
                     MATCH (task:Task {taskId: $taskId})-[:AFFECTS]->(n)
                     MATCH (k:Knowledge)-[:APPLIES_TO]->(n)
                     RETURN k.name AS name, k.content AS content, k.category AS category`,
                    { taskId: args.taskId }
                );
                const knowledgeSeen = new Set<string>();
                const knowledge = knowledgeResult.records.map(r => ({
                    name: r.get("name"),
                    content: r.get("content"),
                    category: r.get("category")
                })).filter(k => {
                    if (knowledgeSeen.has(k.name)) return false;
                    knowledgeSeen.add(k.name);
                    return true;
                });

                // Die Struktur laut Diagramm — dieselbe Quelle wie in get_task,
                // damit ein Worker sie beim Ziehen schon hat und nicht erst
                // nachfragen muss.
                const spec = await getSpecContext(session, args.taskId);

                // Lock state changed — keep the on-disk manifest (the hooks'
                // offline fallback) in sync, like create_task/update_task_status do.
                if (lockingEnabled) await syncLockManifest(driver);

                result = {
                    status: "OK",
                    taskId: args.taskId,
                    assignedTo: args.agentId,
                    locking: lockingEnabled ? "enabled" : "disabled",
                    locksTransferred: graphInt(transferResult.records[0].get("transferred")),
                    editScope: { files: claim.files || [], nodeIds: claim.nodeIds || [] },
                    scopeMode: claim.scopeMode,
                    workInstructions: detail?.get("workInstructions") || null,
                    description: detail?.get("description") || null,
                    priority: detail?.get("priority") || null,
                    affectedNodes: (detail?.get("affectedNodes") || []).filter((n: any) => n?.id != null),
                    knowledge: knowledge.length > 0 ? knowledge : undefined,
                    knowledgeNote: knowledge.length === 0 ? "No knowledge linked to this task." : undefined,
                    spec: spec.length > 0 ? spec : undefined,
                    specNote: spec.length === 0 ? undefined
                        : "Structure from an imported diagram — keep method names and relations as specified.",
                };
            }

            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        });
    },

    update_task_status: async (args, ctx) => {
        args.agentId = args.agentId || ctx.defaultAgentId;
        const lockingEnabled = ctx.lockingEnabled === true;
        return withTaskSession(args, ctx, async (session, driver) => {
            const taskResult = await session.run(
                `MATCH (t:Task {taskId: $taskId}) RETURN t.status AS currentStatus, t.assignedTo AS assignedTo`,
                { taskId: args.taskId }
            );

            let result: any;
            if (taskResult.records.length === 0) {
                result = { status: "NOT_FOUND", taskId: args.taskId };
            } else {
                const oldStatus: string = taskResult.records[0].get("currentStatus");
                const newStatus: string = args.status;
                const agentId: string = args.agentId || "user";
                // Effective agent for lock activation: use task's current assignedTo if agentId is generic
                const lockAgent: string = agentId;

                // Only the user can mark tasks as done
                if (newStatus === "done" && agentId !== "user") {
                    return { content: [{ type: "text", text: JSON.stringify({ status: "FORBIDDEN", error: "Only the user can mark tasks as done." }) }], isError: true } as any;
                }

                // ── Planned → Active lock transition ────────────────────────────────
                // This runs BEFORE updating status so a conflict blocks the move.
                const lockTransition = await transitionLocks(session, args.taskId, oldStatus, newStatus, lockAgent, lockingEnabled, { comment: args.comment });
                if (!["OK", "NOOP", "DISABLED"].includes(lockTransition.status)) {
                    return { content: [{ type: "text", text: JSON.stringify({
                        ...lockTransition,
                        taskId: args.taskId,
                        error: lockTransition.message,
                        conflictNode: lockTransition.conflictNode,
                        conflictAgent: lockTransition.conflictAgent,
                        conflictGroup: lockTransition.conflictGroup,
                    }) }] };
                }


                console.error(`[lock-transition] Task ${args.taskId}: status ${oldStatus}→${newStatus}, activatedLocks=${lockTransition.activatedCount ?? 0}, releasedLocks=${lockTransition.releasedCount ?? 0}`);

                result = {
                    status: "OK",
                    taskId: args.taskId,
                    oldStatus,
                    newStatus,
                    comment: args.comment || null,
                    locking: lockingEnabled ? "enabled" : "disabled",
                    lockTransition: lockTransition.status === "DISABLED" ? "disabled" : lockTransition.status === "NOOP" ? "no-change" : lockTransition.status === "OK" ? "transitioned" : lockTransition.status,
                    activatedLocks: lockTransition.activatedCount ?? 0,
                    releasedLocks: lockTransition.releasedCount ?? 0,
                };

                // Completing all member tasks moves the Epic to human review;
                // it never auto-closes because its acceptance criteria still
                // require explicit user verification.
                if (newStatus === "done") {
                    try {
                        await session.run(
                            `MATCH (e:Epic)-[:FULFILLED_BY]->(t:Task {taskId:$taskId})
                             WHERE NOT EXISTS { MATCH (e)-[:FULFILLED_BY]->(open:Task) WHERE open.status <> 'done' }
                             SET e.status='review', e.updatedAt=timestamp(), e.updatedBy=$updatedBy`,
                            { taskId: args.taskId, updatedBy: args.agentId || "user" });
                    } catch (e: any) {
                        // A daemon opened before this additive schema revision
                        // can still serve legacy tasks. It has no Epics to
                        // review; reconciliation creates the table on restart.
                        if (!/FULFILLED_BY.*does not exist|Table FULFILLED_BY does not exist/i.test(String(e?.message))) throw e;
                    }
                }
            }

            // Sync lock manifest after task ops that change locks
            if (lockingEnabled) await syncLockManifest(driver);

            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        });
    },

    complete_task: async (args, ctx) => {
        args.agentId = args.agentId || ctx.defaultAgentId;
        const lockingEnabled = ctx.lockingEnabled === true;
        return withTaskSession(args, ctx, async (session, driver) => {
            let result: any;
            const taskResult = await session.run(
                `MATCH (t:Task {taskId: $taskId}) RETURN t.assignedTo AS assignedTo`,
                { taskId: args.taskId }
            );

            if (taskResult.records.length === 0) {
                result = { status: "NOT_FOUND" };
            } else {
                const completed = await session.taskClaimAtomic({
                    operation: "complete", taskId: args.taskId, agentId: args.agentId,
                    summary: args.summary, lockingEnabled,
                });
                if (!["OK", "NOOP", "DISABLED"].includes(completed.status)) {
                    return { content: [{ type: "text", text: JSON.stringify(completed) }], isError: true };
                }
                const releasedLocks = completed.releasedCount || 0;

                // Auto-sync graph for all files affected by this task
                const affectedFiles = await getSyncFiles(session, { taskId: args.taskId });
                const projectDir = process.env.CODEVIS_PROJECT_DIR || process.cwd();
                let syncedFiles = 0;
                const failedFiles: string[] = [];
                for (const { file } of affectedFiles) {
                    const absolutePath = resolve(projectDir, file);
                    const ext = extname(file);
                    const syncResult = await syncFileToGraph(absolutePath, file, ext, driver);
                    if (syncResult) syncedFiles++;
                    else failedFiles.push(file);
                }

                result = {
                    status: failedFiles.length ? "SYNC_FAILED" : "OK",
                    taskId: args.taskId,
                    newStatus: "review",
                    locking: lockingEnabled ? "enabled" : "disabled",
                    graphSynced: syncedFiles,
                    failedFiles,
                    releasedLocks,
                    note: failedFiles.length
                        ? "Task moved to review, but graph synchronization failed for some files. Repair those files and retry with sync_task."
                        : lockingEnabled
                        ? "Task moved to review. Graph synced and all locks for this task were released."
                        : "Task moved to review and the graph was synced. Locking is disabled."
                };
            }

            // Sync lock manifest after task ops that change locks
            if (lockingEnabled) await syncLockManifest(driver);

            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], ...(result.status === 'SYNC_FAILED' ? { isError: true } : {}) };
        });
    },

    list_tasks: async (args, ctx) => {
        return withTaskSession(args, ctx, async (session, _driver) => {
            // Default: exclude 'done' tasks to reduce context. Use status: "all" or "done" to include them.
            let statusFilter: string;
            if (args.status === "all") {
                statusFilter = "";
            } else if (args.status) {
                statusFilter = `WHERE t.status = $status`;
            } else {
                statusFilter = `WHERE t.status <> 'done'`;
            }

            const listResult = await session.run(
                `MATCH (t:Task) ${statusFilter}
                 OPTIONAL MATCH (t)-[:AFFECTS]->(direct)
                 WITH t, collect(DISTINCT {id: elementId(direct), name: coalesce(direct.name, direct.path, elementId(direct)), file: coalesce(direct.file, direct.path), label: labels(direct)[0], ipv6: direct.ipv6, locked: direct.locked, lockType: 'direct'}) AS directNodes
                 OPTIONAL MATCH (trans) WHERE trans.lockGroup = t.taskId AND NOT EXISTS { MATCH (t)-[:AFFECTS]->(trans) }
                 WITH t, directNodes, collect(DISTINCT {id: elementId(trans), name: coalesce(trans.name, trans.path, elementId(trans)), file: coalesce(trans.file, trans.path), label: labels(trans)[0], ipv6: trans.ipv6, locked: trans.locked, lockType: 'transitive', lockOrigin: trans.lockOrigin}) AS transitiveNodes
                 RETURN t.taskId AS taskId, t.title AS title, t.description AS description,
                        t.status AS status, t.priority AS priority, t.category AS category,
                        t.createdBy AS createdBy, t.assignedTo AS assignedTo,
                        t.summary AS summary, t.lastComment AS lastComment,
                        t.updatedBy AS updatedBy, t.updatedAt AS updatedAt,
                        directNodes AS directNodes, transitiveNodes AS transitiveNodes
                 ORDER BY CASE status
                   WHEN 'in_progress' THEN 0 WHEN 'blocked' THEN 1 WHEN 'needs_info' THEN 2
                   WHEN 'review' THEN 3 WHEN 'todo' THEN 4 WHEN 'backlog' THEN 5
                   WHEN 'done' THEN 6 ELSE 7 END,
                 CASE priority
                   WHEN 'critical' THEN 0 WHEN 'high' THEN 1
                   WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END`,
                { status: args.status }
            );

            // affectedNodes = direct (AFFECTS) + transitive (lockGroup) nodes.
            // The list-comprehension concat `[n IN … WHERE …] + [n IN …]` is not
            // supported by Kuzu, so we collect both lists raw and merge/filter the
            // null placeholders (OPTIONAL no-match) here in JS.
            // Epic-Zugehörigkeit EINMAL für alle Tasks, nicht pro Task eine
            // Abfrage. Muss dasselbe liefern wie die Bridge-Route /api/tasks —
            // zwei Quellen für dieselbe Aussage laufen sonst auseinander.
            const membership = await readEpicMembership(session);
            const result = listResult.records.map(r => {
                const m = membership.get(r.get("taskId"));
                return {
                    taskId: r.get("taskId"),
                    title: r.get("title"),
                    description: r.get("description"),
                    status: r.get("status"),
                    priority: r.get("priority"),
                    category: r.get("category"),
                    createdBy: r.get("createdBy"),
                    assignedTo: r.get("assignedTo"),
                    summary: r.get("summary"),
                    lastComment: r.get("lastComment"),
                    updatedBy: r.get("updatedBy"),
                    epicId: m ? m.epicId : null,
                    epicTitle: m ? m.epicTitle : null,
                    seqIndex: m ? m.seqIndex : null,
                    affectedNodes: [...(r.get("directNodes") || []), ...(r.get("transitiveNodes") || [])]
                        .filter((n: any) => n?.id != null)
                };
            });

            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        });
    },

    get_next_task: async (args, ctx) => {
        args.agentId = args.agentId || ctx.defaultAgentId;
        return withTaskSession(args, ctx, async (session, driver) => {
            let result: any;

            // Find highest-priority todo task
            //
            // Das Tor steht auf 'review', nicht auf 'done': ist der Vorgänger
            // in review, hat der Worker seinen Schritt fertig — die Abnahme ist
            // Menschensache und darf ihn nicht blockieren. Sonst steht die
            // Sequenz still, bis jemand hinschaut.
            //
            // Die zweite Bedingung begrenzt den Vorlauf auf genau einen Schritt:
            // der Vor-Vorgänger muss wirklich 'done' sein. Ohne sie liefe der
            // Worker der Abnahme beliebig weit davon, und eine spaet abgelehnte
            // Arbeit hätte schon drei Nachfolger, die darauf aufbauen.
            const taskResult = await session.run(
                `MATCH (t:Task)
                 WHERE t.status IN ['todo', 'backlog']
                   AND ($epicId IS NULL OR EXISTS { MATCH (e:Epic {taskId: $epicId})-[:FULFILLED_BY]->(t) })
                   AND ($epicId IS NULL OR NOT EXISTS {
                       MATCH (pre:Task)-[:DEPENDS_ON]->(t)
                       WHERE NOT (pre.status IN ['review', 'done'])
                   })
                   AND ($epicId IS NULL OR NOT EXISTS {
                       MATCH (pre2:Task)-[:DEPENDS_ON]->(:Task)-[:DEPENDS_ON]->(t)
                       WHERE pre2.status <> 'done'
                   })
                 RETURN t.taskId AS taskId, t.title AS title, t.description AS description, t.priority AS priority, t.workInstructions AS workInstructions
                 ORDER BY CASE t.status WHEN 'todo' THEN 0 WHEN 'backlog' THEN 1 ELSE 2 END,
                 CASE t.priority
                   WHEN 'critical' THEN 0 WHEN 'high' THEN 1
                   WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END
                 LIMIT 1`,
                { epicId: args.epicId || null }
            );

            if (taskResult.records.length === 0) {
                result = args.epicId
                    ? { status: "EPIC_DONE", epicId: args.epicId, message: "No runnable tasks remain in this epic." }
                    : { status: "NO_TASKS", message: "No todo tasks available." };
            } else {
                const taskId = taskResult.records[0].get("taskId");
                return handlers.claim_task({ ...args, taskId }, ctx);
            }

            // Sync lock manifest after task ops that change locks
            await syncLockManifest(driver);

            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        });
    },

    // NOTE: get_task and plan_task_waves live further down, in the
    // Object.assign(handlers, ...) override block. Do not add copies here.

    add_task_comment: async (args, ctx) => {
        return withTaskSession(args, ctx, async (session) => {
            const author = args.agentId || ctx.defaultAgentId || "agent";
            const text = String(args.text || "").trim();
            if (!text) {
                return { content: [{ type: "text", text: "text required" }], isError: true } as any;
            }
            const { value: comment } = await appendTaskComment(session, args.taskId, { text, author });
            return { content: [{ type: "text", text: JSON.stringify({ status: "OK", comment }, null, 2) }] };
        });
    },

};

// Wave 5 handlers: merged into handlers map at module load
Object.assign(handlers, {
    // ── activate_wave ─────────────────────────────────────────────────────────
    // Sets all tasks in the wave to 'todo' so workers can claim them.
    // Tasks in other inactive waves remain in 'backlog' (not claimable).
    activate_wave: async (args, ctx) => {
        return withTaskSession(args, ctx, async (session, driver) => {
            const waveId = args.waveId;
            if (waveId == null) {
                return { content: [{ type: "text", text: JSON.stringify({ status: "ERROR", error: "waveId is required." }) }], isError: true } as any;
            }

            // Check wave exists
            const countResult = await session.run(
                `MATCH (t:Task {wave: $waveId}) RETURN count(t) AS c`,
                { waveId }
            );
            const taskCount = countResult.records[0]?.get("c")?.toNumber?.() ?? 0;
            if (taskCount === 0) {
                return { content: [{ type: "text", text: JSON.stringify({ status: "NOT_FOUND", error: `No tasks found with wave=${waveId}.` }) }] };
            }

            // Check no other wave is currently active (waveStatus='active')
            const activeCheck = await session.run(
                `MATCH (t:Task) WHERE t.wave IS NOT NULL AND t.wave <> $waveId AND t.waveStatus = 'active'
                 RETURN DISTINCT t.wave AS activeWave LIMIT 1`,
                { waveId }
            );
            if (activeCheck.records.length > 0) {
                const activeWave = activeCheck.records[0].get("activeWave");
                return { content: [{ type: "text", text: JSON.stringify({
                    status: "CONFLICT",
                    error: `Wave ${activeWave} is already active. Complete it before activating wave ${waveId}.`,
                }) }] };
            }

            // Activate: set all backlog/todo tasks in this wave to 'todo' + waveStatus='active'
            const activateResult = await session.run(
                `MATCH (t:Task {wave: $waveId})
                 WHERE t.status IN ['backlog', 'todo', 'needs_info']
                 SET t.status = 'todo', t.waveStatus = 'active', t.updatedAt = timestamp()
                 RETURN count(t) AS activated`,
                { waveId }
            );
            const activatedCount = activateResult.records[0]?.get("activated")?.toNumber?.() ?? 0;

            await syncLockManifest(driver);

            const result = {
                status: "OK",
                waveId,
                activatedTasks: activatedCount,
                totalTasksInWave: taskCount,
                note: `Wave ${waveId} activated. Workers can now claim these ${activatedCount} tasks.`,
            };

            process.stderr.write(`[wave] Wave ${waveId} activated: ${activatedCount} tasks\n`);
            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        });
    },

    // ── complete_wave ─────────────────────────────────────────────────────────
    // Gate-check: only proceeds if ALL tasks in wave are done/review.
    // If all done: triggers commitSyncWave, then auto-activates the next wave.
    // Can be forced by lead (force: true) even if some tasks are blocked.
    complete_wave: async (args, ctx) => {
        return withTaskSession(args, ctx, async (session, driver) => {
            const waveId = args.waveId;
            if (waveId == null) {
                return { content: [{ type: "text", text: JSON.stringify({ status: "ERROR", error: "waveId is required." }) }], isError: true } as any;
            }

            // Count tasks by status
            const statusResult = await session.run(
                `MATCH (t:Task {wave: $waveId})
                 RETURN t.status AS status, count(t) AS c`,
                { waveId }
            );
            const statusCounts: Record<string, number> = {};
            let totalTasks = 0;
            for (const r of statusResult.records) {
                const s = r.get("status") as string;
                const c = r.get("c")?.toNumber?.() ?? 0;
                statusCounts[s] = c;
                totalTasks += c;
            }

            const doneTasks = (statusCounts["done"] || 0) + (statusCounts["review"] || 0);
            if (!statusResult.records.length) {
                return { content: [{ type: 'text', text: JSON.stringify({ status: 'NOT_FOUND', waveId }) }], isError: true };
            }
            const blockedTasks = (statusCounts["blocked"] || 0) + (statusCounts["needs_info"] || 0);
            const inProgressTasks = statusCounts["in_progress"] || 0;

            process.stderr.write(
                `[wave] Wave ${waveId} gate-check: ${doneTasks}/${totalTasks} done, ${blockedTasks} blocked\n`
            );

            const force = args.force === true;
            if (!force && doneTasks < totalTasks) {
                const pendingStatuses = Object.entries(statusCounts)
                    .filter(([s]) => !["done", "review"].includes(s))
                    .map(([s, c]) => `${c} ${s}`)
                    .join(", ");
                return { content: [{ type: "text", text: JSON.stringify({
                    status: "GATE_BLOCKED",
                    waveId,
                    doneTasks,
                    totalTasks,
                    pendingStatuses,
                    hint: inProgressTasks > 0
                        ? `${inProgressTasks} tasks still in_progress. Wait for workers to complete.`
                        : blockedTasks > 0
                        ? `${blockedTasks} tasks blocked/needs_info. Resolve or move them to another wave with move_to_wave.`
                        : "Waiting for tasks to be marked done.",
                    note: "Use force: true to proceed anyway (skips blocked tasks).",
                }) }] };
            }

            // Mark wave as syncing
            await session.run(
                `MATCH (t:Task {wave: $waveId}) SET t.waveStatus = 'syncing'`,
                { waveId }
            );

            process.stderr.write(`[wave] Wave ${waveId} committing, files=[...]\n`);

            // Run commit-sync across all touched files in this wave
            const syncResult = await commitSyncWave(waveId, driver);

            if (syncResult.status === "PARTIAL_FAIL") {
                return { content: [{ type: "text", text: JSON.stringify({
                    status: "SYNC_FAILED",
                    waveId,
                    syncResult,
                    hint: "Wave left in 'syncing' status. Retry with complete_wave or sync_wave.",
                }) }] };
            }

            // Auto-activate the next wave (waveId + 1) if it exists
            const nextWave = waveId + 1;
            const nextWaveCheck = await session.run(
                `MATCH (t:Task {wave: $nextWave}) RETURN count(t) AS c`,
                { nextWave }
            );
            const nextWaveCount = nextWaveCheck.records[0]?.get("c")?.toNumber?.() ?? 0;
            let nextWaveActivated = false;

            if (nextWaveCount > 0) {
                await session.run(
                    `MATCH (t:Task {wave: $nextWave})
                     WHERE t.status IN ['backlog', 'todo', 'needs_info']
                     SET t.status = 'todo', t.waveStatus = 'active', t.updatedAt = timestamp()`,
                    { nextWave }
                );
                nextWaveActivated = true;
                process.stderr.write(`[wave] Wave ${nextWave} auto-activated (${nextWaveCount} tasks)\n`);
            }

            process.stderr.write(`[wave] Wave ${waveId} committed successfully\n`);

            await syncLockManifest(driver);

            return { content: [{ type: "text", text: JSON.stringify({
                status: "OK",
                waveId,
                waveStatus: "committed",
                syncResult,
                nextWave: nextWaveActivated ? { waveId: nextWave, taskCount: nextWaveCount, activated: true } : null,
            }, null, 2) }] };
        });
    },

    // ── move_to_wave ──────────────────────────────────────────────────────────
    // Move a task to a different wave (e.g. if it's blocked in the current wave).
    // Allows the current wave to proceed without the blocked task.
    move_to_wave: async (args, ctx) => {
        return withTaskSession(args, ctx, async (session, driver) => {
            if (!args.taskId || args.newWave == null) {
                return { content: [{ type: "text", text: JSON.stringify({ status: "ERROR", error: "taskId and newWave are required." }) }], isError: true } as any;
            }

            const taskResult = await session.run(
                `MATCH (t:Task {taskId: $taskId})
                 RETURN t.wave AS wave, t.status AS status, t.title AS title`,
                { taskId: args.taskId }
            );
            if (taskResult.records.length === 0) {
                return { content: [{ type: "text", text: JSON.stringify({ status: "NOT_FOUND" }) }] };
            }

            const oldWave = taskResult.records[0].get("wave");
            await session.run(
                `MATCH (t:Task {taskId: $taskId})
                 SET t.wave = $newWave, t.waveStatus = 'pending', t.updatedAt = timestamp()`,
                { taskId: args.taskId, newWave: args.newWave }
            );

            process.stderr.write(
                `[wave] Task ${args.taskId} moved from wave ${oldWave} to wave ${args.newWave}\n`
            );

            await syncLockManifest(driver);
            return { content: [{ type: "text", text: JSON.stringify({
                status: "OK",
                taskId: args.taskId,
                oldWave,
                newWave: args.newWave,
            }, null, 2) }] };
        });
    },

    // ── sync_task ─────────────────────────────────────────────────────────────
    // Run a standalone commit-sync for a task's touched files.
    // Used for tasks with wave=null (hotfixes) or when complete_task needs
    // a full commit-sync rather than just a live-sync.
    sync_task: async (args, ctx) => {
        return withTaskSession(args, ctx, async (session, driver) => {
            if (!args.taskId) {
                return { content: [{ type: "text", text: JSON.stringify({ status: "ERROR", error: "taskId is required." }) }], isError: true } as any;
            }

            const task = await session.run('MATCH (t:Task {taskId:$taskId}) RETURN t.taskId AS taskId', { taskId: args.taskId });
            if (!task.records.length) return { content: [{ type: 'text', text: JSON.stringify({ status: 'NOT_FOUND', taskId: args.taskId }) }], isError: true };
            const affectedFiles = await getSyncFiles(session, { taskId: args.taskId });

            const projectDir = process.env.CODEVIS_PROJECT_DIR || process.cwd();
            const { resolve: pathResolve, extname } = await import("path");

            const results: Record<string, any> = {};
            const failedFiles: string[] = [];
            for (const { file } of affectedFiles) {
                const absolutePath = pathResolve(projectDir, file);
                const ext = extname(file);
                try {
                    const res = await commitSyncFile(absolutePath, file, ext, driver, args.taskId);
                    results[file] = res
                        ? { created: res.created, removed: res.removed, updated: res.updated }
                        : "failed";
                    if (!res) failedFiles.push(file);
                } catch (err: any) {
                    results[file] = { error: err.message };
                    failedFiles.push(file);
                }
            }

            return { content: [{ type: "text", text: JSON.stringify({
                status: failedFiles.length ? "SYNC_FAILED" : "OK",
                taskId: args.taskId,
                syncResults: results,
                failedFiles,
            }, null, 2) }], ...(failedFiles.length ? { isError: true } : {}) };
        });
    },
}); // end Object.assign(handlers, wave5 handlers)

/**
 * LADYBUG: OPTIONAL MATCH und Aggregation über dieselbe Variable gehen nicht
 * zusammen — `MATCH (e:Epic) OPTIONAL MATCH (e)-[:FULFILLED_BY]->(t) RETURN
 * e.title, count(t)` scheitert mit "Variable e is not in scope". Genau daran
 * war list_epics unbenutzbar, während get_epic lief, weil es zwei getrennte
 * Abfragen absetzt. Wer die Abfragen hier wieder zusammenzieht, baut den
 * Fehler zurück.
 *
 * Und: ein Daemon, der vor einer additiven Schema-Revision geöffnet wurde,
 * kennt eine Tabelle noch nicht und antwortet mit einem Binder-Fehler statt mit
 * einer leeren Menge. reconcileSchema legt sie beim nächsten Daemon-Start an.
 */
function isMissingTable(err: any, table: string): boolean {
    return new RegExp(`${table}.*does not exist`, "i").test(String(err && err.message));
}

/**
 * Alle manuellen Reihenfolge-Kanten. kind='derived' bleibt aussen vor — die
 * stammt aus plan_task_waves und ist keine vom Menschen gesetzte Ordnung.
 */
async function manualDeps(session: any): Promise<Array<[string, string]>> {
    try {
        const rows = await session.run(
            `MATCH (a:Task)-[r:DEPENDS_ON]->(b:Task) WHERE r.kind='manual'
             RETURN a.taskId AS from, b.taskId AS to`);
        return rows.records.map((r: any) => [r.get("from"), r.get("to")] as [string, string]);
    } catch (err: any) {
        if (isMissingTable(err, "DEPENDS_ON")) return [];
        throw err;
    }
}

/**
 * Bringt die Mitglieder eines Epics in Ausführungsreihenfolge.
 *
 * Kopf ist das Mitglied ohne manuellen Vorgänger IM SELBEN Epic; eine Kette
 * darf nicht über Epic-Grenzen laufen. Was die Kette nicht erreicht (Zyklus,
 * verwaiste Kante) hängt sortiert hinten dran — eine vollständige Liste mit
 * fragwuerdiger Ordnung ist brauchbarer als eine, in der Tasks fehlen.
 */
function orderMembers(members: string[], deps: Array<[string, string]>): string[] {
    const mine = new Set(members);
    const next = new Map<string, string>();
    const hasPred = new Set<string>();
    for (const [from, to] of deps) {
        if (!mine.has(from) || !mine.has(to)) continue;
        next.set(from, to);
        hasPred.add(to);
    }
    const ordered: string[] = [];
    const seen = new Set<string>();
    for (const head of members.slice().sort().filter((id) => !hasPred.has(id))) {
        let cur: string | undefined = head;
        while (cur && mine.has(cur) && !seen.has(cur)) {
            seen.add(cur);
            ordered.push(cur);
            cur = next.get(cur);
        }
    }
    for (const id of members.slice().sort()) if (!seen.has(id)) { seen.add(id); ordered.push(id); }
    return ordered;
}

/** taskId -> { epicId, epicTitle, seqIndex } für ALLE Tasks auf einmal. */
async function readEpicMembership(session: any) {
    const byTask = new Map<string, { epicId: string; epicTitle: string; seqIndex: number }>();
    let memberRows: any;
    try {
        memberRows = await session.run(
            `MATCH (e:Epic)-[:FULFILLED_BY]->(t:Task)
             RETURN e.taskId AS epicId, e.title AS epicTitle, t.taskId AS taskId`);
    } catch (err: any) {
        if (isMissingTable(err, "FULFILLED_BY")) return byTask;
        throw err;
    }
    const membersOf = new Map<string, { title: string; taskIds: string[] }>();
    for (const r of memberRows.records) {
        const epicId = r.get("epicId");
        if (!membersOf.has(epicId)) membersOf.set(epicId, { title: r.get("epicTitle"), taskIds: [] });
        membersOf.get(epicId)!.taskIds.push(r.get("taskId"));
    }
    if (membersOf.size === 0) return byTask;
    const deps = await manualDeps(session);
    for (const [epicId, { title, taskIds }] of membersOf) {
        orderMembers(taskIds, deps).forEach((id, i) =>
            byTask.set(id, { epicId, epicTitle: title, seqIndex: i + 1 }));
    }
    return byTask;
}

// Epic workflow handlers. Epics use the same single CodeNode table as tasks;
// their semantic label is "Epic" and membership/dependency edges are never
// consulted by lock traversal.
Object.assign(handlers, {
    create_epic: async (args: any, ctx: any) => {
        args.createdBy = args.createdBy || ctx.defaultAgentId || "user";
        if (process.env.CODEVIS_TASK_GATE !== "off") {
            const problems: string[] = taskSpecProblems(args, { subject: "epic" });
            if (problems.length) return { content: [{ type: "text", text: JSON.stringify({
                status: "UNDERSPECIFIED",
                error: "Epic rejected by the specification gate. Fix the following and call create_epic again:",
                problems,
            }) }], isError: true } as any;
        }
        return withTaskSession(args, ctx, async (session) => {
            const epicId = generateWorkItemId('epic');
            await session.run(
                `CREATE (e:Epic {taskId:$epicId, title:$title, description:$description,
                  workInstructions:$workInstructions, status:'backlog', priority:$priority,
                  createdBy:$createdBy, createdAt:timestamp(), updatedAt:timestamp(),
                  updatedBy:$createdBy, summary:null})`,
                { epicId, title: args.title, description: args.description, workInstructions: args.workInstructions,
                  priority: args.priority || "medium", createdBy: args.createdBy }
            );
            return { content: [{ type: "text", text: JSON.stringify({ status: "OK", epicId, title: args.title, statusValue: "backlog" }, null, 2) }] };
        });
    },

    list_epics: async (args: any, ctx: any) => withTaskSession(args, ctx, async (session) => {
        // Zwei Abfragen, gezählt wird in JS — siehe isMissingTable oben.
        const result = await session.run(
            `MATCH (e:Epic)
             RETURN e.taskId AS epicId, e.title AS title, e.description AS description,
                    e.workInstructions AS workInstructions, e.status AS status, e.priority AS priority,
                    e.createdBy AS createdBy, e.createdAt AS createdAt, e.updatedAt AS updatedAt,
                    e.updatedBy AS updatedBy, e.summary AS summary
             ORDER BY e.createdAt`);
        const counts = new Map<string, { total: number; done: number; in_progress: number }>();
        const statuses = new Map<string, string[]>();
        try {
            const memberRows = await session.run(
                `MATCH (e:Epic)-[:FULFILLED_BY]->(t:Task)
                 RETURN e.taskId AS epicId, t.status AS status`);
            for (const r of memberRows.records) {
                const id = r.get("epicId");
                if (!statuses.has(id)) statuses.set(id, []);
                statuses.get(id)!.push(r.get('status'));
                if (!counts.has(id)) counts.set(id, { total: 0, done: 0, in_progress: 0 });
                const c = counts.get(id)!;
                c.total++;
                if (r.get("status") === "done") c.done++;
                else if (r.get("status") === "in_progress") c.in_progress++;
            }
        } catch (err: any) {
            if (!isMissingTable(err, "FULFILLED_BY")) throw err;
        }
        const epics = result.records.map((r: any) => ({
            epicId: r.get("epicId"), title: r.get("title"), description: r.get("description"),
            workInstructions: r.get("workInstructions"), status: deriveEpicStatus(statuses.get(r.get('epicId')) || []),
            storedStatus: r.get('status'), priority: r.get("priority"),
            createdBy: r.get("createdBy"), createdAt: r.get("createdAt"), updatedAt: r.get("updatedAt"),
            updatedBy: r.get("updatedBy"), summary: r.get("summary"),
            progress: counts.get(r.get("epicId")) || { total: 0, done: 0, in_progress: 0 },
        }));
        return { content: [{ type: "text", text: JSON.stringify(epics.filter(epic => !args.status || args.status === 'all' || epic.status === args.status), null, 2) }] };
    }),

    get_epic: async (args: any, ctx: any) => withTaskSession(args, ctx, async (session) => {
        const epicResult = await session.run(
            `MATCH (e:Epic {taskId:$epicId}) RETURN e.taskId AS epicId, e.title AS title,
             e.description AS description, e.workInstructions AS workInstructions, e.status AS status,
             e.priority AS priority, e.createdBy AS createdBy, e.createdAt AS createdAt,
             e.updatedAt AS updatedAt, e.updatedBy AS updatedBy, e.summary AS summary`, { epicId: args.epicId });
        if (!epicResult.records.length) return { content: [{ type: "text", text: `Epic ${args.epicId} not found` }], isError: true } as any;
        const tasksResult = await session.run(
            `MATCH (e:Epic {taskId:$epicId})-[:FULFILLED_BY]->(t:Task)
             OPTIONAL MATCH (pre:Task)-[d:DEPENDS_ON]->(t)
             WHERE EXISTS { MATCH (e)-[:FULFILLED_BY]->(pre) }
             RETURN t.taskId AS taskId, t.title AS title, t.description AS description,
                    t.workInstructions AS workInstructions, t.status AS status, t.priority AS priority,
                    collect(CASE WHEN pre IS NULL THEN null ELSE {from:pre.taskId, to:t.taskId, kind:d.kind} END) AS dependencies`,
            { epicId: args.epicId });
        const er = epicResult.records[0];
        const epic: any = {}; er.keys.forEach((k: string) => { epic[k] = er.get(k); });
        epic.tasks = tasksResult.records.map((r: any) => ({
            taskId: r.get("taskId"), title: r.get("title"), description: r.get("description"),
            workInstructions: r.get("workInstructions"), status: r.get("status"), priority: r.get("priority"),
            dependsOn: (r.get("dependencies") || []).filter(Boolean),
        }));
        epic.dependencies = epic.tasks.flatMap((t: any) => t.dependsOn);
        epic.storedStatus = epic.status;
        epic.status = deriveEpicStatus(epic.tasks.map((t: any) => t.status));
        return { content: [{ type: "text", text: JSON.stringify(epic, null, 2) }] };
    }),

    update_epic: async (args: any, ctx: any) => withTaskSession(args, ctx, async (session) => {
        if (process.env.CODEVIS_TASK_GATE !== 'off') {
            const stored = await session.run(
                'MATCH (e:Epic {taskId:$epicId}) RETURN e.title AS title,e.description AS description,e.workInstructions AS workInstructions',
                { epicId: args.epicId });
            if (!stored.records.length) return { content: [{ type: 'text', text: `Epic ${args.epicId} not found` }], isError: true } as any;
            const row = stored.records[0];
            const problems = taskSpecProblems(mergeTaskSpec({ title: row.get('title'), description: row.get('description'), workInstructions: row.get('workInstructions') }, args), { subject: 'epic' });
            if (problems.length) return { content: [{ type: 'text', text: JSON.stringify({ status: 'UNDERSPECIFIED', problems }) }], isError: true } as any;
        }
        const result = await session.run(
            `MATCH (e:Epic {taskId:$epicId}) SET e.title=COALESCE($title,e.title),
             e.description=COALESCE($description,e.description),
             e.workInstructions=COALESCE($workInstructions,e.workInstructions),
             e.priority=COALESCE($priority,e.priority), e.updatedAt=timestamp(), e.updatedBy=$updatedBy
             RETURN e.taskId AS epicId, e.title AS title, e.description AS description,
                    e.workInstructions AS workInstructions, e.priority AS priority, e.status AS status`,
            { epicId: args.epicId, title: args.title ?? null, description: args.description ?? null,
              workInstructions: args.workInstructions ?? null, priority: args.priority ?? null, updatedBy: ctx.defaultAgentId || "agent" });
        if (!result.records.length) return { content: [{ type: "text", text: `Epic ${args.epicId} not found` }], isError: true } as any;
        const r = result.records[0], out: any = {}; r.keys.forEach((k: string) => { out[k] = r.get(k); });
        return { content: [{ type: "text", text: JSON.stringify({ status: "OK", ...out }, null, 2) }] };
    }),

    add_task_to_epic: async (args: any, ctx: any) => withTaskSession(args, ctx, async (session) => {
        const result = await session.epicMembershipAtomic({ operation: 'add', epicId: args.epicId, taskId: args.taskId, taskIds: args.taskIds });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], ...(result.status === 'OK' ? {} : { isError: true }) };
    }),

    set_epic_task_order: async (args: any, ctx: any) => withTaskSession(args, ctx, async (session) => {
        const result = await session.epicMembershipAtomic({ operation: 'order', epicId: args.epicId, taskId: args.taskId, taskIds: args.taskIds });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], ...(result.status === 'OK' ? {} : { isError: true }) };
    }),

    remove_task_from_epic: async (args: any, ctx: any) => withTaskSession(args, ctx, async (session) => {
        const result = await session.epicMembershipAtomic({ operation: 'remove', epicId: args.epicId, taskId: args.taskId, taskIds: args.taskIds });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], ...(result.status === 'OK' ? {} : { isError: true }) };
    }),
});



const definitions = [
    {
        name: "create_task",
        description: "Lead agent creates a task. Links affected code and, only when locking.enabled=true, plans locks for the affected subgraph. " +
            "The task becomes a :Task node in the graph, linked to code nodes via AFFECTS edges. " +
            "Workers can claim open tasks to begin work. " +
            "SPECIFICATION GATE: tasks must be fully specified or creation is rejected — " +
            "title >= 8 chars, description >= 80 chars (problem + desired outcome + constraints), " +
            "workInstructions >= 50 chars (exact steps + acceptance criteria for the worker).",
        inputSchema: {
            type: "object",
            properties: {
                title: { type: "string", description: "Short task title." },
                description: { type: "string", description: "Detailed task description with acceptance criteria." },
                targetNodes: { type: "array", items: { type: "string" }, description: "Names of code nodes this task affects." },
                targetNodeIds: { type: "array", items: { type: "string" }, description: "Exact elementId strings of affected code nodes." },
                files: { type: "array", items: { type: "string" }, description: "Explicit edit scope: exact project-relative files, including new files. Overrides scope inferred from affected nodes." },
                scopeMode: { type: "string", enum: ["inherit", "open", "strict", "flexible"], description: "Edit mode. Inherit uses the Epic default, or Flexible. Open still respects foreign claims." },
                initialStatus: { type: "string", enum: ["backlog", "todo", "in_progress"], description: "Default todo. in_progress atomically acquires scope; conflicts leave the task in backlog." },
                targetIpv6s: { type: "array", items: { type: "string" }, description: "IPv6 addresses of affected nodes. Alternative to targetNodes." },
                lockDepth: { type: "number", description: "How many hops to lock around each target node. Default: 0 (only the named nodes)." },
                lockEdgeTypes: { type: "array", items: { type: "string" }, description: "Edge types for lock traversal. Default: ['CALLS']." },
                priority: { type: "string", enum: ["critical", "high", "medium", "low"], description: "Task priority. Default: 'medium'." },
                workInstructions: { type: "string", description: "Detailed prompt/instructions for the worker agent. Describes exactly what to do, which tools to use, and acceptance criteria. REQUIRED by the specification gate (>= 50 chars)." },
                knowledgeLinks: { type: "array", items: { type: "string" }, description: "Names of Knowledge nodes to link to this task. Saves separate link_knowledge calls." },
                createdBy: { type: "string", description: "Lead agent ID that creates this task." },
                db: { type: "string", description: "Database: 'project_db' or 'codevis_db'.", enum: ["project_db", "codevis_db"] }
            },
            required: ["title", "description", "createdBy"]
        }
    },
    {
        name: "claim_task",
        description: "Atomically claim a task and its complete file scope. A conflict leaves status, owner and existing claims unchanged.",
        inputSchema: {
            type: "object",
            properties: {
                taskId: { type: "string", description: "Task ID to claim." },
                agentId: { type: "string", description: "Worker agent ID claiming the task." },
                db: { type: "string", description: "Database: 'project_db' or 'codevis_db'.", enum: ["project_db", "codevis_db"] }
            },
            required: ["taskId", "agentId"]
        }
    },
    {
        name: "update_task_status",
        description: "Update a task's status. Can be used by both AI agents and users (via Kanban UI). " +
            "Supports: backlog, todo, in_progress, review, blocked, needs_info, done. " +
            "When set to 'done', locks are automatically released. " +
            "When set to 'needs_info', optionally attach a question for the user.",
        inputSchema: {
            type: "object",
            properties: {
                taskId: { type: "string", description: "Task ID to update." },
                status: { type: "string", enum: ["backlog", "todo", "in_progress", "review", "blocked", "needs_info", "done"], description: "New status." },
                comment: { type: "string", description: "Optional comment (e.g. why blocked, what info is needed, review notes)." },
                agentId: { type: "string", description: "Agent or user making the change." },
                db: { type: "string", description: "Database: 'project_db' or 'codevis_db'.", enum: ["project_db", "codevis_db"] }
            },
            required: ["taskId", "status"]
        }
    },
    {
        name: "complete_task",
        description: "Worker marks a task as reviewed and immediately releases every lock in the task's lock group. Only the user can set 'done'.",
        inputSchema: {
            type: "object",
            properties: {
                taskId: { type: "string", description: "Task ID to complete." },
                agentId: { type: "string", description: "Worker agent ID completing the task." },
                summary: { type: "string", description: "Brief summary of what was done." },
                db: { type: "string", description: "Database: 'project_db' or 'codevis_db'.", enum: ["project_db", "codevis_db"] }
            },
            required: ["taskId", "agentId"]
        }
    },
    {
        name: "list_tasks",
        description: "List all tasks grouped by Kanban status. Returns tasks with their status, priority, assigned agent, and affected nodes.",
        inputSchema: {
            type: "object",
            properties: {
                status: { type: "string", enum: ["backlog", "todo", "in_progress", "review", "blocked", "needs_info", "done", "all"], description: "Filter by status. Default: excludes 'done'. Use 'all' to include done tasks." },
                db: { type: "string", description: "Database: 'project_db' or 'codevis_db'.", enum: ["project_db", "codevis_db"] }
            }
        }
    },
    {
        name: "plan_task_waves",
        description: "Analyzes the CALLS graph between pending tasks and suggests an optimal execution order in waves. " +
            "Tasks with no cross-task dependencies go in Wave 1 (can run in parallel). " +
            "Tasks that depend on Wave 1 outputs go in Wave 2, etc. " +
            "This is a RECOMMENDATION — the lead agent decides the final order. " +
            "Also flags tasks within the same wave that share files (parallel risk). " +
            "Pass commit:true to persist wave assignments, emitWorkflow:true to also write an executable Workflow script.",
        inputSchema: {
            type: "object",
            properties: {
                db: { type: "string", description: "Database: 'project_db' or 'codevis_db'.", enum: ["project_db", "codevis_db"] },
                epicId: { type: "string", description: "Optional epic scope for planning." },
                commit: { type: "boolean", description: "Persist the computed wave assignments onto the Task nodes (t.wave, t.waveStatus='pending')." },
                emitWorkflow: { type: "boolean", description: "Also write the plan as an executable Claude Code Workflow script to .codevis/workflows/. Each wave becomes a barrier; tasks within a wave run in parallel, except tasks sharing a file, which run sequentially. Returns the path in 'workflowScript'." }
            }
        }
    },
    {
        name: "get_next_task",
        description: "Returns the highest-priority todo task with full details including affected nodes and their lock status. Auto-claims the task and locks affected nodes for the requesting agent.",
        inputSchema: {
            type: "object",
            properties: {
                agentId: { type: "string", description: "Agent ID that will be assigned the task." },
                epicId: { type: "string", description: "Optional epic scope; only dependency-ready tasks are considered." },
                db: { type: "string", description: "Database: 'project_db' or 'codevis_db'.", enum: ["project_db", "codevis_db"] }
            },
            required: ["agentId"]
        }
    },
    {
        name: "get_task",
        description: "Fetch a single task by ID with full details: task properties, affected nodes with source code, " +
            "and all linked Knowledge nodes. Replaces the need to call list_tasks (which returns all 80+ tasks) " +
            "just to find one task. Workers should call this right after claim_task to get everything they need.",
        inputSchema: {
            type: "object",
            properties: {
                taskId: { type: "string", description: "Task ID to fetch (e.g. 'task-1234567890')." },
                db: { type: "string", description: "Database: 'project_db' or 'codevis_db'.", enum: ["project_db", "codevis_db"] }
            },
            required: ["taskId"]
        }
    },
    {
        name: "add_task_comment",
        description: "Append a comment to a task. Agents can add comments (e.g. to report progress, ask questions, or request the user to delete/edit earlier comments) but CANNOT edit or delete comments — only the user can do that via the Kanban UI.",
        inputSchema: {
            type: "object",
            properties: {
                taskId: { type: "string", description: "Task ID to comment on." },
                text: { type: "string", description: "Comment text." },
                agentId: { type: "string", description: "Agent ID posting the comment. Defaults to server's agent ID." },
                db: { type: "string", description: "Database: 'project_db' or 'codevis_db'.", enum: ["project_db", "codevis_db"] }
            },
            required: ["taskId", "text"]
        }
    },

    {
        name: "activate_wave",
        description: "Activate a wave: set all tasks in the wave from backlog/todo to 'todo' so workers can claim them. " +
            "Only one wave can be active at a time. Fails if another wave is already active. " +
            "The wave system ensures atomic graph commits between waves.",
        inputSchema: {
            type: "object",
            properties: {
                waveId: { type: "number", description: "Wave number to activate (e.g. 1, 2, 3...)." },
                db: { type: "string", description: "Database: 'project_db' or 'codevis_db'.", enum: ["project_db", "codevis_db"] }
            },
            required: ["waveId"]
        }
    },
    {
        name: "complete_wave",
        description: "Gate-check and commit a wave. " +
            "Fails with GATE_BLOCKED if any tasks are not done/review (unless force: true). " +
            "On success: runs a full commit-sync over all touched files, then auto-activates the next wave. " +
            "Commit-sync creates CREATED/REMOVED edges, updates CALLS, and sets lastSeenMtime. " +
            "If sync partially fails, wave stays in 'syncing' status — retry with complete_wave again.",
        inputSchema: {
            type: "object",
            properties: {
                waveId: { type: "number", description: "Wave number to complete." },
                force: { type: "boolean", description: "If true, proceed even if some tasks are blocked/needs_info (skip them)." },
                db: { type: "string", description: "Database: 'project_db' or 'codevis_db'.", enum: ["project_db", "codevis_db"] }
            },
            required: ["waveId"]
        }
    },
    {
        name: "move_to_wave",
        description: "Move a task to a different wave. " +
            "Use when a blocked task is holding up the current wave — move it to a later wave so the current wave can complete. " +
            "Task keeps its locks; only the wave number changes.",
        inputSchema: {
            type: "object",
            properties: {
                taskId: { type: "string", description: "Task ID to move." },
                newWave: { type: "number", description: "Target wave number (null = standalone/no-wave)." },
                db: { type: "string", description: "Database: 'project_db' or 'codevis_db'.", enum: ["project_db", "codevis_db"] }
            },
            required: ["taskId", "newWave"]
        }
    },
    {
        name: "sync_task",
        description: "Run a full commit-sync for a standalone task (wave=null). " +
            "Creates CREATED/REMOVED edges for new/removed functions, resyncs CALLS edges. " +
            "Call after complete_task for hotfixes or tasks outside the wave system. " +
            "Wave-based tasks are synced automatically by complete_wave.",
        inputSchema: {
            type: "object",
            properties: {
                taskId: { type: "string", description: "Task ID to sync." },
                db: { type: "string", description: "Database: 'project_db' or 'codevis_db'.", enum: ["project_db", "codevis_db"] }
            },
            required: ["taskId"]
        }
    },

];

definitions.push(...([
    { name: "create_epic", description: "Create an Epic after applying the task-style specification gate.", inputSchema: { type: "object", properties: { title: { type: "string" }, description: { type: "string" }, workInstructions: { type: "string" }, priority: { type: "string", enum: ["critical", "high", "medium", "low"] }, createdBy: { type: "string" }, db: { type: "string", enum: ["project_db", "codevis_db"] } }, required: ["title", "description", "workInstructions"] } },
    { name: "list_epics", description: "List epics with total/done/in-progress task counts.", inputSchema: { type: "object", properties: { status: { type: "string" }, db: { type: "string", enum: ["project_db", "codevis_db"] } } } },
    { name: "get_epic", description: "Get an epic, its tasks, and DEPENDS_ON flow edges.", inputSchema: { type: "object", properties: { epicId: { type: "string" }, db: { type: "string", enum: ["project_db", "codevis_db"] } }, required: ["epicId"] } },
    { name: "update_epic", description: "Update editable epic content using patch semantics.", inputSchema: { type: "object", properties: { epicId: { type: "string" }, title: { type: "string" }, description: { type: "string" }, workInstructions: { type: "string" }, priority: { type: "string", enum: ["critical", "high", "medium", "low"] }, db: { type: "string", enum: ["project_db", "codevis_db"] } }, required: ["epicId"] } },
    { name: "add_task_to_epic", description: "Assign a task to an epic, replacing any previous epic membership.", inputSchema: { type: "object", properties: { epicId: { type: "string" }, taskId: { type: "string" }, db: { type: "string", enum: ["project_db", "codevis_db"] } }, required: ["epicId", "taskId"] } },
    { name: "remove_task_from_epic", description: "Remove a task and bridge its in-epic dependency chain with manual edges.", inputSchema: { type: "object", properties: { epicId: { type: "string" }, taskId: { type: "string" }, db: { type: "string", enum: ["project_db", "codevis_db"] } }, required: ["epicId", "taskId"] } },
    { name: "set_epic_task_order", description: "Set the execution order of an epic's tasks. taskIds must list exactly all of its tasks; the manual DEPENDS_ON chain is rewritten to match. This order drives which task get_next_task hands out.", inputSchema: { type: "object", properties: { epicId: { type: "string" }, taskIds: { type: "array", items: { type: "string" } }, db: { type: "string", enum: ["project_db", "codevis_db"] } }, required: ["epicId", "taskIds"] } },
] as any[]));

// ── Wave 5: Override get_task to include createdNodes / removedNodes ──────────
// Also override plan_task_waves to support commit:true (persist wave assignments).
Object.assign(handlers, {

    get_task: async (args: any, ctx: any) => {
        return withTaskSession(args, ctx, async (session: any, _driver: any) => {
            if (!args.taskId) {
                return { content: [{ type: "text", text: JSON.stringify({ status: "ERROR", error: "taskId is required." }) }], isError: true } as any;
            }

            const taskResult = await session.run(
                `MATCH (t:Task {taskId: $taskId})
                 RETURN t.taskId AS taskId, t.title AS title, t.description AS description,
                        t.workInstructions AS workInstructions, t.status AS status,
                        t.priority AS priority, t.category AS category,
                        t.wave AS wave, t.waveStatus AS waveStatus,
                        t.assignedTo AS assignedTo, t.createdBy AS createdBy,
                        t.summary AS summary, t.lastComment AS lastComment,
                        t.updatedBy AS updatedBy, t.comments AS comments`,
                { taskId: args.taskId }
            );

            if (taskResult.records.length === 0) {
                return { content: [{ type: "text", text: JSON.stringify({ status: "NOT_FOUND", error: `Task '${args.taskId}' not found.` }) }] };
            }

            const t = taskResult.records[0];

            // Impact and edit scope are separate: reservations are not impact links.
            const nodesResult = await session.run(
                `MATCH (n) WHERE n.lockGroup = $taskId OR EXISTS {
                    MATCH (t:Task {taskId: $taskId})-[:AFFECTS]->(n)
                 }
                 OPTIONAL MATCH (t:Task {taskId: $taskId})-[a:AFFECTS]->(n)
                 RETURN elementId(n) AS id, coalesce(n.name, n.path, elementId(n)) AS name,
                        n.ipv6 AS ipv6, labels(n) AS labels,
                        coalesce(n.file, n.path) AS file, n.startLine AS startLine, n.endLine AS endLine,
                        n.locked AS locked, n.lockedBy AS lockedBy, n.lockOrigin AS lockOrigin,
                        n.bodySnippet AS bodySnippet,
                        (a IS NOT NULL) AS isDirect`,
                { taskId: args.taskId }
            );

            const scopeResult = await session.run(
                `MATCH (t:Task {taskId:$taskId})-[:RESERVES]->(n)
                 RETURN elementId(n) AS id, coalesce(n.file,n.path) AS file,
                        n.locked AS locked, n.lockedBy AS agentId, n.lockGroup AS ownerTaskId,
                        n.lockExpires AS expires`, { taskId: args.taskId }
            );
            const editScope = scopeResult.records.map((r: any) => ({
                nodeId: r.get("id"), file: r.get("file"),
                active: r.get("locked") === true && Number(r.get("expires")) > Date.now(),
                agentId: r.get("agentId"), ownerTaskId: r.get("ownerTaskId"),
                expires: graphInt(r.get("expires")),
            }));
            const affectedNodes = nodesResult.records.filter((r: any) => !(r.get("labels") || []).includes("TaskScope")).map((r: any) => {
                const file: string | null = r.get("file");
                const startLine: number | null = graphInt(r.get("startLine"));
                const endLine: number | null = graphInt(r.get("endLine"));
                let source: string | null = null;
                if (file && startLine != null && endLine != null) {
                    try {
                        const absolutePath = resolve(TASK_PROJECT_ROOT, file);
                        const lines = readFileSync(absolutePath, "utf-8").split("\n");
                        source = lines.slice(startLine - 1, endLine).join("\n");
                    } catch { source = r.get("bodySnippet") || null; }
                } else {
                    source = r.get("bodySnippet") || null;
                }
                return {
                    id: r.get("id"), name: r.get("name"), ipv6: r.get("ipv6"), labels: r.get("labels"),
                    file, startLine, endLine,
                    locked: r.get("locked") || false,
                    lockedBy: r.get("lockedBy") || null,
                    lockOrigin: r.get("lockOrigin") || null,
                    lockType: r.get("isDirect") ? "direct" : "transitive",
                    source,
                };
            });

            // Created nodes (via CREATED edge from this task — set during commitSyncFile)
            const createdResult = await session.run(
                `MATCH (t:Task {taskId: $taskId})-[:CREATED]->(n)
                 RETURN n.name AS name, n.file AS file, n.ipv6 AS ipv6,
                        n.startLine AS startLine, n.endLine AS endLine`,
                { taskId: args.taskId }
            );
            const createdNodes = createdResult.records.map((r: any) => ({
                name: r.get("name"),
                file: r.get("file"),
                ipv6: r.get("ipv6"),
                startLine: graphInt(r.get("startLine")),
                endLine: graphInt(r.get("endLine")),
            }));

            // Removed nodes (via REMOVED edge from this task — tombstoned during commitSyncFile)
            const removedResult = await session.run(
                `MATCH (t:Task {taskId: $taskId})-[:REMOVED]->(n)
                 RETURN n.name AS name, n.file AS file, n.ipv6 AS ipv6,
                        n.removedAt AS removedAt`,
                { taskId: args.taskId }
            );
            const removedNodes = removedResult.records.map((r: any) => ({
                name: r.get("name"),
                file: r.get("file"),
                ipv6: r.get("ipv6"),
                removedAt: r.get("removedAt"),
            }));

            // Documentary outcome, deliberately separate from AFFECTS/locks.
            const touchedNodes = await getTouchedNodes(session, args.taskId);

            // Linked knowledge
            const knowledgeResult = await session.run(
                `MATCH (k:Knowledge)-[:APPLIES_TO]->(t:Task {taskId: $taskId})
                 RETURN k.name AS name, k.category AS category, k.content AS content
                 UNION
                 MATCH (task:Task {taskId: $taskId})-[:AFFECTS]->(n)
                 MATCH (k:Knowledge)-[:APPLIES_TO]->(n)
                 RETURN k.name AS name, k.category AS category, k.content AS content`,
                { taskId: args.taskId }
            );
            const seen = new Set<string>();
            const linkedKnowledge: Array<{ name: string; category: string; content: string }> = [];
            for (const r of knowledgeResult.records) {
                const name: string = r.get("name");
                if (seen.has(name)) continue;
                seen.add(name);
                linkedKnowledge.push({ name, category: r.get("category"), content: r.get("content") });
            }

            const result = {
                status: "OK",
                taskId: t.get("taskId"),
                title: t.get("title"),
                description: t.get("description"),
                workInstructions: t.get("workInstructions"),
                status_value: t.get("status"),
                priority: t.get("priority"),
                category: t.get("category"),
                wave: t.get("wave"),
                waveStatus: t.get("waveStatus"),
                assignedTo: t.get("assignedTo"),
                createdBy: t.get("createdBy"),
                summary: t.get("summary"),
                lastComment: t.get("lastComment"),
                updatedBy: t.get("updatedBy"),
                comments: (t.get("comments") || []).map((s: string) => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean),
                affectedNodes,
                editScope,
                scopePolicy: await readScopePolicy(session, args.taskId),
                createdNodes,
                removedNodes,
                touchedNodes,
                linkedKnowledge: linkedKnowledge.length > 0 ? linkedKnowledge : [],
                // Was das Diagramm über diesen Code sagt — Struktur, an die
                // sich die Umsetzung halten soll. Leer, wenn keine Spec daran
                // hängt; siehe getSpecContext.
                spec: await getSpecContext(session, args.taskId),
            };

            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        });
    },

    // plan_task_waves: extended to support commit:true (persist wave assignments to graph)
    plan_task_waves: async (args: any, ctx: any) => {
        const dbKey = pickDbName(args, "project_db");
        const driver = pickDbDriver(ctx, args, "project_db");
        const session = driver.session();

        try {
            const tasksResult = await session.run(
                `MATCH (t:Task) WHERE t.status IN ['todo', 'backlog', 'open', 'blocked', 'needs_info']
                 AND ($epicId IS NULL OR EXISTS { MATCH (:Epic {taskId:$epicId})-[:FULFILLED_BY]->(t) })
                 OPTIONAL MATCH (t)-[:AFFECTS|:RESERVES]->(n)
                 RETURN t.taskId AS taskId, t.title AS title, t.priority AS priority, t.status AS status,
                        collect(DISTINCT {name: coalesce(n.name,n.path), file: coalesce(n.file,n.path)}) AS nodes`,
                { epicId: args.epicId || null }
            );

            if (tasksResult.records.length === 0) {
                return { content: [{ type: "text", text: JSON.stringify({ status: "NO_TASKS", message: "No pending tasks to plan." }) }] };
            }

            const tasks: Array<{
                taskId: string; title: string; priority: string; status: string;
                nodes: Array<{name: string; file: string}>;
                dependsOn: Set<string>;
                wave: number;
            }> = [];

            for (const r of tasksResult.records) {
                const nodes = (r.get("nodes") as any[]).filter((n: any) => n.name !== null);
                tasks.push({
                    taskId: r.get("taskId"),
                    title: r.get("title"),
                    priority: r.get("priority") || "medium",
                    status: r.get("status"),
                    nodes,
                    dependsOn: new Set(),
                    wave: 0,
                });
            }

            // Dependency detection via CALLS graph
            for (const task of tasks) {
                for (const node of task.nodes) {
                    if (!node.name) continue;
                    const callsResult = await session.run(
                        `MATCH (f {name: $name, file: $file})-[:CALLS]->(callee)
                         WHERE callee.file <> $file
                         RETURN DISTINCT callee.name AS calleeName, callee.file AS calleeFile`,
                        { name: node.name, file: node.file }
                    );
                    for (const cr of callsResult.records) {
                        const calleeName = cr.get("calleeName");
                        const calleeFile = cr.get("calleeFile");
                        for (const otherTask of tasks) {
                            if (otherTask.taskId === task.taskId) continue;
                            if (otherTask.nodes.some(n => n.name === calleeName && n.file === calleeFile)) {
                                task.dependsOn.add(otherTask.taskId);
                            }
                        }
                    }
                }
            }

            // Manual flow edits are authoritative input to the topological
            // plan. DEPENDS_ON points predecessor -> successor.
            const manualResult = await session.run(
                `MATCH (pre:Task)-[d:DEPENDS_ON]->(next:Task) WHERE d.kind = 'manual'
                 AND pre.taskId IN $taskIds AND next.taskId IN $taskIds
                 RETURN pre.taskId AS predecessor, next.taskId AS successor`,
                { taskIds: tasks.map(t => t.taskId) }
            );
            const byId = new Map(tasks.map(t => [t.taskId, t]));
            for (const r of manualResult.records) byId.get(r.get("successor"))?.dependsOn.add(r.get("predecessor"));

            // Kahn's algorithm: topological sort into waves
            const taskMap = new Map(tasks.map(t => [t.taskId, t]));
            const assigned = new Set<string>();
            let waveNum = 1;
            let remaining = tasks.length;
            while (remaining > 0) {
                const waveMembers: string[] = [];
                for (const task of tasks) {
                    if (assigned.has(task.taskId)) continue;
                    if ([...task.dependsOn].every(dep => assigned.has(dep))) {
                        waveMembers.push(task.taskId);
                    }
                }
                if (waveMembers.length === 0) {
                    return { content: [{ type: 'text', text: JSON.stringify({
                        status: 'CYCLE', error: 'Task dependencies contain a cycle. Resolve it before scheduling these tasks.',
                        blockedTaskIds: tasks.filter(task => !assigned.has(task.taskId)).map(task => task.taskId),
                    }) }], isError: true };
                }
                for (const id of waveMembers) {
                    taskMap.get(id)!.wave = waveNum; assigned.add(id); remaining--;
                }
                waveNum++;
            }

            // Build output grouped by wave
            const waves: Record<number, any[]> = {};
            for (const task of tasks) {
                if (!waves[task.wave]) waves[task.wave] = [];
                const deps = [...task.dependsOn].map(depId => {
                    const dep = taskMap.get(depId);
                    return dep ? `${dep.taskId} (${dep.title})` : depId;
                });
                waves[task.wave].push({
                    taskId: task.taskId, title: task.title,
                    priority: task.priority, status: task.status,
                    targetNodes: task.nodes.map(n => `${n.file}:${n.name}`),
                    dependsOn: deps, canParallel: true,
                });
            }

            // Risk assessment: tasks sharing files within a wave
            for (const [, waveTasks] of Object.entries(waves)) {
                const fileMap: Record<string, string[]> = {};
                for (const t of waveTasks) {
                    for (const node of t.targetNodes) {
                        const file = targetFile(node);
                        if (!fileMap[file]) fileMap[file] = [];
                        if (!fileMap[file].includes(t.taskId)) fileMap[file].push(t.taskId);
                    }
                }
                for (const [file, taskIds] of Object.entries(fileMap)) {
                    if (taskIds.length > 1) {
                        for (const t of waveTasks) {
                            if (taskIds.includes(t.taskId)) {
                                t.canParallel = false;
                                t.sharedFileWarning = `Shares ${file} with task(s): ${taskIds.filter((id: string) => id !== t.taskId).join(", ")}`;
                            }
                        }
                    }
                }
            }

            // ── Persist wave assignments if commit: true ──────────────────────
            // Sets t.wave and t.waveStatus='pending' on each Task node.
            let committed = false;
            if (args.commit === true) {
                // Replanning replaces only machine-derived edges in this scope.
                await session.run(
                    `MATCH (pre:Task)-[d:DEPENDS_ON]->(next:Task)
                     WHERE d.kind = 'derived' AND pre.taskId IN $taskIds AND next.taskId IN $taskIds
                     DELETE d`, { taskIds: tasks.map(t => t.taskId) });
                for (const task of tasks) {
                    for (const predecessor of task.dependsOn) {
                        const isManual = manualResult.records.some((r: any) => r.get("predecessor") === predecessor && r.get("successor") === task.taskId);
                        if (isManual) continue;
                        await session.run(
                            `MATCH (pre:Task {taskId:$predecessor}), (next:Task {taskId:$successor})
                             WHERE NOT EXISTS { MATCH (pre)-[:DEPENDS_ON]->(next) }
                             CREATE (pre)-[:DEPENDS_ON {kind:'derived'}]->(next)`,
                            { predecessor, successor: task.taskId });
                    }
                }
                for (const task of tasks) {
                    await session.run(
                        `MATCH (t:Task {taskId: $taskId})
                         SET t.wave = $wave, t.waveStatus = 'pending', t.updatedAt = timestamp()`,
                        { taskId: task.taskId, wave: task.wave }
                    );
                }
                committed = true;
                process.stderr.write(
                    `[wave] plan_task_waves committed ${tasks.length} tasks across ${Object.keys(waves).length} waves\n`
                );
            }

            const result: Record<string, any> = {
                status: "OK",
                totalTasks: tasks.length,
                totalWaves: Object.keys(waves).length,
                committed,
                recommendation: committed
                    ? `Wave assignments persisted to graph. Use activate_wave(1) to start Wave 1.`
                    : "This is a SUGGESTION. Pass commit: true to persist wave assignments.",
                waves,
            };

            // Optional: write the plan out as an executable Workflow script, so the
            // wave order is enforced by the runtime instead of by an agent
            // remembering it. Failure here must not lose the plan itself — the
            // caller still gets the waves, plus the reason the file was not written.
            if (args.emitWorkflow === true) {
                try {
                    const generatedAt = new Date().toISOString();
                    const script = renderWaveWorkflow(waves, dbKey, generatedAt);
                    const outDir = resolve(TASK_PROJECT_ROOT, ".codevis", "workflows");
                    mkdirSync(outDir, { recursive: true });
                    const outPath = resolve(outDir, `wave-plan-${generatedAt.replace(/[:.]/g, "-")}.mjs`);
                    writeFileSync(outPath, script, "utf-8");
                    result.workflowScript = outPath;
                    result.workflowNote =
                        "Run it with the Workflow tool: Workflow({ scriptPath: '<path>' }). " +
                        "One CodeVis Worker per task, one wave at a time; tasks sharing a file run sequentially. " +
                        "The script is a snapshot — regenerate it after the task set changes.";
                } catch (e: any) {
                    result.workflowError = `Plan computed, but writing the workflow script failed: ${e.message}`;
                }
            }

            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        } finally {
            await session.close();
        }
    },

}); // end Wave 5 get_task / plan_task_waves overrides



definitions.push(...["plan_task_scope", "expand_task_scope"].map(name => ({
    name,
    description: name === "plan_task_scope"
        ? "Add explicit file edit scope before claiming a task. Plans do not reserve ownership. Exact paths may name new files."
        : "Atomically expand a claimed task into free files. A conflict changes no claims and returns immediately. Coordinate a safe checkpoint and explicit handoff; do not retry while holding competing claims.",
    inputSchema: {
        type: "object",
        properties: {
            taskId: { type: "string" },
            agentId: { type: "string" },
            files: { type: "array", items: { type: "string" }, description: "Exact project-relative file paths, including new files. No directory globs." },
            nodeIds: { type: "array", items: { type: "string" }, description: "Exact elementId strings. File-backed nodes reserve their whole file." },
            db: { type: "string", enum: ["project_db", "codevis_db"] },
        },
        required: ["taskId", "agentId"],
    },
})) as any[]);

export const taskTools: ToolModule = { definitions, handlers };

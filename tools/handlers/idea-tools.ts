/**
 * Idea Dump MCP tools.
 *
 * Ideas are lightweight, unspecced fragments that the user drops into the Idea
 * Dump column before they graduate to Tasks. They bypass the Task spec gate
 * deliberately: the whole point is zero-friction capture. Claude reads them,
 * asks follow-up questions in chat, and only then calls promote_idea_to_task
 * with a fully specified title/description/workInstructions.
 *
 * Storage: :Idea nodes in the selected workspace (CodeNode table, label='Idea').
 * The idea text lives in the `content` column (same as Knowledge nodes).
 * The idea's own ID is stored in `taskId` for routing symmetry with tasks.
 * On promotion: a PROMOTED_TO edge links the Idea to the new Task, and the
 * idea's status becomes 'promoted' so the board hides it from the open list.
 */

import type { ServerContext, ToolHandler, ToolModule } from "../lib/graph.js";
import { mcpOk, mcpErr, pickDbDriver } from "../lib/graph.js";
import { createRequire } from "node:module";
const { taskSpecProblems } = createRequire(import.meta.url)("../lib/task-rules.cjs");
const { generateWorkItemId, generateTaskId } = createRequire(import.meta.url)("../lib/task-id.cjs");

// Ideas live beside the code, tasks and epics of the selected workspace.
async function withIdeaSession<T>(
    args: Record<string, any>,
    ctx: ServerContext,
    fn: (session: any) => Promise<T>
): Promise<T> {
    const session = pickDbDriver(ctx, args, "codevis_db").session();
    try {
        return await fn(session);
    } finally {
        await session.close();
    }
}

const ok = mcpOk;
// Hiess als einzige der vier Kopien `fail` statt `err` — der Name bleibt, damit
// die Aufrufstellen unverändert lesen, die Funktion dahinter ist jetzt dieselbe.
const fail = mcpErr;

// Was aus der Idee werden soll, und wie dringend. Beides sind Notizen an der
// Idee — die Umwandlung passiert weiterhin bewusst über promote_idea_to_task.
// Gespeichert auf vorhandenen Spalten: `category` trägt die Intent-Liste
// (kommagetrennt), `priority` die Stufe. Eine eigene Spalte hätte eine
// Migration der CodeNode-Tabelle gekostet, ohne etwas dazuzugewinnen.
const IDEA_INTENTS = ["task", "epic", "knowledge"];
const IDEA_PRIORITIES = ["critical", "high", "medium", "low"];

function normalizeIntent(value: any): string | null {
    if (value == null) return null;
    const list = Array.isArray(value) ? value : String(value).split(",");
    const clean = [...new Set(list
        .map((v: any) => String(v).trim().toLowerCase())
        .filter((v: string) => IDEA_INTENTS.includes(v)))];
    return clean.join(",");   // "" loescht die Auswahl wieder
}

function normalizePriority(value: any): string | null {
    if (value == null) return null;
    const p = String(value).trim().toLowerCase();
    if (p === "") return "";
    return IDEA_PRIORITIES.includes(p) ? p : null;
}

function intentToList(stored: any): string[] {
    if (!stored) return [];
    return String(stored).split(",").map(s => s.trim()).filter(s => IDEA_INTENTS.includes(s));
}

const handlers: Record<string, ToolHandler> = {

    create_idea: async (args, ctx) => {
        const content = String(args.content || "").trim();
        if (!content) return fail("content is required");
        return withIdeaSession(args, ctx, async (session) => {
            const ideaId = generateWorkItemId('idea');
            const createdBy = args.createdBy || ctx.defaultAgentId || "user";
            const intent = normalizeIntent(args.intent) || "";
            const priority = normalizePriority(args.priority) || "";
            await session.run(
                `CREATE (i:Idea {
                    taskId: $ideaId,
                    name: $ideaId,
                    content: $content,
                    status: 'open',
                    createdBy: $createdBy,
                    category: $intent,
                    priority: $priority,
                    createdAt: timestamp(),
                    updatedAt: timestamp()
                })`,
                { ideaId, content, createdBy, intent, priority }
            );
            return ok({ status: "OK", ideaId, content, createdBy, intent: intentToList(intent), priority });
        });
    },

    list_ideas: async (args, ctx) => {
        return withIdeaSession(args, ctx, async (session) => {
            // Default: only open ideas. Pass status='all' to include promoted ones.
            const showAll = args.status === "all";
            const result = await session.run(
                showAll
                    ? `MATCH (i:Idea)
                       RETURN i.taskId AS ideaId, i.content AS content,
                              i.status AS status, i.createdBy AS createdBy,
                              i.category AS intent, i.priority AS priority,
                              i.createdAt AS createdAt
                       ORDER BY i.createdAt`
                    : `MATCH (i:Idea) WHERE i.status = 'open'
                       RETURN i.taskId AS ideaId, i.content AS content,
                              i.status AS status, i.createdBy AS createdBy,
                              i.category AS intent, i.priority AS priority,
                              i.createdAt AS createdAt
                       ORDER BY i.createdAt`
            );
            const ideas = result.records.map((r: any) => ({
                ideaId: r.get("ideaId"),
                content: r.get("content"),
                status: r.get("status"),
                createdBy: r.get("createdBy"),
                // Was daraus werden soll, wie es am Board gesetzt wurde.
                intent: intentToList(r.get("intent")),
                priority: r.get("priority") || "",
            }));
            return ok(ideas);
        });
    },

    update_idea: async (args, ctx) => {
        if (!args.ideaId) return fail("ideaId is required");
        // Teil-Update: Intent oder Prio allein zu ändern ist ein eigener Fall,
        // sonst müsste der Aufrufer den Text mitschicken, den er nicht kennt.
        const content = String(args.content ?? "").trim();
        const intent = normalizeIntent(args.intent);
        const priority = normalizePriority(args.priority);
        if (!content && intent === null && priority === null)
            return fail("content, intent or priority is required");
        return withIdeaSession(args, ctx, async (session) => {
            const result = await session.run(
                `MATCH (i:Idea {taskId: $ideaId})
                 SET i.content = COALESCE($content, i.content),
                     i.category = COALESCE($intent, i.category),
                     i.priority = COALESCE($priority, i.priority),
                     i.updatedAt = timestamp()
                 RETURN i.taskId AS ideaId, i.content AS content,
                        i.category AS intent, i.priority AS priority`,
                { ideaId: args.ideaId, content: content || null, intent, priority }
            );
            if (result.records.length === 0) return fail(`Idea '${args.ideaId}' not found`);
            const r = result.records[0];
            return ok({
                status: "OK",
                ideaId: args.ideaId,
                content: r.get("content"),
                intent: intentToList(r.get("intent")),
                priority: r.get("priority") || "",
            });
        });
    },

    delete_idea: async (args, ctx) => {
        if (!args.ideaId) return fail("ideaId is required");
        return withIdeaSession(args, ctx, async (session) => {
            await session.run(
                `MATCH (i:Idea {taskId: $ideaId}) DETACH DELETE i`,
                { ideaId: args.ideaId }
            );
            return ok({ status: "OK", ideaId: args.ideaId });
        });
    },

    promote_idea_to_task: async (args, ctx) => {
        if (!args.ideaId) return fail("ideaId is required");

        // Apply the spec gate — same thresholds as create_task — so a promotion
        // path cannot be used to bypass the specification requirement.
        if (process.env.CODEVIS_TASK_GATE !== "off") {
            const problems: string[] = taskSpecProblems(args);
            if (problems.length > 0) {
                return { content: [{ type: "text", text: JSON.stringify({
                    status: "UNDERSPECIFIED",
                    error: "Spec gate: flesh out the task description before promoting.",
                    problems,
                }) }], isError: true } as any;
            }
        }

        return withIdeaSession(args, ctx, async (session) => {
            // Confirm idea exists
            const ideaCheck = await session.run(
                `MATCH (i:Idea {taskId: $ideaId})
                 RETURN i.content AS content, i.priority AS priority`,
                { ideaId: args.ideaId }
            );
            if (ideaCheck.records.length === 0) return fail(`Idea '${args.ideaId}' not found`);

            const taskId = generateTaskId();
            const createdBy = args.createdBy || ctx.defaultAgentId || "user";
            // Ohne explizite Angabe erbt der Task die Prio, die am Idea-Zettel
            // steht — sie wurde am Board gesetzt, und sie stillschweigend
            // auf 'medium' zurückzusetzen wäre das Gegenteil davon.
            const priority = normalizePriority(args.priority)
                || normalizePriority(ideaCheck.records[0].get("priority"))
                || "medium";

            // Create the Task node (no locks — this is a backlog entry for the lead
            // to refine further with targetNodes before moving to in_progress).
            const promoted = await session.run(
                `MATCH (i:Idea {taskId: $ideaId}) WHERE i.status = 'open'
                 CREATE (t:Task {
                    taskId: $taskId,
                    title: $title,
                    description: $description,
                    workInstructions: $workInstructions,
                    status: 'backlog',
                    priority: $priority,
                    createdBy: $createdBy,
                    createdAt: timestamp(),
                    assignedTo: null,
                    completedAt: null,
                    summary: null
                })
                 CREATE (i)-[:PROMOTED_TO]->(t)
                 SET i.status = 'promoted', i.updatedAt = timestamp()
                 RETURN t.taskId AS taskId`,
                {
                    ideaId: args.ideaId,
                    taskId,
                    title: args.title,
                    description: args.description,
                    workInstructions: args.workInstructions,
                    priority,
                    createdBy,
                }
            );

            // A retry may arrive after another caller committed the promotion.
            if (!promoted.records.length) {
                const existing = await session.run(
                    `MATCH (i:Idea {taskId: $ideaId})-[:PROMOTED_TO]->(t:Task)
                     RETURN t.taskId AS taskId, t.title AS title, t.priority AS priority`,
                    { ideaId: args.ideaId }
                );
                if (!existing.records.length) return fail(`Idea '${args.ideaId}' is no longer open`);
                const task = existing.records[0];
                return ok({ status: 'OK', ideaId: args.ideaId, taskId: task.get('taskId'),
                    title: task.get('title'), priority: task.get('priority'), alreadyPromoted: true });
            }

            return ok({
                status: "OK",
                ideaId: args.ideaId,
                taskId,
                title: args.title,
                priority,
                note: "Task created in backlog. Add targetNodes with create_task's lock machinery or let the lead refine it.",
            });
        });
    },
};

const definitions = [
    {
        name: "create_idea",
        description:
            "Drop a raw, unspecified idea into the Idea Dump. No title, no acceptance criteria — " +
            "just a sentence or keyword. The idea skips the task spec gate entirely: capture first, " +
            "refine later. Claude reads the dump, asks follow-up questions, and calls " +
            "promote_idea_to_task once the idea is fully understood.",
        inputSchema: {
            type: "object",
            properties: {
                content: { type: "string", description: "The idea text. Can be a single word or a paragraph." },
                createdBy: { type: "string", description: "Author. Defaults to the calling agent." },
                intent: {
                    type: "array",
                    items: { type: "string", enum: ["task", "epic", "knowledge"] },
                    description: "What the idea should become. Multiple allowed. A note, not a conversion — promotion still happens explicitly.",
                },
                priority: { type: "string", enum: ["critical", "high", "medium", "low"], description: "How urgent the idea is. Inherited by promote_idea_to_task." },
            },
            required: ["content"],
        },
    },
    {
        name: "list_ideas",
        description:
            "List ideas from the Idea Dump. By default returns only open (unresolved) ideas. " +
            "Call this when the user says they have ideas to discuss, then weigh them, ask follow-up " +
            "questions, and propose which ones to turn into tasks.",
        inputSchema: {
            type: "object",
            properties: {
                status: {
                    type: "string",
                    enum: ["open", "promoted", "all"],
                    description: "Filter by status. Default: 'open'. 'promoted' shows ideas that became tasks.",
                },
            },
        },
    },
    {
        name: "update_idea",
        description:
            "Edit an idea in-place: its text, what it should become (intent), or its priority. " +
            "Every field is optional except ideaId — pass only what changes.",
        inputSchema: {
            type: "object",
            properties: {
                ideaId: { type: "string", description: "The idea's ID (idea-TIMESTAMP)." },
                content: { type: "string", description: "The new idea text." },
                intent: {
                    type: "array",
                    items: { type: "string", enum: ["task", "epic", "knowledge"] },
                    description: "What the idea should become. Multiple allowed; an empty array clears the choice.",
                },
                priority: { type: "string", enum: ["critical", "high", "medium", "low"], description: "How urgent the idea is." },
            },
            required: ["ideaId"],
        },
    },
    {
        name: "delete_idea",
        description: "Permanently delete an idea. Use when the user decides an idea is not worth keeping.",
        inputSchema: {
            type: "object",
            properties: {
                ideaId: { type: "string", description: "The idea's ID (idea-TIMESTAMP)." },
            },
            required: ["ideaId"],
        },
    },
    {
        name: "promote_idea_to_task",
        description:
            "Graduate a fully-discussed idea into a proper Task in the backlog. " +
            "The idea stays in the graph with status='promoted' and a PROMOTED_TO edge to the new task, " +
            "so the provenance is preserved. The task spec gate applies: " +
            "title >= 8 chars, description >= 80 chars, workInstructions >= 50 chars. " +
            "Call this ONLY after the agent and user have agreed on what the task should do — " +
            "not to turn a raw idea into a task directly.",
        inputSchema: {
            type: "object",
            properties: {
                ideaId: { type: "string", description: "The idea to promote." },
                title: { type: "string", description: "Task title (>= 8 chars)." },
                description: { type: "string", description: "Task description (>= 80 chars)." },
                workInstructions: { type: "string", description: "Exact steps + acceptance criteria (>= 50 chars)." },
                priority: { type: "string", enum: ["critical", "high", "medium", "low"], description: "Task priority. Default: medium." },
                createdBy: { type: "string", description: "Author. Defaults to calling agent." },
            },
            required: ["ideaId", "title", "description", "workInstructions"],
        },
    },
];

export const ideaTools: ToolModule = { definitions, handlers };

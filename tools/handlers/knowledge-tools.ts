import { createRequire } from "module";
import type { ToolHandler, ToolModule } from "../lib/graph.js";
import { pickDbDriver } from "../lib/graph.js";

const { codeTargetPredicate } = createRequire(import.meta.url)("../lib/task-rules.cjs");
const { updateKnowledge, resolveEditableKnowledge } = createRequire(import.meta.url)("../../server/knowledge-edit.cjs");

const handlers: Record<string, ToolHandler> = {
    create_knowledge: async (args, ctx) => {
        const driver = pickDbDriver(ctx, args, "project_db");
        const session = driver.session();

        try {
            const { name, content, category } = args;
            if (!name || !content) {
                return { content: [{ type: "text", text: JSON.stringify({ status: "ERROR", error: "name and content are required." }) }], isError: true } as any;
            }

            // The absence check and CREATE must be one database statement.
            // Separate requests allowed simultaneous upserts to create duplicates.
            const created = args.nodeId ? null : await session.run(
                `OPTIONAL MATCH (existing:Knowledge {name: $name})
                 WITH count(existing) AS matches WHERE matches = 0
                 CREATE (k:Knowledge {
                    name: $name, content: $content, category: $category,
                    createdAt: timestamp()
                 }) RETURN elementId(k) AS nodeId`,
                { name, content, category: category || 'general' }
            );
            if (!created?.records.length) {
                const saved = await updateKnowledge(session, { ...args, category: category || 'general' });
                return { content: [{ type: "text", text: JSON.stringify({
                    status: "UPDATED", message: `Knowledge '${saved.name}' updated.`, ...saved,
                }) }] };
            }

            return { content: [{ type: "text", text: JSON.stringify({
                status: "CREATED",
                message: `Knowledge '${name}' created.`,
                name, category: category || "general",
                nodeId: created.records[0].get('nodeId'),
            }) }] };
        } finally {
            await session.close();
        }
    },

    link_knowledge: async (args, ctx) => {
        const driver = pickDbDriver(ctx, args, "project_db");
        const session = driver.session();

        try {
            const { knowledgeName, targetNodes, taskId } = args;
            if (!knowledgeName && !args.nodeId) {
                return { content: [{ type: "text", text: JSON.stringify({ status: "ERROR", error: "nodeId or knowledgeName is required." }) }], isError: true } as any;
            }
            if (!targetNodes && !taskId) {
                return { content: [{ type: "text", text: JSON.stringify({ status: "ERROR", error: "targetNodes or taskId is required." }) }], isError: true } as any;
            }

            // Resolve once; all writes use exact identity and Markdown links
            // remain authoritative in their source document.
            const knowledge = await resolveEditableKnowledge(session, { nodeId: args.nodeId, name: knowledgeName });
            const knowledgeNodeId = knowledge.nodeId;

            let linked = 0;

            // Count via RETURN instead of summary counters — the Ladybug compat
            // driver returns an empty summary (no counters); a RETURNed count
            // works on both backends.
            const countOf = (result: any) => {
                const c = result.records[0]?.get("c");
                return c && typeof c.toNumber === "function" ? c.toNumber() : (Number(c) || 0);
            };

            // Link to code nodes
            if (targetNodes && Array.isArray(targetNodes)) {
                for (const nodeName of targetNodes) {
                    // Dieselbe Falle wie in create_task: ein File-Knoten trägt
                    // `path`, kein `name`. `n:File` stand als erlaubtes Ziel in
                    // der Bedingung, wurde aber über name gesucht und konnte
                    // deshalb nie treffen. link_knowledge meldete dann 0
                    // verknüpfte Knoten -- richtig gezählt, aber ohne Hinweis
                    // darauf, dass die Zielart selbst nicht erreichbar war.
                    const result = await session.run(
                        `MATCH (k:Knowledge) WHERE elementId(k) = $knowledgeNodeId
                         MATCH (n)
                         WHERE ${codeTargetPredicate("n", "$nodeName")}
                         MERGE (k)-[:APPLIES_TO]->(n)
                         RETURN count(n) AS c`,
                        { knowledgeNodeId, nodeName }
                    );
                    linked += countOf(result);
                }
            }

            // Link to task
            if (taskId) {
                const result = await session.run(
                    `MATCH (k:Knowledge) WHERE elementId(k) = $knowledgeNodeId
                     MATCH (t:Task {taskId: $taskId})
                     MERGE (k)-[:APPLIES_TO]->(t)
                     RETURN count(t) AS c`,
                    { knowledgeNodeId, taskId }
                );
                linked += countOf(result);
            }

            return { content: [{ type: "text", text: JSON.stringify({
                status: "OK",
                message: `Knowledge '${knowledge.name}' linked to ${linked} node(s).`,
                knowledgeName: knowledge.name,
                nodeId: knowledgeNodeId,
                targetNodes: targetNodes || [],
                taskId: taskId || null,
                edgesCreated: linked,
            }) }] };
        } finally {
            await session.close();
        }
    },

    list_knowledge: async (args, ctx) => {
        const driver = pickDbDriver(ctx, args, "project_db");
        const session = driver.session();

        try {
            const result = await session.run(
                `MATCH (k:Knowledge)
                 OPTIONAL MATCH (k)-[:APPLIES_TO]->(n)
                 RETURN elementId(k) AS nodeId, k.name AS name, k.category AS category, k.content AS content,
                        k.kind AS kind, k.sourcePath AS sourcePath,
                        k.createdAt AS createdAt,
                        collect(DISTINCT {id: elementId(n), name: COALESCE(n.name, n.title, n.path, n.taskId), type: labels(n)[0], file: COALESCE(n.file, n.path)}) AS linkedNodes
                 ORDER BY category, name`
            );

            const knowledge = result.records.map(r => {
                const linkedNodes = (r.get("linkedNodes") as any[]).filter((n: any) => n.id != null);
                return {
                    nodeId: r.get('nodeId'), kind: r.get('kind'), sourcePath: r.get('sourcePath'),
                    name: r.get("name"),
                    category: r.get("category"),
                    content: r.get("content"),
                    linkedTo: linkedNodes,
                };
            });

            return { content: [{ type: "text", text: JSON.stringify({
                status: "OK",
                count: knowledge.length,
                knowledge,
            }, null, 2) }] };
        } finally {
            await session.close();
        }
    },

    get_knowledge_for_node: async (args, ctx) => {
        const driver = pickDbDriver(ctx, args, "project_db");
        const session = driver.session();

        try {
            const { nodeName, taskId } = args;
            if (!nodeName && !taskId) {
                return { content: [{ type: "text", text: JSON.stringify({ status: "ERROR", error: "nodeName or taskId is required." }) }], isError: true } as any;
            }

            let query: string;
            let params: Record<string, any>;

            if (taskId) {
                // Get knowledge for a task + all its affected nodes
                query = `
                    MATCH (k:Knowledge)-[:APPLIES_TO]->(t:Task {taskId: $taskId})
                    RETURN elementId(k) AS nodeId, k.name AS name, k.category AS category, k.content AS content
                    UNION
                    MATCH (t:Task {taskId: $taskId})-[:AFFECTS]->(n)
                    MATCH (k:Knowledge)-[:APPLIES_TO]->(n)
                    RETURN elementId(k) AS nodeId, k.name AS name, k.category AS category, k.content AS content`;
                params = { taskId };
            } else {
                // Get knowledge for a specific node
                query = `
                    MATCH (k:Knowledge)-[:APPLIES_TO]->(n)
                    WHERE n.name = $nodeName OR (n:File AND n.path = $nodeName)
                    RETURN elementId(k) AS nodeId, k.name AS name, k.category AS category, k.content AS content`;
                params = { nodeName };
            }

            const result = await session.run(query, params);

            // One Knowledge node may be linked through several affected nodes.
            const seen = new Set<string>();
            const knowledge: Array<{ nodeId: string; name: string; category: string; content: string }> = [];
            for (const r of result.records) {
                const name = r.get("name");
                const nodeId = r.get("nodeId");
                if (seen.has(nodeId)) continue;
                seen.add(nodeId);
                knowledge.push({
                    nodeId, name,
                    category: r.get("category"),
                    content: r.get("content"),
                });
            }

            return { content: [{ type: "text", text: JSON.stringify({
                status: "OK",
                count: knowledge.length,
                knowledge,
            }, null, 2) }] };
        } finally {
            await session.close();
        }
    },
};

const definitions = [
    {
        name: "create_knowledge",
        description: "Create or update a Knowledge node in the graph. Knowledge nodes contain conventions, patterns, " +
            "domain rules, or architectural guidelines that workers need when editing specific code. " +
            "Link them to code nodes via link_knowledge so workers automatically receive relevant context.",
        inputSchema: {
            type: "object",
            properties: {
                nodeId: { type: "string", description: "Exact elementId of an existing Knowledge node to update. Markdown-owned nodes must be edited in their source file." },
                name: { type: "string", description: "Short name for this knowledge (e.g. 'React Patterns', 'Design System', 'Domain Rules')." },
                content: { type: "string", description: "The actual knowledge content — conventions, rules, examples, guidelines." },
                category: { type: "string", enum: ["framework", "architecture", "domain", "design", "testing", "security", "performance", "general"], description: "Category for organization. Default: 'general'." },
                db: { type: "string", description: "Database: 'project_db' or 'codevis_db'.", enum: ["project_db", "codevis_db"] }
            },
            required: ["name", "content"]
        }
    },
    {
        name: "link_knowledge",
        description: "Link a Knowledge node to code nodes (Functions, Classes, Components, Files) or Tasks via APPLIES_TO edges. " +
            "Workers automatically see linked knowledge when they claim a task that affects these nodes.",
        inputSchema: {
            type: "object",
            properties: {
                nodeId: { type: "string", description: "Exact elementId of the Knowledge node to link. Markdown-owned outgoing links must be edited in the source file." },
                knowledgeName: { type: "string", description: "Legacy name lookup; accepted only when unique. Prefer nodeId." },
                targetNodes: { type: "array", items: { type: "string" }, description: "Names of code nodes to link to." },
                taskId: { type: "string", description: "Task ID to link to (optional, in addition to targetNodes)." },
                db: { type: "string", description: "Database: 'project_db' or 'codevis_db'.", enum: ["project_db", "codevis_db"] }
            },
            anyOf: [{ required: ["nodeId"] }, { required: ["knowledgeName"] }]
        }
    },
    {
        name: "list_knowledge",
        description: "List all Knowledge nodes with their linked code nodes and tasks.",
        inputSchema: {
            type: "object",
            properties: {
                db: { type: "string", description: "Database: 'project_db' or 'codevis_db'.", enum: ["project_db", "codevis_db"] }
            }
        }
    },
    {
        name: "get_knowledge_for_node",
        description: "Get all Knowledge that applies to a specific code node or task. " +
            "For tasks: returns knowledge linked to the task AND to all nodes the task affects. " +
            "Workers should call this after claiming a task to get their full context.",
        inputSchema: {
            type: "object",
            properties: {
                nodeName: { type: "string", description: "Code node name or File path to get knowledge for." },
                taskId: { type: "string", description: "Task ID to get knowledge for (includes knowledge for all affected nodes)." },
                db: { type: "string", description: "Database: 'project_db' or 'codevis_db'.", enum: ["project_db", "codevis_db"] }
            }
        }
    },
];

export const knowledgeTools: ToolModule = { definitions, handlers };

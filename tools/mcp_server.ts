import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createRequire } from "module";
// DB backend: embedded Ladybug through the compatibility client,
// der sich den Daemon mit der Bridge teilt. Ein zweites Backend gibt es nicht.
const ladybug: any = createRequire(import.meta.url)("../server/ladybug-driver.cjs");
const { normalizeWorkspaceName, publicWorkspaceName } = createRequire(import.meta.url)("../lib/workspace-names.cjs");
const { isLockingEnabled } = createRequire(import.meta.url)("../lib/locking-config.cjs");
import type { ServerContext, ToolHandler, ToolModule } from "./lib/graph.js";
import { registerCleanupHandlers } from "./lib/file-ops.js";
import { expireStaleLocks } from "./lib/locks.js";
import { logOperation, mcpSessionId } from "./lib/logger.js";

import { resolve } from "path";
import { createHash } from "crypto";

// ── Handler modules ────────────────────────────────────────────
import { queryTools } from "./handlers/query-tools.js";
import { bridgeTools } from "./handlers/bridge-tools.js";
import { lockTools } from "./handlers/lock-tools.js";
import { taskTools } from "./handlers/task-tools.js";
import { editTools } from "./handlers/edit-tools.js";
import { knowledgeTools } from "./handlers/knowledge-tools.js";
import { specTools } from "./handlers/spec-tools.js";
import { diagramTools } from "./handlers/diagram-tools.js";
import { rosTools } from "./handlers/ros-tools.js";
import { ideaTools } from "./handlers/idea-tools.js";
import { impactTools } from "./handlers/impact-tools.js";
import { analysisTools } from "./handlers/analysis-tools.js";
import { annotationTools } from "./handlers/annotation-tools.js";

// ── Setup ──────────────────────────────────────────────────────
registerCleanupHandlers();

const require = createRequire(import.meta.url);
const paths = require("../server/codevis-paths.cjs");

/** Project root: where the user's codevis.config.cjs lives. */
const config = paths.loadConfig();
const workspaceIdentity = {
    mcpSessionId,
    pid: process.pid,
    projectRoot: paths.PROJECT_ROOT,
    dataDir: paths.DATA_DIR,
    daemonPort: paths.DAEMON_PORT,
    bridgePort: paths.BRIDGE_PORT,
    explicitProjectDir: Boolean(process.env.CODEVIS_PROJECT_DIR),
    fingerprint: createHash("sha256")
        .update(`${resolve(paths.PROJECT_ROOT).toLowerCase()}\0${resolve(paths.DATA_DIR).toLowerCase()}`)
        .digest("hex").slice(0, 16),
};

const targetWorkspace = config.workspaces.project_db || config.workspaces.project || config.workspaces.target;
const metaWorkspace = config.workspaces.codevis_db || config.workspaces.codevis || config.workspaces.meta || null;
if (!targetWorkspace) {
    throw new Error("No project workspace configured. Use workspaces.project_db (legacy: project/target).");
}

const targetDriver = ladybug.driver((targetWorkspace.dbUri || targetWorkspace.neo4jUri), ladybug.auth.basic(targetWorkspace.auth.user, targetWorkspace.auth.pass));
const metaDriver = metaWorkspace
    ? ladybug.driver((metaWorkspace.dbUri || metaWorkspace.neo4jUri), ladybug.auth.basic(metaWorkspace.auth.user, metaWorkspace.auth.pass))
    : targetDriver;

const ctx: ServerContext = {
    targetDriver,
    metaDriver,
    targetWorkspace,
    metaWorkspace: metaWorkspace || targetWorkspace,
    lockingEnabled: isLockingEnabled(config),
    defaultAgentId: process.env.CODEVIS_AGENT_ID || undefined,
};

// ── Role-based tool selection ─────────────────────────────────
// CODEVIS_ROLE: "lead" | "worker" | undefined (all tools)
const role = process.env.CODEVIS_ROLE || "";

// Collect ALL definitions and handlers first
const workspaceTools: ToolModule = {
    definitions: [{
        name: "get_workspace_identity",
        description: "Returns the exact project root, data directory, ports, and fingerprint this MCP process is bound to. Call this before trusting analysis when several CodeVis projects or sessions are open.",
        inputSchema: { type: "object", properties: {} },
    }],
    handlers: {
        get_workspace_identity: async () => ({
            content: [{ type: "text", text: JSON.stringify(workspaceIdentity, null, 2) }],
        }),
    },
};

const fullModules = [workspaceTools, queryTools, impactTools, analysisTools, annotationTools, bridgeTools, lockTools, taskTools, editTools, knowledgeTools, specTools, diagramTools, ideaTools, rosTools];
const fullDefs = fullModules.flatMap(m => m.definitions);
const fullHandlers: Record<string, ToolHandler> = Object.assign({}, ...fullModules.map(m => m.handlers));

// Keep role filtering aligned with the complete edit surface. Listing individual
// legacy names in each role silently drifted when edit_code_patch, rewrite,
// move, rename and multi-file editing were added: generated workers could not
// use the tools their own template required, while lead-only servers inherited
// editing capabilities they were meant to omit.
const editToolNames = new Set([
    "edit_function", "edit_code_patch", "insert_code", "rewrite_function",
    "rollback_edit", "move_function", "rename_function", "multi_file_edit",
    "recover_stale_edit",
]);

// Worker tools: what a worker needs
const workerToolNames = new Set([
    // Analysis (always)
    "get_workspace_identity", "project_db", "codevis_db", "tool_db", "meta_db", "predefined_queries", "find_path", "read_function", "impact", "analysis_quality",
    // Reviewable semantic metadata; workers cannot accept/reject proposals.
    "propose_annotation", "list_annotations",
    // Knowledge (read)
    "get_knowledge_for_node", "list_knowledge",
    // Editing
    ...editToolNames,
    // Task lifecycle (own tasks)
    "claim_task", "plan_task_scope", "expand_task_scope", "complete_task", "update_task_status", "list_tasks", "get_next_task", "get_task", "add_task_comment", "sync_task",
    // Locking (own locks + lock/unlock subgraph)
    "check_lock", "list_locks", "extend_locks", "inspect_locked_node", "lock_subgraph", "unlock_subgraph",
    // Node release (request, not approve)
    "release_node", "list_pending_releases",
    // Graph
    "get_runtime_errors",
    // Idea Dump (workers can capture ideas too)
    "create_idea", "list_ideas", "update_idea", "delete_idea", "promote_idea_to_task",
]);

// Lead tools: everything except editing
const leadToolNames = new Set(
    fullDefs.map(d => d.name).filter(n => !editToolNames.has(n))
);

let filteredNames: Set<string>;
if (role === "worker") {
    filteredNames = workerToolNames;
} else if (role === "lead") {
    filteredNames = leadToolNames;
} else {
    filteredNames = new Set(fullDefs.map(d => d.name));
}

// Advertise the clear public names while retaining aliases for older clients.
// Normalize once at the boundary. Handlers receive public names; aliases
// remain an input-compatibility detail only.
const allDefinitions = fullDefs.filter(d => filteredNames.has(d.name)).map((definition) => {
    const clone = structuredClone(definition);
    const db = clone?.inputSchema?.properties?.db;
    if (db) {
        db.enum = ["project_db", "codevis_db", "project", "codevis", "tool", "target", "meta"];
        db.description = "Database: 'project_db' (current repository, default) or 'codevis_db' (CodeVis self-graph). Legacy aliases are accepted.";
    }
    return clone;
});
const allHandlers: Record<string, ToolHandler> = {};
for (const name of filteredNames) {
    if (fullHandlers[name]) allHandlers[name] = logOperation(name, fullHandlers[name]);
}

// ── MCP Server ─────────────────────────────────────────────────
const serverName = role ? `codevis-${role}` : "codevis-graph-mcp";
const server = new Server(
    { name: serverName, version: require("../package.json").version },
    { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: allDefinitions,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const handler = allHandlers[name];
    if (!handler) {
        throw new Error(`Tool not found: ${name}`);
    }
    const args = { ...((request.params.arguments as Record<string, any>) || {}) };
    // Every database-aware MCP operation defaults to the current project. This
    // prevents a missing `db` argument from silently creating work in CodeVis'
    // self-graph. Tools without a db field ignore the extra argument.
    args.db = publicWorkspaceName(normalizeWorkspaceName(args.db, "project_db"));
    const result: any = await handler(args, ctx);
    // Machine-readable provenance on every response. MCP clients that preserve
    // `_meta` can detect a stale process without parsing or altering tool text.
    result._meta = {
        ...(result._meta || {}),
        codevisWorkspace: workspaceIdentity,
    };
    return result;
});

// ── Periodic stale-lock sweep ──────────────────────────────────
// The bridge sweeps too, but only while the dashboard is running. An agent team
// editing code through MCP with no dashboard open would otherwise never reclaim
// a lock left behind by a crashed peer. Running it here ties the sweep to an
// active agent session instead. Disabled for workers (leads own lock lifecycle)
// and when CODEVIS_LOCK_SWEEP_MS=0.
const LOCK_SWEEP_MS = parseInt(process.env.CODEVIS_LOCK_SWEEP_MS || "60000", 10);
function startLockSweep() {
    if (LOCK_SWEEP_MS <= 0 || role === "worker") return;
    const sweep = async () => {
        for (const d of new Set([metaDriver, targetDriver])) {
            const session = d.session();
            try {
                const n = await expireStaleLocks(session);
                if (n > 0) console.error(`[lock-sweep] expired ${n} stale lock(s)`);
            } catch (e: any) {
                console.error(`[lock-sweep] failed: ${e?.message ?? e}`);
            } finally {
                await session.close();
            }
        }
    };
    // unref() so the timer never keeps the process alive on its own.
    setInterval(sweep, LOCK_SWEEP_MS).unref();
}

// ── Start ──────────────────────────────────────────────────────
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    startLockSweep();
    const toolCount = allDefinitions.length;
    console.error(`CodeVis MCP Server running (${role || "full"} mode, ${toolCount} tools) — ${workspaceIdentity.projectRoot} [${workspaceIdentity.fingerprint}]`);
}

main().catch(console.error);

import type { ServerContext, ToolHandler, ToolModule } from "../lib/graph.js";
import { pickDbDriver, mcpOk, mcpErr } from "../lib/graph.js";
import { resolve, dirname, basename, extname } from "path";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { createRequire } from "module";

// All spec DB logic lives in scripts/spec/spec_db.cjs (single source of truth,
// shared with the bridge). These handlers are thin MCP wrappers: read the file,
// call the shared functions, format the MCP envelope.
const require = createRequire(import.meta.url);
const __dirname_spec = dirname(fileURLToPath(import.meta.url));
const specDb = require(resolve(__dirname_spec, "../../scripts/spec/spec_db.cjs"));

const SPEC_PROJECT_ROOT = process.env.CODEVIS_PROJECT_DIR || resolve(__dirname_spec, "../..");

const ok = mcpOk;
const err = mcpErr;
// db resolution, consistent across all spec entry points (MCP, bridge, worker):
//   explicit arg > CODEVIS_SPEC_DB env > 'project'. Public names are preferred;
// Legacy aliases remain accepted at the central MCP compatibility boundary.
// Die Regel selbst steht in tools/lib/graph.ts, damit ROS- und
// Diagramm-Werkzeuge nicht wieder eine eigene Fassung davon führen.
const pickDriver = (ctx: ServerContext, args: Record<string, any>) =>
    pickDbDriver(ctx, args, "project");

const handlers: Record<string, ToolHandler> = {
    import_spec: async (args, ctx) => {
        const file = args.sourceFile || args.file;
        let text: string;
        let specId: string;
        if (typeof args.text === "string" && args.text.trim()) {
            // Inline diagram text (used by the headless build worker).
            text = args.text;
            specId = args.specId || (file ? `spec-${basename(file, extname(file))}` : `spec-inline-${Date.now()}`);
        } else if (file) {
            try {
                text = readFileSync(resolve(SPEC_PROJECT_ROOT, file), "utf8");
            } catch (e: any) {
                return err(`Cannot read '${file}': ${e.message}`);
            }
            specId = args.specId || `spec-${basename(file, extname(file))}`;
        } else {
            return err("Provide either sourceFile (path) or text (inline diagram).");
        }
        const session = pickDriver(ctx, args).session();
        try {
            const r = await specDb.importSpec(session, { text, specId, kind: args.kind, sourceFile: file || specId });
            const needs = r.needsBinding || [];
            return ok({
                status: "IMPORTED", ...r,
                hint: needs.length
                    ? `Confirm bindings for ${needs.join(", ")} via bind_spec before reconcile_spec.`
                    : `All nodes auto-bound. Run reconcile_spec next.`,
            });
        } catch (e: any) {
            return err(e.message);
        } finally {
            await session.close();
        }
    },

    bind_spec: async (args, ctx) => {
        if (!args.specId || !Array.isArray(args.bindings)) {
            return err("specId and bindings:[{alias, target}] are required.");
        }
        const session = pickDriver(ctx, args).session();
        try {
            const results = await specDb.bindSpec(session, args.specId, args.bindings);
            return ok({ status: "OK", specId: args.specId, results });
        } catch (e: any) {
            return err(e.message);
        } finally {
            await session.close();
        }
    },

    reconcile_spec: async (args, ctx) => {
        if (!args.specId) return err("specId is required.");
        const session = pickDriver(ctx, args).session();
        try {
            const r = await specDb.reconcileSpec(session, args.specId, {
                emitTasks: args.emitTasks, priority: args.priority, instructions: args.instructions,
            });
            if (r.error) return err(r.error);
            const s = r.summary || {};
            const hasMissing = (s.missing || 0) + (s.methodMissing || 0) + (s.inheritsMissing || 0)
                + (s.unimplemented || 0) + (s.relationMissing || 0) > 0;
            return ok({
                status: "RECONCILED", ...r,
                hint: r.unbound && r.unbound.length
                    ? `Unbound nodes are NOT errors — bind them via bind_spec: ${r.unbound.join(", ")}`
                    : (hasMissing
                        ? "Missing region → run again with emitTasks:true to create backlog tasks."
                        : "Code conforms to the spec."),
            });
        } catch (e: any) {
            return err(e.message);
        } finally {
            await session.close();
        }
    },
};

const definitions = [
    {
        name: "import_spec",
        description: "Import a PlantUML / WebSequenceDiagrams (.wsd/.puml) diagram into the graph as a spec subgraph. " +
            "Auto-detects SEQUENCE vs CLASS diagrams. Participants/classes are auto-bound to code nodes ONLY on an " +
            "unambiguous exact name match; the rest are reported as needing bind_spec. Idempotent per specId. " +
            "Run bind_spec, then reconcile_spec.",
        inputSchema: {
            type: "object",
            properties: {
                sourceFile: { type: "string", description: "Path to the .wsd/.puml file (relative to the project root)." },
                text: { type: "string", description: "Inline diagram text (alternative to sourceFile)." },
                specId: { type: "string", description: "Optional stable id. Default: 'spec-<filename>'." },
                kind: { type: "string", enum: ["sequence", "class", "usecase", "activity"], description: "Override diagram-type detection." },
                db: { type: "string", enum: ["project_db", "codevis_db"], description: "Workspace: 'project_db' (default) or 'codevis_db'." },
            },
        },
    },
    {
        name: "bind_spec",
        description: "Confirm participant/class → code-node bindings for a spec (the binding layer). " +
            "Each binding maps a diagram node alias to a code node by name or uid. " +
            "Unbound nodes produce no drift — they are surfaced as questions by reconcile_spec.",
        inputSchema: {
            type: "object",
            properties: {
                specId: { type: "string", description: "The spec to bind (from import_spec)." },
                bindings: {
                    type: "array",
                    description: "Bindings to apply.",
                    items: {
                        type: "object",
                        properties: {
                            alias: { type: "string", description: "Participant/class alias in the diagram." },
                            target: { type: "string", description: "Code node name or uid to bind to." },
                        },
                        required: ["alias", "target"],
                    },
                },
                db: { type: "string", enum: ["project_db", "codevis_db"], description: "Workspace: 'project_db' (default) or 'codevis_db'." },
            },
            required: ["specId", "bindings"],
        },
    },
    {
        name: "reconcile_spec",
        description: "Overlay a spec onto the code graph and report three regions (conforms / missing / extra). " +
            "Auto-dispatches by diagram kind: SEQUENCE checks messages against CALLS edges; CLASS checks methods " +
            "against class members (CONTAINS) and inheritance against INHERITS edges. Extra/drift is scoped to bound " +
            "nodes only. With emitTasks:true, creates backlog Tasks for the missing region.",
        inputSchema: {
            type: "object",
            properties: {
                specId: { type: "string", description: "The spec to reconcile." },
                emitTasks: { type: "boolean", description: "Create backlog Tasks for the missing region. Default: false." },
                priority: { type: "string", enum: ["low", "medium", "high"], description: "Priority for emitted tasks. Default: medium." },
                instructions: { type: "string", description: "Architect instructions folded into emitted task workInstructions." },
                db: { type: "string", enum: ["project_db", "codevis_db"], description: "Workspace: 'project_db' (default) or 'codevis_db'." },
            },
            required: ["specId"],
        },
    },
];

export const specTools: ToolModule = { definitions, handlers };

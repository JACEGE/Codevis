import type { ToolHandler, ToolModule } from "../lib/graph.js";
import { pickDbDriver, pickDbName } from "../lib/graph.js";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { analyzeImpactFromSession } = require("../../scripts/impact/impact_reader.cjs");
const paths = require("../../server/codevis-paths.cjs");

const handlers: Record<string, ToolHandler> = {
    impact: async (args, ctx) => {
        const dbName = pickDbName(args, "project_db");
        const workspace = dbName === "codevis_db" ? ctx.metaWorkspace : ctx.targetWorkspace;
        const session = pickDbDriver(ctx, args, "project_db").session();
        try {
            const seed = args.nodeId
                ? { id: String(args.nodeId) }
                : { name: args.name, file: args.file, label: args.label };
            const result = await analyzeImpactFromSession(session, {
                seed,
                profile: args.profile || "balanced",
                ...(args.direction ? { direction: args.direction } : {}),
                ...(args.depth != null ? { depth: Math.max(0, Math.min(8, Number(args.depth))) } : {}),
                relations: Array.isArray(args.relations) && args.relations.length ? args.relations : undefined,
                ...(args.maxNodes != null ? { maxNodes: Math.max(1, Math.min(2000, Number(args.maxNodes))) } : {}),
                ...(args.maxPathsPerNode != null ? { maxPathsPerNode: Math.max(1, Math.min(10, Number(args.maxPathsPerNode))) } : {}),
                projectRoot: paths.PROJECT_ROOT,
                sourceDirs: workspace.sourceDir || [],
                exclude: workspace.exclude || [],
            });
            return { content: [{ type: "text", text: JSON.stringify({ status: "OK", ...result }, null, 2) }] };
        } catch (error: any) {
            const payload = { status: "ERROR", code: error.code || "IMPACT_FAILED", error: error.message,
                candidates: error.candidates || undefined };
            return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], isError: true } as any;
        } finally {
            await session.close();
        }
    },
};

const definitions = [{
    name: "impact",
    description: "Explain the bounded impact radius of one code node. Returns evidence paths, confidence, related tests, tasks, specs and knowledge, plus explicit truncation. Prefer nodeId from elementId(n); a name without file/label may be rejected as ambiguous.",
    inputSchema: {
        type: "object",
        properties: {
            nodeId: { type: "string", description: "Stable elementId of the seed node (preferred)." },
            name: { type: "string", description: "Seed name when nodeId is unavailable." },
            file: { type: "string", description: "File used to disambiguate name." },
            label: { type: "string", description: "Node label used to disambiguate name." },
            profile: { type: "string", enum: ["fast", "balanced", "deep"], description: "Bounded analysis profile. Default: balanced." },
            direction: { type: "string", enum: ["in", "out", "both"], description: "Traversal direction. Default: in (dependants)." },
            depth: { type: "integer", minimum: 0, maximum: 8, description: "Maximum hops. Default: 2." },
            relations: { type: "array", items: { type: "string", pattern: "^[A-Z][A-Z0-9_]*$" }, description: "Optional relationship allow-list." },
            maxNodes: { type: "integer", minimum: 1, maximum: 2000, description: "Explicit result cap. Default: 200." },
            maxPathsPerNode: { type: "integer", minimum: 1, maximum: 10, description: "Shortest evidence paths retained per node. Default: 3." },
            db: { type: "string", enum: ["project_db", "codevis_db"] },
        },
        anyOf: [{ required: ["nodeId"] }, { required: ["name"] }],
    },
}];

export const impactTools: ToolModule = { definitions, handlers };

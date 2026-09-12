import type { ToolHandler, ToolModule } from "../lib/graph.js";
import { mcpErr, mcpOk, pickDbDriver } from "../lib/graph.js";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const annotationDb = require("../../scripts/annotations/annotation_db.cjs");

const handlers: Record<string, ToolHandler> = {
    propose_annotation: async (args, ctx) => {
        const session = pickDbDriver(ctx, args, "project").session();
        try {
            return mcpOk({ status: "OK", annotation: await annotationDb.createAnnotation(session, {
                ...args,
                sourceKind: "llm",
                createdBy: args.createdBy || args.model || ctx.defaultAgentId || "agent",
            }) });
        } catch (error: any) {
            return mcpErr(`${error.code || "ANNOTATION_FAILED"}: ${error.message}`);
        } finally {
            await session.close();
        }
    },

    list_annotations: async (args, ctx) => {
        const session = pickDbDriver(ctx, args, "project").session();
        try {
            return mcpOk({ status: "OK", annotations: await annotationDb.listAnnotations(session, args) });
        } catch (error: any) {
            return mcpErr(`${error.code || "ANNOTATION_FAILED"}: ${error.message}`);
        } finally {
            await session.close();
        }
    },
};

const dbProperty = {
    type: "string",
    enum: ["project_db", "codevis_db"],
    description: "Graph database. Default: project_db.",
};

const definitions = [
    {
        name: "propose_annotation",
        description:
            "Attach a reviewable semantic tag proposal to an exact graph node without changing code-derived " +
            "facts such as CALLS or IMPORTS. Requires evidence and records confidence, weight, model and provenance. " +
            "The proposal remains distinct from human-authored Markdown Knowledge until a user accepts it.",
        inputSchema: {
            type: "object",
            properties: {
                targetNode: { type: "string", description: "Exact target elementId." },
                tag: { type: "string", description: "Lowercase semantic tag, e.g. 'entry-point' or 'domain:billing'." },
                evidence: { type: "string", description: "Concrete graph/code evidence supporting the proposal." },
                confidence: { type: "number", minimum: 0, maximum: 1, description: "How likely the assertion is correct. Default: 0.5." },
                weight: { type: "number", minimum: 0, maximum: 1, description: "How useful/relevant it is for agent context. Default: 0.5." },
                model: { type: "string", description: "Model or annotator implementation that made the proposal." },
                createdBy: { type: "string", description: "Agent identity; defaults to the MCP agent/model." },
                db: dbProperty,
            },
            required: ["targetNode", "tag", "evidence"],
        },
    },
    {
        name: "list_annotations",
        description: "List semantic annotation proposals, optionally for one exact graph node or one review status.",
        inputSchema: {
            type: "object",
            properties: {
                targetNode: { type: "string", description: "Optional exact target elementId." },
                status: { type: "string", enum: ["proposed", "accepted", "rejected"] },
                limit: { type: "number", minimum: 1, maximum: 500 },
                db: dbProperty,
            },
        },
    },
];

export const annotationTools: ToolModule = { definitions, handlers };

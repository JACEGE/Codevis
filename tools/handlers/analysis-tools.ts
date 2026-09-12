import type { ToolHandler, ToolModule } from "../lib/graph.js";
import { pickDbDriver, pickDbName } from "../lib/graph.js";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const paths = require("../../server/codevis-paths.cjs");
const { buildAnalysisQualityReport } = require("../../scripts/parser/analysis_quality_report.cjs");
const { __testing__: { EXTRACTOR_CAPABILITIES } } = require("../../scripts/graph_builder.js");
const handlers: Record<string, ToolHandler> = { analysis_quality: async (args, ctx) => {
    const session = pickDbDriver(ctx, args, "project_db").session();
    const workspace = pickDbName(args, "project_db") === "codevis_db" ? ctx.metaWorkspace : ctx.targetWorkspace;
    try { return { content: [{ type: "text", text: JSON.stringify(await buildAnalysisQualityReport(session, EXTRACTOR_CAPABILITIES, {
        projectRoot: paths.PROJECT_ROOT, sourceDirs: workspace.sourceDir || [], exclude: workspace.exclude || [],
    }), null, 2) }] }; }
    catch (error: any) { return { content: [{ type: "text", text: JSON.stringify({ status: "ERROR", error: error.message }) }], isError: true } as any; }
    finally { await session.close(); }
} };
const definitions = [{ name: "analysis_quality", description: "Report measured internal callsite resolution per language separately from declared extractor capabilities. Percentages do not imply runtime or total parser coverage.", inputSchema: { type: "object", properties: { db: { type: "string", enum: ["project_db", "codevis_db"] } } } }];
export const analysisTools: ToolModule = { definitions, handlers };

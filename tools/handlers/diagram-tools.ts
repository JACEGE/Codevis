import type { ServerContext, ToolHandler, ToolModule } from "../lib/graph.js";
import { pickDbDriver, mcpOk, mcpErr } from "../lib/graph.js";
import { resolve, dirname } from "path";
import { writeFileSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";
import { createRequire } from "module";

// All diagram logic lives in scripts/diagram/ (single source of truth, shared
// with the bridge). These handlers are thin MCP wrappers: call the shared
// functions, format the MCP envelope.
const require = createRequire(import.meta.url);
const __dirname_diagram = dirname(fileURLToPath(import.meta.url));
const classDiagram = require(resolve(__dirname_diagram, "../../scripts/diagram/class_diagram.cjs"));

const DIAGRAM_PROJECT_ROOT = process.env.CODEVIS_PROJECT_DIR || resolve(__dirname_diagram, "../..");

const ok = mcpOk;
const err = mcpErr;
const pickDriver = (ctx: ServerContext, args: Record<string, any>) =>
    pickDbDriver(ctx, args, "tool");

/**
 * Resolve an agent-supplied output path inside the project, or throw.
 *
 * Separators are normalised before the prefix test: `resolve()` returns
 * backslashes on Windows, so a `+ "/"` comparison is always false there and the
 * check silently degrades into "anything goes" or "nothing works" depending on
 * which way it is written.
 */
function resolveInsideProject(relPath: string): string {
    const target = resolve(DIAGRAM_PROJECT_ROOT, relPath);
    const normTarget = target.replace(/\\/g, "/");
    const normRoot = DIAGRAM_PROJECT_ROOT.replace(/\\/g, "/");
    if (normTarget !== normRoot && !normTarget.startsWith(normRoot + "/")) {
        throw new Error(`outFile must stay inside the project: '${relPath}'`);
    }
    return target;
}

const handlers: Record<string, ToolHandler> = {
    generate_class_diagram: async (args, ctx) => {
        const session = pickDriver(ctx, args).session();
        try {
            const r = await classDiagram.generateClassDiagram(session, {
                format: args.format || "plantuml",
                title: args.title || "Class Diagram",
                pathPrefix: args.pathPrefix || null,
                includeMethods: args.includeMethods !== false,
                maxMethods: typeof args.maxMethods === "number" ? args.maxMethods : 12,
                includeUses: args.includeUses !== false,
                includeTests: args.includeTests !== false,
                onlyConnected: args.onlyConnected === true,
            });

            if (r.stats.classes === 0) {
                return ok({
                    status: "EMPTY",
                    stats: r.stats,
                    hint: "No classes in this graph. Either the code is not class-based, the graph was "
                        + "not built yet (`codevis build`), or pathPrefix excluded everything.",
                });
            }

            let savedTo: string | null = null;
            if (args.outFile) {
                let target: string;
                try {
                    target = resolveInsideProject(args.outFile);
                } catch (e: any) {
                    return err(e.message);
                }
                try {
                    mkdirSync(dirname(target), { recursive: true });
                    writeFileSync(target, r.diagram, "utf8");
                    savedTo = args.outFile;
                } catch (e: any) {
                    return err(`Diagram generated but could not be written to '${args.outFile}': ${e.message}`);
                }
            }

            return ok({
                status: "OK",
                stats: r.stats,
                savedTo,
                diagram: r.diagram,
                hint: "PlantUML round-trips: feed it through import_spec + reconcile_spec to track drift "
                    + "between the diagram and the code it came from.",
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
        name: "generate_class_diagram",
        description: "Generate a UML class diagram straight from the code graph — classes with their methods, "
            + "inheritance (including bases that live in a library, drawn as <<external>>), and 'uses' relations "
            + "derived from calls between the classes' methods. Language-agnostic: it reads the graph, not a "
            + "specific parser, so it covers every language the builder understands. Use it to understand a "
            + "codebase's structure without knowing which file holds what. Output is valid PlantUML (round-trips "
            + "through import_spec) or Mermaid (renders in a browser).",
        inputSchema: {
            type: "object",
            properties: {
                format: { type: "string", enum: ["plantuml", "mermaid"], description: "Output format. Default: plantuml." },
                title: { type: "string", description: "Diagram title. Default: 'Class Diagram'." },
                pathPrefix: { type: "string", description: "Only classes under this path prefix (e.g. 'src/core')." },
                includeMethods: { type: "boolean", description: "List methods inside the class boxes. Default: true." },
                maxMethods: { type: "number", description: "Methods shown per class before the rest is summarised. Default: 12." },
                includeUses: { type: "boolean", description: "Draw 'A ..> B : uses' from calls between the classes' methods. Default: true." },
                includeTests: { type: "boolean", description: "Include classes declared in test files. Default: true." },
                onlyConnected: { type: "boolean", description: "Drop classes that have no relation at all. Default: false." },
                outFile: { type: "string", description: "Optional path (relative to the project root) to write the diagram to." },
                db: { type: "string", enum: ["project_db", "codevis_db"], description: "Which graph: 'project_db' (default) or 'codevis_db'." },
            },
        },
    },
];

export const diagramTools: ToolModule = { definitions, handlers };

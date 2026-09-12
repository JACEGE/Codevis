import type { ServerContext, ToolHandler, ToolModule } from "../lib/graph.js";
import { pickDbDriver, mcpOk, mcpErr } from "../lib/graph.js";
import { resolve, dirname } from "path";
import { writeFileSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";
import { createRequire } from "module";

// All ROS graph logic lives in scripts/ros/ (single source of truth, shared
// with the builder and the tests). These handlers are thin MCP wrappers.
const require = createRequire(import.meta.url);
const __dirname_ros = dirname(fileURLToPath(import.meta.url));
const rosDb = require(resolve(__dirname_ros, "../../scripts/ros/ros_db.cjs"));

const ROS_PROJECT_ROOT = process.env.CODEVIS_PROJECT_DIR || resolve(__dirname_ros, "../..");

/**
 * Resolve an agent-supplied output path inside the project, or throw.
 *
 * Without this an `outFile` of `../../../etc/thing` — or any absolute path —
 * wrote wherever it pointed. Separators are normalised first: `resolve()`
 * returns backslashes on Windows, so a `+ "/"` prefix test is always false there
 * and the check degrades into no check at all.
 */
function resolveInsideProject(relPath: string): string {
    const target = resolve(ROS_PROJECT_ROOT, relPath);
    const normTarget = target.replace(/\\/g, "/");
    const normRoot = ROS_PROJECT_ROOT.replace(/\\/g, "/");
    if (normTarget !== normRoot && !normTarget.startsWith(normRoot + "/")) {
        throw new Error(`outFile must stay inside the project: '${relPath}'`);
    }
    return target;
}

const ok = mcpOk;
const err = mcpErr;
const pickDriver = (ctx: ServerContext, args: Record<string, any>) =>
    pickDbDriver(ctx, args, "tool");

const handlers: Record<string, ToolHandler> = {
    generate_ros_diagram: async (args, ctx) => {
        const session = pickDriver(ctx, args).session();
        try {
            const r = await rosDb.generateRosDiagram(session, {
                format: args.format || "plantuml",
                title: args.title,
                pathPrefix: args.pathPrefix || null,
                includeUnowned: args.includeUnowned !== false,
                showInheritance: args.showInheritance !== false,
                onlyConnected: args.onlyConnected === true,
            });

            if (r.stats.rosNodes === 0 && r.stats.edges === 0) {
                return ok({
                    status: "EMPTY",
                    stats: r.stats,
                    hint: "No ROS interfaces in the graph. Run `codevis build` after this change so the "
                        + "ROS extractor has run, and check that the ROS sources are inside a configured sourceDir.",
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
                hint: r.stats.dynamicNames > 0
                    ? `${r.stats.dynamicNames} interface name(s) are computed at runtime and are marked as such in the diagram.`
                    : "Feed this back through import_spec + reconcile_spec to track drift against the code.",
            });
        } catch (e: any) {
            return err(e.message);
        } finally {
            await session.close();
        }
    },

    list_ros_interfaces: async (args, ctx) => {
        const session = pickDriver(ctx, args).session();
        try {
            const model = await rosDb.readRosModel(session, {
                pathPrefix: args.pathPrefix || null,
                includeUnowned: args.includeUnowned !== false,
            });
            const kind = args.kind;
            const interfaces = kind ? model.interfaces.filter((i: any) => i.kind === kind) : model.interfaces;

            // Who talks to what, resolved to names — the question this tool
            // actually gets asked ("who publishes /cmd_vel?").
            const byName = new Map(model.nodes.map((n: any) => [n.id, n.name]));
            const wiring = interfaces.map((i: any) => {
                const mine = model.edges.filter((e: any) => e.iface === i.name);
                return {
                    name: i.name,
                    kind: i.kind,
                    msgType: i.msgType,
                    dynamic: i.dynamic,
                    producers: [...new Set(mine.filter((e: any) => e.direction === "provide").map((e: any) => byName.get(e.nodeId)))],
                    consumers: [...new Set(mine.filter((e: any) => e.direction === "consume").map((e: any) => byName.get(e.nodeId)))],
                };
            });

            return ok({
                status: "OK",
                stats: model.stats,
                nodes: model.nodes.map((n: any) => ({ name: n.name, nodeName: n.nodeName, file: n.file, base: n.base })),
                interfaces: wiring,
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
        name: "generate_ros_diagram",
        description: "Generate a UML class diagram of the ROS 2 architecture straight from the code graph. "
            + "Detects node classes (rclpy/rclcpp Node subclasses) and their publishers, subscribers, services and "
            + "actions, then renders a hybrid diagram: node classes as <<rosnode>> class boxes with typed pub/sub "
            + "methods, and the topics/services/actions they talk over as their own <<topic>>/<<service>>/<<action>> "
            + "boxes in between. Output is valid PlantUML, so it can be fed back through import_spec + reconcile_spec "
            + "to detect drift. Requires a graph built after the ROS extractor landed — run `codevis build` first.",
        inputSchema: {
            type: "object",
            properties: {
                format: { type: "string", enum: ["plantuml", "mermaid"], description: "Output format. Default: plantuml." },
                title: { type: "string", description: "Diagram title. Default: 'ROS 2 Architecture'." },
                pathPrefix: { type: "string", description: "Only include sources under this path prefix (e.g. 'ros2_ws/src')." },
                includeUnowned: { type: "boolean", description: "Include pub/sub found outside a ROS node class (bare functions, files). Default: true." },
                showInheritance: { type: "boolean", description: "Draw the `Node <|-- MyNode` inheritance edges. Default: true." },
                onlyConnected: { type: "boolean", description: "Drop interfaces with a single endpoint (unsubscribed topics). Default: false." },
                outFile: { type: "string", description: "Optional path (relative to the project root) to write the diagram to." },
                db: { type: "string", enum: ["project_db", "codevis_db"], description: "Which graph: 'project_db' (default) or 'codevis_db'." },
            },
        },
    },
    {
        name: "list_ros_interfaces",
        description: "List the ROS 2 topics, services and actions in the graph with their message types and, for each, "
            + "which nodes produce and which consume them. Answers 'who publishes /cmd_vel?' without rendering a diagram.",
        inputSchema: {
            type: "object",
            properties: {
                kind: { type: "string", enum: ["topic", "service", "action"], description: "Restrict to one interface kind." },
                pathPrefix: { type: "string", description: "Only include sources under this path prefix." },
                includeUnowned: { type: "boolean", description: "Include pub/sub found outside a ROS node class. Default: true." },
                db: { type: "string", enum: ["project_db", "codevis_db"], description: "Which graph: 'project_db' (default) or 'codevis_db'." },
            },
        },
    },
];

export const rosTools: ToolModule = { definitions, handlers };

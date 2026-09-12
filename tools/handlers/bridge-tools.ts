import type { ToolHandler, ToolModule } from "../lib/graph.js";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { execFile } from "child_process";
import { promisify } from "util";
import { createRequire } from "module";

const execFileAsync = promisify(execFile);
let isUpdateRunning = false;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
/** Package root (where graph_builder.js lives) */
const PACKAGE_ROOT = resolve(__dirname, "../..");
/** Project root (where the user's codevis.config.js lives) */

/**
 * Where this project's bridge listens.
 *
 * This used to be a hardcoded 'http://localhost:4000'. The bridge does not bind
 * 4000: server/codevis-paths.cjs derives the port from the project path so two
 * projects can serve their dashboards side by side. A bridge started the normal
 * way ('codevis dashboard') was therefore unreachable for get_bridge_config /
 * set_bridge_config, which reported "is the bridge running?" while it was.
 * Reading the port from the same module the bridge binds with means the two
 * cannot drift apart — same reasoning as frontend/src/bridgeUrl.js.
 */
const paths = createRequire(import.meta.url)(
    resolve(PACKAGE_ROOT, "server/codevis-paths.cjs")
);
const { normalizeWorkspaceName } = createRequire(import.meta.url)(
    resolve(PACKAGE_ROOT, "lib/workspace-names.cjs")
);
const BRIDGE_PORT: number = paths.BRIDGE_PORT;
const PROJECT_ROOT: string = paths.PROJECT_ROOT;
const BRIDGE_URL = `http://localhost:${BRIDGE_PORT}`;

const samePath = (a: unknown, b: unknown) => {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const norm = (value: string) => resolve(value).replace(/\\/g, '/').toLowerCase();
    return norm(a) === norm(b);
};

const handlers: Record<string, ToolHandler> = {
    update_graph_smart: async (args, _ctx) => {
        if (isUpdateRunning) {
            return {
                content: [{ type: "text", text: "Error: Graph update is still running. Not finished yet." }],
                isError: true,
            } as any;
        }

        isUpdateRunning = true;
        let target: string;
        try {
            target = normalizeWorkspaceName(args?.target);
        } catch {
            isUpdateRunning = false;
            return {
                content: [{ type: "text", text: "Error: Invalid target. Use 'project_db' or 'codevis_db'." }],
                isError: true,
            } as any;
        }

        if (target === "target") {
            let projectConfig: any;
            try {
                projectConfig = paths.loadConfig();
            } catch (error: any) {
                isUpdateRunning = false;
                return {
                    content: [{ type: "text", text: `Error reading CodeVis configuration: ${error.message}` }],
                    isError: true,
                } as any;
            }
            if (projectConfig.workMode === "planning") {
                isUpdateRunning = false;
                return {
                    content: [{ type: "text", text: "Skipped: this project is in planning mode, so no code graph is built. Switch after code exists with `codevis init code [--source <paths>]`." }],
                };
            }
        }

        // For "meta": run against CodeVis package itself (self-analysis)
        // For "tool": run against the target project (using its config)
        const graphBuilder = resolve(PACKAGE_ROOT, "scripts/graph_builder.js");
        const targetName = target === "meta" ? "meta" : "target";
        const cwd = PROJECT_ROOT;

        try {
            const { stdout, stderr } = await execFileAsync(process.execPath, [graphBuilder, targetName, "diff"], {
                cwd,
                maxBuffer: 1024 * 1024 * 10,
                env: { ...process.env, CODEVIS_PROJECT_DIR: cwd },
            });
            return {
                content: [{ type: "text", text: `Update finished successfully.\n\nSTDOUT:\n${stdout}\n\nSTDERR:\n${stderr}` }],
            };
        } catch (error: any) {
            return {
                content: [{ type: "text", text: `Error executing update: ${error.message}\n${error.stdout ? "STDOUT: " + error.stdout : ""}\n${error.stderr ? "STDERR: " + error.stderr : ""}` }],
                isError: true,
            } as any;
        } finally {
            isUpdateRunning = false;
        }
    },

    get_bridge_config: async (_args, _ctx) => {
        try {
            const [statusRes, pulseRes] = await Promise.all([
                fetch(`${BRIDGE_URL}/api/status`),
                fetch(`${BRIDGE_URL}/api/pulse/status`)
            ]);
            const status = await statusRes.json() as any;
            const pulse = await pulseRes.json() as any;
            if (!samePath(status.projectRoot, paths.PROJECT_ROOT) || !samePath(status.dataDir, paths.DATA_DIR)) {
                return {
                    content: [{ type: "text", text: JSON.stringify({
                        error: "WORKSPACE_MISMATCH",
                        expected: { projectRoot: paths.PROJECT_ROOT, dataDir: paths.DATA_DIR, bridgePort: BRIDGE_PORT },
                        connectedBridge: { projectRoot: status.projectRoot, dataDir: status.dataDir, bridgePort: status.bridgePort, pid: status.pid },
                        fix: "Restart the MCP client/session from the intended project so its .mcp.json is reloaded.",
                    }, null, 2) }],
                    isError: true,
                } as any;
            }
            const result = { ...status, pulseRunning: pulse.running };
            return {
                content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            };
        } catch (error: any) {
            return {
                content: [{ type: "text", text: `Error reading bridge config: ${error.message}. Is the bridge server running on port ${BRIDGE_PORT}? Start it with 'codevis dashboard'.` }],
                isError: true,
            } as any;
        }
    },

    set_bridge_config: async (args, _ctx) => {
        const results: string[] = [];

        try {
            // Switch database
            if (args.activeDb !== undefined) {
                const res = await fetch(`${BRIDGE_URL}/api/switch-db`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ db: args.activeDb })
                });
                const data = await res.json() as any;
                results.push(`DB switched to '${args.activeDb}': ${data.nodes} nodes, ${data.links} links`);
            }

            // Update node limits
            const limitKeys = ['seedLimit', 'funcLimit', 'moduleLimit', 'endpointLimit'];
            if (limitKeys.some(k => args[k] !== undefined)) {
                const body: any = {};
                limitKeys.forEach(k => { if (args[k] !== undefined) body[k] = args[k]; });
                const res = await fetch(`${BRIDGE_URL}/api/config`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body)
                });
                const data = await res.json() as any;
                results.push(`Limits updated: ${JSON.stringify(data.limits)}`);
            }

            // Toggle pulse
            if (args.pulse !== undefined) {
                const endpoint = args.pulse ? 'start' : 'stop';
                await fetch(`${BRIDGE_URL}/api/pulse/${endpoint}`, { method: 'POST' });
                results.push(`Pulse ${args.pulse ? 'started' : 'stopped'}`);
            }

            return {
                content: [{ type: "text", text: results.length > 0 ? results.join('\n') : 'No changes requested.' }],
            };
        } catch (error: any) {
            return {
                content: [{ type: "text", text: `Error setting bridge config: ${error.message}` }],
                isError: true,
            } as any;
        }
    },
};

const definitions = [
    {
        name: "update_graph_smart",
        description: "Smart updates the code graph using only changed files since the last commit. Should be used after code changes.",
        inputSchema: {
            type: "object",
            properties: {
                target: {
                    type: "string",
                    description: "Workspace to update: 'project_db' (default project) or 'codevis_db' (CodeVis itself).",
                    enum: ["project_db", "codevis_db"],
                },
            },
            required: ["target"],
        },
    },
    {
        name: "get_bridge_config",
        description: "Reads the current state of the bridge server: active database, node/link limits, loaded node count, and whether the pulse traffic simulator is running. Use this to understand what is currently being visualized.",
        inputSchema: {
            type: "object",
            properties: {}
        }
    },
    {
        name: "set_bridge_config",
        description: "Updates the bridge server configuration. Can switch the active database, update node limits, or toggle the pulse traffic simulator. Only specify the properties you want to change.",
        inputSchema: {
            type: "object",
            properties: {
                activeDb: {
                    type: "string",
                    description: "Switch the active database: 'project_db' or 'codevis_db'.",
                    enum: ["project_db", "codevis_db"]
                },
                seedLimit: { type: "number", description: "Max cluster seed nodes (1-100)." },
                funcLimit: { type: "number", description: "Max function nodes to load (1-2000)." },
                moduleLimit: { type: "number", description: "Max module nodes to load (0-500)." },
                endpointLimit: { type: "number", description: "Max endpoint nodes to load (0-200)." },
                pulse: {
                    type: "boolean",
                    description: "true = start auto traffic simulation, false = stop it."
                }
            }
        }
    },
];

export const bridgeTools: ToolModule = { definitions, handlers };

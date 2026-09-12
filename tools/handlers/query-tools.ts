import type { ToolHandler, ToolModule } from "../lib/graph.js";
import { mcpErr, mcpOk, pickDbDriver } from "../lib/graph.js";
import { PREDEFINED_QUERIES } from "../lib/queries.js";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { findPath } = require("../../server/pathfinder-route.cjs");
const { assertReadOnlyQuery } = require("../../server/query-security.cjs");

const handlers: Record<string, ToolHandler> = {
    project_db: async (args, ctx) => handlers.tool_db(args, ctx),
    codevis_db: async (args, ctx) => handlers.meta_db(args, ctx),
    tool_db: async (args, ctx) => {
        const { query } = args;
        const driver = ctx.targetDriver;
        const session = driver.session();
        try {
            assertReadOnlyQuery(query);
            const result = await session.runReadOnly(query);
            const records = result.records.map(record => {
                const out: any = {};
                record.keys.forEach(key => {
                    out[key] = record.get(key);
                });
                return out;
            });
            return {
                content: [{ type: "text", text: JSON.stringify(records, null, 2) }],
            };
        } catch (error: any) {
            return {
                content: [{ type: "text", text: `Error executing query: ${error.message}` }],
                isError: true,
            } as any;
        } finally {
            await session.close();
        }
    },

    meta_db: async (args, ctx) => {
        const { query } = args;
        const driver = ctx.metaDriver;
        const session = driver.session();
        try {
            assertReadOnlyQuery(query);
            const result = await session.runReadOnly(query);
            const records = result.records.map(record => {
                const out: any = {};
                record.keys.forEach(key => {
                    out[key] = record.get(key);
                });
                return out;
            });
            return {
                content: [{ type: "text", text: JSON.stringify(records, null, 2) }],
            };
        } catch (error: any) {
            return {
                content: [{ type: "text", text: `Error executing query: ${error.message}` }],
                isError: true,
            } as any;
        } finally {
            await session.close();
        }
    },

    get_runtime_errors: async (args, ctx) => {
        const driver = pickDbDriver(ctx, args, "project_db");
        const session = driver.session();
        try {
            // Ladybug does not accept expressions/parameters in LIMIT. Clamp a
            // numeric value first and interpolate only the resulting integer.
            const requestedLimit = Number(args?.limit ?? 5);
            const limit = Number.isFinite(requestedLimit)
                ? Math.max(1, Math.min(100, Math.floor(requestedLimit)))
                : 5;

            // Query retrieves the node that errored, plus up to 1 level of callers and callees
            const result = await session.run(`
                MATCH (errNode)
                WHERE errNode.lastError IS NOT NULL
                OPTIONAL MATCH (caller)-[:CALLS|RENDERS]->(errNode)
                OPTIONAL MATCH (errNode)-[:CALLS|RENDERS]->(callee)
                RETURN errNode.name AS errored_function,
                       errNode.file AS file,
                       errNode.lastError AS error_message,
                       errNode.lastErrorStack AS stack_trace,
                       errNode.lastErrorTimestamp AS timestamp,
                       collect(DISTINCT caller.name) AS called_by,
                       collect(DISTINCT callee.name) AS calls_to
                ORDER BY timestamp DESC
                LIMIT ${limit}
            `);

            const records = result.records.map(record => {
                const out: any = {};
                record.keys.forEach(key => {
                    out[key] = record.get(key);
                });
                return out;
            });

            return {
                content: [{ type: "text", text: JSON.stringify(records, null, 2) }],
            };
        } catch (error: any) {
            return {
                content: [{ type: "text", text: `Error fetching runtime errors: ${error.message}` }],
                isError: true,
            } as any;
        } finally {
            await session.close();
        }
    },

    predefined_queries: async (_args, _ctx) => {
        return {
            content: [{ type: "text", text: JSON.stringify(PREDEFINED_QUERIES, null, 2) }],
        };
    },

    find_path: async (args, ctx) => {
        const session = pickDbDriver(ctx, args, "project").session();
        try {
            return mcpOk(await findPath(session, args));
        } catch (error: any) {
            return mcpErr(`${error.code || "ROUTE_FAILED"}: ${error.message}`);
        } finally {
            await session.close();
        }
    },
};

const definitions = [
    {
        name: "project_db",
        description: "Executes a read-only Cypher query on the analysed project's database.",
        inputSchema: { type: "object", properties: { query: { type: "string", description: "Cypher query to execute." } }, required: ["query"] },
    },
    {
        name: "codevis_db",
        description: "Executes a read-only Cypher query on CodeVis' protected self-graph database.",
        inputSchema: { type: "object", properties: { query: { type: "string", description: "Cypher query to execute." } }, required: ["query"] },
    },
    {
        name: "tool_db",
        description: "Deprecated alias for project_db. Executes a read-only Cypher query on the analysed project.",
        inputSchema: {
            type: "object",
            properties: {
                query: {
                    type: "string",
                    description: "The Cypher query to execute (e.g. 'MATCH (n) RETURN n LIMIT 10')",
                },
            },
            required: ["query"],
        },
    },
    {
        name: "meta_db",
        description: "Deprecated alias for codevis_db. Queries CodeVis' protected self-graph.",
        inputSchema: {
            type: "object",
            properties: {
                query: {
                    type: "string",
                    description: "The Cypher query to execute on the local CodeVis meta graph.",
                },
            },
            required: ["query"],
        },
    },
    {
        name: "get_runtime_errors",
        description: "Retrieves functions or components that have logged an unhandled error during runtime, including who called them and what they might have called.",
        inputSchema: {
            type: "object",
            properties: {
                limit: {
                    type: "number",
                    description: "Maximum number of recent errors to retrieve. Default is 5."
                },
                db: {
                    type: "string",
                    description: "Database to inspect: project_db or codevis_db.",
                    enum: ["project_db", "codevis_db"]
                }
            }
        }
    },
    {
        name: "predefined_queries",
        description:
            "Returns a catalogue of ready-to-use Cypher queries for common code analysis tasks. " +
            "Use this tool FIRST when you want to analyse the codebase (e.g. find recursion, dead code, duplicates, entry points). " +
            "Pick the matching query by name and execute it with project_db or codevis_db.",
        inputSchema: {
            type: "object",
            properties: {},
        },
    },
    {
        name: "find_path",
        description:
            "Find one or more shortest bounded routes between two exact graph node elementIds. " +
            "Use this for questions such as 'how does A reach Z?'. The result includes ordered nodes, " +
            "actual edge directions, a dashboard-ready subgraph, and NO_PATH when no static route is known.",
        inputSchema: {
            type: "object",
            properties: {
                startNode: { type: "string", description: "Exact elementId of the route start." },
                targetNode: { type: "string", description: "Exact elementId of the route destination." },
                direction: { type: "string", enum: ["out", "in"], description: "out follows callees; in follows callers. Default: out." },
                relations: { type: "array", items: { type: "string", enum: ["CALLS", "CALLS_CONDITIONALLY", "RENDERS"] }, description: "Edges to traverse. Default: CALLS and RENDERS." },
                maxHops: { type: "number", minimum: 1, maximum: 12, description: "Maximum route length. Default: 8." },
                maxPaths: { type: "number", minimum: 1, maximum: 5, description: "Number of equally short alternatives. Default: 1." },
                db: { type: "string", enum: ["project_db", "codevis_db"] },
            },
            required: ["startNode", "targetNode"],
        },
    },
];

export const queryTools: ToolModule = { definitions, handlers };

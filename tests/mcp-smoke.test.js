#!/usr/bin/env node
/**
 * Smoke tests for the MCP server.
 * Starts the server via stdio, verifies tool listing and basic tool calls.
 * Run: node --test tests/mcp-smoke.test.js
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { resolve } = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const net = require("node:net");

const PROJECT_DIR = resolve(__dirname, "..");
const SERVER_SCRIPT = resolve(PROJECT_DIR, "tools/mcp_server.ts");
const TSX_LAUNCHER = resolve(PROJECT_DIR, "lib/tsx-launcher.cjs");

let Client, StdioClientTransport;
let client;
let dataDir, daemonPort;

// Expected tool names — update this list if tools are added/removed
const EXPECTED_TOOLS = [
    "project_db", "codevis_db", "tool_db", "meta_db", "update_graph_smart", "get_runtime_errors",
    "get_workspace_identity", "get_bridge_config", "set_bridge_config", "predefined_queries",
    "lock_subgraph", "unlock_subgraph", "check_lock", "list_locks",
    "inspect_locked_node", "extend_locks", "force_unlock",
    "create_task", "claim_task", "update_task_status", "complete_task",
    "list_tasks", "get_next_task",
    "edit_function", "insert_code", "read_function", "rollback_edit",
];

describe("MCP Server Smoke Tests", () => {
    before(async () => {
        dataDir = fs.mkdtempSync(resolve(os.tmpdir(), 'codevis-mcp-smoke-'));
        daemonPort = await new Promise((resolvePort, reject) => {
            const server = net.createServer();
            server.once('error', reject);
            server.listen(0, '127.0.0.1', () => {
                const port = server.address().port;
                server.close(() => resolvePort(port));
            });
        });
        // Dynamic import for ESM-only MCP SDK
        const clientMod = await import("@modelcontextprotocol/sdk/client/index.js");
        const transportMod = await import("@modelcontextprotocol/sdk/client/stdio.js");
        Client = clientMod.Client;
        StdioClientTransport = transportMod.StdioClientTransport;

        const transport = new StdioClientTransport({
            command: process.execPath,
            args: [TSX_LAUNCHER, SERVER_SCRIPT],
            cwd: PROJECT_DIR,
            env: { ...process.env, CODEVIS_DATA_DIR: dataDir,
                LADYBUG_DAEMON_PORT: String(daemonPort), LADYBUG_PIDFILE: resolve(dataDir, 'daemon.pid') },
        });

        client = new Client({ name: "smoke-test", version: "1.0.0" }, { capabilities: {} });
        await client.connect(transport);
    });

    after(async () => {
        if (client) {
            try { await client.close(); } catch {}
        }
        try {
            await fetch(`http://127.0.0.1:${daemonPort}/shutdown`, {
                method: 'POST', headers: { Connection: 'close' }, signal: AbortSignal.timeout(10000),
            });
        } catch {}
        if (dataDir) await fs.promises.rm(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    });

    it("lists all expected tools", async () => {
        const result = await client.listTools();
        const toolNames = result.tools.map(t => t.name);

        for (const expected of EXPECTED_TOOLS) {
            assert.ok(
                toolNames.includes(expected),
                `Missing tool: ${expected}. Got: ${toolNames.join(", ")}`
            );
        }
        // At least 24 tools (the core set)
        assert.ok(toolNames.length >= EXPECTED_TOOLS.length,
            `Expected at least ${EXPECTED_TOOLS.length} tools, got ${toolNames.length}`);
    });

    it("every tool has a description and inputSchema", async () => {
        const result = await client.listTools();
        for (const tool of result.tools) {
            assert.ok(tool.description, `Tool ${tool.name} has no description`);
            assert.ok(tool.inputSchema, `Tool ${tool.name} has no inputSchema`);
        }
    });

    it("workspace-aware tools expose the public project_db/codevis_db names", async () => {
        const result = await client.listTools();
        for (const name of ["import_spec", "bind_spec", "reconcile_spec", "update_graph_smart"]) {
            const tool = result.tools.find(t => t.name === name);
            assert.ok(tool, `Missing tool: ${name}`);
            const property = name === "update_graph_smart" ? "target" : "db";
            const values = tool.inputSchema?.properties?.[property]?.enum || [];
            assert.ok(values.includes("project_db"), `${name}.${property} must accept project_db`);
            assert.ok(values.includes("codevis_db"), `${name}.${property} must accept codevis_db`);
        }
    });

    it("get_runtime_errors accepts a bounded limit on Ladybug", async () => {
        const result = await client.callTool({
            name: "get_runtime_errors",
            arguments: { db: "project_db", limit: 1 },
        });
        assert.ok(!result.isError, result.content?.[0]?.text || "runtime error query failed");
        assert.doesNotThrow(() => JSON.parse(result.content[0].text));
    });

    it("get_workspace_identity exposes stable project provenance", async () => {
        const result = await client.callTool({ name: "get_workspace_identity", arguments: {} });
        assert.ok(!result.isError, result.content?.[0]?.text);
        const identity = JSON.parse(result.content[0].text);
        assert.ok(identity.projectRoot);
        assert.ok(identity.dataDir);
        assert.match(identity.fingerprint, /^[0-9a-f]{16}$/);
    });

    it("list_locks returns valid response", async () => {
        const result = await client.callTool({
            name: "list_locks",
            arguments: {},
        });
        assert.ok(result.content, "Response should have content");
        assert.ok(Array.isArray(result.content), "Content should be an array");
        assert.equal(result.content[0].type, "text", "Content type should be text");
        // Should be parseable JSON
        const parsed = JSON.parse(result.content[0].text);
        assert.ok(typeof parsed === "object", "Response should be valid JSON object");
    });

    it("Knowledge MCP round-trip exposes and accepts exact identities", async () => {
        const call = async (name, args) => {
            const result = await client.callTool({ name, arguments: { ...args, db: 'project_db' } });
            assert.ok(!result.isError, result.content?.[0]?.text);
            return JSON.parse(result.content[0].text);
        };
        const created = await call('create_knowledge', { name: 'Identity smoke', content: 'Before' });
        assert.equal(typeof created.nodeId, 'string');
        const updated = await call('create_knowledge', { nodeId: created.nodeId, name: 'Identity smoke', content: 'After' });
        assert.equal(updated.nodeId, created.nodeId); assert.equal(updated.content, 'After');
        const task = await call('create_task', {
            title: 'Verify Knowledge identity round trip',
            description: 'Verify that a Knowledge node can be linked by exact identity to this existing task through the MCP protocol.',
            workInstructions: 'Create Knowledge, update it using nodeId, link it to this task, and verify the exact linked identities returned by list_knowledge.',
        });
        const linked = await call('link_knowledge', { nodeId: created.nodeId, taskId: task.taskId });
        assert.equal(linked.edgesCreated, 1);
        const row = (await call('list_knowledge', {})).knowledge.find(item => item.nodeId === created.nodeId);
        assert.equal(row.content, 'After'); assert.equal(row.linkedTo.length, 1);
        assert.equal(row.linkedTo[0].type, 'Task'); assert.equal(typeof row.linkedTo[0].id, 'string');
    });

    it("predefined_queries returns query catalogue", async () => {
        const result = await client.callTool({
            name: "predefined_queries",
            arguments: {},
        });
        assert.ok(result.content, "Response should have content");
        const parsed = JSON.parse(result.content[0].text);
        assert.ok(Array.isArray(parsed), "Predefined queries should be an array");
        assert.ok(parsed.length > 20, `Expected 20+ queries, got ${parsed.length}`);
        // Each query should have name and query fields
        assert.ok(parsed[0].name, "Each query should have a name");
        assert.ok(parsed[0].query, "Each query should have a query field");
    });

    it("meta_db can execute a simple query", async () => {
        const result = await client.callTool({
            name: "meta_db",
            arguments: { query: "RETURN 1 AS value" },
        });
        assert.ok(result.content, "Response should have content");
        assert.ok(!result.isError, result.content[0]?.text);
        const parsed = JSON.parse(result.content[0].text);
        assert.ok(Array.isArray(parsed), "Query result should be an array");
    });
});

#!/usr/bin/env node
/**
 * E2E tests for the critical Lock → Edit → Unlock flow.
 * Tests the full MCP tool chain exactly as agents use it.
 *
 * Runs against the embedded Ladybug DB (no server needed).
 * Run: node --test tests/mcp-e2e.test.js
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { resolve } = require("node:path");
const { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } = require("node:fs");
const net = require("node:net");

const PROJECT_DIR = resolve(__dirname, "..");
const SERVER_SCRIPT = resolve(PROJECT_DIR, "tools/mcp_server.ts");
const TSX_CLI = resolve(PROJECT_DIR, "lib/tsx-launcher.cjs");
const E2E_DATA_DIR = resolve(PROJECT_DIR, "tools/.e2e-data");

// Fixture lives inside tools/ so update_graph_smart indexes it
const FIXTURE_DIR = resolve(PROJECT_DIR, "tools/.e2e-fixtures");
const FIXTURE_FILE = resolve(FIXTURE_DIR, "sample.js");
const FIXTURE_REL = "tools/.e2e-fixtures/sample.js";

const SAMPLE_CODE = `function greet(name) {
  return "Hello, " + name;
}

function farewell(name) {
  return "Goodbye, " + name;
}
`;

let Client, StdioClientTransport;
let client;
let createdTaskId = null;
let fileTaskId = null;
let fileTargetId = null;
let e2eDaemonPort = null;

function freePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const port = server.address().port;
            server.close(() => resolve(port));
        });
    });
}

/** Call an MCP tool and return the parsed JSON response */
async function call(name, args = {}) {
    // 10-minute per-request timeout: update_graph_smart runs a real diff build,
    // which can exceed the MCP SDK's 60s default by a lot on slower machines/CI
    // (first run after many file changes re-parses each changed file).
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 600_000 });
    assert.ok(result.content?.[0]?.text, `${name} returned empty response`);
    const text = result.content[0].text;
    try {
        return JSON.parse(text);
    } catch {
        return { _raw: text };
    }
}

describe("MCP E2E Tests", () => {
    before(async () => {
        // 1. Create fixture file on disk
        mkdirSync(FIXTURE_DIR, { recursive: true });
        writeFileSync(FIXTURE_FILE, SAMPLE_CODE, "utf-8");
        e2eDaemonPort = await freePort();

        // 2. Start MCP server
        const clientMod = await import("@modelcontextprotocol/sdk/client/index.js");
        const transportMod = await import("@modelcontextprotocol/sdk/client/stdio.js");
        Client = clientMod.Client;
        StdioClientTransport = transportMod.StdioClientTransport;

        // Invoke the installed CLI directly. `npx` inserts cmd/npm/tsx wrapper
        // processes on Windows; when a test times out those descendants survive
        // the runner and keep the database open. An isolated data dir also
        // prevents this destructive E2E flow from touching a developer's graph.
        const transport = new StdioClientTransport({
            command: process.execPath,
            args: [TSX_CLI, SERVER_SCRIPT],
            cwd: PROJECT_DIR,
            env: {
                ...process.env,
                CODEVIS_DATA_DIR: E2E_DATA_DIR,
                CODEVIS_TARGET_SRC: FIXTURE_DIR,
                // This suite specifically verifies the opt-in locking flow.
                CODEVIS_LOCKING: "on",
                LADYBUG_DAEMON_PORT: String(e2eDaemonPort),
            },
        });

        client = new Client({ name: "e2e-test", version: "1.0.0" }, { capabilities: {} });
        await client.connect(transport);

        // 3. Clean up stale locks from previous runs
        try { await call("force_unlock", { targetAgentId: "e2e-agent-1", callerAgentId: "lead-e2e" }); } catch {}
        try { await call("force_unlock", { targetAgentId: "e2e-agent-2", callerAgentId: "lead-e2e" }); } catch {}
        try { await call("force_unlock", { targetAgentId: "e2e-lead", callerAgentId: "lead-e2e" }); } catch {}

        // 4. Index fixture into graph via the real pipeline
        await call("update_graph_smart", { target: "project" });

        // 5. Verify fixture was indexed
        const nodes = await call("tool_db", {
            query: `MATCH (f:File {path: '${FIXTURE_REL}'})-[:CONTAINS]->(fn:Function) RETURN fn.name AS name ORDER BY fn.name`,
        });
        assert.ok(
            Array.isArray(nodes) && nodes.length >= 2,
            `Fixture should have 2 functions in graph, got: ${JSON.stringify(nodes)}`
        );
    });

    after(async () => {
        // Cleanup locks
        try { await call("force_unlock", { targetAgentId: "e2e-agent-1", callerAgentId: "lead-e2e" }); } catch {}
        try { await call("force_unlock", { targetAgentId: "e2e-agent-2", callerAgentId: "lead-e2e" }); } catch {}
        try { await call("force_unlock", { targetAgentId: "e2e-lead", callerAgentId: "lead-e2e" }); } catch {}

        if (client) {
            try { await client.close(); } catch {}
        }

        if (e2eDaemonPort) {
            try {
                await fetch(`http://127.0.0.1:${e2eDaemonPort}/shutdown`, { method: "POST", body: "{}" });
                await new Promise((resolve) => setTimeout(resolve, 500));
            } catch { /* daemon may already be gone */ }
        }

        // Remove fixture from disk
        if (existsSync(FIXTURE_DIR)) {
            rmSync(FIXTURE_DIR, { recursive: true, force: true });
        }
        if (existsSync(E2E_DATA_DIR)) {
            rmSync(E2E_DATA_DIR, { recursive: true, force: true });
        }
    });

    // ── Lock → Edit → Unlock ──────────────────────────────────────

    it("lock_subgraph locks a function for an agent", async () => {
        const result = await call("lock_subgraph", {
            nodeName: "greet",
            agentId: "e2e-agent-1",
            depth: 0,
            ttlMs: 60000,
        });
        assert.equal(result.status, "OK", `lock failed: ${JSON.stringify(result)}`);
    });

    it("check_lock confirms the lock owner", async () => {
        const nodes = await call("tool_db", {
            query: `MATCH (fn:Function {name: 'greet', file: '${FIXTURE_REL}'}) RETURN fn.locked AS locked, fn.lockedBy AS lockedBy`,
        });
        assert.ok(Array.isArray(nodes) && nodes.length > 0);
        assert.equal(nodes[0].locked, true);
        assert.equal(nodes[0].lockedBy, "e2e-agent-1");
    });

    it("list_locks includes the active lock", async () => {
        const result = await call("list_locks", {});
        assert.ok(Array.isArray(result));
        const ours = result.filter(l => l.agentId === "e2e-agent-1");
        assert.ok(ours.length > 0, "Should list our lock group");
        assert.ok(ours[0].nodeCount >= 1, "Lock group should contain at least 1 node");
    });

    it("read_function returns the current code from disk", async () => {
        const result = await call("read_function", {
            file: FIXTURE_REL,
            functionName: "greet",
        });
        const text = JSON.stringify(result);
        assert.ok(text.includes("Hello"), `read_function should contain 'Hello', got: ${text}`);
    });

    it("edit_function replaces the function body (authorized agent)", async () => {
        const newBody = `function greet(name) {\n  return "Hi, " + name + "!";\n}`;
        const result = await call("edit_function", {
            file: FIXTURE_REL,
            functionName: "greet",
            newBody,
            agentId: "e2e-agent-1",
        });
        assert.equal(result.status, "OK", `edit failed: ${JSON.stringify(result)}`);

        // Verify disk change
        const content = readFileSync(FIXTURE_FILE, "utf-8");
        assert.ok(content.includes("Hi, "), "File should contain new greeting");
        assert.ok(!content.includes('"Hello, "'), "Old greeting should be gone");
        assert.ok(content.includes("Goodbye"), "farewell function should be intact");
    });

    it("edit_function rejects a different agent", async () => {
        const result = await call("edit_function", {
            file: FIXTURE_REL,
            functionName: "greet",
            newBody: `function greet() { return "hacked"; }`,
            agentId: "rogue-agent",
        });
        assert.ok(
            result.status === "LOCKED_BY_OTHER" || result.error,
            `Should reject rogue agent, got: ${JSON.stringify(result)}`
        );
        const content = readFileSync(FIXTURE_FILE, "utf-8");
        assert.ok(content.includes("Hi, "), "File should still have authorized edit");
    });

    it("graph was synced after edit (function still in graph)", async () => {
        const nodes = await call("tool_db", {
            query: `MATCH (fn:Function {name: 'greet', file: '${FIXTURE_REL}'}) RETURN fn.startLine AS startLine, fn.endLine AS endLine`,
        });
        assert.ok(Array.isArray(nodes) && nodes.length > 0, "greet should still exist in graph after edit");
    });

    it("unlock_subgraph releases the lock", async () => {
        const result = await call("unlock_subgraph", { agentId: "e2e-agent-1" });
        assert.equal(result.status, "OK");
        assert.ok(result.unlockedCount >= 1, "Should have unlocked at least 1 node");
    });

    it("check_lock confirms function is unlocked", async () => {
        const nodes = await call("tool_db", {
            query: `MATCH (fn:Function {name: 'greet', file: '${FIXTURE_REL}'}) RETURN fn.locked AS locked`,
        });
        assert.ok(Array.isArray(nodes) && nodes.length > 0);
        assert.ok(!nodes[0].locked, "greet should be unlocked");
    });

    // ── Task Create → Claim → Complete ────────────────────────────

    it("create_task creates a task targeting farewell", async () => {
        // Payload satisfies the create_task specification gate
        // (title >= 8, description >= 80, workInstructions >= 50 chars).
        const result = await call("create_task", {
            title: "E2E: Refactor farewell",
            description: "E2E validation task: the farewell function in the test fixture should return a different greeting. " +
                "This exercises the full task lifecycle (create, claim, complete, done) including lock transitions.",
            workInstructions: "Edit the farewell function in tools/.e2e-fixtures/sample.js so it returns 'See you later, ' + name. " +
                "Acceptance: read_function shows the new body and the graph still contains the farewell node.",
            targetNodes: ["farewell"],
            lockDepth: 0,
            priority: "low",
            createdBy: "lead-e2e",
        });
        assert.equal(result.status, "OK", `create_task failed: ${JSON.stringify(result)}`);
        assert.ok(result.taskId, "Should return a taskId");
        createdTaskId = result.taskId;
    });

    // Eine Datei als Ziel war der stille Ausfall: das Praedikat listete n:File
    // als erlaubt und verglich trotzdem n.name — ein File-Knoten trägt aber
    // nur `path`. create_task meldete OK, die AFFECTS-Kante entstand nie, und
    // niemand bekam eine Fehlermeldung. Gemessen an einem echten Graphen:
    // 37 File-Knoten, 0 mit name.
    it("eine Datei als Ziel bekommt ihre AFFECTS-Kante", async () => {
        const result = await call("create_task", {
            title: "E2E: Datei als Ziel",
            description: "E2E validation task: a task whose target is a FILE rather than a function. " +
                "File nodes carry only a path, so a name-based predicate can never match them.",
            workInstructions: "Nothing to edit — this task exists to assert that the AFFECTS edge to a File node is created at all.",
            targetNodes: [FIXTURE_REL],
            lockDepth: 0,
            priority: "low",
            createdBy: "lead-e2e",
        });
        assert.equal(result.status, "OK", `create_task failed: ${JSON.stringify(result)}`);

        const edges = await call("tool_db", {
            query: `MATCH (t:Task {taskId: '${result.taskId}'})-[:AFFECTS]->(f:File)
                    RETURN count(f) AS count`,
        });
        assert.equal(Number(edges[0].count), 1, "die Task haengt an keiner Datei");
        fileTaskId = result.taskId;
        const targets = await call('tool_db', {
            query: `MATCH (t:Task {taskId: '${fileTaskId}'})-[:AFFECTS]->(f:File) RETURN elementId(f) AS id`,
        });
        fileTargetId = targets[0].id;
        const listed = (await call('list_tasks', {status: 'all'})).find(t => t.taskId === fileTaskId);
        assert.equal(listed.affectedNodes.length, 1);
        assert.equal(listed.affectedNodes[0].id, fileTargetId);
        assert.equal(listed.affectedNodes[0].name, FIXTURE_REL);
        assert.equal(listed.affectedNodes[0].file, FIXTURE_REL);
        assert.equal(listed.affectedNodes[0].label, 'File');
        const detail = await call('get_task', {taskId: fileTaskId});
        assert.equal(detail.affectedNodes[0].id, fileTargetId);
        assert.equal(detail.affectedNodes[0].name, FIXTURE_REL);
        assert.equal(detail.affectedNodes[0].file, FIXTURE_REL);
    });

    it("task creation plans file scope without claiming code nodes", async () => {
        const nodes = await call("tool_db", {
            query: `MATCH (fn:Function {name: 'farewell', file: '${FIXTURE_REL}'}) RETURN fn.locked AS locked, fn.lockStatus AS lockStatus`,
        });
        assert.ok(Array.isArray(nodes) && nodes.length > 0, "farewell should exist in graph");
        // Locks arm only once a worker actually starts the task (in_progress); a
        // task sitting in todo must not block anyone. The claim_task step below
        // asserts the transition to a hard lock.
        assert.ok(!nodes[0].locked, "a freshly created (todo) task must not hard-lock its nodes");
        assert.equal(nodes[0].lockStatus, null, "plans must not overwrite shared code-node ownership");
        const task = await call("get_task", { taskId: createdTaskId });
        assert.ok(task.editScope.some(scope => scope.file === FIXTURE_REL.toLowerCase() || scope.file === FIXTURE_REL));
        assert.ok(task.editScope.every(scope => !scope.active));
    });

    it("list_tasks shows the new task", async () => {
        const tasks = await call("list_tasks", { status: "all" });
        const ours = tasks.find(t => t.taskId === createdTaskId);
        assert.ok(ours, "Should find our task");
        assert.equal(ours.title, "E2E: Refactor farewell");
    });

    it("claim_task assigns task to a worker agent", async () => {
        const result = await call("claim_task", {
            taskId: createdTaskId,
            agentId: "e2e-agent-2",
        });
        assert.equal(result.status, "OK", `claim failed: ${JSON.stringify(result)}`);
    });

    it("task is now in_progress", async () => {
        const tasks = await call("list_tasks", { status: "in_progress" });
        const ours = tasks.find(t => t.taskId === createdTaskId);
        assert.ok(ours, "Task should be in_progress");
        assert.equal(ours.assignedTo, "e2e-agent-2");
    });

    it("farewell lock transferred to claiming agent", async () => {
        const nodes = await call("tool_db", {
            query: `MATCH (fn:Function {name: 'farewell', file: '${FIXTURE_REL}'}) RETURN fn.locked AS locked, fn.lockedBy AS lockedBy`,
        });
        assert.ok(Array.isArray(nodes) && nodes.length > 0);
        assert.equal(nodes[0].locked, true);
        assert.equal(nodes[0].lockedBy, "e2e-agent-2");
    });

    it("complete_task marks task as review", async () => {
        const result = await call("complete_task", {
            taskId: createdTaskId,
            agentId: "e2e-agent-2",
            summary: "E2E test — farewell refactored",
        });
        assert.equal(result.status, "OK", `complete failed: ${JSON.stringify(result)}`);
        assert.ok(result.releasedLocks > 0, "completion should release the task lock group");

        const remainingLocks = await call("tool_db", {
            query: `MATCH (n) WHERE n.lockGroup = '${createdTaskId}' RETURN count(n) AS count`,
        });
        assert.equal(Number(remainingLocks[0].count), 0, "completing agent should hold zero locks for the task");
    });

    it("task is now in review", async () => {
        const tasks = await call("list_tasks", { status: "review" });
        const ours = tasks.find(t => t.taskId === createdTaskId);
        assert.ok(ours, "Task should be in review");
    });

    it("locks are released during review", async () => {
        const nodes = await call("tool_db", {
            query: `MATCH (fn:Function {name: 'farewell', file: '${FIXTURE_REL}'}) RETURN fn.locked AS locked`,
        });
        assert.ok(Array.isArray(nodes) && nodes.length > 0);
        assert.ok(!nodes[0].locked, "farewell should be unlocked during review");
    });

    it("locks released when user marks task done", async () => {
        const result = await call("update_task_status", {
            taskId: createdTaskId,
            status: "done",
            agentId: "user",
        });
        assert.equal(result.status, "OK");
        assert.equal(result.releasedLocks, 0, "completion already released the locks");

        const nodes = await call("tool_db", {
            query: `MATCH (fn:Function {name: 'farewell', file: '${FIXTURE_REL}'}) RETURN fn.locked AS locked`,
        });
        assert.ok(!nodes[0].locked, "farewell should be unlocked after done");
    });

    it('claim_task and get_next_task retain File target identity and path for workers', async () => {
        const claimed = await call('claim_task', {taskId: fileTaskId, agentId: 'file-worker'});
        assert.equal(claimed.status, 'OK');
        assert.equal(claimed.affectedNodes[0].id, fileTargetId);
        assert.equal(claimed.affectedNodes[0].file, FIXTURE_REL);
        assert.equal(claimed.affectedNodes[0].name, FIXTURE_REL);
        await call('update_task_status', {taskId: fileTaskId, status: 'todo', agentId: 'file-worker'});
        const next = await call('get_next_task', {agentId: 'file-worker'});
        assert.equal(next.status, 'OK');
        assert.equal(next.taskId, fileTaskId);
        assert.equal(next.affectedNodes[0].id, fileTargetId);
        assert.equal(next.affectedNodes[0].file, FIXTURE_REL);
        assert.equal(next.affectedNodes[0].name, FIXTURE_REL);
    });
});

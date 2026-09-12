#!/usr/bin/env node
/**
 * Tests for lock-guard.js and bash-guard.js PreToolUse hooks.
 * Run: node --test tests/hooks.test.js
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const { writeFileSync, mkdirSync, rmSync, existsSync } = require("node:fs");
const { resolve } = require("node:path");

const PROJECT_DIR = resolve(__dirname, "..");
const LOCK_GUARD = resolve(PROJECT_DIR, "templates/hooks/lock-guard.cjs");
const BASH_GUARD = resolve(PROJECT_DIR, "templates/hooks/bash-guard.cjs");
const LOCKS_FILE = resolve(PROJECT_DIR, ".claude/locks.test.json");

// Helper: run a hook script with simulated stdin and env
function runHook(script, stdinData, env = {}) {
    return new Promise((resolve, reject) => {
        const child = execFile("node", [script], {
            env: {
                ...process.env,
                CLAUDE_PROJECT_DIR: PROJECT_DIR,
                CODEVIS_LOCKING: "on",
                ...env,
            },
            timeout: 5000,
        }, (err, stdout, stderr) => {
            if (err && err.killed) return reject(new Error("Hook timed out"));
            // Hooks always exit 0, even on deny
            try {
                const result = JSON.parse(stdout.trim());
                resolve(result.hookSpecificOutput);
            } catch (e) {
                reject(new Error(`Failed to parse hook output: ${stdout}\n${stderr}`));
            }
        });
        child.stdin.write(JSON.stringify(stdinData));
        child.stdin.end();
    });
}

// ── lock-guard.js tests ──────────────────────────────────────────

describe("lock-guard.js", () => {
    const locksPath = resolve(PROJECT_DIR, ".claude/locks.json");
    let originalLocks = null;

    // These cases seed locks.json, so they exercise the MANIFEST fallback and
    // must say so: with the live graph query enabled the hook never reads the
    // manifest, and the assertions below would pass or fail for reasons that
    // have nothing to do with the behaviour they name. (They used to pass only
    // because the live path threw on every call — see loadGraphDriver.)
    const runLockGuard = (stdinData, env = {}) =>
        runHook(LOCK_GUARD, stdinData, { CODEVIS_LOCK_SOURCE: "manifest", ...env });

    before(() => {
        // Backup existing locks.json
        if (existsSync(locksPath)) {
            originalLocks = require("fs").readFileSync(locksPath, "utf-8");
        }
        // Write test locks
        writeFileSync(locksPath, JSON.stringify({
            "scripts/graph_builder.js": [
                { name: "findFiles", lockedBy: "worker-1", lockGroup: "task-100" },
                { name: "parseFiles", lockedBy: "worker-2", lockGroup: "task-200" },
            ],
            "tools/mcp_server.ts": [
                { name: "main", lockedBy: "worker-1", lockGroup: "task-100" },
            ],
            "new/claimed-file.js": [
                { name: null, lockedBy: "worker-1", lockGroup: "task-100", lockExpires: Date.now() + 300000 },
            ],
            "new/expired-file.js": [
                { name: null, lockedBy: "worker-1", lockGroup: "task-100", lockExpires: 1 },
            ],
            // lock_subgraph pulls the File/ASTNode nodes in as blast radius, and
            // those reach the manifest with name: null.
            "server/ladybug-daemon.cjs": [
                { name: null, lockedBy: "worker-2", lockGroup: "task-200" },
            ],
        }));
    });

    after(() => {
        // Restore original locks.json
        if (originalLocks !== null) {
            writeFileSync(locksPath, originalLocks);
        } else if (existsSync(locksPath)) {
            rmSync(locksPath);
        }
    });

    it("blocks a locked-function edit even when CODEVIS_AGENT_ID is not set", async () => {
        // v3 returned allow() outright when no agent id was set, so the guard
        // was disabled by the *absence* of a variable rather than by any
        // decision — a lead could silently overwrite a function a worker was
        // midway through. Holding no identity now means holding no locks, so
        // every lock is foreign. force_unlock is the deliberate way through.
        const result = await runLockGuard({
            tool_name: "Edit",
            tool_input: {
                file_path: resolve(PROJECT_DIR, "scripts/graph_builder.js"),
                old_string: "function findFiles(",
                new_string: "function findFiles(dir,",
            },
        }, { CODEVIS_AGENT_ID: "" });
        assert.equal(result.permissionDecision, "deny");
        assert.ok(result.permissionDecisionReason.includes("findFiles"));
    });

    it("allows an edit that touches none of the file's locked functions", async () => {
        // The guard is surgical, not file-wide: worker-1 owns the only lock in
        // mcp_server.ts ('main'), and this edit names nothing locked.
        const result = await runLockGuard({
            tool_name: "Edit",
            tool_input: {
                file_path: resolve(PROJECT_DIR, "tools/mcp_server.ts"),
                old_string: "const unrelatedThing = 1;",
                new_string: "const unrelatedThing = 2;",
            },
        }, { CODEVIS_AGENT_ID: "worker-1" });
        assert.equal(result.permissionDecision, "allow");
    });

    it("blocks a file reserved by a nameless (file-level) foreign lock", async () => {
        const result = await runLockGuard({
            tool_name: "Edit",
            tool_input: {
                file_path: resolve(PROJECT_DIR, "server/ladybug-daemon.cjs"),
                old_string: "const x = 1;",
                new_string: "const x = 2;",
            },
        }, { CODEVIS_AGENT_ID: "worker-1" });
        assert.equal(result.permissionDecision, "deny");
        assert.ok(result.permissionDecisionReason.includes("file level"));
    });

    it("does not treat a nameless lock as the literal name 'null'", async () => {
        // `oldString.includes(lock.name)` coerces null to the substring "null",
        // so before the guard skipped nameless entries this edit was blocked
        // with a nonsensical reason — by its own owner, no less.
        const result = await runLockGuard({
            tool_name: "Edit",
            tool_input: {
                file_path: resolve(PROJECT_DIR, "server/ladybug-daemon.cjs"),
                old_string: "if (value === null) {",
                new_string: "if (value == null) {",
            },
        }, { CODEVIS_AGENT_ID: "worker-2" });
        assert.equal(result.permissionDecision, "allow");
    });

    it("denies when the lock manifest is unreadable", async () => {
        // "cannot determine" is not "no locks". v3 conflated the two: a corrupt
        // manifest returned null, which its `!locks` check treated as empty and
        // waved through — disabling enforcement entirely.
        const saved = require("fs").readFileSync(locksPath, "utf-8");
        writeFileSync(locksPath, "{ this is not json");
        try {
            const result = await runLockGuard({
                tool_name: "Edit",
                tool_input: {
                    file_path: resolve(PROJECT_DIR, "scripts/graph_builder.js"),
                    old_string: "function findFiles(",
                    new_string: "function findFiles(dir,",
                },
            }, { CODEVIS_AGENT_ID: "worker-1" });
            assert.equal(result.permissionDecision, "deny");
        } finally {
            writeFileSync(locksPath, saved);
        }
    });

    it("blocks Edit on own locked function (must use a graph-aware edit tool)", async () => {
        const result = await runLockGuard( {
            tool_name: "Edit",
            tool_input: {
                file_path: resolve(PROJECT_DIR, "scripts/graph_builder.js"),
                old_string: "function findFiles(",
                new_string: "function findFiles(dir,",
            },
        }, { CODEVIS_AGENT_ID: "worker-1" });
        assert.equal(result.permissionDecision, "deny");
        assert.ok(result.permissionDecisionReason.includes("findFiles"));
    });

    it("blocks Edit on function locked by another agent", async () => {
        const result = await runLockGuard( {
            tool_name: "Edit",
            tool_input: {
                file_path: resolve(PROJECT_DIR, "scripts/graph_builder.js"),
                old_string: "function parseFiles(",
                new_string: "function parseFiles(dir,",
            },
        }, { CODEVIS_AGENT_ID: "worker-1" });
        assert.equal(result.permissionDecision, "deny");
        assert.ok(result.permissionDecisionReason.includes("parseFiles"));
    });

    it("blocks Write on file with foreign locks", async () => {
        const result = await runLockGuard( {
            tool_name: "Write",
            tool_input: {
                file_path: resolve(PROJECT_DIR, "scripts/graph_builder.js"),
                content: "// overwritten",
            },
        }, { CODEVIS_AGENT_ID: "worker-3" });
        assert.equal(result.permissionDecision, "deny");
    });

    it("blocks Write on file where all locks belong to agent (must use a graph-aware edit tool)", async () => {
        const result = await runLockGuard( {
            tool_name: "Write",
            tool_input: {
                file_path: resolve(PROJECT_DIR, "tools/mcp_server.ts"),
                content: "// overwritten",
            },
        }, { CODEVIS_AGENT_ID: "worker-1" });
        assert.equal(result.permissionDecision, "deny");
    });

    it("permits creation only inside a live owned file scope", async () => {
        const create = (file, agentId) => runLockGuard({
            tool_name: "Write",
            tool_input: { file_path: resolve(PROJECT_DIR, file), content: "// new code" },
        }, { CODEVIS_AGENT_ID: agentId });
        assert.equal((await create("new/claimed-file.js", "worker-1")).permissionDecision, "allow");
        assert.equal((await create("new/claimed-file.js", "worker-2")).permissionDecision, "deny");
        assert.equal((await create("new/expired-file.js", "worker-1")).permissionDecision, "deny");
        assert.equal((await create("new/unclaimed-file.js", "worker-1")).permissionDecision, "deny");
    });

    it("requires explicit scope before editing a free file when locking is enabled", async () => {
        const result = await runLockGuard( {
            tool_name: "Edit",
            tool_input: {
                file_path: resolve(PROJECT_DIR, "package.json"),
                old_string: '"name":',
                new_string: '"name": "test",',
            },
        }, { CODEVIS_AGENT_ID: "worker-5" });
        assert.equal(result.permissionDecision, "deny");
        assert.match(result.permissionDecisionReason, /Scope required/);
    });

    it("denies on malformed JSON input when agentId is set", async () => {
        const result = await new Promise((resolve, reject) => {
            const child = require("node:child_process").execFile("node", [LOCK_GUARD], {
                env: {
                    ...process.env,
                    CLAUDE_PROJECT_DIR: PROJECT_DIR,
                    CODEVIS_AGENT_ID: "worker-1",
                    CODEVIS_LOCK_SOURCE: "manifest",
                },
                timeout: 5000,
            }, (err, stdout, stderr) => {
                if (err && err.killed) return reject(new Error("Hook timed out"));
                try {
                    const result = JSON.parse(stdout.trim());
                    resolve(result.hookSpecificOutput);
                } catch (e) {
                    reject(new Error(`Failed to parse hook output: ${stdout}\n${stderr}`));
                }
            });
            child.stdin.write("NOT VALID JSON {{{");
            child.stdin.end();
        });
        assert.equal(result.permissionDecision, "deny");
        assert.ok(result.permissionDecisionReason.includes("lock-guard internal error"));
    });

    it("blocks Edit when filePath uses ./ prefix (path normalization)", async () => {
        const result = await runLockGuard( {
            tool_name: "Write",
            tool_input: {
                file_path: resolve(PROJECT_DIR, "./scripts/../scripts/graph_builder.js"),
                content: "// overwritten",
            },
        }, { CODEVIS_AGENT_ID: "worker-3" });
        assert.equal(result.permissionDecision, "deny");
    });

    // Regression guard for the live path. The hook used to hard-require
    // `neo4j-driver`, a package CodeVis no longer ships: the require threw on
    // every invocation, so the "live, deterministic" query never ran and every
    // decision came from the manifest instead. Nothing failed loudly — the
    // fallback answered, and the suite above stayed green. Assert the driver the
    // hook reaches for actually loads, in both the checkout and the template.
    // Was `codevis init` ausliefert, muss das sein, was hier läuft.
    //
    // Geprüft wurde das nur für lock-guard.js, und bash-guard.js war
    // tatsaechlich auseinandergelaufen: der Vorlage fehlten zwei Kommentare.
    // Diesmal war es harmlos, aber der Weg dorthin ist der gefaehrliche --
    // eine Regel, die hier greift und beim Nutzer fehlt, fällt niemandem auf,
    // der beide Seiten nicht nebeneinanderlegt. Byte-Gleichheit ist die
    // einzige Zusicherung, die das ausschließt.
    it("runs the shipped guards inside an ESM project even with locking disabled", async () => {
        const fs = require("fs");
        const dir = fs.mkdtempSync(resolve(require('os').tmpdir(), 'codevis-esm-hooks-'));
        try {
            fs.writeFileSync(resolve(dir, 'package.json'), '{"type":"module"}');
            for (const name of ["lock-guard.cjs", "bash-guard.cjs"]) {
                const script = resolve(dir, name);
                fs.copyFileSync(resolve(PROJECT_DIR, 'templates/hooks', name), script);
                const output = await runHook(script, { tool_name: 'Edit', tool_input: { file_path: 'src/app.js' } }, { CLAUDE_PROJECT_DIR: dir, CODEVIS_LOCKING: 'off' });
                assert.equal(output.permissionDecision, 'allow');
            }
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("can load the graph driver both hooks require", () => {
        const driver = require(resolve(PROJECT_DIR, "server/ladybug-driver.cjs"));
        assert.equal(typeof driver.driver, "function");
        assert.equal(typeof driver.auth.basic, "function");

        for (const hook of [LOCK_GUARD, BASH_GUARD]) {
            // Comments are stripped first: both hooks document the old require
            // in prose, and matching that text would fail for the wrong reason.
            const code = require("fs").readFileSync(hook, "utf-8")
                .split("\n").filter(l => !l.trim().startsWith("//")).join("\n");
            const requires = code.match(/require\((['"])neo4j-driver\1\)/g) || [];
            assert.equal(requires.length, 0, `${hook} still requires the removed neo4j-driver`);
        }
    });

    it("allows non-Edit/Write tools", async () => {
        const result = await runLockGuard( {
            tool_name: "Read",
            tool_input: {
                file_path: resolve(PROJECT_DIR, "scripts/graph_builder.js"),
            },
        }, { CODEVIS_AGENT_ID: "worker-3" });
        assert.equal(result.permissionDecision, "allow");
    });

    it("bypasses lock enforcement when project locking is disabled", async () => {
        const result = await runLockGuard({
            tool_name: "Edit",
            tool_input: {
                file_path: resolve(PROJECT_DIR, "scripts/graph_builder.js"),
                old_string: "function findFiles(",
                new_string: "function findFiles(dir,",
            },
        }, { CODEVIS_AGENT_ID: "worker-9", CODEVIS_LOCKING: "off" });
        assert.equal(result.permissionDecision, "allow");
    });
});

// ── bash-guard.js tests ──────────────────────────────────────────

describe("bash-guard.js", () => {
    const locksPath = resolve(PROJECT_DIR, ".claude/locks.json");
    let originalLocks = null;

    before(() => {
        if (existsSync(locksPath)) {
            originalLocks = require("fs").readFileSync(locksPath, "utf-8");
        }
        writeFileSync(locksPath, JSON.stringify({
            "scripts/graph_builder.js": [
                { name: "findFiles", lockedBy: "worker-1", lockGroup: "task-100" },
            ],
        }));
    });

    after(() => {
        if (originalLocks !== null) {
            writeFileSync(locksPath, originalLocks);
        } else if (existsSync(locksPath)) {
            rmSync(locksPath);
        }
    });

    it("allows all commands when CODEVIS_AGENT_ID is not set", async () => {
        const result = await runHook(BASH_GUARD, {
            tool_input: { command: "sed -i 's/foo/bar/' scripts/graph_builder.js" },
        }, { CODEVIS_AGENT_ID: "" });
        assert.equal(result.permissionDecision, "allow");
    });

    it("allows harmless commands", async () => {
        const result = await runHook(BASH_GUARD, {
            tool_input: { command: "ls -la" },
        }, { CODEVIS_AGENT_ID: "worker-2" });
        assert.equal(result.permissionDecision, "allow");
    });

    it("allows npm/node commands", async () => {
        const result = await runHook(BASH_GUARD, {
            tool_input: { command: "npm test" },
        }, { CODEVIS_AGENT_ID: "worker-2" });
        assert.equal(result.permissionDecision, "allow");
    });

    it("blocks sed -i on locked file by other agent", async () => {
        const result = await runHook(BASH_GUARD, {
            tool_input: { command: "sed -i 's/foo/bar/' scripts/graph_builder.js" },
        }, { CODEVIS_AGENT_ID: "worker-2" });
        assert.equal(result.permissionDecision, "deny");
    });

    it("allows sed -i on locked file by own agent", async () => {
        const result = await runHook(BASH_GUARD, {
            tool_input: { command: "sed -i 's/foo/bar/' scripts/graph_builder.js" },
        }, { CODEVIS_AGENT_ID: "worker-1" });
        assert.equal(result.permissionDecision, "allow");
    });

    it("blocks rm on locked source file", async () => {
        const result = await runHook(BASH_GUARD, {
            tool_input: { command: "rm scripts/graph_builder.js" },
        }, { CODEVIS_AGENT_ID: "worker-2" });
        assert.equal(result.permissionDecision, "deny");
    });

    it("allows rm on non-source files", async () => {
        const result = await runHook(BASH_GUARD, {
            tool_input: { command: "rm tmp/output.log" },
        }, { CODEVIS_AGENT_ID: "worker-2" });
        assert.equal(result.permissionDecision, "allow");
    });

    it("denies on malformed JSON input when agentId is set", async () => {
        const result = await new Promise((resolve, reject) => {
            const child = require("node:child_process").execFile("node", [BASH_GUARD], {
                env: {
                    ...process.env,
                    CLAUDE_PROJECT_DIR: PROJECT_DIR,
                    CODEVIS_AGENT_ID: "worker-1",
                    CODEVIS_LOCKING: "on",
                },
                timeout: 5000,
            }, (err, stdout, stderr) => {
                if (err && err.killed) return reject(new Error("Hook timed out"));
                try {
                    const result = JSON.parse(stdout.trim());
                    resolve(result.hookSpecificOutput);
                } catch (e) {
                    reject(new Error(`Failed to parse hook output: ${stdout}\n${stderr}`));
                }
            });
            child.stdin.write("NOT VALID JSON {{{");
            child.stdin.end();
        });
        assert.equal(result.permissionDecision, "deny");
        assert.ok(result.permissionDecisionReason.includes("bash-guard internal error"));
    });

    it("blocks git checkout -- on locked file", async () => {
        const result = await runHook(BASH_GUARD, {
            tool_input: { command: "git checkout -- scripts/graph_builder.js" },
        }, { CODEVIS_AGENT_ID: "worker-2" });
        assert.equal(result.permissionDecision, "deny");
    });

    it("blocks redirect to locked source file", async () => {
        const result = await runHook(BASH_GUARD, {
            tool_input: { command: "echo 'x' > scripts/graph_builder.js" },
        }, { CODEVIS_AGENT_ID: "worker-2" });
        assert.equal(result.permissionDecision, "deny");
    });
});

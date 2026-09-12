"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { inspectGraphFreshness } = require("../scripts/impact/graph_freshness.cjs");
const { collectSourceFiles } = require("../lib/source-files.cjs");

test("freshness shares build exclusions, test rules, explicit roots and overlapping sources", async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codevis-source-selection-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    for (const file of ["src/app.js", "src/api.hh", "src/app.test.js", "src/types.d.ts", "src/generated/client.js",
        "src/vendor/lib.js", "src/.venv/lib.py", "src/coverage/report.js", "tests/app.test.js", "tests/node_modules/lib.js"]) {
        fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        fs.writeFileSync(path.join(root, file), "// unchanged\n");
    }
    for (const [sourceDirs, expected] of [
        [["src"], ["src/api.hh", "src/app.js"]],
        [["src", "tests", "src/app.js"], ["src/api.hh", "src/app.js", "tests/app.test.js"]],
        ["src/app.test.js", ["src/app.test.js"]],
    ]) {
        const context = { projectRoot: root, sourceDirs, exclude: ["src/generated/**"] };
        const built = collectSourceFiles(root, sourceDirs, { exclude: context.exclude });
        assert.deepEqual(built.files.map(f => path.relative(root, f).replaceAll("\\", "/")).sort(), expected);
        const session = { run: async () => ({ records: expected.map(file => record({ path: file,
            sourceMtime: Date.now() + 60_000, parseStatus: "current" })) }) };
        assert.equal((await inspectGraphFreshness(session, context)).state, "current");
    }
});

test("an empty graph without source evidence has unknown freshness", async () => {
    const result = await inspectGraphFreshness({ run: async () => ({ records: [] }) }, { projectRoot: process.cwd(), sourceDirs: [] });
    assert.equal(result.state, "unknown");
});

function record(values) { return { get: (key) => values[key] }; }

test("missing or unreadable source trees cannot be reported as current", async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codevis-partial-scan-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src/app.js"), "export {};\n");
    const session = { run: async () => ({ records: [record({ path: "src/app.js", sourceMtime: Date.now() + 60_000 })] }) };
    const context = { projectRoot: root, sourceDirs: ["src", "unavailable"] };
    const missing = await inspectGraphFreshness(session, context);
    assert.equal(missing.state, "unknown");
    assert.ok(missing.sourceErrors.some(e => e.code === 'ENOENT'));
    fs.mkdirSync(path.join(root, "unavailable"));
    const readdir = fs.readdirSync;
    t.mock.method(fs, 'readdirSync', (dir, ...args) => {
        if (dir === path.join(root, 'unavailable')) throw Object.assign(new Error('denied'), { code: 'EACCES' });
        return readdir(dir, ...args);
    });
    const unreadable = await inspectGraphFreshness(session, context);
    assert.equal(unreadable.state, "unknown");
    assert.ok(unreadable.sourceErrors.some(e => e.code === 'EACCES'));
});

test("freshness compares disk files, hashes, parse errors, additions and deletions", async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codevis-impact-fresh-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, "src"));
    const currentPath = path.join(root, "src/current.js");
    const changedPath = path.join(root, "src/changed.js");
    fs.writeFileSync(currentPath, "const current = true;\n");
    fs.writeFileSync(changedPath, "const changed = true;\n");
    const hash = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    const future = Date.now() + 60_000;
    const session = { run: async () => ({ records: [
        record({ path: "src/current.js", sourceMtime: future, lastParsed: future, contentHash: hash(currentPath), parseStatus: "current" }),
        record({ path: "src/changed.js", sourceMtime: future, lastParsed: future, contentHash: "wrong", parseStatus: "current" }),
        record({ path: "src/deleted.js", sourceMtime: future, lastParsed: future, contentHash: null, parseStatus: "current" }),
    ] }) };
    const result = await inspectGraphFreshness(session, { projectRoot: root, sourceDirs: ["src"] });
    assert.equal(result.state, "stale");
    assert.deepEqual(result.staleFiles, ["src/changed.js", "src/deleted.js"]);
});

test("freshness reports a matching graph as current", async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codevis-impact-current-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, "src"));
    const file = path.join(root, "src/a.js"); fs.writeFileSync(file, "export {};\n");
    const contentHash = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    const session = { run: async () => ({ records: [record({ path: "src/a.js", sourceMtime: Date.now() + 60_000,
        lastParsed: null, contentHash, parseStatus: "current" })] }) };
    const result = await inspectGraphFreshness(session, { projectRoot: root, sourceDirs: ["src"] });
    assert.equal(result.state, "current"); assert.equal(result.staleFileCount, 0);
});

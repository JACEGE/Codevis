const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, before, describe, it } = require("node:test");
require("../lib/tsx-userinfo-preload.cjs");
const { register } = require("tsx/cjs/api");
const { openTestDb } = require("./helpers/ladybug-session.cjs");

const unregister = register();
after(() => unregister());

// rename_function and move_function wrote the files and then tried to SET
// n.uid — the primary key, which Ladybug rejects — so the graph kept the old
// name and file. The other rename/move tests mock the session and missed it.
describe("rename_function and move_function update the real graph", () => {
    let db, ctx, project, previousProject, editTools;

    before(async () => {
        project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codevis-rename-")));
        previousProject = process.env.CODEVIS_PROJECT_DIR;
        process.env.CODEVIS_PROJECT_DIR = project;
        editTools = require("../tools/handlers/edit-tools.ts").editTools;
        db = await openTestDb();
        const driver = { session: () => db.session };
        ctx = { targetDriver: driver, metaDriver: driver, defaultAgentId: "agent-1", lockingEnabled: false };
    });
    after(async () => {
        if (previousProject === undefined) delete process.env.CODEVIS_PROJECT_DIR;
        else process.env.CODEVIS_PROJECT_DIR = previousProject;
        await db?.cleanup();
        fs.rmSync(project, { recursive: true, force: true });
    });

    const seed = async (file, name, uid, startLine, endLine) => {
        await db.session.run(`MERGE (f:File {path: $file})`, { file });
        await db.session.run(
            `MERGE (n:Function {uid: $uid})
             SET n.name = $name, n.file = $file, n.startLine = $startLine, n.endLine = $endLine,
                 n.ipv6 = 'fd00:0001:aaaa:bbbb:0000:0000:0000:0000'`,
            { uid, name, file, startLine, endLine });
        await db.session.run(`MATCH (f:File {path: $file}), (n) WHERE elementId(n) = $uid MERGE (f)-[:CONTAINS]->(n)`, { file, uid });
    };
    const call = async (name, args) => JSON.parse((await editTools.handlers[name](args, ctx)).content[0].text);
    const node = async (uid) => (await db.session.run(
        `MATCH (n) WHERE elementId(n) = $uid RETURN n.name AS name, n.file AS file`, { uid })).records[0];

    it("rename keeps the node identity and changes its name", async () => {
        fs.writeFileSync(path.join(project, "a.js"), "export function work() {\n  return 42;\n}\n");
        await seed("a.js", "work", "fn-work", 1, 3);
        await db.session.run(`CREATE (:Task {taskId: 'T-1', title: 't', status: 'todo'})`);
        await db.session.run(`MATCH (t:Task {taskId: 'T-1'}), (n) WHERE elementId(n) = 'fn-work' MERGE (t)-[:AFFECTS]->(n)`);
        await db.session.run(`MERGE (c:Variable {uid: 'var-inner'})
            SET c.name = 'inner', c.file = 'a.js', c.ipv6 = 'fd00:0001:aaaa:bbbb:0001:0000:0000:0000'`);

        const result = await call("rename_function", { agentId: "agent-1", file: "a.js", oldName: "work", newName: "renamed" });
        assert.equal(result.status, "OK", JSON.stringify(result));
        assert.match(fs.readFileSync(path.join(project, "a.js"), "utf8"), /function renamed\(\)/);
        const renamed = await node("fn-work");
        assert.equal(renamed.get("name"), "renamed");
        const linked = await db.session.run(`MATCH (:Task {taskId: 'T-1'})-[:AFFECTS]->(n) RETURN n.name AS name`);
        assert.deepEqual(linked.records.map(r => r.get("name")), ["renamed"]);
        // The post-edit file sync must find the renamed node, not add a second one.
        const named = await db.session.run(`MATCH (n:Function {file: 'a.js'}) RETURN n.name AS name`);
        assert.deepEqual(named.records.map(r => r.get("name")), ["renamed"]);
        const child = await db.session.run(`MATCH (n) WHERE elementId(n) = 'var-inner' RETURN n.ipv6 AS ipv6`);
        const renamedIpv6 = (await db.session.run(`MATCH (n) WHERE elementId(n) = 'fn-work' RETURN n.ipv6 AS ipv6`)).records[0].get("ipv6");
        assert.equal(child.records[0].get("ipv6").slice(0, 20), renamedIpv6.slice(0, 20));
        assert.equal(child.records[0].get("ipv6").slice(20), "0001:0000:0000:0000");
    });

    it("a Python rename also renames call sites in the same file", async () => {
        fs.writeFileSync(path.join(project, "mod.py"), "def work():\n    return 42\n\ndef main():\n    work = 1\n    return work\n\ndef run():\n    return work()\n");
        await seed("mod.py", "work", "fn-py-work", 1, 2);
        await seed("mod.py", "run", "fn-py-run", 8, 9);
        await db.session.run(`MATCH (a) WHERE elementId(a) = 'fn-py-run' MATCH (b) WHERE elementId(b) = 'fn-py-work' MERGE (a)-[:CALLS]->(b)`);

        const result = await call("rename_function", { agentId: "agent-1", file: "mod.py", oldName: "work", newName: "renamed" });
        assert.equal(result.status, "OK", JSON.stringify(result));
        const text = fs.readFileSync(path.join(project, "mod.py"), "utf8");
        assert.match(text, /def renamed\(\):/);
        assert.match(text, /return renamed\(\)/);
        // main() is no caller: its local variable of the same name stays.
        assert.match(text, /work = 1\n    return work\n/);
    });

    it("move refuses when functions left in the source file still call it", async () => {
        fs.writeFileSync(path.join(project, "used.js"), "function inner() {\n  return 1;\n}\nexport function outer() {\n  return inner();\n}\n");
        await seed("used.js", "inner", "fn-inner", 1, 3);
        await seed("used.js", "outer", "fn-outer", 4, 6);
        await db.session.run(`MATCH (a) WHERE elementId(a) = 'fn-outer' MATCH (b) WHERE elementId(b) = 'fn-inner' MERGE (a)-[:CALLS]->(b)`);
        const before = fs.readFileSync(path.join(project, "used.js"), "utf8");

        const result = await call("move_function", { agentId: "agent-1", sourceFile: "used.js", targetFile: "other.js", functionName: "inner" });
        assert.equal(result.status, "SOURCE_CALLERS");
        assert.deepEqual(result.sourceCallers, ["outer"]);
        assert.equal(fs.readFileSync(path.join(project, "used.js"), "utf8"), before);
        assert.equal(fs.existsSync(path.join(project, "other.js")), false);
    });

    it("move keeps the node identity and changes its file", async () => {
        fs.writeFileSync(path.join(project, "src.js"), "export function helper() {\n  return 1;\n}\n");
        await seed("src.js", "helper", "fn-helper", 1, 3);

        const result = await call("move_function", { agentId: "agent-1", sourceFile: "src.js", targetFile: "dst.js", functionName: "helper" });
        assert.equal(result.status, "OK", JSON.stringify(result));
        assert.match(fs.readFileSync(path.join(project, "dst.js"), "utf8"), /function helper\(\)/);
        const moved = await node("fn-helper");
        assert.equal(moved.get("file"), "dst.js");
        const contains = await db.session.run(`MATCH (f:File)-[:CONTAINS]->(n) WHERE elementId(n) = 'fn-helper' RETURN f.path AS path`);
        assert.deepEqual(contains.records.map(r => r.get("path")), ["dst.js"]);
    });
});

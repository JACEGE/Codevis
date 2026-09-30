const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, before, it } = require("node:test");
require("../lib/tsx-userinfo-preload.cjs");
const { register } = require("tsx/cjs/api");
const { openTestDb } = require("./helpers/ladybug-session.cjs");

const unregister = register();
after(() => unregister());

// These handlers are otherwise tested against mocked sessions, which is how
// wrong status fields and ignored filters went unnoticed.
let db, ctx, project, previousProject, previousGate;
before(async () => {
    project = fs.mkdtempSync(path.join(os.tmpdir(), "codevis-mcp-real-"));
    fs.mkdirSync(path.join(project, ".claude"));
    previousProject = process.env.CODEVIS_PROJECT_DIR;
    previousGate = process.env.CODEVIS_TASK_GATE;
    process.env.CODEVIS_PROJECT_DIR = project;
    process.env.CODEVIS_TASK_GATE = "off";
    db = await openTestDb();
    const driver = { session: () => db.session };
    ctx = { targetDriver: driver, metaDriver: driver, defaultAgentId: "lead-1", lockingEnabled: false };
});
after(async () => {
    for (const [key, value] of [["CODEVIS_PROJECT_DIR", previousProject], ["CODEVIS_TASK_GATE", previousGate]]) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await db?.cleanup();
    fs.rmSync(project, { recursive: true, force: true });
});

const parse = (result) => JSON.parse(result.content[0].text);

it("update_epic reports OK and the epic's own status separately", async () => {
    const { taskTools } = require("../tools/handlers/task-tools.ts");
    await db.session.run("CREATE (:Epic {taskId: 'E-1', title: 'Epic', status: 'backlog', priority: 'low'})");
    const result = parse(await taskTools.handlers.update_epic({ epicId: "E-1", priority: "high" }, ctx));
    assert.equal(result.status, "OK");
    assert.equal(result.epicStatus, "backlog");
    assert.equal(result.priority, "high");
});

it("list_ideas honours status 'promoted', and delete_idea reports a missing idea", async () => {
    const { ideaTools } = require("../tools/handlers/idea-tools.ts");
    await db.session.run("CREATE (:Idea {taskId: 'idea-open', content: 'a', status: 'open', createdAt: 1})");
    await db.session.run("CREATE (:Idea {taskId: 'idea-done', content: 'b', status: 'promoted', createdAt: 2})");
    const promoted = parse(await ideaTools.handlers.list_ideas({ status: "promoted" }, ctx));
    assert.deepEqual(promoted.map(i => i.ideaId), ["idea-done"]);
    const open = parse(await ideaTools.handlers.list_ideas({}, ctx));
    assert.deepEqual(open.map(i => i.ideaId), ["idea-open"]);
    const missing = await ideaTools.handlers.delete_idea({ ideaId: "nope" }, ctx);
    assert.equal(missing.isError, true);
    assert.equal(JSON.parse(missing.content[0].text).status, "NOT_FOUND");
});

it("get_runtime_errors returns empty lists, not null, for a node without callers", async () => {
    const { queryTools } = require("../tools/handlers/query-tools.ts");
    await db.session.run("MERGE (f:Function {uid: 'fn-err'}) SET f.name = 'boom', f.file = 'a.js', f.lastError = 'x', f.lastErrorTimestamp = 1");
    const [row] = parse(await queryTools.handlers.get_runtime_errors({}, ctx));
    assert.deepEqual(row.called_by, []);
    assert.deepEqual(row.calls_to, []);
});

it("the execution-path predefined query parses and reads stepOrder", async () => {
    const { PREDEFINED_QUERIES } = require("../scripts/predefined-queries.cjs");
    const entry = (PREDEFINED_QUERIES || []).find(q => q.name === "execution_path_for_event");
    assert.ok(entry, "query exists");
    await db.session.run("MERGE (e:UserEvent {uid: 'evt-1'})");
    await db.session.run("MERGE (f:Function {uid: 'fn-step'}) SET f.name = 'step'");
    await db.session.run("MATCH (e) WHERE elementId(e) = 'evt-1' MATCH (f) WHERE elementId(f) = 'fn-step' MERGE (e)-[:EXECUTION_STEP {stepOrder: 3}]->(f)");
    const result = await db.session.run(entry.query.replace("EVENT_UID_HERE", "evt-1"));
    assert.equal(Number(result.records[0].get("stepOrder")), 3);
});

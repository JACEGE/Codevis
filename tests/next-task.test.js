const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, before, it } = require("node:test");
require("../lib/tsx-userinfo-preload.cjs");
const { register } = require("tsx/cjs/api");
const { openTestDb } = require("./helpers/ladybug-session.cjs");
const { taskClaimOperation } = require("../server/task-claims.cjs");

const unregister = register();
after(() => unregister());

const root = path.resolve(__dirname, "..");
let db, ctx, project, previousProject;

before(async () => {
    // syncLockManifest writes .claude/locks.json below the project.
    project = fs.mkdtempSync(path.join(os.tmpdir(), "codevis-next-task-"));
    fs.mkdirSync(path.join(project, ".claude"));
    previousProject = process.env.CODEVIS_PROJECT_DIR;
    process.env.CODEVIS_PROJECT_DIR = project;
    db = await openTestDb();
    db.session.taskClaimAtomic = options => taskClaimOperation(db.session, options, root);
    const driver = { session: () => db.session };
    ctx = { targetDriver: driver, metaDriver: driver, defaultAgentId: "worker-x", lockingEnabled: true };
});
after(async () => {
    if (previousProject === undefined) delete process.env.CODEVIS_PROJECT_DIR;
    else process.env.CODEVIS_PROJECT_DIR = previousProject;
    await db?.cleanup();
    fs.rmSync(project, { recursive: true, force: true });
});

// get_next_task handed out backlog tasks of inactive waves, and it returned the
// top candidate's claim failure on every call instead of trying the next one.
it("get_next_task skips inactive waves and falls through a conflicting top candidate", async () => {
    const { taskTools } = require("../tools/handlers/task-tools.ts");
    const s = db.session;
    await s.run("CREATE (:Task {taskId:'wave2', status:'backlog', priority:'critical', wave:2, title:'w2'})");
    await s.run("CREATE (:Task {taskId:'held', status:'todo', priority:'low', title:'held'})");
    await s.run("CREATE (:Task {taskId:'blocked', status:'todo', priority:'high', title:'blocked'})");
    await s.run("CREATE (:Task {taskId:'free', status:'todo', priority:'medium', title:'free'})");
    const op = (operation, taskId, files, agentId) => taskClaimOperation(s, { operation, taskId, agentId, files }, root);
    await op("plan", "held", ["new/shared.js"], "lead-1");
    await op("plan", "blocked", ["new/shared.js"], "lead-1");
    await op("plan", "free", ["new/free.js"], "lead-1");
    assert.equal((await op("claim", "held", undefined, "worker-held")).status, "OK");

    const result = JSON.parse((await taskTools.handlers.get_next_task({ agentId: "worker-x" }, ctx)).content[0].text);
    assert.equal(result.status, "OK", JSON.stringify(result));
    assert.equal(result.taskId, "free");
    const wave = await s.run("MATCH (t:Task {taskId:'wave2'}) RETURN t.status AS status");
    assert.equal(wave.records[0].get("status"), "backlog");
});

// Without an epicId, DEPENDS_ON used to be ignored and a task was handed out
// before the task it depends on was finished.
it("get_next_task respects DEPENDS_ON without an epic", async () => {
    const { taskTools } = require("../tools/handlers/task-tools.ts");
    const s = db.session;
    await s.run("MATCH (t:Task) DETACH DELETE t");
    await s.run(`CREATE (a:Task {taskId:'first', status:'todo', priority:'low', title:'first'})
        CREATE (b:Task {taskId:'second', status:'todo', priority:'critical', title:'second'})
        CREATE (a)-[:DEPENDS_ON]->(b)`); // flow edge: prerequisite -> dependent, as plan_task_waves writes it
    const next = JSON.parse((await taskTools.handlers.get_next_task({ agentId: "worker-dep" }, ctx)).content[0].text);
    assert.equal(next.status, "OK", JSON.stringify(next));
    assert.equal(next.taskId, "first", "the higher-priority task waits for its prerequisite");
});

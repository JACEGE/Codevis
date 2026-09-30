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

// Knotennamen sind nicht eindeutig. Lead-Operationen wirkten früher auf jeden
// Knoten mit dem Namen und gaben damit fremde Locks frei.
describe("lead lock operations act on one node", () => {
    const { lockTools } = require("../tools/handlers/lock-tools.ts");
    const { createBackupToken } = require("../tools/lib/edit-backups.cjs");
    let db, ctx, project, previousProject;

    before(async () => {
        project = fs.mkdtempSync(path.join(os.tmpdir(), "codevis-lead-ops-"));
        fs.mkdirSync(path.join(project, ".claude", "backups"), { recursive: true });
        previousProject = process.env.CODEVIS_PROJECT_DIR;
        process.env.CODEVIS_PROJECT_DIR = project;
        db = await openTestDb();
        const driver = { session: () => db.session };
        ctx = { targetDriver: driver, metaDriver: driver, defaultAgentId: "lead-1" };
    });
    after(async () => {
        if (previousProject === undefined) delete process.env.CODEVIS_PROJECT_DIR;
        else process.env.CODEVIS_PROJECT_DIR = previousProject;
        await db?.cleanup();
        fs.rmSync(project, { recursive: true, force: true });
    });

    const call = async (name, args) =>
        JSON.parse((await lockTools.handlers[name]({ ...args }, ctx)).content[0].text);
    const lockOf = async (file) => (await db.session.run(
        `MATCH (n:Function {name: 'render', file: $file}) RETURN n.lockedBy AS lockedBy`, { file }
    )).records[0].get("lockedBy");

    it("approve_release refuses an ambiguous name and releases only the chosen node", async () => {
        const later = Date.now() + 600000;
        await db.session.run(`CREATE (:Function {name: 'render', file: 'a.js', locked: true, lockedBy: 'worker-a', lockExpires: $later, pendingRelease: true})`, { later });
        await db.session.run(`CREATE (:Function {name: 'render', file: 'b.js', locked: true, lockedBy: 'worker-b', lockExpires: $later, pendingRelease: true})`, { later });
        await db.session.run(`CREATE (:Task {taskId: 'T-1', title: 'waits on a', status: 'blocked'})`);
        await db.session.run(`MATCH (t:Task {taskId: 'T-1'}), (n:Function {name: 'render', file: 'a.js'}) CREATE (t)-[:AFFECTS]->(n)`);

        const ambiguous = await call("approve_release", { nodeName: "render" });
        assert.equal(ambiguous.status, "AMBIGUOUS");
        assert.equal(ambiguous.candidates.length, 2);
        assert.equal(await lockOf("a.js"), "worker-a");

        const released = await call("approve_release", { nodeName: "render", file: "a.js" });
        assert.equal(released.status, "RELEASED");
        assert.equal(await lockOf("a.js"), null);
        assert.equal(await lockOf("b.js"), "worker-b");
        assert.deepEqual(released.tasksNowUnblocked.map(t => t.taskId), ["T-1"]);
    });

    it("reject_release accepts a nodeId", async () => {
        const id = (await db.session.run(
            `MATCH (n:Function {name: 'render', file: 'b.js'}) RETURN elementId(n) AS id`)).records[0].get("id");
        const rejected = await call("reject_release", { nodeName: "render", nodeId: id, reason: "tests missing" });
        assert.equal(rejected.status, "REJECTED");
        assert.equal(await lockOf("b.js"), "worker-b");
    });

    it("recover_stale_edit restores the crashed agent's backup and leaves other nodes locked", async () => {
        const stale = Date.now() - 600000;
        fs.writeFileSync(path.join(project, "c.js"), "function render( {\n");
        const token = createBackupToken("c.js", "worker-c", project);
        fs.writeFileSync(path.join(project, ".claude", "backups", `${token}.bak`), "function render() {}\n");
        await db.session.run(`CREATE (:Function {name: 'render', file: 'c.js', locked: true, lockedBy: 'worker-c', editInProgress: true, editInProgressSince: $stale})`, { stale });

        const result = await call("recover_stale_edit", { nodeName: "render" });
        assert.equal(result.status, "OK");
        assert.equal(result.fileRestored, true, JSON.stringify(result));
        assert.equal(fs.readFileSync(path.join(project, "c.js"), "utf8"), "function render() {}\n");
        assert.equal(await lockOf("c.js"), null);
        assert.equal(await lockOf("b.js"), "worker-b");
    });
});

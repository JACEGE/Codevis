const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, describe, it } = require("node:test");
require("../lib/tsx-userinfo-preload.cjs");
const { register } = require("tsx/cjs/api");

const unregister = register();
after(() => unregister());

// syncLockManifest schreibt .claude/locks.json unter das Projektverzeichnis.
const project = fs.mkdtempSync(path.join(os.tmpdir(), "codevis-lead-auth-"));
fs.mkdirSync(path.join(project, ".claude"));
const previousProject = process.env.CODEVIS_PROJECT_DIR;
process.env.CODEVIS_PROJECT_DIR = project;
after(() => {
    if (previousProject === undefined) delete process.env.CODEVIS_PROJECT_DIR;
    else process.env.CODEVIS_PROJECT_DIR = previousProject;
    fs.rmSync(project, { recursive: true, force: true });
});

// Ein Worker-Server ohne CODEVIS_AGENT_ID durfte die Lead-Prüfung überspringen,
// weil `callerAgentId && …` bei fehlender ID gar nicht erst prüfte.
describe("lead-only lock tools", () => {
    const { lockTools } = require("../tools/handlers/lock-tools.ts");
    const writes = [];
    const session = {
        run: async (cypher) => {
            if (/\bSET\b|DELETE/.test(cypher) && !/lockExpires <= timestamp\(\)/.test(cypher)) writes.push(cypher);
            return { records: [{ get: () => 0 }] };
        },
        close: async () => {},
    };
    const driver = { session: () => session };
    const ctx = { targetDriver: driver, metaDriver: driver, defaultAgentId: undefined };

    const call = async (name, args, role) => {
        const previous = process.env.CODEVIS_ROLE;
        if (role === undefined) delete process.env.CODEVIS_ROLE; else process.env.CODEVIS_ROLE = role;
        try {
            const result = await lockTools.handlers[name]({ ...args }, ctx);
            return JSON.parse(result.content[0].text);
        } finally {
            if (previous === undefined) delete process.env.CODEVIS_ROLE; else process.env.CODEVIS_ROLE = previous;
        }
    };

    for (const name of ["approve_release", "reject_release", "recover_stale_edit"]) {
        it(`${name} denies an anonymous worker`, async () => {
            writes.length = 0;
            const result = await call(name, { nodeName: "render", reason: "r" }, "worker");
            assert.equal(result.status, "DENIED");
            assert.deepEqual(writes, []);
        });

        it(`${name} denies a named non-lead agent`, async () => {
            const result = await call(name, { nodeName: "render", reason: "r", callerAgentId: "worker-1" });
            assert.equal(result.status, "DENIED");
        });

        it(`${name} ignores a lead ID a worker claims for itself`, async () => {
            writes.length = 0;
            const result = await call(name, { nodeName: "render", reason: "r", callerAgentId: "lead-x" }, "worker");
            assert.equal(result.status, "DENIED");
            assert.deepEqual(writes, []);
        });

        it(`${name} still admits an anonymous caller without a role`, async () => {
            const result = await call(name, { nodeName: "render", reason: "r" });
            assert.notEqual(result.status, "DENIED");
        });
    }
});

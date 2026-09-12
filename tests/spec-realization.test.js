#!/usr/bin/env node
/**
 * Spec -> Code binding as a REALIZED_BY edge, against a real Ladybug database.
 *
 * The binding used to live only as a uid in the `value` property. That form
 * cannot be trusted: a rename changes the target's uid, the spec node survives
 * the rebuild with the old one, and it keeps reporting status:'confirmed' while
 * pointing at nothing. Every member then reads as missing and reconcile emits
 * ghost tasks for code that exists.
 *
 * The decisive test here is the last one: after the code node is gone, the spec
 * node must report as unrealised. An edge cannot outlive its endpoint — that is
 * the entire reason for preferring it over a property.
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { openTestDb } = require("./helpers/ladybug-session.cjs");
const {
    importSpec, bindSpec, listUnrealizedSpecs, listUnspecifiedCode, relinkRealizations,
} = require("../scripts/spec/spec_db.cjs");

const PUML = fs.readFileSync(path.join(__dirname, "fixtures", "domain.puml"), "utf8");

// The fixture declares BaseEntity, Order, Repository, OrderRepo, LineItem.
// Only two of them get real code, so both directions of the coverage question
// have something to find.
// MERGE, not CREATE — the graph builder merges on (name, file) and the uid is
// derived from those, which is what makes a binding survive a rebuild at all.
async function seedCode(session) {
    for (const name of ["Order", "BaseEntity"]) {
        await session.run(`MERGE (c:Class {name: $name, file: $file})`,
            { name, file: `src/${name.toLowerCase()}.js` });
    }
    // Code with no diagram behind it.
    await session.run(`MERGE (c:Class {name: $name, file: $file})`,
        { name: "LegacyImporter", file: "src/legacy.js" });
}

const realizations = async (session) => {
    const res = await session.run(
        `MATCH (p)-[e:REALIZED_BY]->(c)
         RETURN p.name AS spec, p.label AS specLabel, c.name AS code, e.confidence AS confidence`);
    return res.records.map((r) => ({
        spec: r.get("spec"), specLabel: r.get("specLabel"),
        code: r.get("code"), confidence: r.get("confidence"),
    }));
};

describe("REALIZED_BY — spec bound to code", () => {
    let db, session;

    before(async () => {
        db = await openTestDb();
        session = db.session;
        await seedCode(session);
        await importSpec(session, { text: PUML, specId: "domain", kind: "class", sourceFile: "domain.puml" });
    });

    after(async () => { if (db) await db.cleanup(); });

    it("draws the edge for classes that auto-bound to code", async () => {
        const rows = await realizations(session);
        const pairs = rows.map((r) => `${r.spec}->${r.code}`).sort();
        assert.deepEqual(pairs, ["BaseEntity->BaseEntity", "Order->Order"]);
        assert.ok(rows.every((r) => r.confidence === "exact"), JSON.stringify(rows));
    });

    it("draws NO edge for classes with no code", async () => {
        const rows = await realizations(session);
        for (const ghost of ["Repository", "OrderRepo", "LineItem"]) {
            assert.ok(!rows.some((r) => r.spec === ghost), `${ghost} must not be realised`);
        }
    });

    it("answers 'specified but not built' from the graph", async () => {
        const open = (await listUnrealizedSpecs(session, "domain")).map((r) => r.name).sort();
        assert.deepEqual(open, ["LineItem", "OrderRepo", "Repository"]);
    });

    it("answers 'built but not specified' from the graph", async () => {
        const un = (await listUnspecifiedCode(session, ["Class"])).map((r) => r.name).sort();
        assert.deepEqual(un, ["LegacyImporter"]);
    });

    it("bindSpec draws the edge for a manual binding", async () => {
        await session.run(`CREATE (c:Class {name: $n, file: 'src/repo.js'})`, { n: "OrderRepository" });
        const res = await bindSpec(session, "domain", [{ alias: "OrderRepo", target: "OrderRepository" }]);
        assert.equal(res[0].status, "BOUND");
        assert.equal(res[0].realized, true, "binding reported success but drew no edge");

        const rows = await realizations(session);
        const row = rows.find((r) => r.spec === "OrderRepo");
        assert.ok(row, "OrderRepo has no REALIZED_BY edge after bindSpec");
        assert.equal(row.code, "OrderRepository");
        assert.equal(row.confidence, "manual");
    });

    it("re-binding replaces the edge instead of adding a second one", async () => {
        await session.run(`CREATE (c:Class {name: $n, file: 'src/repo2.js'})`, { n: "OrderRepoV2" });
        await bindSpec(session, "domain", [{ alias: "OrderRepo", target: "OrderRepoV2" }]);

        const rows = (await realizations(session)).filter((r) => r.spec === "OrderRepo");
        assert.equal(rows.length, 1, `OrderRepo is realised by ${rows.length} nodes at once`);
        assert.equal(rows[0].code, "OrderRepoV2");
    });
});

describe("REALIZED_BY — the edge cannot lie", () => {
    let db, session;

    before(async () => {
        db = await openTestDb();
        session = db.session;
        await seedCode(session);
        await importSpec(session, { text: PUML, specId: "domain", kind: "class", sourceFile: "domain.puml" });
    });

    after(async () => { if (db) await db.cleanup(); });

    it("reports unrealised once the code node is gone", async () => {
        // What a rebuild does to a renamed class: the old node disappears. The
        // spec node survives (it is on the rebuild preserve list) and keeps its
        // stale `value` uid — the property form would still claim 'confirmed'.
        const before = (await listUnrealizedSpecs(session, "domain")).map((r) => r.name);
        assert.ok(!before.includes("Order"), "Order should start out realised");

        await session.run(`MATCH (c:Class {name: 'Order'}) DETACH DELETE c`);

        const after = (await listUnrealizedSpecs(session, "domain")).map((r) => r.name);
        assert.ok(after.includes("Order"),
            "the code node is gone but the spec node still claims to be realised");

        // And the property is exactly as untrustworthy as advertised: it still
        // holds the dead uid. This is why the edge, not `value`, is the answer.
        const res = await session.run(
            `MATCH (p:SpecClass {name: 'Order'}) RETURN p.value AS uid, p.status AS status`);
        assert.ok(res.records[0].get("uid"), "value should still hold the stale uid (the rematch hint)");
        const dead = await session.run(
            `MATCH (c) WHERE c.uid = $uid RETURN c.uid AS uid`, { uid: res.records[0].get("uid") });
        assert.equal(dead.records.length, 0, "the uid in `value` must now point at nothing");
    });
});

describe("REALIZED_BY — surviving a rebuild", () => {
    let db, session;

    // What a rebuild does to one node. It MUST go through MERGE with the same
    // merge keys the builder uses: the uid is derived from (label + sorted merge
    // props), so MERGE reproduces it exactly. CREATE would NOT — the translator
    // allocates a fresh uid there and ignores any uid passed in the map, which
    // is precisely how this test failed the first time it was written.
    const rebuildNode = async (name, file) => {
        await session.run(`MATCH (c:Class {name: $name}) DETACH DELETE c`, { name });
        await session.run(`MERGE (c:Class {name: $name, file: $file})`, { name, file });
    };

    before(async () => {
        db = await openTestDb();
        session = db.session;
        await seedCode(session);
        await importSpec(session, { text: PUML, specId: "domain", kind: "class", sourceFile: "domain.puml" });
    });

    after(async () => { if (db) await db.cleanup(); });

    it("restores the edge for code that did not change", async () => {
        await rebuildNode("Order", "src/order.js");
        // Wiping the node took its edge with it, as it must.
        assert.ok((await listUnrealizedSpecs(session, "domain")).some((r) => r.name === "Order"));

        const { restored, stale } = await relinkRealizations(session);
        assert.ok(restored >= 1, `nothing was restored (stale: ${JSON.stringify(stale)})`);
        assert.ok(!(await listUnrealizedSpecs(session, "domain")).some((r) => r.name === "Order"),
            "an unchanged binding did not come back after the rebuild");
    });

    it("does NOT invent a binding for code that was renamed", async () => {
        // A rename produces a DIFFERENT uid — the hint must find nothing rather
        // than attach the spec node to whatever else is lying around.
        await session.run(`MATCH (c:Class {name: 'BaseEntity'}) DETACH DELETE c`);
        await session.run(`CREATE (c:Class {name: 'BaseRecord', file: 'src/baseentity.js'})`);

        const { stale } = await relinkRealizations(session);
        assert.ok(stale.some((s) => s.name === "BaseEntity"), "renamed binding should be reported stale");

        const rows = await realizations(session);
        assert.ok(!rows.some((r) => r.spec === "BaseEntity"),
            "BaseEntity must stay unrealised — a rename is exactly the case a rematch has to decide");
    });
});

#!/usr/bin/env node
/**
 * Integration test for class-diagram import — against a REAL Ladybug database.
 *
 * Everything else under tests/spec-*.test.js is a pure-parser test, so the DB
 * layer of the spec importer was never executed by the suite. This covers the
 * claim the feature actually makes: that importing a PlantUML class diagram
 * puts its STRUCTURE into the graph the same way parsed code is — real edges
 * between real nodes — rather than a flat bag of nodes that one reader
 * function reassembles on the fly.
 *
 * It also pins the two bugs that were found here:
 *   - class attributes (SpecField) must survive and be attached to their class
 *   - class→class and class→member links must be PERSISTED, not synthesised
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { openTestDb } = require("./helpers/ladybug-session.cjs");
const { importSpec, getSpecSubgraph } = require("../scripts/spec/spec_db.cjs");

const PUML = fs.readFileSync(path.join(__dirname, "fixtures", "domain.puml"), "utf8");

describe("class diagram import → graph", () => {
    let db, session, result, sub;

    before(async () => {
        db = await openTestDb();
        session = db.session;
        result = await importSpec(session, {
            text: PUML, specId: "domain", kind: "class", sourceFile: "domain.puml",
        });
        sub = await getSpecSubgraph(session, "domain");
    });

    after(async () => { if (db) await db.cleanup(); });

    const nodesOf = (label) => sub.nodes.filter((n) => n.labels[0] === label);
    const nameOf = (id) => (sub.nodes.find((n) => n.id === id) || {}).name;
    const edgesOf = (type) => sub.edges.filter((e) => e.relType === type);

    it("imports every class, including ones only named in a relation", () => {
        // LineItem has no class block in the fixture — it appears solely as the
        // target of `Order *-- LineItem`. The parser declares it implicitly, so
        // the composition below has a real node to point at.
        const names = nodesOf("SpecClass").map((n) => n.name).sort();
        assert.deepEqual(names, ["BaseEntity", "LineItem", "Order", "OrderRepo", "Repository"]);
    });

    it("imports attributes as SpecField nodes", () => {
        // `total : number` on Order and `+id : string` on BaseEntity.
        const fields = nodesOf("SpecField").map((n) => n.name).sort();
        assert.deepEqual(fields, ["id", "total"]);
    });

    it("attaches members to their OWNING class, not to the diagram", () => {
        const declares = edgesOf("DECLARES");
        const owned = declares.map((e) => `${nameOf(e.source)}.${nameOf(e.target)}`).sort();

        assert.ok(owned.includes("Order.total"), `expected Order.total in ${owned.join(", ")}`);
        assert.ok(owned.includes("BaseEntity.id"), `expected BaseEntity.id in ${owned.join(", ")}`);
        assert.ok(owned.includes("Order.submit"));
        assert.ok(owned.includes("Order.validate"));

        // Every member has exactly one parent — a member wired both to its class
        // and to the diagram would render twice.
        for (const m of [...nodesOf("SpecField"), ...nodesOf("SpecMethod")]) {
            const parents = sub.edges.filter((e) => e.target === m.id);
            assert.equal(parents.length, 1, `${m.name} has ${parents.length} parents`);
            assert.equal(parents[0].relType, "DECLARES");
        }
    });

    it("PERSISTS the structure — the edges are in the DB, not invented on read", async () => {
        // The point of the change: query the raw graph directly, bypassing
        // getSpecSubgraph entirely. If this returns nothing, the diagram is not
        // really in the graph, whatever the reader chooses to draw.
        const res = await session.run(
            `MATCH (k:SpecClass)-[:DECLARES]->(m) RETURN k.name AS cls, m.name AS member`);
        const pairs = res.records.map((r) => `${r.get("cls")}.${r.get("member")}`).sort();
        assert.ok(pairs.includes("Order.total"), `raw graph has: ${pairs.join(", ")}`);
        assert.ok(pairs.length >= 6, `expected all members persisted, got ${pairs.length}`);
    });

    it("stores inheritance as the code graph's own INHERITS edge", async () => {
        // Not a spec-only edge type: an imported hierarchy answers the same
        // INHERITS queries a parsed one does.
        const res = await session.run(
            `MATCH (a:SpecClass)-[:INHERITS]->(b:SpecClass) RETURN a.name AS child, b.name AS parent`);
        const pairs = res.records.map((r) => `${r.get("child")}->${r.get("parent")}`).sort();
        assert.deepEqual(pairs, ["Order->BaseEntity", "OrderRepo->Repository"]);
    });

    it("stores non-inheritance UML relations under their own type", async () => {
        // Association and composition share the SPEC_RELATES table (they have no
        // code counterpart) but keep their distinct UML type in `name`.
        const res = await session.run(
            `MATCH (a:SpecClass)-[e:SPEC_RELATES]->(b:SpecClass)
             RETURN a.name AS from, b.name AS to, e.name AS type`);
        const rows = res.records.map((r) => `${r.get("from")}-${r.get("type")}->${r.get("to")}`).sort();
        assert.deepEqual(rows, ["Order-association->OrderRepo", "Order-composition->LineItem"]);
    });

    it("draws every relation, and none into the void", () => {
        assert.equal(result.relationCount, 4);
        assert.equal(result.relationEdges, 4, "a relation lost its edge");
        // A dangling edge would render as a ghost node in the UI.
        for (const e of sub.edges) {
            assert.ok(sub.nodes.some((n) => n.id === e.target) || e.target === "domain",
                `edge points at a non-existent node: ${JSON.stringify(e)}`);
            assert.ok(sub.nodes.some((n) => n.id === e.source) || e.source === "domain",
                `edge starts at a non-existent node: ${JSON.stringify(e)}`);
        }
    });

    it("re-import is idempotent — no duplicate nodes or edges", async () => {
        await importSpec(session, {
            text: PUML, specId: "domain", kind: "class", sourceFile: "domain.puml",
        });
        const again = await getSpecSubgraph(session, "domain");
        assert.equal(again.nodes.length, sub.nodes.length, "node count changed on re-import");
        assert.equal(again.edges.length, sub.edges.length, "edge count changed on re-import");
    });
});

describe("class diagram subgraph — legacy specs without persisted edges", () => {
    let db, session;

    before(async () => {
        db = await openTestDb();
        session = db.session;
        // A spec as it was stored BEFORE edges were persisted: children hang off
        // the diagram by DERIVES only, ownership lives in `scope` as a name.
        await session.run(
            `CREATE (s:SpecClassDiagram {name: $id, title: $t, category: 'class'})`,
            { id: "old", t: "Legacy" });
        await session.run(
            `MATCH (s:SpecClassDiagram {name: $id})
             CREATE (k:SpecClass {name: 'Order', kind: 'class'}) MERGE (s)-[:DERIVES]->(k)`,
            { id: "old" });
        await session.run(
            `MATCH (s:SpecClassDiagram {name: $id})
             CREATE (f:SpecField {name: 'total', scope: 'Order'}) MERGE (s)-[:DERIVES]->(f)`,
            { id: "old" });
    });

    after(async () => { if (db) await db.cleanup(); });

    it("still reconstructs ownership by name, so old diagrams keep rendering", async () => {
        const sub = await getSpecSubgraph(session, "old");
        const cls = sub.nodes.find((n) => n.name === "Order");
        const fld = sub.nodes.find((n) => n.name === "total");
        assert.ok(cls && fld, "legacy nodes missing from subgraph");
        const declares = sub.edges.find((e) => e.relType === "DECLARES");
        assert.ok(declares, "legacy spec lost its class→member structure");
        assert.equal(declares.source, cls.id);
        assert.equal(declares.target, fld.id);
    });
});

#!/usr/bin/env node
/**
 * Unit tests for the Cypher → Ladybug/Kuzu translation layer.
 *
 * Pure-function tests — no daemon, no database, sub-second in CI.
 * The fixture table lives next to the translator itself
 * (server/ladybug-translate.cjs SELF_TEST_CASES) so new translation rules
 * add their cases in one place and both the manual self-test and this
 * suite pick them up.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { translate, SELF_TEST_CASES } = require("../server/ladybug-translate.cjs");

describe("ladybug-translate", () => {
    for (const [input, expected] of SELF_TEST_CASES) {
        it(`translates: ${input.slice(0, 70)}`, () => {
            const { cypher } = translate(input);
            assert.equal(cypher, expected);
        });
    }

    it("flags timestamp() queries for __now injection", () => {
        const { injectNow } = translate("SET n.updatedAt = timestamp()");
        assert.equal(injectNow, true);
    });

    it("does not flag timestamp-free queries", () => {
        const { injectNow } = translate("MATCH (n) RETURN n.name");
        assert.equal(injectNow, false);
    });

    it("rejects an unterminated backtick-quoted identifier clearly", () => {
        assert.throws(
            () => translate("MATCH (n:`Weird Label) RETURN n"),
            /Unterminated backtick-quoted identifier at offset \d+/,
        );
    });

    it("registers CREATE identity placeholders for node CREATEs", () => {
        const { creates } = translate("CREATE (t:Task {taskId: $id, title: $t})");
        assert.ok(Array.isArray(creates) && creates.length === 1, "one CREATE pattern expected");
        assert.ok(creates[0].seqParam, "seq placeholder expected");
    });

    // Node patterns whose '(' is NOT preceded by a classic introducer keyword
    // (MATCH/MERGE/CREATE/OPTIONAL/comma/rel). These used to be mis-rewritten by
    // the boolean-label rule (rule 5) into `x.label = '…'` booleans, which are
    // invalid where a node pattern is required.
    it("keeps a fixed-length named path's node patterns intact (not booleans)", () => {
        const { cypher } = translate(
            "MATCH p = (a:File)-[:CONTAINS]->(b:Function) RETURN p");
        assert.equal(
            cypher,
            "MATCH p = (a:CodeNode {label:'File'})-[:CONTAINS]->(b:CodeNode {label:'Function'}) RETURN p");
        assert.ok(!/a\.label\s*=/.test(cypher), "node var must not become a boolean");
    });

    it("keeps shortestPath() node patterns intact", () => {
        const { cypher } = translate(
            "MATCH p = shortestPath((a:Function)-[:CALLS*1..6]-(b:Function)) RETURN p");
        assert.equal(
            cypher,
            "MATCH p = shortestPath((a:CodeNode {label:'Function'})-[:CALLS*1..6]-(b:CodeNode {label:'Function'})) RETURN p");
        assert.ok(!/a\.label\s*=/.test(cypher), "node var must not become a boolean");
    });

    it("keeps a WHERE NOT pattern predicate's node patterns intact", () => {
        const { cypher } = translate(
            "MATCH (n) WHERE NOT (n:File)-[:IMPORTS]->(:File) RETURN n");
        assert.equal(
            cypher,
            "MATCH (n) WHERE NOT (n:CodeNode {label:'File'})-[:IMPORTS]->(:CodeNode {label:'File'}) RETURN n");
        assert.ok(!/n\.label\s*=/.test(cypher), "node var must not become a boolean");
    });

    // A parenthesised boolean group (no relationship following) must STILL be
    // rewritten by rule 5 — the fix must not turn every `NOT (…)` into a pattern.
    it("still rewrites a NOT-grouped boolean label predicate (no rel follows)", () => {
        const { cypher } = translate(
            "MATCH (n) WHERE NOT (n:Function OR n:Task) RETURN n");
        assert.equal(
            cypher,
            "MATCH (n) WHERE NOT (n.label = 'Function' OR n.label = 'Task') RETURN n");
    });

    // The MERGE-derived uid is the single-table primary key. It must not depend
    // on the order the caller wrote the business keys, or the same logical node
    // gets two different uids → duplicate nodes.
    it("derives an order-independent uid from MERGE business keys", () => {
        const uidOf = (q) => (translate(q).cypher.match(/uid: ([^}]+)}/) || [])[1];
        const a = uidOf("MERGE (s:State {name:'x', file:'y'})");
        const b = uidOf("MERGE (s:State {file:'y', name:'x'})");
        assert.ok(a, "uid expression expected");
        assert.equal(a, b, "uid must be identical regardless of key order");
    });

    it("rewrites a fold-in-only node pattern to its boolean column", () => {
        const { cypher } = translate("MATCH (n:Component) RETURN count(n)");
        assert.equal(cypher, "MATCH (n:CodeNode {isComponent:true}) RETURN count(n)");
    });

    it("keeps the primary label and every supported fold-in in multi-label patterns", () => {
        const { cypher } = translate(
            "MATCH (n:Function:Hook:Async:Component {name:$name}) RETURN n");
        assert.equal(
            cypher,
            "MATCH (n:CodeNode {label:'Function', isHook:true, isAsync:true, isComponent:true, name:$name}) RETURN n",
        );
    });

    it("rejects unsupported secondary labels instead of silently dropping them", () => {
        assert.throws(
            () => translate("MATCH (n:Function:UnmodelledFacet) RETURN n"),
            /unsupported multi-label node pattern.*UnmodelledFacet/i,
        );
    });

    it("sets MERGE fold-ins for existing nodes as well as newly-created nodes", () => {
        const { cypher } = translate(
            "MERGE (func:Function:Component {name: $funcName, file: $path}) SET func.signature = $sig");
        assert.match(cypher, /ON CREATE SET .*func\.isComponent = true/);
        assert.match(cypher, /\bSET func\.isComponent = true, func\.label = func\.label, func\.signature = \$sig$/);
    });
});

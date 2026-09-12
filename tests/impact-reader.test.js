"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { analyzeImpactFromSession } = require("../scripts/impact/impact_reader.cjs");

test("node caps inspect the boundary and report omitted transitive callers", async () => {
    const sessionFor = (edges) => ({ run: async (query, params = {}) => {
        if (query.startsWith("MATCH (n)")) return { records: [record(node("n", "seed", "seed", "src/a.js"))] };
        return { records: query.includes("[r:CALLS]") ? edges
            .filter(([, to]) => Object.values(params).includes(to))
            .map(([from, to]) => record({ ...node("a", from, from, "src/a.js"),
                ...node("b", to, to, "src/a.js"), confidence: "exact" })) : [] };
    } });
    const options = { seed: { id: "seed" }, relations: ["CALLS"], direction: "in", depth: 2,
        graphFreshness: { state: "current" } };
    for (const maxNodes of [1, 2]) {
        const result = await analyzeImpactFromSession(sessionFor([["caller", "seed"], ["transitive", "caller"]]), { ...options, maxNodes });
        assert.equal(result.truncation.truncated, true);
        assert.ok(result.truncation.omittedNodes > 0);
        assert.equal(result.testSelection.complete, false);
        assert.equal(result.knowledgeReview.complete, false);
        assert.ok(result.analysisQuality.limitations.includes("node-limit-reached"));
    }
    const exhausted = await analyzeImpactFromSession(sessionFor([["caller", "seed"]]), { ...options, maxNodes: 2 });
    assert.equal(exhausted.truncation.truncated, false);
    const depthLimited = await analyzeImpactFromSession(sessionFor([["caller", "seed"], ["transitive", "caller"]]), { ...options, maxNodes: 2, depth: 1 });
    assert.equal(depthLimited.truncation.truncated, false);
});

function record(values) { return { get: (key) => values[key] }; }
function node(prefix, id, name, file, extras = {}) {
    return { [`${prefix}Id`]: id, [`${prefix}Labels`]: [extras.label || "Function"], [`${prefix}Label`]: extras.label || "Function",
        [`${prefix}Name`]: name, [`${prefix}Title`]: null, [`${prefix}File`]: file, [`${prefix}Path`]: null,
        [`${prefix}StartLine`]: 1, [`${prefix}EndLine`]: 2, [`${prefix}IsTest`]: extras.isTest || false };
}

test("database adapter uses stable element IDs and typed edge scans", async () => {
    const queries = [];
    const session = { run: async (query, params) => {
        queries.push({ query, params });
        if (query.startsWith("MATCH (n)")) return { records: [record(node("n", "Function|save|src/a.js", "save", "src/a.js"))] };
        if (query.includes("[r:CALLS]")) return { records: [record({ ...node("a", "Function|caller|src/b.js", "caller", "src/b.js"),
            ...node("b", "Function|save|src/a.js", "save", "src/a.js"), confidence: "exact", resolvedBy: "named-import" })] };
        return { records: [] };
    } };
    const result = await analyzeImpactFromSession(session, { seed: { id: "Function|save|src/a.js" }, relations: ["CALLS"], depth: 1,
        graphFreshness: { state: "current", staleFiles: [] } });
    assert.equal(result.seed.id, "Function|save|src/a.js");
    assert.deepEqual(result.impacted.map((item) => item.id), ["Function|caller|src/b.js"]);
    assert.ok(queries.some(({ query }) => query.includes("elementId(n) = $id")));
    assert.ok(queries.every(({ query }) => !query.includes(" IN $ids")));
});

test("database adapter reports ambiguous candidates instead of guessing", async () => {
    const session = { run: async () => ({ records: [
        record(node("n", "one", "save", "a.js")), record(node("n", "two", "save", "b.js")),
    ] }) };
    await assert.rejects(() => analyzeImpactFromSession(session, { seed: { name: "save" }, relations: [] }),
        (error) => error.code === "AMBIGUOUS_SEED" && error.candidates.length === 2);
});

test("database adapter only reads edges incident to the bounded frontier", async () => {
    const queries = [];
    const session = { run: async (query, params = {}) => {
        queries.push({ query, params });
        if (query.startsWith("MATCH (n)")) return { records: [record(node("n", "seed", "save", "src/a.js"))] };
        if (query.includes("[r:CALLS]") && Object.values(params).includes("seed")) return { records: [record({
            ...node("a", "caller", "caller", "src/b.js"), ...node("b", "seed", "save", "src/a.js"),
            confidence: "exact", resolvedBy: "named-import",
        })] };
        return { records: [] };
    } };
    const result = await analyzeImpactFromSession(session, { seed: { id: "seed" }, relations: ["CALLS"],
        direction: "in", depth: 1, graphFreshness: { state: "current", staleFiles: [] } });
    assert.deepEqual(result.impacted.map((item) => item.id), ["caller"]);
    const edgeQueries = queries.filter(({ query }) => query.includes("-[r:"));
    assert.ok(edgeQueries.length > 0);
    assert.ok(edgeQueries.every(({ query }) => query.includes("elementId(")));
    assert.ok(edgeQueries.every(({ query }) => query.includes("WHERE")));
    assert.ok(edgeQueries.every(({ query }) => !/MATCH \(a\)-\[r:[A-Z_]+\]->\(b\) RETURN/.test(query)));
});

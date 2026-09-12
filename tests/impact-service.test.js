"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { analyzeImpact, edgeConfidence, resolveSeed } = require("../scripts/impact/impact_service.cjs");

test('node-limit omissions count unique nodes reached by multiple paths', () => {
    const result = analyzeImpact({
        nodes: ['seed', 'left', 'right', 'omitted'].map(id => ({ id, label: 'Function', name: id })),
        edges: [['seed', 'left'], ['seed', 'right'], ['left', 'omitted'], ['right', 'omitted']]
            .map(([from, to]) => ({ from, to, relType: 'CALLS' })),
        seed: 'seed', direction: 'out', depth: 2, relations: ['CALLS'], maxNodes: 3,
    });
    assert.equal(result.truncation.truncated, true);
    assert.equal(result.truncation.omittedNodes, 1);
});

const nodes = [
    { id: "a", label: "Function", name: "save", file: "src/save.js", startLine: 1 },
    { id: "b", label: "Function", name: "controller", file: "src/api.js", startLine: 2 },
    { id: "c", label: "Function", name: "route", file: "src/route.js", startLine: 3 },
    { id: "d", label: "Function", name: "alternate", file: "src/alternate.js", startLine: 4 },
    { id: "t", label: "Function", name: "save test", file: "tests/save.test.js", isTest: true },
    { id: "task", label: "Task", title: "Change save" },
    { id: "spec", label: "Spec", name: "Save flow" },
    { id: "knowledge", label: "Knowledge", name: "Persistence rule" },
];

const edges = [
    { from: "b", to: "a", relType: "CALLS", resolvedBy: "named-import" },
    { from: "c", to: "b", relType: "CALLS", confidence: "likely" },
    { from: "d", to: "b", relType: "CALLS", confidence: "possible" },
    { from: "c", to: "d", relType: "CALLS", confidence: "exact" },
    { from: "a", to: "c", relType: "CALLS", confidence: "exact" }, // cycle
    { from: "t", to: "b", relType: "CALLS", confidence: "exact" },
    { from: "task", to: "a", relType: "AFFECTS" },
    { from: "spec", to: "b", relType: "REALIZED_BY" },
    { from: "knowledge", to: "a", relType: "APPLIES_TO" },
];

test("resolves only unambiguous seeds", () => {
    assert.equal(resolveSeed(nodes, { name: "save" }).id, "a");
    assert.throws(() => resolveSeed([...nodes, { id: "a2", label: "Function", name: "save", file: "other.js" }], { name: "save" }),
        (error) => error.code === "AMBIGUOUS_SEED" && error.candidates.length === 2);
    assert.throws(() => resolveSeed(nodes, { name: "missing" }), (error) => error.code === "SEED_NOT_FOUND");
});

test("returns bounded shortest incoming paths with inherited confidence", () => {
    const result = analyzeImpact({ nodes, edges, seed: { id: "a" }, depth: 3, relations: ["CALLS"] });
    assert.deepEqual(result.impacted.map((node) => [node.id, node.distance, node.confidence]), [
        ["b", 1, "exact"], ["d", 2, "possible"], ["c", 2, "likely"], ["t", 2, "exact"],
    ]);
    assert.equal(result.impacted.find((node) => node.id === "c").paths.length, 1);
    assert.ok(result.impacted.every((node) => node.paths.every((path) => path.length === node.distance)));
});

test("keeps multiple shortest paths deterministically", () => {
    const graphEdges = [
        { from: "b", to: "a", relType: "CALLS", confidence: "exact" },
        { from: "d", to: "a", relType: "CALLS", confidence: "exact" },
        { from: "c", to: "b", relType: "CALLS", confidence: "exact" },
        { from: "c", to: "d", relType: "CALLS", confidence: "exact" },
    ];
    const result = analyzeImpact({ nodes, edges: graphEdges.reverse(), seed: "a", depth: 2, relations: ["CALLS"] });
    assert.equal(result.impacted.find((node) => node.id === "c").paths.length, 2);
});

test("reports related work and knowledge in explicit sections", () => {
    const result = analyzeImpact({ nodes, edges, seed: "a", depth: 1, relations: ["CALLS"] });
    assert.deepEqual(result.attachments.tasks.map((node) => node.id), ["task"]);
    assert.deepEqual(result.attachments.specs.map((node) => node.id), ["spec"]);
    assert.deepEqual(result.attachments.knowledge.map((node) => node.id), ["knowledge"]);
    assert.deepEqual(result.attachments.tests.map((node) => node.id), ["t"]);
});

test("stale state degrades confidence and caps are explicit", () => {
    const result = analyzeImpact({ nodes, edges, seed: "a", depth: 3, relations: ["CALLS"], maxNodes: 2,
        graphFreshness: { state: "stale", staleFiles: ["src/save.js"] } });
    assert.equal(result.impacted[0].confidence, "unknown");
    assert.equal(result.truncation.truncated, true);
    assert.ok(result.truncation.omittedNodes > 0);
    assert.deepEqual(result.graphFreshness.staleFiles, ["src/save.js"]);
});

test("edge confidence is conservative and evidence-backed", () => {
    assert.equal(edgeConfidence({ relType: "CALLS", resolvedBy: "receiver-type" }), "exact");
    assert.equal(edgeConfidence({ relType: "CALLS", resolvedBy: "heuristic" }), "likely");
    assert.equal(edgeConfidence({ relType: "CALLS" }), "unknown");
    assert.equal(edgeConfidence({ relType: "AFFECTS" }), "exact");
});

test("selects affected test functions without claiming completeness", () => {
    const result = analyzeImpact({ nodes, edges, seed: "a", depth: 2, relations: ["CALLS"] });
    assert.equal(result.testSelection.status, "selected");
    assert.equal(result.testSelection.complete, true);
    assert.deepEqual(result.testSelection.selected.map((node) => node.id), ["t"]);
    assert.equal(result.testSelection.selected[0].selectedBy, "impact-path");
    assert.match(result.testSelection.note, /not a substitute/);
});

test("recognizes common test paths and reports incomplete selections", () => {
    const testNode = { id: "vitest", label: "Function", name: "works", file: "src/save.spec.ts" };
    const result = analyzeImpact({ nodes: [...nodes, testNode], edges: [...edges,
        { from: "vitest", to: "a", relType: "CALLS", confidence: "exact" }], seed: "a", depth: 1,
        relations: ["CALLS"], maxNodes: 1 });
    assert.equal(result.testSelection.status, "incomplete");
    assert.equal(result.testSelection.complete, false);
    assert.equal(result.testSelection.selected.length, 1);
    assert.equal(result.testSelection.selected[0].selectedBy, "direct-relation");
    assert.match(result.testSelection.note, /not a substitute/);
});

test("marks linked knowledge for review without claiming it is stale", () => {
    const result = analyzeImpact({ nodes, edges, seed: "a", depth: 1, relations: ["CALLS"] });
    assert.equal(result.knowledgeReview.status, "review-recommended");
    assert.deepEqual(result.knowledgeReview.candidates.map((node) => node.id), ["knowledge"]);
    assert.equal(result.knowledgeReview.candidates[0].status, "review-recommended");
    assert.match(result.knowledgeReview.note, /does not claim/);
});

test("reports evidence quality as counts and limitations, not fake coverage", () => {
    const result = analyzeImpact({ nodes, edges, seed: "a", depth: 2, relations: ["CALLS"] });
    assert.deepEqual(result.analysisQuality.confidence, { exact: 2, likely: 1, possible: 1, unknown: 0 });
    assert.equal(result.analysisQuality.traversedUniqueEdges, 4);
    assert.deepEqual(result.analysisQuality.limitations, ["multi-target-or-heuristic-evidence"]);
    assert.match(result.analysisQuality.note, /not total parser coverage/);
});

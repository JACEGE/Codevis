"use strict";
const test = require("node:test"); const assert = require("node:assert/strict"); const { createQualityBaseline, evaluateQualityBaseline, evaluateQualityGates } = require("../scripts/parser/analysis_quality_gate.cjs");
const report = { graphFreshness: { state: "current" }, measured: [{ language: "js", internalResolutionPercent: 80 }, { language: "xml", internalResolutionPercent: null }], totals: { parseErrors: 1 }, declared: [{ extension: ".js", supportedCapabilities: ["func", "call"] }] };
test("stale and unknown evidence cannot pass gates or create baselines", () => {
    for (const graphFreshness of [{ state: "stale" }, { state: "unknown" }, undefined]) {
        const outdated = { ...report, graphFreshness };
        const gate = evaluateQualityGates(outdated, { minResolution: 70, maxParseErrors: 1 });
        assert.equal(gate.passed, false);
        assert.deepEqual(gate.failures.map(f => f.gate), ["graph-freshness"]);
        assert.throws(() => createQualityBaseline(outdated), /Rebuild the graph/);
    }
});
test("quality gates fail with structured evidence and ignore unmeasured ratios", () => { const result = evaluateQualityGates(report, { minResolution: 90, maxParseErrors: 0, requiredCapabilities: [".js:callback"] }); assert.equal(result.passed, false); assert.deepEqual(result.failures.map(f => f.gate), ["min-resolution", "max-parse-errors", "required-capability"]); assert.ok(!result.failures.some(f => f.language === "xml")); });
test("quality gates pass explicit achievable requirements", () => { assert.deepEqual(evaluateQualityGates(report, { minResolution: 80, maxParseErrors: 1, requiredCapabilities: [".js:call"] }), { passed: true, failures: [] }); assert.throws(() => evaluateQualityGates(report, { requiredCapabilities: ["broken"] }), /\.ext:capability/); });
test("quality baselines detect language regressions without inventing unmeasured coverage", () => { const baseline = createQualityBaseline(report); assert.deepEqual(Object.keys(baseline.languages), ["js"]); const regressed = { ...report, measured: [{ language: "js", internalResolutionPercent: 77, parseErrors: 2 }, { language: "xml", internalResolutionPercent: null, parseErrors: 0 }] }; const result = evaluateQualityBaseline(regressed, baseline, { maxRegression: 2 }); assert.equal(result.passed, false); assert.deepEqual(result.failures.map((failure) => failure.gate), ["baseline-resolution", "baseline-parse-errors"]); });

test("baseline measurements cannot disappear and silently pass", () => {
    const baseline = createQualityBaseline(report);
    for (const measured of [[], [{ language: 'js', internalResolutionPercent: null }]]) {
        const result = evaluateQualityBaseline({ ...report, measured }, baseline);
        assert.equal(result.passed, false);
        assert.equal(result.failures[0].gate, 'baseline-resolution');
        assert.equal(result.failures[0].language, 'js');
        assert.equal(result.failures[0].actual, null);
    }
});

test("malformed baseline measurements fail validation", () => {
    for (const languages of [[], { js: {} }, { js: { internalResolutionPercent: '80' } },
        { js: { internalResolutionPercent: 101 } }, { js: { internalResolutionPercent: 80, parseErrors: -1 } }]) {
        assert.throws(() => evaluateQualityBaseline(report, { version: 1, languages }), /Invalid quality baseline/);
    }
});

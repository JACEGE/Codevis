"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildAnalysisQualityReport } = require("../scripts/parser/analysis_quality_report.cjs");

const record = (values) => ({ get: (key) => values[key] });

test("quality report separates measured resolution from declared capability", async () => {
    const session = { run: async () => ({ records: [
        record({ language: "js", callSites: 10, externalCallSites: 4, internalCallSites: 6, callsResolved: 5, parseStatus: "current" }),
        record({ language: "js", callSites: 5, externalCallSites: 2, internalCallSites: 3, callsResolved: 1, parseStatus: "parse_error" }),
        record({ language: "py", callSites: 2, externalCallSites: 2, internalCallSites: 0, callsResolved: 0, parseStatus: "current" }),
    ] }) };
    const report = await buildAnalysisQualityReport(session, { ".js": { extension: ".js", wasm: "js.wasm", capabilities: { func: true, callback: false } } });
    assert.deepEqual(report.measured[0], { language: "js", files: 2, parseErrors: 1, allSites: 15, externalSites: 6,
        internalSites: 9, resolvedInternalSites: 6, internalResolutionPercent: 66.7, legacyOverallResolutionPercent: null });
    assert.equal(report.measured[1].internalResolutionPercent, null);
    assert.deepEqual(report.declared[0].supportedCapabilities, ["func"]);
    assert.deepEqual(report.declared[0].unsupportedCapabilities, ["callback"]);
    assert.match(report.note, /not semantic completeness/);
});

test("quality report degrades honestly for graphs built before internal/external counters", async () => {
    let calls = 0;
    const session = { run: async () => { calls++; if (calls === 1) throw new Error("Cannot find property externalCallSites for f");
        return { records: [record({ language: "js", callSites: 10, callsResolved: 4, parseStatus: null })] }; } };
    const report = await buildAnalysisQualityReport(session, {});
    assert.equal(report.measurementSchema, "legacy-overall-v0");
    assert.equal(report.measured[0].internalResolutionPercent, null);
    assert.equal(report.measured[0].legacyOverallResolutionPercent, 40);
    assert.match(report.note, /Rebuild the graph/);
});

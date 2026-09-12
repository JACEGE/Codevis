"use strict";
function evaluateQualityGates(report, { minResolution = null, maxParseErrors = null, requiredCapabilities = [] } = {}) {
    const failures = [];
    if (report.graphFreshness?.state !== "current") failures.push({ gate: "graph-freshness", actual: report.graphFreshness?.state || "unknown", expected: "current" });
    if (minResolution != null) for (const row of report.measured) if (row.internalResolutionPercent != null && row.internalResolutionPercent < minResolution) failures.push({ gate: "min-resolution", language: row.language, actual: row.internalResolutionPercent, expected: minResolution });
    if (maxParseErrors != null && report.totals.parseErrors > maxParseErrors) failures.push({ gate: "max-parse-errors", actual: report.totals.parseErrors, expected: maxParseErrors });
    const declared = new Map(report.declared.map((entry) => [entry.extension, new Set(entry.supportedCapabilities)]));
    for (const requirement of requiredCapabilities) { const [extension, capability] = String(requirement).split(":"); if (!extension || !capability) throw new Error(`Invalid capability requirement '${requirement}'. Use .ext:capability.`); if (!declared.get(extension)?.has(capability)) failures.push({ gate: "required-capability", extension, capability }); }
    return { passed: failures.length === 0, failures };
}

function createQualityBaseline(report) {
    if (report.graphFreshness?.state !== "current") throw new Error("Rebuild the graph before saving a quality baseline; graph freshness must be current.");
    return { version: 1, languages: Object.fromEntries(report.measured
        .filter((row) => row.internalResolutionPercent != null)
        .map((row) => [row.language, { internalResolutionPercent: row.internalResolutionPercent,
            parseErrors: row.parseErrors || 0 }])) };
}

function evaluateQualityBaseline(report, baseline, { maxRegression = 0 } = {}) {
    if (!baseline || baseline.version !== 1 || !baseline.languages || typeof baseline.languages !== "object" || Array.isArray(baseline.languages)) {
        throw new Error("Invalid quality baseline. Expected { version: 1, languages: {...} }.");
    }
    if (!Number.isFinite(maxRegression) || maxRegression < 0 || maxRegression > 100) {
        throw new Error("maxRegression must be from 0 to 100");
    }
    const failures = [];
    const measured = new Map(report.measured.map(row => [row.language, row]));
    for (const [language, expected] of Object.entries(baseline.languages)) {
        if (!expected || !Number.isFinite(expected.internalResolutionPercent)
            || expected.internalResolutionPercent < 0 || expected.internalResolutionPercent > 100
            || !Number.isInteger(expected.parseErrors ?? 0) || (expected.parseErrors ?? 0) < 0) {
            throw new Error(`Invalid quality baseline measurement for '${language}'.`);
        }
        const row = measured.get(language);
        if (!Number.isFinite(row?.internalResolutionPercent)
            || row.internalResolutionPercent < expected.internalResolutionPercent - maxRegression) {
            failures.push({ gate: "baseline-resolution", language,
                actual: row?.internalResolutionPercent ?? null, expected: expected.internalResolutionPercent,
                maxRegression });
        }
        if ((row?.parseErrors || 0) > (expected.parseErrors || 0)) failures.push({ gate: "baseline-parse-errors",
            language: row.language, actual: row.parseErrors || 0, expected: expected.parseErrors || 0 });
    }
    return { passed: failures.length === 0, failures };
}
module.exports = { createQualityBaseline, evaluateQualityBaseline, evaluateQualityGates };

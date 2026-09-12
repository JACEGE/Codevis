"use strict";

const { inspectGraphFreshness } = require("../impact/graph_freshness.cjs");

function num(value) { return value && typeof value.toNumber === "function" ? value.toNumber() : Number(value || 0); }

async function buildAnalysisQualityReport(session, capabilities, sourceContext) {
    let result;
    let measurementSchema = "internal-external-v1";
    try {
        result = await session.run(`MATCH (f:File) RETURN f.path AS path, f.language AS language, f.callSites AS callSites, f.externalCallSites AS externalCallSites, f.internalCallSites AS internalCallSites, f.callsResolved AS callsResolved, f.parseStatus AS parseStatus`);
    } catch (error) {
        if (!/Cannot find property|property .*not found/i.test(error?.message || "")) throw error;
        measurementSchema = "legacy-overall-v0";
        result = await session.run(`MATCH (f:File) RETURN f.path AS path, f.language AS language, f.callSites AS callSites, f.callsResolved AS callsResolved, f.parseStatus AS parseStatus`);
    }
    const languages = new Map();
    for (const record of result.records) {
        const language = String(record.get("language") || "unknown").toLowerCase();
        if (!languages.has(language)) languages.set(language, { language, files: 0, parseErrors: 0, allSites: 0, externalSites: 0, internalSites: 0, resolvedInternalSites: 0 });
        const row = languages.get(language); row.files++;
        if (record.get("parseStatus") === "parse_error") row.parseErrors++;
        row.allSites += num(record.get("callSites")); row.externalSites += num(record.get("externalCallSites"));
        row.internalSites += num(record.get("internalCallSites")); row.resolvedInternalSites += num(record.get("callsResolved"));
    }
    const measured = [...languages.values()].map((row) => ({ ...row,
        internalResolutionPercent: measurementSchema === "internal-external-v1" && row.internalSites ? Math.round(1000 * row.resolvedInternalSites / row.internalSites) / 10 : null,
        legacyOverallResolutionPercent: measurementSchema === "legacy-overall-v0" && row.allSites ? Math.round(1000 * row.resolvedInternalSites / row.allSites) / 10 : null,
    })).sort((a, b) => a.language.localeCompare(b.language));
    const declared = Object.values(capabilities || {}).map((entry) => ({ extension: entry.extension, wasm: entry.wasm,
        supportedCapabilities: Object.entries(entry.capabilities).filter(([, enabled]) => enabled).map(([name]) => name).sort(),
        unsupportedCapabilities: Object.entries(entry.capabilities).filter(([, enabled]) => !enabled).map(([name]) => name).sort(),
    })).sort((a, b) => a.extension.localeCompare(b.extension));
    return {
        graphFreshness: sourceContext?.projectRoot
            ? await inspectGraphFreshness(session, sourceContext)
            : { state: "unknown", staleFiles: [] },
        measured, declared, measurementSchema,
        totals: measured.reduce((total, row) => ({ files: total.files + row.files, parseErrors: total.parseErrors + row.parseErrors,
            internalSites: total.internalSites + row.internalSites, resolvedInternalSites: total.resolvedInternalSites + row.resolvedInternalSites }),
        { files: 0, parseErrors: 0, internalSites: 0, resolvedInternalSites: 0 }),
        note: measurementSchema === "internal-external-v1"
            ? "Resolution percentages cover observed internal callsites only. Declared capabilities show configured queries, not semantic completeness."
            : "Legacy graph: internal and external callsites are not separated, so internal resolution is unavailable. Rebuild the graph to enable comparable quality metrics.",
    };
}

module.exports = { buildAnalysisQualityReport };

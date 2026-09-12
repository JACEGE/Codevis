"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const { collectSourceFiles } = require("../../lib/source-files.cjs");

async function inspectGraphFreshness(session, { projectRoot, sourceDirs, exclude = [], maxStaleFiles = 50 }) {
    const { files, sourceErrors } = collectSourceFiles(projectRoot, sourceDirs, { exclude });
    const disk = new Map();
    for (const absolute of files) {
        try {
            disk.set(path.relative(projectRoot, absolute).replace(/\\/g, "/"),
                { absolute, mtime: Math.ceil(fs.statSync(absolute).mtimeMs) });
        } catch (error) {
            sourceErrors.push({ path: absolute, code: error.code, message: error.message });
        }
    }
    const result = await session.run(`MATCH (f:File) RETURN f.path AS path, f.sourceMtime AS sourceMtime, f.lastParsed AS lastParsed, f.contentHash AS contentHash, f.parseStatus AS parseStatus`);
    const graph = new Map(result.records.map((record) => [record.get("path"), {
        sourceMtime: Number(record.get("sourceMtime") ?? record.get("lastParsed") ?? 0),
        contentHash: record.get("contentHash"), parseStatus: record.get("parseStatus"),
    }]));
    const stale = new Set();
    for (const [file, state] of disk) {
        const parsed = graph.get(file);
        let changed = !parsed || state.mtime > parsed.sourceMtime || parsed.parseStatus === "parse_error";
        if (!changed && parsed.contentHash) {
            try {
                changed = crypto.createHash("sha256").update(fs.readFileSync(state.absolute)).digest("hex") !== parsed.contentHash;
            } catch (_) { changed = true; }
        }
        if (changed) stale.add(file);
    }
    for (const file of graph.keys()) if (!disk.has(file)) stale.add(file);
    const staleFiles = [...stale].sort();
    return { state: sourceErrors.length ? "unknown" : staleFiles.length ? "stale" : disk.size ? "current" : "unknown", staleFileCount: staleFiles.length,
        staleFiles: staleFiles.slice(0, maxStaleFiles), truncated: staleFiles.length > maxStaleFiles, sourceErrors };
}

module.exports = { inspectGraphFreshness };

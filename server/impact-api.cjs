"use strict";

const { analyzeImpactFromSession } = require("../scripts/impact/impact_reader.cjs");

function integer(value, fallback, min, max, name) {
    const parsed = value == null ? fallback : Number(value);
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
    return parsed;
}

function parseImpactRequest(body = {}) {
    if (!body.nodeId && !body.name) throw new Error("nodeId or name is required");
    const direction = body.direction || "in";
    if (!["in", "out", "both"].includes(direction)) throw new Error("direction must be in, out, or both");
    const relations = body.relations == null ? undefined : body.relations;
    if (relations && (!Array.isArray(relations) || relations.some((rel) => !/^[A-Z][A-Z0-9_]*$/.test(rel)))) {
        throw new Error("relations must contain uppercase relationship names");
    }
    const parsed = {
        seed: body.nodeId ? { id: String(body.nodeId) } : { name: body.name, file: body.file, label: body.label },
        profile: body.profile || "balanced", relations,
    };
    if (!["fast", "balanced", "deep"].includes(parsed.profile)) throw new Error("profile must be fast, balanced, or deep");
    if (body.direction != null) parsed.direction = direction;
    if (body.depth != null) parsed.depth = integer(body.depth, 2, 0, 8, "depth");
    if (body.maxNodes != null) parsed.maxNodes = integer(body.maxNodes, 200, 1, 2000, "maxNodes");
    if (body.maxPathsPerNode != null) parsed.maxPathsPerNode = integer(body.maxPathsPerNode, 3, 1, 10, "maxPathsPerNode");
    return parsed;
}

async function runImpactRequest(session, body, context) {
    return analyzeImpactFromSession(session, {
        ...parseImpactRequest(body), projectRoot: context.projectRoot, sourceDirs: context.sourceDirs || [], exclude: context.exclude || [],
    });
}

module.exports = { parseImpactRequest, runImpactRequest };

"use strict";

const { analyzeImpact, DEFAULT_RELATIONS } = require("./impact_service.cjs");
const { isTestPath } = require("../test-file.cjs");
const { inspectGraphFreshness } = require("./graph_freshness.cjs");
const { resolveImpactOptions } = require("./impact_profiles.cjs");

const ATTACHMENT_RELATIONS = Object.freeze(["AFFECTS", "APPLIES_TO", "REALIZED_BY"]);
const SAFE_RELATION = /^[A-Z][A-Z0-9_]*$/;

function value(record, key) {
    try {
        const result = record.get(key);
        return result && typeof result.toNumber === "function" ? result.toNumber() : result;
    } catch (_) { return null; }
}

function rowNode(record, prefix) {
    const labels = value(record, `${prefix}Labels`);
    const file = value(record, `${prefix}File`);
    const path = value(record, `${prefix}Path`);
    const sourcePath = String(file || path || "").replace(/\\/g, "/");
    return {
        id: String(value(record, `${prefix}Id`)),
        label: Array.isArray(labels) ? (labels[0] || "Unknown") : (value(record, `${prefix}Label`) || "Unknown"),
        name: value(record, `${prefix}Name`), title: value(record, `${prefix}Title`),
        file, path,
        startLine: value(record, `${prefix}StartLine`), endLine: value(record, `${prefix}EndLine`),
        // Dieselbe Definition wie im Service und im Builder — siehe
        // scripts/test-file.cjs. Hier fehlte zusätzlich die
        // entryPointKind-Prüfung, die der Service hat, also konnte derselbe
        // Knoten je nach Weg durch den Code Test oder Produktivcode sein.
        isTest: value(record, `${prefix}IsTest`) === true
            || /test/i.test(String(value(record, `${prefix}EntryPointKind`) || ""))
            || isTestPath(sourcePath),
        isFrameworkEntrypoint: value(record, `${prefix}IsFrameworkEntrypoint`) === true,
        entryPointKind: value(record, `${prefix}EntryPointKind`),
    };
}

const NODE_RETURN = (v, prefix) => `elementId(${v}) AS ${prefix}Id, labels(${v}) AS ${prefix}Labels, ${v}.label AS ${prefix}Label, `
    + `${v}.name AS ${prefix}Name, ${v}.title AS ${prefix}Title, ${v}.file AS ${prefix}File, ${v}.path AS ${prefix}Path, `
    + `${v}.startLine AS ${prefix}StartLine, ${v}.endLine AS ${prefix}EndLine, `
    + `${v}.isFrameworkEntrypoint AS ${prefix}IsFrameworkEntrypoint, ${v}.entryPointKind AS ${prefix}EntryPointKind`;

async function findSeedCandidates(session, selector) {
    if (typeof selector === "string") selector = { id: selector };
    const clauses = [];
    const params = {};
    if (selector.id != null) { clauses.push("elementId(n) = $id"); params.id = String(selector.id); }
    else {
        if (selector.name != null) { clauses.push("(n.name = $name OR n.title = $name)"); params.name = selector.name; }
        if (selector.file != null) { clauses.push("(n.file = $file OR n.path = $file)"); params.file = selector.file; }
        if (selector.label != null) { clauses.push("(n.label = $label OR $label IN labels(n))"); params.label = selector.label; }
    }
    if (!clauses.length) throw new TypeError("seed must contain id, name, file, or label");
    const result = await session.run(`MATCH (n) WHERE ${clauses.join(" AND ")} RETURN ${NODE_RETURN("n", "n")} ORDER BY n.file, n.name`, params);
    return result.records.map((record) => rowNode(record, "n"));
}

const FRONTIER_CHUNK_SIZE = 25;

function chunks(values, size = FRONTIER_CHUNK_SIZE) {
    const result = [];
    for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
    return result;
}

async function readIncidentRelationEdges(session, relation, nodeIds, direction = "both") {
    if (!SAFE_RELATION.test(relation)) throw new Error(`Unsafe relationship type: ${relation}`);
    const edges = [];
    for (const group of chunks([...new Set(nodeIds.map(String))])) {
        if (!group.length) continue;
        const params = Object.fromEntries(group.map((id, index) => [`id${index}`, id]));
        const endpoint = (variable) => group.map((_, index) => `elementId(${variable}) = $id${index}`).join(" OR ");
        const predicate = direction === "out" ? endpoint("a") : direction === "in" ? endpoint("b")
            : `((${endpoint("a")}) OR (${endpoint("b")}))`;
        try {
            const result = await session.run(`MATCH (a)-[r:${relation}]->(b) WHERE ${predicate} RETURN ${NODE_RETURN("a", "a")}, ${NODE_RETURN("b", "b")}, r.confidence AS confidence, r.resolvedBy AS resolvedBy`, params);
            for (const record of result.records) edges.push({
                fromNode: rowNode(record, "a"), toNode: rowNode(record, "b"), relType: relation,
                confidence: value(record, "confidence"), resolvedBy: value(record, "resolvedBy"),
            });
        } catch (error) {
            if (/table|does not exist|not found/i.test(error?.message || "")) return [];
            throw error;
        }
    }
    return edges;
}

async function readBoundedEdges(session, seedId, relations, { direction = "both", depth = 2, maxNodes = 500 } = {}) {
    const nodes = new Map();
    const edges = new Map();
    const visited = new Set([String(seedId)]);
    let frontier = [String(seedId)];
    const remember = (edge) => {
        nodes.set(edge.fromNode.id, edge.fromNode); nodes.set(edge.toNode.id, edge.toNode);
        edges.set(`${edge.fromNode.id}\0${edge.relType}\0${edge.toNode.id}`, edge);
    };
    // Inspect the boundary even when the node budget is full. Its edges let
    // analyzeImpact distinguish an exhausted graph from omitted dependants.
    for (let level = 0; level < depth && frontier.length; level++) {
        const next = new Set();
        for (const relation of relations) {
            for (const edge of await readIncidentRelationEdges(session, relation, frontier, direction)) {
                remember(edge);
                const candidates = direction === "out" ? [edge.toNode.id] : direction === "in" ? [edge.fromNode.id]
                    : [edge.fromNode.id, edge.toNode.id];
                for (const id of candidates) if (!visited.has(id) && visited.size + next.size < maxNodes) next.add(id);
            }
        }
        for (const id of next) visited.add(id);
        frontier = [...next];
    }
    return { nodes, edges };
}

async function analyzeImpactFromSession(session, options) {
    options = resolveImpactOptions(options);
    const relations = [...new Set(options.relations || DEFAULT_RELATIONS)];
    const candidates = await findSeedCandidates(session, options.seed);
    if (candidates.length !== 1) {
        const error = new Error(candidates.length ? "Impact seed is ambiguous" : "Impact seed was not found");
        error.code = candidates.length ? "AMBIGUOUS_SEED" : "SEED_NOT_FOUND";
        error.candidates = candidates;
        throw error;
    }
    const bounded = await readBoundedEdges(session, candidates[0].id, relations, options);
    const nodes = new Map([[candidates[0].id, candidates[0]], ...bounded.nodes]);
    const edgeMap = new Map(bounded.edges);
    const attachmentIds = [...nodes.keys()];
    for (const relation of ATTACHMENT_RELATIONS) {
        for (const edge of await readIncidentRelationEdges(session, relation, attachmentIds, "both")) {
            nodes.set(edge.fromNode.id, edge.fromNode); nodes.set(edge.toNode.id, edge.toNode);
            edgeMap.set(`${edge.fromNode.id}\0${edge.relType}\0${edge.toNode.id}`, edge);
        }
    }
    const edges = [...edgeMap.values()].map((edge) => ({ from: edge.fromNode.id, to: edge.toNode.id,
        relType: edge.relType, confidence: edge.confidence, resolvedBy: edge.resolvedBy }));
    const graphFreshness = options.graphFreshness || (options.projectRoot
        ? await inspectGraphFreshness(session, { projectRoot: options.projectRoot, sourceDirs: options.sourceDirs || [], exclude: options.exclude || [] })
        : { state: "unknown", staleFiles: [] });
    return analyzeImpact({ ...options, graphFreshness, seed: { id: candidates[0].id }, relations, nodes: [...nodes.values()], edges });
}

module.exports = { ATTACHMENT_RELATIONS, FRONTIER_CHUNK_SIZE, analyzeImpactFromSession, findSeedCandidates,
    readIncidentRelationEdges, readBoundedEdges };

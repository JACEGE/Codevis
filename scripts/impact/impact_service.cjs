"use strict";
const { isTestPath } = require("../test-file.cjs");

const CONFIDENCE_RANK = Object.freeze({ unknown: 0, possible: 1, likely: 2, exact: 3 });
const DEFAULT_RELATIONS = Object.freeze([
    "CALLS", "CALLS_CONDITIONALLY", "PASSES_CALLBACK", "IMPORTS", "IMPORTS_SYMBOL",
    "RESOLVES_TO", "RENDERS", "READS_STATE", "WRITES_STATE", "FETCHES", "AWAITS",
    "CONTAINS", "INHERITS", "REALIZED_BY", "AFFECTS", "APPLIES_TO",
]);
const ATTACHMENT_LABELS = Object.freeze({ Test: "tests", Task: "tasks", Spec: "specs", Knowledge: "knowledge" });

function normalizeConfidence(value) {
    const normalized = String(value || "").toLowerCase();
    return Object.hasOwn(CONFIDENCE_RANK, normalized) ? normalized : null;
}

function edgeConfidence(edge) {
    const declared = normalizeConfidence(edge.confidence);
    if (declared) return declared;
    const resolvedBy = String(edge.resolvedBy || "").toLowerCase();
    if (/^(uid|element-id|exact|named-import|receiver-type|self-receiver|same-file)$/.test(resolvedBy)) return "exact";
    if (resolvedBy) return "likely";
    if (["CONTAINS", "IMPORTS", "IMPORTS_SYMBOL", "EXPORTS_SYMBOL", "AFFECTS", "APPLIES_TO", "REALIZED_BY"].includes(edge.relType)) return "exact";
    return "unknown";
}

function weakestConfidence(a, b) {
    return CONFIDENCE_RANK[a] <= CONFIDENCE_RANK[b] ? a : b;
}

function publicNode(node) {
    return {
        id: String(node.id),
        label: node.label || "Unknown",
        name: node.name ?? node.title ?? node.path ?? String(node.id),
        file: node.file ?? node.path ?? null,
        startLine: node.startLine ?? null,
        endLine: node.endLine ?? null,
        isTest: isTestNode(node),
        entryPointKind: node.entryPointKind ?? null,
    };
}

function isTestNode(node) {
    if (node.isTest === true) return true;
    if (/test/i.test(String(node.entryPointKind || ""))) return true;
    // Die Pfadregeln stehen in scripts/test-file.cjs, gemeinsam mit denen des
    // Builders. Diese Kopie kannte `test_helper.py`, `helper_test.py` und
    // `*.d.ts` nicht -- also galt hier als Produktivcode, was der Builder als
    // Test ausschließt.
    return isTestPath(node.file || node.path || "");
}

function attachmentSection(node) {
    if (isTestNode(node)) return "tests";
    if (typeof node.label === "string" && node.label.startsWith("Spec")) return "specs";
    return ATTACHMENT_LABELS[node.label] || null;
}

function resolveSeed(nodes, selector) {
    if (typeof selector === "string") selector = { id: selector };
    const candidates = nodes.filter((node) => {
        if (selector.id != null) return String(node.id) === String(selector.id);
        if (selector.name != null && node.name !== selector.name && node.title !== selector.name) return false;
        if (selector.file != null && node.file !== selector.file && node.path !== selector.file) return false;
        if (selector.label != null && node.label !== selector.label) return false;
        return selector.name != null || selector.file != null || selector.label != null;
    });
    if (candidates.length !== 1) {
        const error = new Error(candidates.length ? "Impact seed is ambiguous" : "Impact seed was not found");
        error.code = candidates.length ? "AMBIGUOUS_SEED" : "SEED_NOT_FOUND";
        error.candidates = candidates.map(publicNode).sort(compareNodes);
        throw error;
    }
    return candidates[0];
}

function compareNodes(a, b) {
    return String(a.file || "").localeCompare(String(b.file || ""))
        || String(a.name || "").localeCompare(String(b.name || ""))
        || String(a.id).localeCompare(String(b.id));
}

function compareEdges(a, b) {
    return String(a.relType).localeCompare(String(b.relType))
        || String(a.from).localeCompare(String(b.from))
        || String(a.to).localeCompare(String(b.to));
}

function orientedSteps(edge, direction) {
    const steps = [];
    if (direction === "out" || direction === "both") steps.push({ from: String(edge.from), to: String(edge.to), direction: "out" });
    if (direction === "in" || direction === "both") steps.push({ from: String(edge.to), to: String(edge.from), direction: "in" });
    return steps;
}

function pathKey(path) {
    return path.map((step) => `${step.from}:${step.relType}:${step.direction}:${step.to}`).join("|");
}

function summarizeAnalysisQuality(impacted, graphFreshness, truncation) {
    const uniqueEdges = new Map();
    for (const node of impacted) {
        for (const path of node.paths) for (const edge of path) {
            uniqueEdges.set(`${edge.from}|${edge.relType}|${edge.direction}|${edge.to}`, edge);
        }
    }
    const confidence = { exact: 0, likely: 0, possible: 0, unknown: 0 };
    for (const edge of uniqueEdges.values()) confidence[edge.confidence]++;
    const limitations = [];
    if (graphFreshness.state !== "current") limitations.push(`graph-${graphFreshness.state}`);
    if (truncation.truncated) limitations.push("node-limit-reached");
    if (confidence.unknown) limitations.push("unknown-edge-evidence");
    if (confidence.possible) limitations.push("multi-target-or-heuristic-evidence");
    return {
        status: limitations.length ? "qualified" : "eligible",
        traversedUniqueEdges: uniqueEdges.size,
        confidence,
        limitations,
        note: "Counts describe the evidence used by this result, not total parser coverage or runtime certainty.",
    };
}

function analyzeImpact({ nodes, edges, seed, profile = "custom", direction = "in", depth = 2, relations = DEFAULT_RELATIONS,
    maxNodes = 200, maxPathsPerNode = 3, graphFreshness = { state: "current", staleFiles: [] } }) {
    if (!Array.isArray(nodes) || !Array.isArray(edges)) throw new TypeError("nodes and edges must be arrays");
    if (!Number.isInteger(depth) || depth < 0) throw new RangeError("depth must be a non-negative integer");
    if (!(["in", "out", "both"].includes(direction))) throw new RangeError("direction must be in, out, or both");

    const nodeById = new Map(nodes.map((node) => [String(node.id), node]));
    const seedNode = resolveSeed(nodes, seed);
    const seedId = String(seedNode.id);
    const allowed = new Set(relations);
    const adjacency = new Map();
    for (const edge of [...edges].sort(compareEdges)) {
        if (!allowed.has(edge.relType)) continue;
        for (const step of orientedSteps(edge, direction)) {
            if (!nodeById.has(step.from) || !nodeById.has(step.to)) continue;
            if (!adjacency.has(step.from)) adjacency.set(step.from, []);
            adjacency.get(step.from).push({ ...step, relType: edge.relType, confidence: edgeConfidence(edge), resolvedBy: edge.resolvedBy ?? null });
        }
    }

    const distances = new Map([[seedId, 0]]);
    const paths = new Map([[seedId, [[]]]]);
    let frontier = [seedId];
    const omittedIds = new Set();
    for (let level = 0; level < depth && frontier.length; level++) {
        const next = new Set();
        for (const from of [...frontier].sort()) {
            for (const step of adjacency.get(from) || []) {
                const candidateDistance = level + 1;
                const knownDistance = distances.get(step.to);
                if (knownDistance != null && knownDistance < candidateDistance) continue;
                if (knownDistance == null && distances.size >= maxNodes) { omittedIds.add(step.to); continue; }
                if (knownDistance == null) { distances.set(step.to, candidateDistance); paths.set(step.to, []); next.add(step.to); }
                const targetPaths = paths.get(step.to);
                for (const basePath of paths.get(from) || []) {
                    if (targetPaths.length >= maxPathsPerNode) break;
                    const candidate = [...basePath, step];
                    if (!targetPaths.some((existing) => pathKey(existing) === pathKey(candidate))) targetPaths.push(candidate);
                }
            }
        }
        frontier = [...next];
    }

    const freshnessState = graphFreshness?.state || "unknown";
    const stale = freshnessState !== "current";
    const impacted = [...distances.entries()].filter(([id]) => id !== seedId).map(([id, distance]) => {
        const nodePaths = paths.get(id) || [];
        const confidence = stale ? "unknown" : nodePaths.reduce((best, path) => {
            const pathConfidence = path.reduce((value, step) => weakestConfidence(value, step.confidence), "exact");
            return CONFIDENCE_RANK[pathConfidence] > CONFIDENCE_RANK[best] ? pathConfidence : best;
        }, "unknown");
        return { ...publicNode(nodeById.get(id)), distance, confidence, paths: nodePaths };
    }).sort((a, b) => a.distance - b.distance || compareNodes(a, b));

    const includedIds = new Set([seedId, ...impacted.map((node) => node.id)]);
    const attachments = { tests: [], tasks: [], specs: [], knowledge: [] };
    for (const node of nodes) {
        const section = attachmentSection(node);
        if (!section || includedIds.has(String(node.id))) continue;
        const reasons = edges.filter((edge) => {
            const from = String(edge.from), to = String(edge.to), id = String(node.id);
            return (from === id && includedIds.has(to)) || (to === id && includedIds.has(from));
        }).map((edge) => ({ relType: edge.relType, connectedTo: String(edge.from) === String(node.id) ? String(edge.to) : String(edge.from) }));
        if (reasons.length) attachments[section].push({ ...publicNode(node), reasons: reasons.sort(compareEdges) });
    }
    for (const values of Object.values(attachments)) values.sort(compareNodes);

    const selectedTests = [];
    for (const node of impacted) {
        if (node.isTest) selectedTests.push({ ...node, selectedBy: "impact-path" });
    }
    for (const node of attachments.tests) {
        if (!selectedTests.some((test) => test.id === node.id)) selectedTests.push({ ...node, confidence: stale ? "unknown" : "exact", selectedBy: "direct-relation" });
    }
    selectedTests.sort(compareNodes);
    const omittedNodes = omittedIds.size;
    const incomplete = stale || omittedNodes > 0;
    const knowledgeCandidates = attachments.knowledge.map((node) => ({
        ...node,
        status: "review-recommended",
        reason: "Linked code is inside the selected impact radius.",
    }));

    const truncation = { truncated: omittedNodes > 0, omittedNodes, maxNodes, maxPathsPerNode };
    return {
        seed: publicNode(seedNode), profile, direction, depth, relations: [...allowed].sort(),
        graphFreshness: { ...graphFreshness, state: freshnessState, staleFiles: [...(graphFreshness?.staleFiles || [])].sort() },
        impacted, attachments,
        testSelection: {
            status: incomplete ? "incomplete" : (selectedTests.length ? "selected" : "none-found"),
            selected: selectedTests,
            complete: !incomplete,
            note: selectedTests.length
                ? "Run these tests first; static impact is not a substitute for the full suite."
                : "No tests were identified by the available graph evidence; this does not prove that no tests are affected.",
        },
        knowledgeReview: {
            status: incomplete ? "incomplete" : (knowledgeCandidates.length ? "review-recommended" : "none-linked"),
            candidates: knowledgeCandidates,
            complete: !incomplete,
            note: knowledgeCandidates.length
                ? "These documents are linked to impacted code and should be reviewed; CodeVis does not claim their content is wrong."
                : "No linked Knowledge was found in the available impact evidence.",
        },
        truncation,
        analysisQuality: summarizeAnalysisQuality(impacted, graphFreshness || { state: freshnessState }, truncation),
    };
}

module.exports = { CONFIDENCE_RANK, DEFAULT_RELATIONS, analyzeImpact, edgeConfidence, isTestNode, resolveSeed, summarizeAnalysisQuality, weakestConfidence };

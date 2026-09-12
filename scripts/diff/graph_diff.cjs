/**
 * graph_diff.cjs — compare two code-graph snapshots.
 *
 * Pure: takes the two Maps produced by graph_snapshot.cjs and returns plain
 * objects. No database, no filesystem, no git — so the interesting part (what
 * counts as "changed", what the blast radius is) is unit-testable without
 * building a graph.
 *
 * What this answers that a textual diff cannot: which EXISTING code is now
 * connected to the change. A patch shows the lines a branch touched; the graph
 * shows who calls into them, what they now depend on, and which edges vanished.
 *
 * What it cannot answer: whether the code inside a function is correct. A body
 * rewrite that keeps the same calls and the same signature shows up as a
 * `changed` node at most — and only if it altered the stored snippet. Use this
 * to scope a review, not to replace reading the diff.
 */

"use strict";

const { analyzeImpact } = require("../impact/impact_service.cjs");

/** Fields whose change makes a node "modified" rather than merely moved. */
const COMPARED_FIELDS = ["signature", "bodySnippet"];

/**
 * Compare two snapshots.
 *
 * @param {{nodes: Map, edges: Map}} base   The graph as it is now (e.g. main).
 * @param {{nodes: Map, edges: Map}} head   The graph after the change (e.g. a PR).
 * @returns {object} diff
 */
function diffSnapshots(base, head) {
    const nodes = { added: [], removed: [], changed: [] };

    for (const [key, node] of head.nodes) {
        const before = base.nodes.get(key);
        if (!before) {
            nodes.added.push(node);
            continue;
        }
        const fields = COMPARED_FIELDS.filter((f) => (before[f] ?? null) !== (node[f] ?? null));
        // A pure line shift (something was inserted above) is not a change: the
        // span is compared, never the absolute position.
        const spanBefore = (before.endLine ?? 0) - (before.startLine ?? 0);
        const spanAfter = (node.endLine ?? 0) - (node.startLine ?? 0);
        if (spanBefore !== spanAfter) fields.push("span");
        if (fields.length) nodes.changed.push({ ...node, changedFields: fields, before });
    }

    for (const [key, node] of base.nodes) {
        if (!head.nodes.has(key)) nodes.removed.push(node);
    }

    const edges = { added: [], removed: [] };
    for (const [key, edge] of head.edges) {
        if (!base.edges.has(key)) edges.added.push(edge);
    }
    for (const [key, edge] of base.edges) {
        if (!head.edges.has(key)) edges.removed.push(edge);
    }

    const touchedKeys = new Set([
        ...nodes.added.map((n) => n.key),
        ...nodes.removed.map((n) => n.key),
        ...nodes.changed.map((n) => n.key),
    ]);

    const diff = {
        nodes,
        edges,
        files: diffFiles(nodes),
        blastRadius: blastRadius(base, head, touchedKeys, edges),
        stats: {
            nodesAdded: nodes.added.length,
            nodesRemoved: nodes.removed.length,
            nodesChanged: nodes.changed.length,
            edgesAdded: edges.added.length,
            edgesRemoved: edges.removed.length,
            baseNodes: base.nodes.size,
            headNodes: head.nodes.size,
        },
    };
    diff.changeImpact = impactChangedNodes(base, head, diff);
    return diff;
}

function impactChangedNodes(base, head, diff, { depth = 2, maxSeeds = 50, maxNodesPerSeed = 100 } = {}) {
    const seeds = [
        ...diff.nodes.added.map((node) => ({ node, state: "added", snapshot: head })),
        ...diff.nodes.changed.map((node) => ({ node, state: "changed", snapshot: head })),
        ...diff.nodes.removed.map((node) => ({ node, state: "removed", snapshot: base })),
    ].sort((a, b) => a.node.key.localeCompare(b.node.key));
    const results = [];
    for (const { node, state, snapshot } of seeds.slice(0, maxSeeds)) {
        const nodes = [...snapshot.nodes.values()].map((item) => ({ ...item, id: item.key }));
        const edges = [...snapshot.edges.values()].map((edge) => ({
            from: edge.from, to: edge.to, relType: edge.relType,
            confidence: edge.confidence, resolvedBy: edge.resolvedBy,
        }));
        const impact = analyzeImpact({ nodes, edges, seed: { id: node.key }, direction: "in", depth,
            maxNodes: maxNodesPerSeed, graphFreshness: { state: "current", staleFiles: [] } });
        results.push({ state, seed: impact.seed, impacted: impact.impacted, testSelection: impact.testSelection,
            knowledgeReview: impact.knowledgeReview, truncation: impact.truncation });
    }
    return {
        depth, seeds: results,
        truncation: { truncated: seeds.length > maxSeeds, omittedSeeds: Math.max(0, seeds.length - maxSeeds), maxSeeds },
    };
}

/** Files grouped by what happened to them, derived from the node diff. */
function diffFiles(nodes) {
    const added = new Set(), removed = new Set(), touched = new Set();
    for (const n of nodes.added) (n.label === "File" ? added : touched).add(n.file || n.path || "");
    for (const n of nodes.removed) (n.label === "File" ? removed : touched).add(n.file || n.path || "");
    for (const n of nodes.changed) touched.add(n.file || n.path || "");
    // A file that is itself new is not also "touched".
    for (const f of added) touched.delete(f);
    for (const f of removed) touched.delete(f);
    return { added: [...added].filter(Boolean), removed: [...removed].filter(Boolean), touched: [...touched].filter(Boolean) };
}

/**
 * Blast radius: nodes that did NOT change themselves but whose wiring did.
 *
 * This is the part a text diff structurally cannot produce. An unchanged
 * function that suddenly calls a new module, or that lost its only caller, is
 * exactly what a reviewer wants to look at — and it appears nowhere in the
 * patch, because nothing about its own lines moved.
 *
 * Each entry carries the edges responsible, so the finding is checkable rather
 * than a bare assertion that something is affected.
 */
function blastRadius(base, head, touchedKeys, edges) {
    const impacted = new Map();

    const note = (key, entry) => {
        if (touchedKeys.has(key)) return;          // it changed itself — not "collateral"
        if (!head.nodes.has(key) && !base.nodes.has(key)) return;
        if (!impacted.has(key)) {
            const node = head.nodes.get(key) || base.nodes.get(key);
            impacted.set(key, { key, label: node.label, name: node.name, file: node.file || node.path, reasons: [] });
        }
        impacted.get(key).reasons.push(entry);
    };

    for (const e of edges.added) {
        note(e.from, { kind: "gained-outgoing", relType: e.relType, other: e.to });
        note(e.to, { kind: "gained-incoming", relType: e.relType, other: e.from });
    }
    for (const e of edges.removed) {
        note(e.from, { kind: "lost-outgoing", relType: e.relType, other: e.to });
        note(e.to, { kind: "lost-incoming", relType: e.relType, other: e.from });
    }

    return [...impacted.values()].sort((a, b) => b.reasons.length - a.reasons.length);
}

// ============================================================================
// RENDERING
// ============================================================================

/** Short display form of a node key (`Function|foo|src/a.js` -> `foo (src/a.js)`). */
function shortKey(key) {
    const [label, name, file] = String(key).split("|");
    const cleanFile = (file || "").split("#")[0];
    return cleanFile ? `${name} [${label}] (${cleanFile})` : `${name} [${label}]`;
}

/** Human-readable summary for the terminal. */
function renderText(diff, { limit = 25 } = {}) {
    const L = [];
    const s = diff.stats;
    L.push(`Nodes: +${s.nodesAdded} / -${s.nodesRemoved} / ~${s.nodesChanged}   (base ${s.baseNodes} -> head ${s.headNodes})`);
    L.push(`Edges: +${s.edgesAdded} / -${s.edgesRemoved}`);
    L.push("");

    const section = (title, items, fmt) => {
        if (!items.length) return;
        L.push(`${title} (${items.length})`);
        for (const it of items.slice(0, limit)) L.push(`  ${fmt(it)}`);
        // Never let a cap masquerade as completeness.
        if (items.length > limit) L.push(`  ... ${items.length - limit} more`);
        L.push("");
    };

    section("New files", diff.files.added, (f) => f);
    section("Deleted files", diff.files.removed, (f) => f);
    section("Added nodes", diff.nodes.added, (n) => shortKey(n.key));
    section("Removed nodes", diff.nodes.removed, (n) => shortKey(n.key));
    section("Changed nodes", diff.nodes.changed, (n) => `${shortKey(n.key)}  [${n.changedFields.join(", ")}]`);
    section("New edges", diff.edges.added, (e) => `${shortKey(e.from)} -${e.relType}-> ${shortKey(e.to)}`);
    section("Removed edges", diff.edges.removed, (e) => `${shortKey(e.from)} -${e.relType}-> ${shortKey(e.to)}`);
    section("Blast radius (unchanged code, changed wiring)", diff.blastRadius,
        (b) => `${b.name} [${b.label}] (${b.file}) — ${b.reasons.length}x ${[...new Set(b.reasons.map((r) => r.kind))].join(", ")}`);

    const dependencyImpact = new Map();
    for (const entry of diff.changeImpact?.seeds || []) {
        for (const node of entry.impacted) {
            if (!dependencyImpact.has(node.id)) dependencyImpact.set(node.id, { ...node, seeds: [] });
            dependencyImpact.get(node.id).seeds.push(entry.seed.name);
        }
    }
    section("Dependency impact (unchanged dependants)", [...dependencyImpact.values()],
        (n) => `${n.name} [${n.label}] (${n.file}) - ${n.confidence}, ${n.distance} hop(s), from ${[...new Set(n.seeds)].join(", ")}`);
    if (diff.changeImpact?.truncation?.truncated) {
        L.push(`Impact seeds truncated: ${diff.changeImpact.truncation.omittedSeeds} omitted (max ${diff.changeImpact.truncation.maxSeeds})`, "");
    }
    return L.join("\n");
}

/**
 * Mermaid graph of the change. Added nodes/edges are drawn solid, removed ones
 * dashed, blast-radius nodes plain — so "what got wired to what" is readable at
 * a glance instead of reconstructed from two lists.
 */
function renderMermaid(diff, { maxNodes = 60 } = {}) {
    const lines = ["graph LR"];
    const ids = new Map();
    let n = 0;
    const id = (key) => {
        if (!ids.has(key)) ids.set(key, `n${n++}`);
        return ids.get(key);
    };
    const esc = (s) => String(s).replace(/"/g, "'");

    const classOf = new Map();
    for (const node of diff.nodes.added) classOf.set(node.key, "added");
    for (const node of diff.nodes.removed) classOf.set(node.key, "removed");
    for (const node of diff.nodes.changed) classOf.set(node.key, "changed");
    for (const b of diff.blastRadius) if (!classOf.has(b.key)) classOf.set(b.key, "context");

    const edges = [
        ...diff.edges.added.map((e) => ({ ...e, state: "added" })),
        ...diff.edges.removed.map((e) => ({ ...e, state: "removed" })),
    ];

    const drawn = new Set();
    let truncated = 0;
    for (const e of edges) {
        if (drawn.size >= maxNodes && !(drawn.has(e.from) && drawn.has(e.to))) { truncated++; continue; }
        drawn.add(e.from);
        drawn.add(e.to);
        const arrow = e.state === "added" ? "-->" : "-.->";
        lines.push(`  ${id(e.from)}["${esc(shortKey(e.from))}"] ${arrow}|${e.relType}| ${id(e.to)}["${esc(shortKey(e.to))}"]`);
    }
    // Isolated changes (a rewritten function with unchanged wiring) still belong
    // in the picture, otherwise the diagram silently omits part of the change.
    for (const node of [...diff.nodes.added, ...diff.nodes.changed, ...diff.nodes.removed]) {
        if (drawn.has(node.key) || drawn.size >= maxNodes) continue;
        drawn.add(node.key);
        lines.push(`  ${id(node.key)}["${esc(shortKey(node.key))}"]`);
    }

    for (const [key, cls] of classOf) {
        if (drawn.has(key)) lines.push(`  class ${id(key)} ${cls};`);
    }
    lines.push("  classDef added fill:#0d5,stroke:#083,color:#000;");
    lines.push("  classDef removed fill:#f66,stroke:#a22,color:#000;");
    lines.push("  classDef changed fill:#fd6,stroke:#a82,color:#000;");
    lines.push("  classDef context fill:#eee,stroke:#999,color:#000;");
    if (truncated) lines.push(`  %% ${truncated} further edge(s) omitted (maxNodes=${maxNodes})`);
    return lines.join("\n");
}

module.exports = {
    COMPARED_FIELDS,
    diffSnapshots,
    diffFiles,
    blastRadius,
    impactChangedNodes,
    shortKey,
    renderText,
    renderMermaid,
};

/**
 * graph_snapshot.cjs — read a comparable snapshot of a code graph.
 *
 * "Comparable" is the whole point: a snapshot must identify a node the same way
 * in two independently built databases. `uid` cannot do that — the daemon hands
 * out uids from a per-database sequence counter (`uid = prefix + seq`), so the
 * same function gets different uids in two builds and every node would look
 * added-and-removed at once. Identity here is therefore the NATURAL key the
 * builder itself merges on: semantic label + the node's stable source identity
 * (`name`, symbol name, URL or source `elementId`) + owning file.
 *
 * The snapshot deliberately covers only the structural layer (files, functions,
 * classes, components, endpoints, ...). AST/statement/control-flow nodes are
 * excluded: they exist per expression, they dominate the node count, and a diff
 * over them reports noise rather than architecture. `labels` overrides this.
 */

"use strict";

/**
 * Labels worth diffing. Excluded on purpose:
 *   ASTNode / Statement / ControlFlow — per-expression noise, huge.
 *   Task / Knowledge / BraindumpSession — project management, not code.
 *   UserEvent / RouteEvent / LogEntry / RuntimeDOM — runtime recordings; they
 *   differ between two builds because they were recorded, not because the code
 *   changed.
 */
const DEFAULT_LABELS = [
    "File", "Module", "Function", "Class", "Component", "Endpoint",
    "State", "Effect", "DOMElement", "ExportedSymbol", "ImportedSymbol",
    "Topic", "Service", "Action",
];

/**
 * Relationship types worth diffing — the structural edges between the labels
 * above. Runtime/task edges are left out for the same reason as their nodes.
 */
const DEFAULT_RELS = [
    "CONTAINS", "DECLARES", "IMPORTS", "IMPORTS_SYMBOL", "EXPORTS_SYMBOL",
    "RESOLVES_TO", "CALLS", "CALLS_CONDITIONALLY", "RETURNS", "RENDERS",
    "READS_STATE", "WRITES_STATE", "HAS_EFFECT", "WATCHES", "HANDLES",
    "FETCHES", "AWAITS", "WRAPS", "ALIAS_OF", "CONSUMES_CONTEXT", "INHERITS",
    "PASSES_CALLBACK", "PASSES_PROP", "DATA_FLOWS_TO", "BELONGS_TO",
    "USES_TOPIC", "PUBLISHES_TOPIC", "SUBSCRIBES_TOPIC",
    "PROVIDES_SERVICE", "CALLS_SERVICE", "PROVIDES_ACTION", "USES_ACTION",
];

/** Unwrap a driver value (Ladybug integers arrive as objects). */
function val(record, key) {
    let v;
    try {
        v = record.get(key);
    } catch (_) {
        return null; // column absent in this backend's result
    }
    if (v === undefined) return null;
    if (v && typeof v.toNumber === "function") return v.toNumber();
    return v;
}

/** The file a node belongs to — File nodes carry `path`, everything else `file`. */
function ownerFile(node) {
    return node.file || node.path || "";
}

/**
 * Effect nodes have no name in the source, so the builder synthesises one as
 * `{hookType}_{uid[0..3]}` — and the uid comes from the database's sequence
 * counter. The same `useEffect` therefore gets a different name in every build,
 * which made all 86 of them show up as removed-and-added in a diff where the
 * branch had not touched a single hook.
 *
 * Stripping the uid fragment restores a comparable name; the occurrence index
 * (see nodeKey) then keeps several hooks in one file apart, by source order.
 *
 * The real fix belongs in the builder — a synthetic name derived from something
 * stable (file + enclosing function + ordinal) would make these nodes hold still
 * across rebuilds for every consumer, not just this one. Until then, this is a
 * reader-side repair.
 */
function stableName(node) {
    // An Effect whose synthetic name was never assigned (the naming pass runs
    // late in a build and may not have completed) still has to appear in the
    // snapshot. Dropping it would report the whole file's hooks as deleted in
    // the next diff — a silent, and very loud-looking, lie.
    if (node.label === "Effect" && typeof node.name !== "string") return node.hookType || "effect";
    if (node.label !== "Effect" || typeof node.name !== "string") {
        return node.name ?? node.localName ?? node.publicName ?? node.url ?? node.elementId;
    }
    const m = /^(use[A-Za-z]*)_[0-9a-f]{4}(?:_\d+)?$/.exec(node.name);
    return m ? m[1] : node.name;
}

/**
 * Stable identity for a node, independent of the database it came from.
 *
 * Two nodes in one file can legitimately share the same base identity (an
 * overloaded C++ method, a helper defined twice in different scopes). They are
 * disambiguated by their order in the file rather than by line number: a node
 * that only moved down because something was inserted above it must NOT read as
 * removed+added.
 */
function nodeKey(node, occurrence = 0) {
    const base = `${node.label}|${stableName(node)}|${ownerFile(node)}`;
    return occurrence === 0 ? base : `${base}#${occurrence}`;
}

/**
 * Read every diffable node, keyed by `nodeKey`.
 * @returns {Promise<Map<string, object>>}
 */
async function readNodes(session, { labels = DEFAULT_LABELS } = {}) {
    const byKey = new Map();

    for (const label of labels) {
        const res = await session.run(`
            MATCH (n:${label})
            RETURN n.name AS name, n.file AS file, n.path AS path,
                   n.localName AS localName, n.publicName AS publicName,
                   n.url AS url, n.elementId AS elementId,
                   n.startLine AS startLine, n.endLine AS endLine,
                   n.signature AS signature, n.bodySnippet AS bodySnippet,
                   n.hookType AS hookType
        `);

        // Group per (name, file) first so the occurrence suffix can be assigned
        // in source order — see nodeKey.
        const groups = new Map();
        for (const r of res.records) {
            const node = {
                label,
                name: val(r, "name"),
                file: val(r, "file"),
                path: val(r, "path"),
                localName: val(r, "localName"),
                publicName: val(r, "publicName"),
                url: val(r, "url"),
                elementId: val(r, "elementId"),
                startLine: val(r, "startLine"),
                endLine: val(r, "endLine"),
                signature: val(r, "signature"),
                bodySnippet: val(r, "bodySnippet"),
                hookType: val(r, "hookType"),
            };
            // A node with no usable identity at all cannot be compared; anything
            // that has *some* stable handle (a path, a hook type) is kept, so a
            // gap in the builder never turns into a phantom deletion here.
            if (stableName(node) == null && node.path === null) continue;
            if (node.name === null && node.path !== null) node.name = node.path;
            const base = `${label}|${stableName(node)}|${ownerFile(node)}`;
            if (!groups.has(base)) groups.set(base, []);
            groups.get(base).push(node);
        }

        for (const [, nodes] of groups) {
            nodes.sort((a, b) => (a.startLine ?? 0) - (b.startLine ?? 0));
            nodes.forEach((node, i) => {
                node.key = nodeKey(node, i);
                byKey.set(node.key, node);
            });
        }
    }

    return byKey;
}

/**
 * Read every diffable edge as `{ key, relType, from, to }`, where `from`/`to`
 * are node keys.
 *
 * Queried one rel type at a time rather than as an untyped `-[r]->` plus
 * `type(r)`: the Ladybug translation layer stores all edges in per-type tables,
 * so a typed match is an indexed lookup while the untyped form is a scan across
 * every table. Edges whose endpoints are outside the snapshot (AST-level nodes)
 * are dropped — they cannot be named in the diff anyway.
 *
 * Endpoint disambiguation: the occurrence suffix from `readNodes` cannot be
 * recovered from an edge row, so an edge endpoint always binds to occurrence 0.
 * With duplicate names in one file that can attach an edge to the wrong twin;
 * the count stays right, the attribution may not. Rare enough to accept, and
 * `nodes` in the result is the authoritative part.
 */
async function readEdges(session, nodesByKey, { rels = DEFAULT_RELS } = {}) {
    const edges = new Map();

    for (const relType of rels) {
        let res;
        try {
            res = await session.run(`
                MATCH (a)-[r:${relType}]->(b)
                RETURN a.label AS aLabel, a.name AS aName, a.file AS aFile, a.path AS aPath,
                       a.localName AS aLocalName, a.publicName AS aPublicName,
                       a.url AS aUrl, a.elementId AS aElementId, a.hookType AS aHookType,
                       b.label AS bLabel, b.name AS bName, b.file AS bFile, b.path AS bPath,
                       b.localName AS bLocalName, b.publicName AS bPublicName,
                       b.url AS bUrl, b.elementId AS bElementId, b.hookType AS bHookType
            `);
        } catch (e) {
            // A rel table that does not exist in this database (older schema, or
            // a graph built before a rel type was introduced) is not an error:
            // it simply contributes no edges. Anything else is re-thrown.
            if (/table|does not exist|not found/i.test(e.message || "")) continue;
            throw e;
        }

        for (const r of res.records) {
            const from = {
                label: val(r, "aLabel"), name: val(r, "aName"),
                file: val(r, "aFile"), path: val(r, "aPath"),
                localName: val(r, "aLocalName"), publicName: val(r, "aPublicName"),
                url: val(r, "aUrl"), elementId: val(r, "aElementId"), hookType: val(r, "aHookType"),
            };
            const to = {
                label: val(r, "bLabel"), name: val(r, "bName"),
                file: val(r, "bFile"), path: val(r, "bPath"),
                localName: val(r, "bLocalName"), publicName: val(r, "bPublicName"),
                url: val(r, "bUrl"), elementId: val(r, "bElementId"), hookType: val(r, "bHookType"),
            };
            if (!from.label || !to.label) continue;
            if (from.name === null) from.name = from.path;
            if (to.name === null) to.name = to.path;

            const fromKey = nodeKey(from);
            const toKey = nodeKey(to);
            if (!nodesByKey.has(fromKey) || !nodesByKey.has(toKey)) continue;

            const key = `${fromKey} -[${relType}]-> ${toKey}`;
            if (!edges.has(key)) edges.set(key, { key, relType, from: fromKey, to: toKey });
        }
    }

    return edges;
}

/**
 * Full snapshot of one graph.
 * @returns {Promise<{nodes: Map, edges: Map, label: string}>}
 */
async function readSnapshot(session, opts = {}) {
    const nodes = await readNodes(session, opts);
    const edges = await readEdges(session, nodes, opts);
    return { nodes, edges, label: opts.label || "snapshot" };
}

module.exports = {
    DEFAULT_LABELS,
    DEFAULT_RELS,
    nodeKey,
    ownerFile,
    readNodes,
    readEdges,
    readSnapshot,
};

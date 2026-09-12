/**
 * ros_db.cjs — Read the ROS 2 layer out of the code graph.
 *
 * Mirrors scripts/spec/spec_db.cjs: takes an open neo4j/ladybug-compatible
 * `session`, returns plain JS objects. No MCP envelope, no rendering — the
 * rendering lives in scripts/ros/ros_diagram.js, so the model can be inspected
 * (and tested) on its own.
 *
 * The interface edges are queried one rel type at a time rather than with an
 * untyped `-[r]->` plus `type(r)`. Seven cheap indexed lookups beat one broad
 * scan across every rel table, and it sidesteps any question of alternation
 * support in the Kuzu/Ladybug translation layer.
 */

"use strict";

const { buildRosDiagram } = require("./ros_diagram.js");
const { KIND_LABEL, directionOf, canonicalizeRosName } = require("./ros_model.js");

/** Every interface edge type, with the interface label it points at. */
const INTERFACE_EDGES = [
    { relType: "PUBLISHES_TOPIC", label: "Topic" },
    { relType: "SUBSCRIBES_TOPIC", label: "Topic" },
    { relType: "USES_TOPIC", label: "Topic" },
    { relType: "PROVIDES_SERVICE", label: "Service" },
    { relType: "CALLS_SERVICE", label: "Service" },
    { relType: "PROVIDES_ACTION", label: "Action" },
    { relType: "USES_ACTION", label: "Action" },
];

function val(record, key) {
    const v = record.get(key);
    if (v === undefined) return null;
    if (v && typeof v.toNumber === "function") return v.toNumber();
    return v;
}

/**
 * Read the ROS model.
 *
 * @param {object} session Open graph session.
 * @param {object} [opts]
 * @param {string} [opts.pathPrefix] Restrict to files under this path prefix
 *        (e.g. `ros2_ws/src`) — useful when the graph holds more than the
 *        ROS workspace.
 * @param {boolean} [opts.includeUnowned=true] Include interfaces reached from a
 *        plain Function or File rather than from a ROS node class. Without it,
 *        node-less scripts (a bare `main()` that publishes) vanish.
 * @returns {Promise<{nodes, interfaces, edges, stats}>}
 */
async function readRosModel(session, opts = {}) {
    const { pathPrefix = null, includeUnowned = true } = opts;
    const prefixOk = (file) => !pathPrefix || (file || "").startsWith(pathPrefix);

    // --- ROS node classes ---------------------------------------------------
    const nodesRes = await session.run(`
        MATCH (c:Class)
        WHERE c.isRosNode = true
        RETURN c.uid AS uid, c.name AS name, c.file AS file,
               c.rosNodeName AS nodeName, c.rosBase AS base
    `);
    const nodes = [];
    const nodeByKey = new Map();
    for (const r of nodesRes.records) {
        const file = val(r, "file");
        if (!prefixOk(file)) continue;
        const name = val(r, "name");
        const node = {
            id: val(r, "uid") || `class:${name}:${file}`,
            name,
            kind: "class",
            file,
            nodeName: val(r, "nodeName"),
            base: val(r, "base"),
        };
        nodes.push(node);
        nodeByKey.set(`Class:${name}:${file}`, node);
    }

    // --- interface nodes ----------------------------------------------------
    // Keyed on the LITERAL source name here; the canonical ROS name is applied
    // below, once the owning node (and therefore the `~/` namespace) is known.
    const rawInterfaces = new Map();
    for (const label of ["Topic", "Service", "Action"]) {
        const res = await session.run(`
            MATCH (t:${label})
            RETURN t.name AS name, t.rosKind AS kind, t.msgType AS msgType, t.rosDynamic AS dynamic
        `);
        for (const r of res.records) {
            const name = val(r, "name");
            if (!name || rawInterfaces.has(name)) continue;
            rawInterfaces.set(name, {
                name,
                kind: val(r, "kind") || label.toLowerCase(),
                msgType: val(r, "msgType"),
                dynamic: val(r, "dynamic") === true,
            });
        }
    }

    // --- which ROS node class owns which method -----------------------------
    // Read once: the alternative is a lookup per edge, and on the single-table
    // backend every one of those is a full scan.
    const nodeById = new Map(nodes.map((n) => [n.id, n]));
    const methodOwner = new Map();
    const ownerRes = await session.run(`
        MATCH (c:Class)-[:CONTAINS]->(f:Function)
        WHERE c.isRosNode = true
        RETURN c.uid AS classUid, c.name AS className, c.file AS classFile,
               f.name AS fnName, f.file AS fnFile
    `);
    for (const r of ownerRes.records) {
        const cls = nodeByKey.get(`Class:${val(r, "className")}:${val(r, "classFile")}`);
        if (!cls) continue;
        const key = `${val(r, "fnName")}|${val(r, "fnFile")}`;
        if (methodOwner.has(key) && methodOwner.get(key) !== cls.id) {
            console.warn(
                `Skipping ambiguous ROS method owner for '${key}': ` +
                `'${methodOwner.get(key)}' and '${cls.id}'.`
            );
            methodOwner.set(key, null);
        } else if (!methodOwner.has(key)) {
            methodOwner.set(key, cls.id);
        }
    }

    // --- interface edges ----------------------------------------------------
    const edges = [];
    const orphanOwners = new Map(); // owners that are not ROS node classes

    for (const { relType, label } of INTERFACE_EDGES) {
        const res = await session.run(`
            MATCH (src)-[r:${relType}]->(t:${label})
            RETURN src.label AS srcLabel, src.name AS srcName, src.file AS srcFile,
                   src.path AS srcPath, src.uid AS srcUid, src.isRosNode AS srcIsRosNode,
                   t.name AS iface, r.msgType AS msgType, r.callback AS callback
        `);
        for (const r of res.records) {
            const srcLabel = val(r, "srcLabel");
            const srcName = val(r, "srcName");
            const srcFile = val(r, "srcFile") || val(r, "srcPath");
            const iface = val(r, "iface");
            if (!iface || !prefixOk(srcFile)) continue;

            let owner = nodeByKey.get(`Class:${srcName}:${srcFile}`);

            // A C++ method is defined out-of-line: `void AEB::init()` sits in the
            // .cpp while `class AEB` is declared in the .hpp. The interface edge
            // therefore hangs off a Function in a file that contains no class at
            // all, and the diagram used to invent a node called `init`. The
            // builder links such methods to their class, so ask the graph who
            // owns this function instead of guessing from the file.
            if (!owner && srcLabel === "Function") {
                owner = nodeById.get(methodOwner.get(`${srcName}|${srcFile}`));
            }

            if (!owner) {
                // The edge hangs off a Function or File, or off a class that is
                // not a ROS node. Both are real architecture — group them under
                // a synthetic owner so they still appear in the diagram.
                if (!includeUnowned) continue;
                const key = `${srcLabel}:${srcName}:${srcFile}`;
                if (!orphanOwners.has(key)) {
                    orphanOwners.set(key, {
                        id: val(r, "srcUid") || key,
                        name: srcLabel === "File" ? (srcFile || srcName) : srcName,
                        kind: srcLabel === "File" ? "file" : "class",
                        file: srcFile,
                        nodeName: null,
                        base: null,
                    });
                }
                owner = orphanOwners.get(key);
            }

            // Resolve to the canonical ROS name so a publisher on 'cmd_vel' and
            // a subscriber on '/cmd_vel' meet at the same box. `~/x` needs the
            // owning node's runtime name, which is only known here.
            const raw = rawInterfaces.get(iface);
            const canonical = canonicalizeRosName(iface, {
                nodeName: owner.nodeName,
                dynamic: raw ? raw.dynamic : false,
            });

            edges.push({
                nodeId: owner.id,
                iface: canonical,
                literalName: iface,
                relType,
                kind: label.toLowerCase(),
                direction: directionOf(relType),
                msgType: val(r, "msgType"),
                callback: val(r, "callback"),
                // The method the interface is created in. Subscriptions and
                // services name their callback, publishers do not — and "which
                // method publishes this" is the question a reader has as soon as
                // a node has more than a handful of them. The builder writes the
                // edge from the enclosing Function, so the name is right here;
                // it was simply dropped when the edge was folded onto its owning
                // class.
                viaFunction: srcLabel === "Function" ? srcName : null,
            });
        }
    }

    // A Class-level and a Function-level edge describe the same publisher (the
    // builder writes both, so either entry point finds it). Once both owners
    // are in the model that shows up as a duplicate box, so drop the orphan
    // owner whenever the same file already contributes a ROS node class.
    const rosFiles = new Set(nodes.map((n) => n.file));
    for (const [key, owner] of orphanOwners) {
        if (owner.kind !== "file" && rosFiles.has(owner.file)) {
            orphanOwners.delete(key);
        }
    }
    // Before those function-level edges are discarded, harvest what only they
    // know: the method the interface is created in. The class-level twin carries
    // the ownership, the function-level twin carries the method name — dropping
    // one without the other threw away half the information about the same call
    // site.
    const methodByCall = new Map();
    for (const e of edges) {
        if (!e.viaFunction) continue;
        methodByCall.set(`${e.iface}|${e.relType}`, e.viaFunction);
    }
    for (const e of edges) {
        if (e.viaFunction) continue;
        const via = methodByCall.get(`${e.iface}|${e.relType}`);
        if (via) e.viaFunction = via;
    }

    const ownerIds = new Set([...nodes.map((n) => n.id), ...[...orphanOwners.values()].map((o) => o.id)]);
    const model = {
        nodes: [...nodes, ...orphanOwners.values()],
        edges: edges.filter((e) => ownerIds.has(e.nodeId)),
    };

    // Rebuild the interface list on the CANONICAL names the edges now use, so
    // literal spellings that resolve to the same ROS name collapse into one box.
    // Interfaces nobody references are noise from an earlier build and drop out
    // of this pass automatically.
    const merged = new Map();
    for (const e of model.edges) {
        const raw = rawInterfaces.get(e.literalName) || {};
        const prev = merged.get(e.iface);
        // A fully-qualified type (`geometry_msgs/msg/Twist`, from C++) beats an
        // unqualified one (`Twist`, from a Python import) whichever came first.
        const candidate = raw.msgType || e.msgType || null;
        const better = (a, b) => {
            if (!a) return b;
            if (!b) return a;
            return b.includes("/") && !a.includes("/") ? b : a;
        };
        if (!prev) {
            merged.set(e.iface, {
                name: e.iface,
                kind: raw.kind || e.kind,
                msgType: candidate,
                dynamic: raw.dynamic === true,
                aliases: new Set([e.literalName]),
            });
        } else {
            prev.msgType = better(prev.msgType, candidate);
            prev.dynamic = prev.dynamic || raw.dynamic === true;
            prev.aliases.add(e.literalName);
        }
    }
    model.interfaces = [...merged.values()].map((i) => ({
        name: i.name,
        kind: i.kind,
        msgType: i.msgType,
        dynamic: i.dynamic,
        // The literal spellings found in source, when they differed from the
        // canonical name — useful when tracking down which file wrote what.
        aliases: [...i.aliases].filter((a) => a !== i.name),
    }));

    model.stats = {
        rosNodes: nodes.length,
        otherOwners: orphanOwners.size,
        topics: model.interfaces.filter((i) => i.kind === "topic").length,
        services: model.interfaces.filter((i) => i.kind === "service").length,
        actions: model.interfaces.filter((i) => i.kind === "action").length,
        edges: model.edges.length,
        dynamicNames: model.interfaces.filter((i) => i.dynamic).length,
    };
    return model;
}

/**
 * Render an already-read model. Split out from `generateRosDiagram` so a caller
 * that needs the same model in two formats (the bridge returns PlantUML *and*
 * Mermaid in one response) does not have to query the graph twice.
 */
function renderModel(model, opts = {}) {
    return buildRosDiagram(model, {
        format: opts.format || "plantuml",
        title: opts.title || "ROS 2 Architecture",
        showInheritance: opts.showInheritance !== false,
        onlyConnected: opts.onlyConnected === true,
    });
}

/**
 * Read the ROS layer and render it in one step.
 * @returns {Promise<{diagram, stats, model}>}
 */
async function generateRosDiagram(session, opts = {}) {
    const model = await readRosModel(session, opts);
    return { diagram: renderModel(model, opts), stats: model.stats, model };
}

module.exports = { readRosModel, renderModel, generateRosDiagram, INTERFACE_EDGES, KIND_LABEL };

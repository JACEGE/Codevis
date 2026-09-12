/**
 * ros_diagram.js
 * ----------------------------------------------------------------------------
 * Pure renderer: ROS graph model -> UML diagram text (PlantUML or Mermaid).
 *
 * No graph access, no I/O — `scripts/ros/ros_db.cjs` reads the graph and hands
 * the model in. That keeps the layout rules unit-testable and lets the same
 * model be rendered twice in different formats.
 *
 * DIAGRAM SHAPE — "hybrid class diagram"
 * --------------------------------------
 * A pure UML class diagram would show `MinimalPublisher --|> Node` and lose the
 * topic wiring, which is the part that actually carries the architecture. A
 * pure component diagram would show the wiring but stop being a class diagram.
 * So: ROS node classes are rendered as class boxes with `<<rosnode>>` and
 * typed pub/sub methods, and the topics/services/actions they talk over are
 * rendered as their own `<<topic>>` / `<<service>>` / `<<action>>` boxes in
 * between. The result is valid PlantUML a class parser accepts (so it can be
 * fed straight back through `import_spec`), but it reads as a ROS graph.
 * ----------------------------------------------------------------------------
 */

"use strict";

const { shortMsgType } = require("./ros_model.js");
// Geteilt statt nachgebaut: dieselben Mermaid-Regeln wie im Klassendiagramm.
// Sie sind dort im Browser gemessen worden, und ein zweiter Satz Regeln wäre
// genau die Kopie, die hier schon einmal auseinandergelaufen ist.
const {
    mermaidMember: sharedMermaidMember,
    label: sharedLabel,
    classLabel: sharedClassLabel,
} = require("../diagram/class_render.cjs");

const STEREOTYPE = { topic: "topic", service: "service", action: "action" };

// Arrow direction per edge type: does the node produce into the interface, or
// consume from it? Producing points node -> interface, consuming points the
// other way, so the diagram reads as data flow rather than as call direction.
const EDGE_STYLE = {
    PUBLISHES_TOPIC: { dir: "out", label: "publishes" },
    SUBSCRIBES_TOPIC: { dir: "in", label: "subscribes" },
    PROVIDES_SERVICE: { dir: "in", label: "serves" },
    CALLS_SERVICE: { dir: "out", label: "calls" },
    PROVIDES_ACTION: { dir: "in", label: "serves" },
    USES_ACTION: { dir: "out", label: "sends goal" },
    USES_TOPIC: { dir: "out", label: "uses" },
};

// ============================================================================
// HELPERS
// ============================================================================

/** PlantUML identifier: quote anything that is not a bare word. */
function q(name) {
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `"${String(name).replace(/"/g, "'")}"`;
}

/** Mermaid class ids may not contain `/`, `~` or `-`. */
function mermaidId(name, seen) {
    let id = String(name).replace(/[^A-Za-z0-9_]/g, "_").replace(/^_+/, "");
    if (!id) id = "iface";
    if (!/^[A-Za-z_]/.test(id)) id = "n_" + id;
    if (seen) {
        let base = id, i = 2;
        while (seen.has(id)) id = `${base}_${i++}`;
        seen.add(id);
    }
    return id;
}

/**
 * Method signature shown inside a `<<rosnode>>` box for one interface edge.
 * Publishers read as an outgoing call, subscribers/servers as the handler they
 * install — which is what a reader of the class actually looks for.
 */
function methodFor(edge) {
    const type = shortMsgType(edge.msgType) || "?";
    const iface = edge.iface;
    const cb = callbackName(edge.callback);
    switch (edge.relType) {
        case "PUBLISHES_TOPIC":
            return `+publish(${iface}) : ${type}`;
        case "SUBSCRIBES_TOPIC":
            return `+${cb || "on_" + leaf(iface)}(msg : ${type})`;
        case "PROVIDES_SERVICE":
            return `+${cb || "handle_" + leaf(iface)}(req : ${type})`;
        case "CALLS_SERVICE":
            return `+call(${iface}) : ${type}`;
        case "PROVIDES_ACTION":
            return `+${cb || "execute_" + leaf(iface)}(goal : ${type})`;
        case "USES_ACTION":
            return `+send_goal(${iface}) : ${type}`;
        default:
            return `+uses(${iface}) : ${type}`;
    }
}

/** Last path segment of a ROS name, safe for use in an identifier. */
function leaf(name) {
    const seg = String(name).split("/").filter(Boolean).pop() || "iface";
    return seg.replace(/[^A-Za-z0-9_]/g, "_");
}

/**
 * The bare method name of a callback expression. The graph stores what the
 * source said (`self.scan_cb`, `&ScanListener::scan_cb`, `std::bind(...)`),
 * which is the honest record but reads wrong as a UML method name.
 */
/**
 * Make a member line safe for a Mermaid class diagram.
 *
 * Mermaid's grammar uses `:` to separate a class from its member, so a colon
 * anywhere inside the member text ends the statement early and the whole
 * diagram fails to parse. C++ hits this immediately: a callback parameter is
 * spelled `const cm_msgs::msg::Object::SharedPtr`, and one such method turned
 * the entire ROS diagram into a parse error while the PlantUML output of the
 * same model stayed perfectly valid.
 *
 * `/` gets the same treatment — a ROS type is `pkg/msg/Type` and the slash is
 * not valid in an unquoted member either.
 */
function mermaidMember(sig) {
    // Die ROS-eigene Vorbehandlung: Sichtbarkeitszeichen weg, `const` weg,
    // Typpfade wie `pkg/msg/Type` entschaerft. Danach übernimmt die gehaertete
    // Fassung aus dem Klassendiagramm.
    //
    // Vorher war das hier eine eigenständige Kopie, und sie kannte nur den
    // Doppelpunkt. Alles, was drueben seit dem Browser-Test dazugekommen ist,
    // fehlte: `;` (jede rein virtuelle C++-Methode), eine schließende Klammer
    // ohne öffnende (Absturz IN Mermaids Parser), `__init__` (rendert sonst
    // als "init") und ein führendes `#`, das Mermaid als protected liest --
    // in C++ und JavaScript das Gegenteil. Jeder dieser Fälle nimmt nicht eine
    // Zeile mit, sondern das ganze Diagramm.
    const prepared = String(sig)
        .replace(/^\+/, "")
        .replace(/\bconst\b/g, "")
        .replace(/\//g, "_")   // ROS type paths
        .replace(/\s+/g, " ")
        .trim();
    return sharedMermaidMember(prepared);
}

/** Is this the class constructor rather than a method worth naming? */
function isConstructorName(name) {
    if (!name) return true;
    const n = String(name).trim();
    return n === "__init__" || n === "init" || n === "constructor" || n === "<init>";
}

function callbackName(raw) {
    if (!raw) return null;
    let t = String(raw).trim();
    const bind = /^std::bind\s*\(\s*&?([^,)]+)/.exec(t);
    if (bind) t = bind[1];
    t = t.replace(/^&/, "").trim();
    const seg = t.split(/::|\./).pop();
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(seg) ? seg : null;
}

/** Group edges by owning node, preserving input order. */
function groupEdges(edges) {
    const byNode = new Map();
    for (const e of edges) {
        if (!byNode.has(e.nodeId)) byNode.set(e.nodeId, []);
        byNode.get(e.nodeId).push(e);
    }
    return byNode;
}

/** Best available ROS package name from a project-relative source path. */
function packageName(file) {
    const parts = String(file || "").replace(/\\/g, "/").split("/").filter(Boolean);
    if (parts.length < 2) return null;
    const structural = new Set(["src", "source", "include", "lib"]);
    return parts.find((part, index) => index < parts.length - 1 && !structural.has(part.toLowerCase())) || null;
}

/**
 * Drop interfaces that only one side touches, when `onlyConnected` is set.
 * A topic with a publisher but no subscriber is still architecture (and often
 * a bug worth seeing), so this is OFF by default.
 */
function filterModel(model, { onlyConnected = false } = {}) {
    if (!onlyConnected) return model;
    const degree = new Map();
    for (const e of model.edges) degree.set(e.iface, (degree.get(e.iface) || 0) + 1);
    const keep = new Set([...degree.entries()].filter(([, n]) => n > 1).map(([k]) => k));
    return {
        ...model,
        interfaces: model.interfaces.filter((i) => keep.has(i.name)),
        edges: model.edges.filter((e) => keep.has(e.iface)),
    };
}

// ============================================================================
// PLANTUML
// ============================================================================

function renderPlantUml(model, opts = {}) {
    const { title = "ROS 2 Architecture", showInheritance = true, showFiles = true } = opts;
    const byNode = groupEdges(model.edges);
    const out = [];

    /**
     * Alias per box, because PlantUML identifies a class by its NAME.
     *
     * A ROS workspace routinely holds several packages with the same class name
     * — `AEB` exists three times in this repo's own fixtures, once per package.
     * Emitting `class "AEB"` three times does not draw three boxes: PlantUML
     * merges them into one and hangs every edge from every package onto that
     * single box. The diagram then shows a node publishing topics it never
     * touches. Aliases keep the boxes apart while the label stays readable.
     */
    const aliases = new Map();
    const aliasFor = (key) => {
        if (!aliases.has(key)) aliases.set(key, `E${aliases.size}`);
        return aliases.get(key);
    };
    const nodeAlias = (node) => aliasFor(`n:${node.id}`);
    const ifaceAlias = (name) => aliasFor(`i:${name}`);

    out.push("@startuml");
    out.push(`title ${sharedLabel(title)}`);
    out.push("");
    out.push("skinparam classAttributeIconSize 0");
    out.push("skinparam shadowing false");
    out.push("hide empty members");
    out.push("");

    const renderNode = (node, indent = "") => {
        const stereo = node.kind === "file" ? "<<rosfile>>" : "<<rosnode>>";
        out.push(`${indent}class ${q(node.name)} as ${nodeAlias(node)} ${stereo} {`);
        if (showFiles && node.file) out.push(`${indent}  .. ${node.file} ..`);
        if (node.nodeName) out.push(`${indent}  {field} node name = "${node.nodeName}"`);
        const methods = byNode.get(node.id) || [];
        // Deduplicate: the same publisher created in two branches is one method.
        const seen = new Set();
        for (const e of methods) {
            const sig = methodFor(e);
            if (seen.has(sig)) continue;
            seen.add(sig);
            out.push(`${indent}  ${sig}`);
        }
        out.push(`${indent}}`);
    };

    // --- ROS node classes, grouped by source package -----------------------
    const packages = new Map();
    const ungrouped = [];
    for (const node of model.nodes) {
        const pkg = node.kind === "class" ? packageName(node.file) : null;
        if (!pkg) {
            ungrouped.push(node);
        } else {
            if (!packages.has(pkg)) packages.set(pkg, []);
            packages.get(pkg).push(node);
        }
    }
    for (const [pkg, nodes] of packages) {
        out.push(`package "${String(pkg).replace(/"/g, "'")}" {`);
        for (const node of nodes) renderNode(node, "  ");
        out.push("}");
    }
    for (const node of ungrouped) renderNode(node);
    if (model.nodes.length) out.push("");

    // --- interface boxes ----------------------------------------------------
    for (const iface of model.interfaces) {
        const stereo = STEREOTYPE[iface.kind] || "topic";
        out.push(`class ${q(iface.name)} as ${ifaceAlias(iface.name)} <<${stereo}>> {`);
        if (iface.msgType) {
            out.push(`  {field} ${shortMsgType(iface.msgType)}`);
            if (shortMsgType(iface.msgType) !== iface.msgType) out.push(`  ' full type: ${iface.msgType}`);
        }
        if (iface.dynamic) out.push("  {field} <i>name resolved at runtime</i>");
        out.push("}");
    }
    if (model.interfaces.length) out.push("");

    // --- wiring -------------------------------------------------------------
    const emitted = new Set();
    for (const e of model.edges) {
        const style = EDGE_STYLE[e.relType] || EDGE_STYLE.USES_TOPIC;
        const node = model.nodes.find((n) => n.id === e.nodeId);
        if (!node) continue;
        // The accessing method belongs on the edge: "who publishes this" is only
        // half the answer when a node has twenty methods. The model already
        // carries the callback for subscriptions and services; for publishers it
        // is the enclosing function the builder recorded.
        // A callback names the method that RUNS on the interface — that is the
        // answer to "who handles this". The enclosing function is only a
        // fallback, and it is worthless when it is the constructor: every ROS
        // node creates its publishers in __init__, so labelling every publish
        // edge with it says nothing and reads like a claim that the publishing
        // happens there. Finding the actual `.publish()` call site needs the
        // publisher variable to be tracked through the class; until that exists,
        // no label beats a misleading one.
        const viaName = callbackName(e.callback) || (isConstructorName(e.viaFunction) ? null : e.viaFunction);
        const via = viaName ? ` ${viaName}()` : "";
        const line = style.dir === "out"
            ? `${nodeAlias(node)} ..> ${ifaceAlias(e.iface)} : <<${style.label}>>${via}`
            : `${ifaceAlias(e.iface)} ..> ${nodeAlias(node)} : <<${style.label}>>${via}`;
        if (emitted.has(line)) continue;
        emitted.add(line);
        out.push(line);
    }

    // --- inheritance --------------------------------------------------------
    if (showInheritance) {
        const inh = [];
        for (const node of model.nodes) {
            if (!node.base) continue;
            const line = `${aliasFor(`b:${node.base}`)} <|-- ${nodeAlias(node)}`;
            if (!inh.includes(line)) inh.push(line);
        }
        if (inh.length) {
            out.push("");
            for (const base of new Set(model.nodes.map((n) => n.base).filter(Boolean))) {
                out.push(`class ${q(base)} as ${aliasFor(`b:${base}`)} <<framework>>`);
            }
            out.push(...inh);
        }
    }

    out.push("");
    out.push("@enduml");
    return out.join("\n");
}

// ============================================================================
// MERMAID
// ============================================================================

function renderMermaid(model, opts = {}) {
    const { title = "ROS 2 Architecture", showInheritance = true } = opts;
    const byNode = groupEdges(model.edges);
    const ids = new Map();
    const seenIds = new Set();
    const idFor = (key, name) => {
        if (!ids.has(key)) ids.set(key, mermaidId(name, seenIds));
        return ids.get(key);
    };

    const out = [];
    out.push("---");
    out.push(`title: ${sharedLabel(title)}`);
    out.push("---");
    out.push("classDiagram");

    // A `classDiagram` with no body is a parse error in Mermaid, so an empty
    // model would throw in the browser instead of simply drawing nothing.
    if (!model.nodes.length && !model.interfaces.length) {
        out.push('  class Empty["No ROS interfaces found in the graph"]');
        return out.join("\n");
    }

    for (const node of model.nodes) {
        const id = idFor("n:" + node.id, node.name);
        out.push(`  class ${id}["${sharedClassLabel(node.name)}"] {`);
        out.push("    <<rosnode>>");
        if (node.nodeName) out.push(`    +String node_name = "${node.nodeName}"`);
        const seen = new Set();
        for (const e of byNode.get(node.id) || []) {
            const sig = mermaidMember(methodFor(e));
            if (seen.has(sig)) continue;
            seen.add(sig);
            out.push(`    +${sig}`);
        }
        out.push("  }");
    }

    for (const iface of model.interfaces) {
        const id = idFor("i:" + iface.name, iface.name);
        out.push(`  class ${id}["${sharedClassLabel(iface.name)}"] {`);
        out.push(`    <<${STEREOTYPE[iface.kind] || "topic"}>>`);
        if (iface.msgType) out.push(`    +${mermaidMember(shortMsgType(iface.msgType))}`);
        out.push("  }");
    }

    const emitted = new Set();
    for (const e of model.edges) {
        const node = model.nodes.find((n) => n.id === e.nodeId);
        if (!node) continue;
        const style = EDGE_STYLE[e.relType] || EDGE_STYLE.USES_TOPIC;
        const a = idFor("n:" + node.id, node.name);
        const b = idFor("i:" + e.iface, e.iface);
        const line = style.dir === "out"
            ? `  ${a} ..> ${b} : ${style.label}`
            : `  ${b} ..> ${a} : ${style.label}`;
        if (emitted.has(line)) continue;
        emitted.add(line);
        out.push(line);
    }

    if (showInheritance) {
        for (const node of model.nodes) {
            if (!node.base) continue;
            const a = idFor("b:" + node.base, node.base);
            const b = idFor("n:" + node.id, node.name);
            const line = `  ${a} <|-- ${b}`;
            if (!emitted.has(line)) { emitted.add(line); out.push(line); }
        }
    }

    return out.join("\n");
}

// ============================================================================
// ENTRY POINT
// ============================================================================

/**
 * Render a ROS graph model as a diagram.
 *
 * @param {object} model
 * @param {Array<{id, name, kind?, file?, nodeName?, base?}>} model.nodes ROS node classes.
 * @param {Array<{name, kind, msgType?, dynamic?}>} model.interfaces Topics/services/actions.
 * @param {Array<{nodeId, iface, relType, msgType?, callback?}>} model.edges
 * @param {object} [opts]
 * @param {"plantuml"|"mermaid"} [opts.format="plantuml"]
 * @param {string} [opts.title]
 * @param {boolean} [opts.showInheritance=true]
 * @param {boolean} [opts.onlyConnected=false] Drop interfaces with a single endpoint.
 * @returns {string}
 */
function buildRosDiagram(model, opts = {}) {
    const safe = {
        nodes: model.nodes || [],
        interfaces: model.interfaces || [],
        edges: model.edges || [],
    };
    const filtered = filterModel(safe, opts);
    return opts.format === "mermaid"
        ? renderMermaid(filtered, opts)
        : renderPlantUml(filtered, opts);
}

module.exports = { buildRosDiagram, renderPlantUml, renderMermaid, methodFor, callbackName, EDGE_STYLE };

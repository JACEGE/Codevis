/**
 * spec_db.cjs — Shared DB logic for the spec overlay (single source of truth).
 *
 * Both the MCP handler (tools/handlers/spec-tools.ts) and the bridge
 * (server/bridge.js) use these functions, so the Cypher lives in exactly one
 * place. Pure-DB layer: takes an open neo4j/ladybug-compatible `session`,
 * returns plain JS objects (no MCP envelope, no HTTP).
 *
 * Ladybug single-table mapping (see schema notes): distinct Spec* labels, spec
 * data folded onto existing CodeNode columns, DERIVES edges for structure,
 * reserved words (order/label) avoided.
 */

"use strict";

const { randomUUID } = require("crypto");
const { parseWsd } = require("./wsd_parser.js");
const { parsePumlClass } = require("./puml_class_parser.js");
const { parsePumlUseCase } = require("./puml_usecase_parser.js");
const { parsePumlActivity } = require("./puml_activity_parser.js");
const { computeRegions } = require("./reconcile.js");
const { computeClassRegions } = require("./reconcile_class.js");
const { computeUseCaseRegions } = require("./reconcile_usecase.js");
const { computeActivityRegions } = require("./reconcile_activity.js");

function detectKind(text) {
    const class_ = (text.match(/^\s*(abstract\s+)?(class|interface|enum)\s+\w/gim) || []).length
        + (text.match(/<\|/g) || []).length;
    const activity = (text.match(/^\s*:[^;]*;\s*$/gm) || []).length
        + (text.match(/^\s*(start|stop)\s*$/gim) || []).length
        + (text.match(/\(\*\)/g) || []).length;
    const usecase = (text.match(/^\s*usecase\b/gim) || []).length
        + (text.match(/^\s*actor\b/gim) || []).length
        + (text.match(/--+>?\s*\([^)]+\)/g) || []).length;
    const sequence = (text.match(/^\s*\S+\s*-+>>?\s*\S+\s*:/gm) || []).length;
    const scores = { class: class_, activity, usecase, sequence };
    return Object.keys(scores).reduce((a, b) => (scores[b] > scores[a] ? b : a), "sequence");
}

function toNum(v) {
    return v && typeof v.toNumber === "function" ? v.toNumber() : (v ?? 0);
}

async function resolveMembers(session, uid) {
    const head = await session.run(
        `MATCH (b) WHERE b.uid = $uid RETURN b.label AS label, b.name AS name`, { uid });
    if (!head.records.length) return [];
    if (head.records[0].get("label") === "Function") return [{ uid, name: head.records[0].get("name") }];
    const c = await session.run(
        `MATCH (b)-[:CONTAINS]->(fn) WHERE b.uid = $uid AND fn.label = 'Function'
         RETURN collect(fn.uid) AS uids, collect(fn.name) AS names`, { uid });
    const uids = c.records[0] ? c.records[0].get("uids") || [] : [];
    const names = c.records[0] ? c.records[0].get("names") || [] : [];
    return uids.map((u, i) => ({ uid: u, name: names[i] })).filter(x => x.uid && x.name);
}

// ── import ───────────────────────────────────────────────────────────────────
async function importSpec(session, { text, specId, kind, sourceFile }) {
    const options = { text, specId, kind, sourceFile };
    if (typeof text !== 'string' || !text.trim() || typeof specId !== 'string' || !specId.trim()) {
        throw new Error('Non-empty diagram text and specId are required.');
    }
    if (session.importSpecAtomic) return session.importSpecAtomic(options);
    if (!session.withTransaction) throw new Error('Spec import requires a transactional session. Restart the CodeVis daemon and retry.');
    return session.withTransaction(async tx => {
        const detected = kind || detectKind(text);
        if (!['class', 'sequence', 'activity', 'usecase'].includes(detected)) throw new Error('Unknown diagram kind.');
        const existing = await tx.run(`MATCH (s) WHERE s.name = $specId AND s.label IN
            ['SpecSequence','SpecClassDiagram','SpecUseCaseDiagram','SpecActivityDiagram']
            RETURN s.category AS kind`, { specId });
        if (existing.records.length > 1) throw new Error('Multiple diagrams share this specId; resolve the duplicate before importing.');
        if (existing.records.length && existing.records[0].get('kind') !== detected) {
            throw new Error('Changing diagram kind requires a new specId. The existing diagram was kept.');
        }
        const bindings = await tx.run(`MATCH (s)-[:DERIVES]->(p) WHERE s.name = $specId
            AND p.label IN ['SpecParticipant','SpecClass','SpecUseCase','SpecProcess'] AND p.status = 'confirmed'
            RETURN p.name AS name, p.label AS label, p.value AS target, p.signature AS signature`, { specId });
        const taskLinks = await tx.run(`MATCH (s)-[:DERIVES]->(p)-[:APPLIES_TO]->(t:Task)
            WHERE s.name = $specId RETURN p.name AS name, p.label AS label, t.taskId AS taskId`, { specId });
        const result = await importParsedSpec(tx, options);
        for (const binding of bindings.records) {
            const values = { specId, name: binding.get('name'), label: binding.get('label'),
                target: binding.get('target'), signature: binding.get('signature') };
            await tx.run(`MATCH (s)-[:DERIVES]->(p) WHERE s.name = $specId AND p.name = $name AND p.label = $label
                OPTIONAL MATCH (p)-[e:REALIZED_BY]->() DELETE e`, values);
            await tx.run(`MATCH (s)-[:DERIVES]->(p) WHERE s.name = $specId AND p.name = $name AND p.label = $label
                SET p.value = $target, p.signature = $signature, p.status = 'confirmed'`, values);
            const linked = await linkRealization(tx, { specId, nodeName: values.name, label: values.label,
                uid: values.target, confidence: 'manual' });
            if (linked) result.needsBinding = result.needsBinding.filter(name => name !== values.name);
        }
        for (const link of taskLinks.records) {
            await tx.run(`MATCH (s)-[:DERIVES]->(p), (t:Task {taskId:$taskId})
                WHERE s.name = $specId AND p.name = $name AND p.label = $label
                MERGE (p)-[:APPLIES_TO]->(t)`,
                { specId, name: link.get('name'), label: link.get('label'), taskId: link.get('taskId') });
        }
        return result;
    });
}

async function importParsedSpec(session, { text, specId, kind, sourceFile }) {
    const detected = kind || detectKind(text);
    // Stash the raw diagram text on `parsed` so the import helpers can persist
    // it on the container node (for the diagram library / re-view).
    if (detected === "class") {
        const parsed = parsePumlClass(text); parsed.sourceFile = sourceFile; parsed.source = text;
        return importClass(session, parsed, specId);
    }
    if (detected === "usecase") {
        const parsed = parsePumlUseCase(text); parsed.sourceFile = sourceFile; parsed.source = text;
        return importUseCase(session, parsed, specId);
    }
    if (detected === "activity") {
        const parsed = parsePumlActivity(text); parsed.sourceFile = sourceFile; parsed.source = text;
        return importActivity(session, parsed, specId);
    }
    const parsed = parseWsd(text); parsed.sourceFile = sourceFile; parsed.source = text;
    return importSequence(session, parsed, specId);
}

/**
 * Draw the Spec -> Code realization edge for a spec node that resolved to code.
 *
 * TWO REPRESENTATIONS, ONE TRUTH. The binding is stored twice on purpose, with
 * strictly separated roles — do not let them drift into two competing answers:
 *
 *   REALIZED_BY edge  = the LIVE truth. Is this spec node realised by code
 *                       right now? An edge cannot outlive its endpoint: when a
 *                       rebuild deletes the code node, the edge goes with it,
 *                       and "unrealised" becomes simply "no outgoing edge".
 *   `value` property  = the HINT only. Which uid this node was last bound to,
 *                       kept so a rematch after a rebuild has a starting point.
 *
 * Never answer "is this bound?" from `value` — that is exactly the bug this
 * replaces: a rename changes the target's uid, and the property kept claiming
 * status:'confirmed' while pointing at a uid that no longer existed.
 *
 * Returns true if an edge was drawn. A uid with no matching node draws nothing
 * and says so, rather than silently recording a binding that does not exist.
 */
async function linkRealization(session, { specId, nodeName, label, uid, confidence }) {
    if (!uid) return false;
    const resolved = await resolveUidHint(session, uid);
    if (!resolved) return false;
    // Der Hinweis stand in einer Schreibweise, die es nicht mehr gibt. Auf die
    // aktuelle umschreiben, sonst läuft der nächste Rebind wieder über den
    // Umweg — und der ist mehrdeutig, wo der Treffer es nicht ist.
    if (resolved.rebound) {
        await session.run(
            `MATCH (s)-[:DERIVES]->(p) WHERE s.name = $specId AND p.name = $nodeName AND p.label = $label
             SET p.value = $newUid`,
            { specId, nodeName, label, newUid: resolved.uid });
    }
    const res = await session.run(
        `MATCH (s)-[:DERIVES]->(p) WHERE s.name = $specId AND p.name = $nodeName AND p.label = $label
         MATCH (c) WHERE c.uid = $uid
         MERGE (p)-[e:REALIZED_BY]->(c) SET e.confidence = $conf, e.matchedAt = timestamp()
         RETURN c.uid AS uid`,
        { specId, nodeName, label, uid: resolved.uid, conf: confidence });
    return res.records.length > 0;
}

/**
 * Zerlegt eine uid der Form `Class||file=src/a.py||name=Foo` in ihre Teile.
 * Alles andere (sha-Hex aus makeUid, `specclass:6149`, leer) gibt null — daraus
 * lässt sich nichts rematchen.
 */
function parseUidHint(uid) {
    const s = String(uid || "");
    if (!s.includes("||")) return null;
    const [label, ...segments] = s.split("||");
    if (!label) return null;
    const props = {};
    for (const seg of segments) {
        const eq = seg.indexOf("=");
        if (eq > 0) props[seg.slice(0, eq)] = seg.slice(eq + 1);
    }
    return { label, name: props.name || null, file: props.file || null, path: props.path || null };
}

/**
 * Die uid eines Hinweises auf einen Knoten auflösen, der es heute noch gibt.
 *
 * Der direkte Treffer ist der Normalfall. Er scheitert aber an einer uid, die
 * in einer alten SCHREIBWEISE gespeichert wurde: der Translator sortiert die
 * Merge-Keys kanonisch (`Class||file=…||name=…`), aeltere Stände taten das
 * nicht (`Class||name=…||file=…`). Beide beschreiben denselben Knoten, aber ein
 * Vergleich auf den String findet ihn nicht — gemessen an einem betroffenen Graphen:
 * 13 gebundene SpecClass-Knoten, 0 REALIZED_BY-Kanten, und `relinkRealizations`
 * probierte nach jedem Build erfolglos denselben String.
 *
 * Deshalb der zweite Weg: den Hinweis in (label, name, file) zerlegen und den
 * Knoten darüber suchen. Das erfindet keine Bindung — mehrdeutig oder gar
 * nicht gefunden heißt weiterhin "nicht realisiert".
 */
async function resolveUidHint(session, uid) {
    const direct = await session.run(`MATCH (c) WHERE c.uid = $uid RETURN c.uid AS uid`, { uid });
    if (direct.records.length) return { uid, rebound: false };

    const hint = parseUidHint(uid);
    if (!hint || !(hint.name || hint.path)) return null;
    const res = await session.run(
        `MATCH (c) WHERE c.label = $label AND c.uid IS NOT NULL
           AND ($name IS NULL OR c.name = $name)
           AND ($file IS NULL OR c.file = $file)
           AND ($path IS NULL OR c.path = $path)
         RETURN c.uid AS uid`,
        { label: hint.label, name: hint.name, file: hint.file, path: hint.path });
    if (res.records.length !== 1) return null;
    return { uid: res.records[0].get("uid"), rebound: true };
}

// Exact unambiguous bind of a name to a code node; null if none/ambiguous.
async function exactBind(session, name, labels) {
    const res = await session.run(
        `MATCH (n) WHERE n.name = $name AND n.uid IS NOT NULL AND n.label IN $labels
         RETURN n.uid AS uid, n.name AS name`, { name, labels });
    return res.records.length === 1 ? { uid: res.records[0].get("uid"), name: res.records[0].get("name") } : null;
}

async function importUseCase(session, parsed, specId) {
    await session.run(
        `MATCH (s:SpecUseCaseDiagram {name: $specId}) OPTIONAL MATCH (s)-[:DERIVES]->(c) DETACH DELETE s, c`, { specId });
    await session.run(
        `CREATE (s:SpecUseCaseDiagram {name: $specId, title: $title, sourceFile: $sourceFile, text: $diagramText, category: 'usecase', createdAt: timestamp()})`,
        { specId, title: parsed.title || specId, sourceFile: parsed.sourceFile || specId, diagramText: parsed.source || '' });

    for (const a of parsed.actors) {
        await session.run(
            `MATCH (s:SpecUseCaseDiagram {name: $specId}) CREATE (x:SpecActor {name: $name, scope: $display}) MERGE (s)-[:DERIVES]->(x)`,
            { specId, name: a.name, display: a.display || null });
    }
    const ucReport = [];
    for (const uc of parsed.usecases) {
        const bound = (await exactBind(session, uc.name, ["Function", "Endpoint", "Component", "Class", "Module"]))
            || (await exactBind(session, uc.id, ["Function", "Endpoint", "Component", "Class", "Module"]));
        const conf = bound ? "exact" : "unbound";
        await session.run(
            `MATCH (s:SpecUseCaseDiagram {name: $specId})
             CREATE (u:SpecUseCase {name: $id, text: $disp, status: $conf, value: $uid, signature: $bn}) MERGE (s)-[:DERIVES]->(u)`,
            { specId, id: uc.id, disp: uc.name, conf, uid: bound ? bound.uid : null, bn: bound ? bound.name : null });
        await linkRealization(session, {
            specId, nodeName: uc.id, label: "SpecUseCase", uid: bound ? bound.uid : null, confidence: conf });
        ucReport.push({ id: uc.id, name: uc.name, bound: bound || null });
    }
    for (const r of parsed.relations) {
        await session.run(
            `MATCH (s:SpecUseCaseDiagram {name: $specId}) CREATE (x:SpecRelation {name: $type, scope: $from, value: $to}) MERGE (s)-[:DERIVES]->(x)`,
            { specId, type: r.type, from: r.from, to: r.to });
    }
    for (const a of parsed.associations) {
        await session.run(
            `MATCH (s:SpecUseCaseDiagram {name: $specId}) CREATE (x:SpecAssoc {name: 'assoc', scope: $actor, value: $uc}) MERGE (s)-[:DERIVES]->(x)`,
            { specId, actor: a.actor, uc: a.usecase });
    }
    return {
        kind: "usecase", specId, title: parsed.title,
        actors: parsed.actors.map(a => a.name),
        usecases: ucReport.map(u => ({ id: u.id, name: u.name, implemented: !!u.bound })),
        needsBinding: ucReport.filter(u => !u.bound).map(u => u.id),
    };
}

async function importActivity(session, parsed, specId) {
    await session.run(
        `MATCH (s:SpecActivityDiagram {name: $specId}) OPTIONAL MATCH (s)-[:DERIVES]->(c) DETACH DELETE s, c`, { specId });
    await session.run(
        `CREATE (s:SpecActivityDiagram {name: $specId, title: $title, sourceFile: $sourceFile, text: $diagramText, category: 'activity', createdAt: timestamp()})`,
        { specId, title: parsed.title || specId, sourceFile: parsed.sourceFile || specId, diagramText: parsed.source || '' });

    // The process this activity describes — bindable like a participant. Try to
    // auto-bind by the diagram title.
    const procName = parsed.title || specId;
    const bound = await exactBind(session, procName, ["Function", "Class", "Module", "Component"]);
    await session.run(
        `MATCH (s:SpecActivityDiagram {name: $specId})
         CREATE (p:SpecProcess {name: $name, status: $conf, value: $uid, signature: $bn}) MERGE (s)-[:DERIVES]->(p)`,
        { specId, name: procName, conf: bound ? "exact" : "unbound", uid: bound ? bound.uid : null, bn: bound ? bound.name : null });
    await linkRealization(session, {
        specId, nodeName: procName, label: "SpecProcess", uid: bound ? bound.uid : null, confidence: "exact" });

    for (const act of parsed.actions) {
        await session.run(
            `MATCH (s:SpecActivityDiagram {name: $specId})
             CREATE (a:SpecAction {name: $method, text: $raw, kind: $guard, ts: $ord}) MERGE (s)-[:DERIVES]->(a)`,
            { specId, method: act.method, raw: act.name, guard: act.guard, ord: act.order });
    }
    return {
        kind: "activity", specId, title: parsed.title,
        process: { name: procName, bound: !!bound },
        actionCount: parsed.actions.length,
        needsBinding: bound ? [] : [procName],
    };
}

async function importSequence(session, parsed, specId) {
    await session.run(
        `MATCH (s:SpecSequence {name: $specId}) OPTIONAL MATCH (s)-[:DERIVES]->(child) DETACH DELETE s, child`,
        { specId });
    await session.run(
        `CREATE (s:SpecSequence {name: $specId, title: $title, sourceFile: $sourceFile, text: $diagramText, category: 'sequence', createdAt: timestamp()})`,
        { specId, title: parsed.title || specId, sourceFile: parsed.sourceFile || specId, diagramText: parsed.source || '' });

    const participants = [];
    for (const p of parsed.participants) {
        const candidates = [p.alias, p.display].filter(Boolean);
        let bound = null, ambiguous = false;
        for (const cand of candidates) {
            const res = await session.run(
                `MATCH (n) WHERE n.name = $name AND n.uid IS NOT NULL AND n.label IN ['Class','Function','Module']
                 RETURN n.uid AS uid, n.name AS name`, { name: cand });
            if (res.records.length === 1) { bound = { uid: res.records[0].get("uid"), name: res.records[0].get("name") }; break; }
            else if (res.records.length > 1) ambiguous = true;
        }
        const conf = bound ? "exact" : (ambiguous ? "ambiguous" : "unbound");
        await session.run(
            `MATCH (s:SpecSequence {name: $specId})
             CREATE (p:SpecParticipant {name: $alias, scope: $display, kind: $kind, status: $conf, value: $uid, signature: $bn})
             MERGE (s)-[:DERIVES]->(p)`,
            { specId, alias: p.alias, display: p.display || null, kind: p.kind, conf, uid: bound ? bound.uid : null, bn: bound ? bound.name : null });
        await linkRealization(session, {
            specId, nodeName: p.alias, label: "SpecParticipant", uid: bound ? bound.uid : null, confidence: conf });
        participants.push({ alias: p.alias, kind: p.kind, bound: bound || null, confidence: conf });
    }
    for (const m of parsed.messages) {
        await session.run(
            `MATCH (s:SpecSequence {name: $specId})
             CREATE (msg:SpecMessage {name: $method, text: $label, scope: $from, value: $to, kind: $guard, ts: $ord, signature: $dir})
             MERGE (s)-[:DERIVES]->(msg)`,
            { specId, method: m.method, label: m.label, from: m.from, to: m.to, guard: m.guard, ord: m.order,
              dir: m.dashed ? "return" : null });
    }
    return {
        kind: "sequence", specId, title: parsed.title,
        participants, messageCount: parsed.messages.length,
        needsBinding: participants.filter(p => !p.bound).map(p => p.alias),
    };
}

// UML relation type -> persisted edge type. `inherits` maps onto the code
// graph's own INHERITS so a diagram's hierarchy is indistinguishable from a
// parsed one; everything else shares SPEC_RELATES and keeps its UML type in
// the edge's `name`.
//
// A relationship type CANNOT be parameterised in Cypher, so this value is
// string-interpolated into the query. It must therefore never come from parser
// output directly: an unknown type falls back to SPEC_RELATES rather than
// reaching the query. Keep it that way.
const CLASS_REL_EDGE = {
    inherits: "INHERITS",
    composition: "SPEC_RELATES",
    aggregation: "SPEC_RELATES",
    association: "SPEC_RELATES",
    dependency: "SPEC_RELATES",
};

async function importClass(session, parsed, specId) {
    await session.run(
        `MATCH (s:SpecClassDiagram {name: $specId}) OPTIONAL MATCH (s)-[:DERIVES]->(child) DETACH DELETE s, child`,
        { specId });
    await session.run(
        `CREATE (s:SpecClassDiagram {name: $specId, title: $title, sourceFile: $sourceFile, text: $diagramText, category: 'class', createdAt: timestamp()})`,
        { specId, title: parsed.title || specId, sourceFile: parsed.sourceFile || specId, diagramText: parsed.source || '' });

    const classes = [];
    for (const c of parsed.classes) {
        let bound = null, ambiguous = false;
        const res = await session.run(
            `MATCH (n) WHERE n.name = $name AND n.uid IS NOT NULL AND n.label IN ['Class','Module']
             RETURN n.uid AS uid, n.name AS name`, { name: c.name });
        if (res.records.length === 1) bound = { uid: res.records[0].get("uid"), name: res.records[0].get("name") };
        else if (res.records.length > 1) ambiguous = true;
        const conf = bound ? "exact" : (ambiguous ? "ambiguous" : "unbound");
        await session.run(
            `MATCH (s:SpecClassDiagram {name: $specId})
             CREATE (k:SpecClass {name: $name, kind: $kind, status: $conf, value: $uid, signature: $bn})
             MERGE (s)-[:DERIVES]->(k)`,
            { specId, name: c.name, kind: c.kind, conf, uid: bound ? bound.uid : null, bn: bound ? bound.name : null });
        await linkRealization(session, {
            specId, nodeName: c.name, label: "SpecClass", uid: bound ? bound.uid : null, confidence: conf });
        // Members are wired to their class with a real DECLARES edge — the same
        // edge parsed code uses for class→member — so the structure IS in the
        // graph and not merely reconstructed by the one function that reads it.
        // `scope` stays as the owning class NAME: it is what reconcile matches
        // on, and it keeps the member readable when its class is gone.
        for (const m of c.methods) {
            // Parameter und Rückgabetyp landen auf denselben Spalten, die eine
            // geparste Code-Funktion benutzt (`params`, `return_type`) — eine
            // Spec-Methode IST eine Methode, und ein Leser muss sich nicht
            // merken, dass sie ihre Signatur woanders ablegt.
            await session.run(
                `MATCH (s:SpecClassDiagram {name: $specId})-[:DERIVES]->(k:SpecClass {name: $owner})
                 CREATE (mm:SpecMethod {name: $mn, scope: $owner, kind: $vis,
                                        params: $params, return_type: $returns, signature: $signature})
                 MERGE (s)-[:DERIVES]->(mm) MERGE (k)-[:DECLARES]->(mm)`,
                { specId, mn: m.name, owner: c.name, vis: m.visibility,
                  params: m.params || null, returns: m.returns || null,
                  signature: m.signature || m.name });
        }
        // Attributes/fields are part of the class STRUCTURE — import them as
        // SpecField members so the diagram's full shape, not just its methods,
        // lands in the graph.
        for (const f of c.fields || []) {
            await session.run(
                `MATCH (s:SpecClassDiagram {name: $specId})-[:DERIVES]->(k:SpecClass {name: $owner})
                 CREATE (ff:SpecField {name: $fn, scope: $owner, kind: $vis,
                                       declaredType: $type, signature: $signature})
                 MERGE (s)-[:DERIVES]->(ff) MERGE (k)-[:DECLARES]->(ff)`,
                { specId, fn: f.name, owner: c.name, vis: f.visibility || null,
                  type: f.type || null, signature: f.signature || f.name });
        }
        classes.push({ name: c.name, kind: c.kind, methods: c.methods.length, fields: (c.fields || []).length, bound: bound || null, confidence: conf });
    }
    // Relations run in a second pass: an arrow may name a class that is only
    // declared further down the diagram, so both endpoints exist only now.
    let relationEdges = 0;
    for (const r of parsed.relations) {
        // The SpecRelation node stays — reconcile reads it, and it is the only
        // record of a relation whose endpoints are not declared classes (the
        // edge below simply does not get drawn in that case).
        await session.run(
            `MATCH (s:SpecClassDiagram {name: $specId})
             CREATE (rel:SpecRelation {name: $type, scope: $from, value: $to,
                                       text: $label, signature: $raw})
             MERGE (s)-[:DERIVES]->(rel)`,
            { specId, type: r.type, from: r.from, to: r.to,
              label: r.label || null, raw: r.raw || null });

        // Label und Multiplizitaeten gehören an die KANTE: dort werden sie
        // gelesen, wenn ein Worker fragt "wie hängt meine Klasse an der
        // anderen". `association` allein sagt ihm nichts.
        const edgeType = CLASS_REL_EDGE[r.type] || "SPEC_RELATES";
        const res = await session.run(
            `MATCH (s:SpecClassDiagram {name: $specId})-[:DERIVES]->(a:SpecClass {name: $from})
             MATCH (s)-[:DERIVES]->(b:SpecClass {name: $to})
             MERGE (a)-[e:${edgeType}]->(b)
             SET e.name = $type, e.umlLabel = $label,
                 e.multiplicityFrom = $fromMult, e.multiplicityTo = $toMult
             RETURN a.uid AS drawn`,
            { specId, from: r.from, to: r.to, type: r.type,
              label: r.label || null,
              fromMult: r.fromMultiplicity || null, toMult: r.toMultiplicity || null });
        if (res.records.length) relationEdges++;
    }
    return {
        kind: "class", specId, title: parsed.title,
        classes, relationCount: parsed.relations.length, relationEdges,
        needsBinding: classes.filter(c => !c.bound).map(c => c.name),
    };
}

// ── bind ─────────────────────────────────────────────────────────────────────
async function bindSpec(session, specId, bindings) {
    const results = [];
    for (const b of bindings) {
        const res = await session.run(
            `MATCH (n) WHERE (n.uid = $target OR n.name = $target OR n.path = $target)
               AND n.uid IS NOT NULL AND n.label IN ['Class','Function','Module','File']
             RETURN n.uid AS uid, coalesce(n.name, n.path) AS name, n.label AS label`, { target: b.target });
        if (res.records.length === 0) { results.push({ alias: b.alias, status: "NOT_FOUND", target: b.target }); continue; }
        if (res.records.length > 1) {
            results.push({ alias: b.alias, status: "AMBIGUOUS", target: b.target,
                candidates: res.records.map(r => ({ uid: r.get("uid"), name: r.get("name") })) });
            continue;
        }
        const r = res.records[0];
        const upd = await session.run(
            `MATCH (s)-[:DERIVES]->(p) WHERE s.name = $specId AND p.name = $alias
               AND p.label IN ['SpecParticipant','SpecClass','SpecUseCase','SpecProcess']
             SET p.value = $uid, p.signature = $name, p.status = 'confirmed' RETURN p.name AS alias, p.label AS label`,
            { specId, alias: b.alias, uid: r.get("uid"), name: r.get("name") });

        let linked = false;
        if (upd.records.length) {
            // Re-binding must not leave the previous edge behind: MERGE would
            // add a second REALIZED_BY and the node would read as realised by
            // two different code nodes at once. Drop the old one first.
            await session.run(
                `MATCH (s)-[:DERIVES]->(p)-[e:REALIZED_BY]->() WHERE s.name = $specId AND p.name = $alias
                   AND p.label IN ['SpecParticipant','SpecClass','SpecUseCase','SpecProcess']
                 DELETE e`,
                { specId, alias: b.alias });
            linked = await linkRealization(session, {
                specId, nodeName: b.alias, label: upd.records[0].get("label"),
                uid: r.get("uid"), confidence: "manual",
            });
        }
        results.push({ alias: b.alias, status: upd.records.length ? "BOUND" : "PARTICIPANT_NOT_FOUND",
            realized: linked,
            boundTo: { uid: r.get("uid"), name: r.get("name"), label: r.get("label") } });
    }
    return results;
}

/**
 * Re-draw REALIZED_BY edges after a graph rebuild, using `value` as the hint.
 *
 * A rebuild deletes and re-creates every code node, so every REALIZED_BY edge
 * goes with it — that is correct (the edge tracks a node that genuinely no
 * longer exists) but on its own it would report EVERY spec node as unrealised
 * after any rebuild, including the vast majority where nothing changed.
 *
 * This works because a code node's uid is DERIVED, not allocated: on Ladybug
 * the translator computes it for MERGE from the label plus the canonically
 * sorted merge properties (e.g. `Class||file=src/order.js||name=Order`). Note
 * it is NOT graph_builder's makeUid() sha256 — `SET n.uid = …` is neutralised
 * there because uid is the primary key. Either way the value is a pure function
 * of (label, name, file), so untouched code rebuilds to the same uid `value`
 * already holds and the edge simply comes back.
 *
 * For RENAMED or MOVED code the uid differs, nothing matches, and the spec node
 * correctly stays unrealised — precisely the signal a structural rematch should
 * act on. The hint never invents a binding; it only restores one whose target
 * still exists.
 *
 * Returns { restored, stale } so a caller can see how much did not come back.
 */
async function relinkRealizations(session) {
    const res = await session.run(
        `MATCH (s)-[:DERIVES]->(p)
         WHERE p.label IN ['SpecClass','SpecParticipant','SpecUseCase','SpecProcess']
           AND p.value IS NOT NULL
         RETURN s.name AS specId, p.name AS name, p.label AS label, p.value AS uid`);

    let restored = 0;
    const stale = [];
    for (const r of res.records) {
        const ok = await linkRealization(session, {
            specId: r.get("specId"), nodeName: r.get("name"),
            label: r.get("label"), uid: r.get("uid"), confidence: "exact",
        });
        if (ok) restored++;
        else stale.push({ specId: r.get("specId"), name: r.get("name"), uid: r.get("uid") });
    }

    const bound = await bindFreshCode(session);
    return { restored, bound, stale };
}

// Womit ein noch nie gebundener Spec-Knoten im Code zusammenfallen darf —
// dieselben Label wie beim Import, damit der Nachlauf nicht großzügiger
// bindet als der erste Versuch.
const RETRY_CODE_LABELS = {
    SpecClass: ["Class", "Module"],
    SpecParticipant: ["Class", "Function", "Module"],
    SpecUseCase: ["Function", "Endpoint", "Component", "Class", "Module"],
    SpecProcess: ["Function", "Class", "Module", "Component"],
};

/**
 * Spec-Knoten binden, für die es beim Import noch keinen Code GAB.
 *
 * Das ist der Normalfall, wenn man richtig herum arbeitet: erst das Diagramm,
 * dann der Code. Beim Import findet die Namenssuche nichts, der Knoten bleibt
 * auf status='unbound' und `value` bleibt leer — und genau daran scheiterte der
 * Nachlauf: er lief nur über Knoten MIT `value` und übersprang die
 * Unbeschriebenen für immer. In einem betroffenen Graphen betraf das 45
 * von 63 bindbaren Spec-Knoten; die wären auch nach zehn Rebuilds nie
 * angewachsen.
 *
 * Gebunden wird nach derselben Regel wie beim Import: exakter Name, genau ein
 * Treffer. Mehrdeutig heißt weiterhin unbound — lieber eine Lücke, die man
 * sieht, als eine Kante, die auf den falschen Knoten zeigt.
 */
async function bindFreshCode(session) {
    const fresh = await session.run(
        `MATCH (s)-[:DERIVES]->(p)
         WHERE p.label IN ['SpecClass','SpecParticipant','SpecUseCase','SpecProcess']
           AND p.value IS NULL
         RETURN s.name AS specId, p.name AS name, p.label AS label,
                p.scope AS display, p.text AS text`);

    let bound = 0;
    for (const r of fresh.records) {
        const label = r.get("label");
        const name = r.get("name");
        const specId = r.get("specId");
        const labels = RETRY_CODE_LABELS[label];
        if (!labels || !name) continue;

        // Zweitkandidaten wie beim Import: der Anzeigename eines Participants
        // (`scope`) und der Text eines Use Case (`text`) sind oft der echte
        // Codename, während `name` nur das Diagramm-Kürzel ist (UC1, GEO).
        let hit = null;
        for (const cand of [name, r.get("display"), r.get("text")].filter(Boolean)) {
            hit = await exactBind(session, cand, labels);
            if (hit) break;
        }
        if (!hit) continue;

        await session.run(
            `MATCH (s)-[:DERIVES]->(p) WHERE s.name = $specId AND p.name = $name AND p.label = $label
             SET p.value = $uid, p.signature = $bn, p.status = 'exact'`,
            { specId, name, label, uid: hit.uid, bn: hit.name });
        if (await linkRealization(session, {
            specId, nodeName: name, label, uid: hit.uid, confidence: "exact",
        })) bound++;
    }
    return bound;
}

// ── realization coverage ─────────────────────────────────────────────────────
// The two questions the spec overlay exists to answer are "specified but not
// built" and "built but not specified". With REALIZED_BY these are plain
// design-to-code relationships rather than inferred value-property matches.
// The coverage queries ask the graph, never the `value` property — see
// linkRealization on why.

/** Spec nodes with no code behind them: specified but not built. */
async function listUnrealizedSpecs(session, specId = null) {
    const res = await session.run(
        `MATCH (s)-[:DERIVES]->(p)
         WHERE p.label IN ['SpecClass','SpecParticipant','SpecUseCase','SpecProcess']
           AND ($specId IS NULL OR s.name = $specId)
           AND NOT EXISTS { MATCH (p)-[:REALIZED_BY]->() }
         RETURN s.name AS specId, p.name AS name, p.label AS label, p.status AS status`,
        { specId });
    return res.records.map((r) => ({
        specId: r.get("specId"), name: r.get("name"),
        label: r.get("label"), status: r.get("status"),
    }));
}

/** Code nodes no diagram accounts for: built but not specified. */
async function listUnspecifiedCode(session, labels = ["Class", "Component"]) {
    const res = await session.run(
        `MATCH (c) WHERE c.label IN $labels AND c.uid IS NOT NULL
           AND NOT EXISTS { MATCH ()-[:REALIZED_BY]->(c) }
         RETURN c.name AS name, c.label AS label, c.uid AS uid`,
        { labels });
    return res.records.map((r) => ({
        name: r.get("name"), label: r.get("label"), uid: r.get("uid"),
    }));
}

// ── reconcile ────────────────────────────────────────────────────────────────
async function reconcileSpec(session, specId, opts = {}) {
    const kindRes = await session.run(
        `MATCH (s) WHERE s.name = $specId AND s.label IN
           ['SpecSequence','SpecClassDiagram','SpecUseCaseDiagram','SpecActivityDiagram'] RETURN s.label AS label`,
        { specId });
    if (!kindRes.records.length) return { error: `No spec '${specId}' found.` };
    const label = kindRes.records[0].get("label");
    if (label === "SpecClassDiagram") return reconcileClass(session, specId, opts);
    if (label === "SpecUseCaseDiagram") return reconcileUseCase(session, specId, opts);
    if (label === "SpecActivityDiagram") return reconcileActivity(session, specId, opts);
    return reconcileSequence(session, specId, opts);
}

async function reconcileUseCase(session, specId, opts) {
    const uRes = await session.run(
        `MATCH (s:SpecUseCaseDiagram {name: $specId})-[:DERIVES]->(u:SpecUseCase)
         RETURN u.name AS id, u.text AS disp, u.value AS uid, u.signature AS bn, u.status AS conf`, { specId });
    const rRes = await session.run(
        `MATCH (s:SpecUseCaseDiagram {name: $specId})-[:DERIVES]->(r:SpecRelation)
         RETURN r.name AS type, r.scope AS from, r.value AS to`, { specId });

    const usecases = uRes.records.map(r => ({ id: r.get("id"), name: r.get("disp") }));
    const relations = rRes.records.map(r => ({ type: r.get("type"), from: r.get("from"), to: r.get("to") }));
    const bindings = {}, uidById = {}, allUids = [];
    for (const r of uRes.records) {
        const id = r.get("id"), uid = r.get("uid"), conf = r.get("conf");
        if (!uid || (conf !== "confirmed" && conf !== "exact")) continue;
        bindings[id] = { uid, name: r.get("bn") };
        uidById[id] = uid; allUids.push(uid);
    }
    let calls = [];
    if (allUids.length) {
        const cRes = await session.run(
            `MATCH (a)-[:CALLS]->(c) WHERE a.uid IN $uids AND c.uid IN $uids RETURN a.uid AS fromUid, c.uid AS toUid`,
            { uids: allUids });
        calls = cRes.records.map(r => ({ fromUid: r.get("fromUid"), toUid: r.get("toUid") }));
    }
    const regions = computeUseCaseRegions({ usecases, bindings, relations, calls });

    const emitted = [];
    if (opts.emitTasks && regions.unimplemented.length) {
        for (const uc of regions.unimplemented) {
            const desc = `Use case '${uc.name}' from diagram '${specId}' has no implementation bound in the code graph. ` +
                `Implement it (a function/endpoint/component that fulfils this capability) so the design is covered.`;
            const wi = `Implement the '${uc.name}' use case end to end. Acceptance: a code node exists and the use case ` +
                `binds to it.` + (opts.instructions ? `\n\nArchitect instructions:\n${opts.instructions}` : "");
            // `uc.id` ist der Knotenname, `uc.name` nur der Anzeigetext. Ohne
            // Code-Bindung ist diese Kante die EINZIGE, die dieser Task je
            // bekommt — bisher hingen Use-Case-Tasks völlig isoliert im Graphen.
            const taskId = await emitTask(session, `Implement use case: ${uc.name}`, desc, wi, opts.priority, null,
                { specId, specNodeName: uc.id, specNodeLabel: "SpecUseCase" });
            emitted.push({ taskId, useCase: uc.name });
        }
    }
    return { kind: "usecase", specId, summary: regions.summary, regions, emitted };
}

async function reconcileActivity(session, specId, opts) {
    const pRes = await session.run(
        `MATCH (s:SpecActivityDiagram {name: $specId})-[:DERIVES]->(p:SpecProcess)
         RETURN p.name AS name, p.value AS uid, p.signature AS bn, p.status AS conf LIMIT 1`, { specId });
    const aRes = await session.run(
        `MATCH (s:SpecActivityDiagram {name: $specId})-[:DERIVES]->(a:SpecAction)
         RETURN a.name AS method, a.text AS raw, a.kind AS guard, a.ts AS ord ORDER BY a.ts`, { specId });
    const actions = aRes.records.map(r => ({ name: r.get("raw"), method: r.get("method"), guard: r.get("guard") }));

    const proc = pRes.records[0];
    const procUid = proc ? proc.get("uid") : null;
    const procConf = proc ? proc.get("conf") : null;
    const processBound = !!(procUid && (procConf === "confirmed" || procConf === "exact"));

    let processCallees = [];
    if (processBound) {
        // Callees = functions the process (or its member functions) calls.
        const members = await resolveMembers(session, procUid);
        const uids = members.map(m => m.uid);
        if (uids.length) {
            const cRes = await session.run(
                `MATCH (a)-[:CALLS]->(c:Function) WHERE a.uid IN $uids RETURN DISTINCT c.name AS name`, { uids });
            processCallees = cRes.records.map(r => ({ name: r.get("name") })).filter(x => x.name);
        }
    }
    const regions = computeActivityRegions({ actions, processBound, processCallees });

    const emitted = [];
    if (opts.emitTasks && processBound && regions.missing.length) {
        for (const m of regions.missing) {
            const desc = `Activity '${specId}' step '${m.action}' is not reflected by any call from the bound process ` +
                `'${proc.get("name")}'. Implement the step so the process performs it as documented.`;
            const wi = `Implement the '${m.action}' step in the '${proc.get("name")}' process (expected callable ~${m.method}). ` +
                `Acceptance: the process calls it.` + (opts.instructions ? `\n\nArchitect instructions:\n${opts.instructions}` : "");
            const taskId = await emitTask(session, `Implement step: ${m.action}`, desc, wi, opts.priority, procUid,
                { specId, specNodeName: proc.get("name"), specNodeLabel: "SpecProcess" });
            emitted.push({ taskId, step: m.action });
        }
    }
    return { kind: "activity", specId, summary: regions.summary, regions, unbound: processBound ? [] : [proc ? proc.get("name") : "process"], emitted };
}

async function reconcileSequence(session, specId, opts) {
    const pRes = await session.run(
        `MATCH (s:SpecSequence {name: $specId})-[:DERIVES]->(p:SpecParticipant)
         RETURN p.name AS alias, p.value AS uid, p.signature AS name, p.status AS conf, p.kind AS kind`, { specId });
    const bindings = {}, members = {}, allUids = [];
    for (const rec of pRes.records) {
        const alias = rec.get("alias"), uid = rec.get("uid"), conf = rec.get("conf");
        if (!uid || (conf !== "confirmed" && conf !== "exact")) continue;
        bindings[alias] = { uid, name: rec.get("name"), kind: rec.get("kind") };
        const mem = await resolveMembers(session, uid);
        members[alias] = mem;
        mem.forEach(m => allUids.push(m.uid));
    }
    let calls = [];
    if (allUids.length) {
        const cRes = await session.run(
            `MATCH (a)-[:CALLS]->(c) WHERE a.uid IN $uids AND c.uid IN $uids RETURN a.uid AS fromUid, c.uid AS toUid`,
            { uids: allUids });
        calls = cRes.records.map(r => ({ fromUid: r.get("fromUid"), toUid: r.get("toUid") }));
    }
    const msgRes = await session.run(
        `MATCH (s:SpecSequence {name: $specId})-[:DERIVES]->(m:SpecMessage)
         RETURN m.scope AS from, m.value AS to, m.name AS method, m.text AS label, m.ts AS ord, m.kind AS guard, m.signature AS dir ORDER BY m.ts`,
        { specId });
    const messages = msgRes.records.map(r => ({
        from: r.get("from"), to: r.get("to"), method: r.get("method"),
        label: r.get("label"), order: toNum(r.get("ord")), guard: r.get("guard"),
        dashed: r.get("dir") === "return" }));
    const regions = computeRegions({ messages, bindings, members, calls });

    const emitted = [];
    if (opts.emitTasks && regions.missing.length) {
        for (const miss of regions.missing) {
            const m = miss.message, caller = bindings[m.from];
            if (!caller) continue;
            const wi = `Sequence spec '${specId}' requires ${m.from} → ${m.to}.${m.method}()` +
                (m.guard ? ` (guard: ${m.guard})` : "") + `. Reason: ${miss.reason}. Implement the call so the code conforms to the diagram.` +
                (opts.instructions ? `\n\nArchitect instructions:\n${opts.instructions}` : "");
            const desc = `The sequence diagram '${specId}' documents the call ${m.from} → ${m.to}.${m.method}(), ` +
                `but the code graph has no matching CALLS edge (reason: ${miss.reason}). ` +
                `Implement the call so the code conforms to the documented design.`;
            const taskId = await emitTask(session, `Implement ${m.from}→${m.to}.${m.method}()`,
                desc, wi, opts.priority, caller.uid,
                // Der Sender, passend zur AFFECTS-Kante auf denselben Code-Knoten.
                { specId, specNodeName: m.from, specNodeLabel: "SpecParticipant" });
            emitted.push({ taskId, call: `${m.from}→${m.to}.${m.method}`, reason: miss.reason });
        }
    }
    return { kind: "sequence", specId, summary: regions.summary, regions, unbound: regions.unbound, emitted };
}

async function reconcileClass(session, specId, opts) {
    const kRes = await session.run(
        `MATCH (s:SpecClassDiagram {name: $specId})-[:DERIVES]->(k:SpecClass)
         RETURN k.name AS name, k.value AS uid, k.signature AS bn, k.status AS conf`, { specId });
    const mRes = await session.run(
        `MATCH (s:SpecClassDiagram {name: $specId})-[:DERIVES]->(m:SpecMethod) RETURN m.name AS method, m.scope AS owner`, { specId });
    const rRes = await session.run(
        `MATCH (s:SpecClassDiagram {name: $specId})-[:DERIVES]->(r:SpecRelation) RETURN r.name AS type, r.scope AS from, r.value AS to`, { specId });

    const methodsByClass = {};
    for (const r of mRes.records) (methodsByClass[r.get("owner")] = methodsByClass[r.get("owner")] || []).push({ name: r.get("method") });
    const classes = kRes.records.map(r => ({ name: r.get("name"), methods: methodsByClass[r.get("name")] || [] }));
    const relations = rRes.records.map(r => ({ type: r.get("type"), from: r.get("from"), to: r.get("to") }));

    const bindings = {}, codeMethods = {}, uidByClass = {}, allUids = [];
    for (const r of kRes.records) {
        const name = r.get("name"), uid = r.get("uid"), conf = r.get("conf");
        if (!uid || (conf !== "confirmed" && conf !== "exact")) continue;
        bindings[name] = { uid, name: r.get("bn") };
        uidByClass[name] = uid;
        codeMethods[name] = await resolveMembers(session, uid);
        allUids.push(uid);
    }
    let inherits = [];
    if (allUids.length) {
        const iRes = await session.run(
            `MATCH (a)-[:INHERITS]->(b) WHERE a.uid IN $uids AND b.uid IN $uids RETURN a.uid AS fromUid, b.uid AS toUid`,
            { uids: allUids });
        inherits = iRes.records.map(r => ({ fromUid: r.get("fromUid"), toUid: r.get("toUid") }));
    }
    const regions = computeClassRegions({ classes, bindings, codeMethods, relations, inherits });

    const emitted = [];
    if (opts.emitTasks && (regions.methodMissing.length || regions.inheritsMissing.length)) {
        // `cls` trägt den SpecClass-Namen mit: aus `text` liesse er sich nur
        // wieder herausparsen, und er ist der Schlüssel zur Kante ins Diagramm.
        const gaps = [
            ...regions.methodMissing.map(m => ({ text: `${m.class}.${m.method}()`, uid: uidByClass[m.class], what: "method", cls: m.class })),
            ...regions.inheritsMissing.map(i => ({ text: `${i.child} extends ${i.parent}`, uid: uidByClass[i.child], what: "inheritance", cls: i.child })),
        ];
        for (const g of gaps) {
            if (!g.uid) continue;
            const wi = `Class spec '${specId}' requires ${g.what} ${g.text}. Implement it so the code conforms to the diagram.` +
                (opts.instructions ? `\n\nArchitect instructions:\n${opts.instructions}` : "");
            const desc = `The class diagram '${specId}' requires ${g.what} '${g.text}', which is absent from ` +
                `the code graph. Implement it so the code conforms to the documented class design.`;
            const taskId = await emitTask(session, `Implement ${g.text}`, desc, wi, opts.priority, g.uid,
                { specId, specNodeName: g.cls, specNodeLabel: "SpecClass" });
            emitted.push({ taskId, gap: g.text });
        }
    }
    return { kind: "class", specId, summary: regions.summary, regions, unbound: regions.unbound, emitted };
}

/**
 * Das Epic zu einem Diagramm — angelegt, wenn es das erste Mal gebraucht wird.
 *
 * Ein Diagramm erzeugt selten einen Task, meistens fünf. Ohne Klammer liegen
 * die als lose Karten im Backlog und niemand sieht mehr, dass sie zusammen
 * „dieses Diagramm umsetzen" bedeuten. Die epicId leitet sich fest aus der
 * specId ab, damit ein zweiter Reconcile-Lauf dasselbe Epic weiterbenutzt
 * statt ein zweites danebenzustellen.
 */
async function ensureDiagramEpic(session, specId) {
    const epicId = `epic-spec-${specId}`;
    const existing = await session.run(
        `MATCH (e:Epic {taskId: $epicId}) RETURN e.taskId AS epicId`, { epicId });
    if (existing.records.length) return epicId;

    const head = await session.run(
        `MATCH (s) WHERE s.name = $specId AND s.label IN
           ['SpecSequence','SpecClassDiagram','SpecUseCaseDiagram','SpecActivityDiagram']
         RETURN s.title AS title, s.sourceFile AS sourceFile`, { specId });
    const title = (head.records[0] && head.records[0].get("title")) || specId;
    const sourceFile = (head.records[0] && head.records[0].get("sourceFile")) || specId;

    await session.run(
        `CREATE (e:Epic {taskId: $epicId, name: $epicId, title: $title,
            description: $descr, workInstructions: $wi,
            status: 'backlog', priority: 'medium', createdBy: 'spec-reconcile',
            createdAt: timestamp(), updatedAt: timestamp(), updatedBy: 'spec-reconcile', summary: null})`,
        {
            epicId,
            title: `Diagramm umsetzen: ${title}`,
            descr: `Sammelt die Tasks, die aus dem Abgleich des Diagramms '${specId}' (${sourceFile}) `
                + `mit dem Code entstanden sind. Jeder davon schliesst eine Luecke, die der Abgleich `
                + `gefunden hat — etwas, das im Diagramm steht und im Code fehlt.`,
            wi: `Die Tasks dieses Epics einzeln abarbeiten. Danach reconcile_spec fuer '${specId}' `
                + `erneut laufen lassen: was dann noch als fehlend gemeldet wird, ist offen geblieben.`,
        });
    return epicId;
}

/**
 * @param {object} [link] Woran der Task außer dem Code noch hängt:
 *   `specId` — das Diagramm (Task kommt in dessen Epic),
 *   `specNodeName` + `specNodeLabel` — der Spec-Knoten, aus dessen Lücke er entstand.
 *
 * Die Kante Spec -> Task ist der EINZIGE Weg zum Diagramm, solange es den Code
 * noch nicht gibt: ein Knoten, der erst gebaut werden soll, kann kein
 * REALIZED_BY tragen, also führt auch kein Weg über AFFECTS zu ihm zurück.
 * getSpecContext in tools/handlers/task-tools.ts liest genau diese Kante —
 * geschrieben hat sie bisher niemand.
 */
async function emitTask(session, title, desc, wi, priority, affectsUid, link = {}) {
    // randomUUID, not Date.now()+rand: several tasks are emitted inside the same
    // millisecond loop, where Date.now() collides and a 4-digit random has real
    // birthday-collision odds — and taskId is the key the AFFECTS MERGE joins on.
    const taskId = `task-${Date.now()}-${randomUUID().slice(0, 8)}`;
    await session.run(
        `CREATE (t:Task {taskId: $taskId, title: $title, description: $descr, workInstructions: $wi,
            status: 'backlog', priority: $priority, createdBy: 'spec-reconcile',
            createdAt: timestamp(), assignedTo: null, completedAt: null, summary: null})`,
        { taskId, title, descr: desc, wi, priority: priority || "medium" });
    if (affectsUid) {
        await session.run(`MATCH (t:Task {taskId: $taskId}), (n) WHERE n.uid = $uid MERGE (t)-[:AFFECTS]->(n)`,
            { taskId, uid: affectsUid });
    }
    if (link.specId && link.specNodeName) {
        await session.run(
            `MATCH (s)-[:DERIVES]->(p)
             WHERE s.name = $specId AND p.name = $nodeName AND p.label = $nodeLabel
             MATCH (t:Task {taskId: $taskId})
             MERGE (p)-[:APPLIES_TO]->(t)`,
            { specId: link.specId, nodeName: link.specNodeName,
              nodeLabel: link.specNodeLabel, taskId });
    }
    if (link.specId) {
        const epicId = await ensureDiagramEpic(session, link.specId);
        await session.run(
            `MATCH (e:Epic {taskId: $epicId}), (t:Task {taskId: $taskId})
             MERGE (e)-[:FULFILLED_BY]->(t)`,
            { epicId, taskId });
    }
    return taskId;
}

// Read a stored spec back as a {nodes, edges} subgraph for visualisation.
async function getSpecSubgraph(session, specId) {
    const res = await session.run(
        `MATCH (s) WHERE s.name = $specId AND s.label IN
           ['SpecSequence','SpecClassDiagram','SpecUseCaseDiagram','SpecActivityDiagram']
         OPTIONAL MATCH (s)-[:DERIVES]->(c)
         RETURN s.name AS sid, s.label AS slabel, s.title AS title,
                collect({uid: c.uid, label: c.label, name: c.name, scope: c.scope, value: c.value, status: c.status}) AS children`,
        { specId });
    if (!res.records.length) return { nodes: [], edges: [] };
    const rec = res.records[0];
    const nodes = [{ id: specId, name: rec.get("title") || specId, labels: [rec.get("slabel")] }];
    const edges = [];
    const children = rec.get("children") || [];

    // Class diagrams carry real STRUCTURE: methods/fields belong to a class and
    // relations connect two classes. importClass persists that as DECLARES and
    // INHERITS/SPEC_RELATES edges, so read them back rather than re-deriving.
    //
    // Diagrams imported before those edges existed have none, and re-importing
    // is not something a reader may do on the caller's behalf — so fall back to
    // synthesising by class NAME, which is exactly what this function used to do
    // for everyone. Legacy specs keep rendering; new ones show the real graph.
    if (rec.get("slabel") === "SpecClassDiagram") {
        // Missing rel tables are created by reconcileSchema at DAEMON START, so a
        // daemon that has been up since before these edge types existed does not
        // know them, and naming one is a hard binder error rather than an empty
        // result. Degrade to the legacy view instead of failing the whole tab —
        // the fallback below produces the same picture. Restarting the daemon is
        // the actual fix; this only keeps a stale one from breaking the UI.
        let stored = { records: [] };
        try {
            stored = await session.run(
                `MATCH (s:SpecClassDiagram {name: $specId})-[:DERIVES]->(a)
                 MATCH (a)-[e:DECLARES|INHERITS|SPEC_RELATES]->(b)
                 RETURN a.uid AS source, b.uid AS target, e.name AS relName, type(e) AS relType`,
                { specId });
        } catch (e) {
            if (!/does not exist|Binder exception/i.test(e.message)) throw e;
            console.warn(`[spec] falling back to derived edges — the database has no ` +
                `DECLARES/INHERITS/SPEC_RELATES tables yet. Restart the Ladybug daemon ` +
                `so the schema reconciles. (${e.message.split("\n")[0]})`);
        }
        if (stored.records.length) {
            for (const c of children) {
                if (!c || !c.uid || c.label === "SpecRelation") continue;
                nodes.push({ id: c.uid, name: c.name, labels: [c.label], status: c.status });
            }
            const memberUids = new Set();
            for (const r of stored.records) {
                const relType = r.get("relType");
                if (relType === "DECLARES") memberUids.add(r.get("target"));
                // Class→class edges render under their UML name ('inherits',
                // 'composition', …), which is what `name` carries and what the
                // legacy path below emitted — so both paths draw the same
                // picture, and only the stored edge type differs.
                edges.push({
                    source: r.get("source"),
                    target: r.get("target"),
                    relType: relType === "DECLARES" ? "DECLARES" : (r.get("relName") || "association"),
                });
            }
            // Classes hang off the diagram; members hang off their class and must
            // NOT also be wired to the diagram, or every member gets two parents.
            for (const c of children) {
                if (!c || !c.uid || c.label === "SpecRelation") continue;
                if (!memberUids.has(c.uid)) edges.push({ source: specId, target: c.uid, relType: "DERIVES" });
            }
            return { nodes, edges };
        }
        const uidByName = {};
        for (const c of children) if (c && c.uid && c.label === "SpecClass") uidByName[c.name] = c.uid;
        for (const c of children) {
            if (!c || !c.uid) continue;
            if (c.label === "SpecRelation") {
                // An edge between two classes — not a node. Draw it if both ends
                // resolve; otherwise skip (a relation to an undeclared class).
                const from = uidByName[c.scope], to = uidByName[c.value];
                if (from && to) edges.push({ source: from, target: to, relType: c.name || "association" });
                continue;
            }
            nodes.push({ id: c.uid, name: c.name, labels: [c.label], status: c.status });
            if (c.label === "SpecMethod" || c.label === "SpecField") {
                const owner = uidByName[c.scope];
                edges.push(owner
                    ? { source: owner, target: c.uid, relType: "DECLARES" }
                    : { source: specId, target: c.uid, relType: "DERIVES" });
            } else {
                edges.push({ source: specId, target: c.uid, relType: "DERIVES" });
            }
        }
        return { nodes, edges };
    }

    for (const c of children) {
        if (!c || !c.uid) continue;
        nodes.push({ id: c.uid, name: c.name, labels: [c.label], status: c.status });
        edges.push({ source: specId, target: c.uid, relType: "DERIVES" });
    }
    return { nodes, edges };
}

// Library: list every stored spec container (newest first) with a child count,
// so a UI can browse previously imported diagrams. collect()+JS length mirrors
// getSpecSubgraph's Ladybug-safe idiom (avoids count() aggregation grouping).
async function listSpecs(session) {
    const toNum = (v) => (v && typeof v.toNumber === 'function') ? v.toNumber() : v;
    const res = await session.run(
        `MATCH (s) WHERE s.label IN
           ['SpecSequence','SpecClassDiagram','SpecUseCaseDiagram','SpecActivityDiagram']
         OPTIONAL MATCH (s)-[:DERIVES]->(c)
         RETURN s.name AS specId, s.label AS label, s.title AS title,
                s.category AS kind, s.createdAt AS createdAt, s.sourceFile AS sourceFile,
                collect(c.uid) AS childUids`);
    return res.records
        .map((r) => ({
            specId: r.get('specId'),
            label: r.get('label'),
            title: r.get('title') || r.get('specId'),
            kind: r.get('kind'),
            sourceFile: r.get('sourceFile') || null,
            createdAt: toNum(r.get('createdAt')) || 0,
            children: (r.get('childUids') || []).filter(Boolean).length,
        }))
        .sort((a, b) => b.createdAt - a.createdAt);
}

// Returns the stored raw diagram text (+ meta) for one spec, so a UI can reopen
// and re-view it without re-running the importer/worker. null if not found.
async function getSpecSource(session, specId) {
    // Raw diagram text lives in the container's `text` column (a pre-existing
    // schema column — the single-table Ladybug model takes no new columns).
    // Legacy specs imported before this simply return null → empty source.
    const res = await session.run(
        `MATCH (s) WHERE s.name = $specId AND s.label IN
           ['SpecSequence','SpecClassDiagram','SpecUseCaseDiagram','SpecActivityDiagram']
         RETURN s.text AS source, s.label AS label, s.title AS title, s.category AS kind,
                s.sourceFile AS sourceFile`,
        { specId });
    if (!res.records.length) return null;
    const r = res.records[0];
    return { specId, source: r.get('source') || '', label: r.get('label'), title: r.get('title') || specId,
        kind: r.get('kind'), sourceFile: r.get('sourceFile') || null };
}

/**
 * Ein importiertes Diagramm samt seiner Kinder aus dem Graphen entfernen.
 *
 * BEWUSST NICHT als MCP-Tool exportiert. Ein Diagramm ist die Absicht des
 * Menschen, nicht abgeleiteter Zustand: es neu einzulesen darf jeder, es
 * wegzuwerfen nur der User über das Frontend. Deshalb hat der einzige Aufrufer
 * (DELETE /api/spec/:specId) eine Bestätigung, die den specId woertlich
 * wiederholen muss.
 *
 * Gelöscht wird derselbe Umfang, den ein Reimport ersetzen würde: der
 * Container und alles, was per DERIVES daran hängt. Code-Knoten bleiben — an
 * ihnen hängen nur die REALIZED_BY-Kanten, und die verschwinden mit ihrem
 * Spec-Ende von selbst (DETACH).
 */
async function deleteSpec(session, specId) {
    const found = await session.run(
        `MATCH (s) WHERE s.name = $specId AND s.label IN
           ['SpecSequence','SpecClassDiagram','SpecUseCaseDiagram','SpecActivityDiagram']
         OPTIONAL MATCH (s)-[:DERIVES]->(c)
         RETURN s.label AS label, count(c) AS children`,
        { specId });
    if (!found.records.length) return null;
    const label = found.records[0].get('label');
    const children = toNum(found.records[0].get('children'));

    await session.run(
        `MATCH (s) WHERE s.name = $specId AND s.label IN
           ['SpecSequence','SpecClassDiagram','SpecUseCaseDiagram','SpecActivityDiagram']
         OPTIONAL MATCH (s)-[:DERIVES]->(c)
         DETACH DELETE s, c`,
        { specId });
    return { specId, label, removed: children + 1 };
}

module.exports = { detectKind, importSpec, bindSpec, reconcileSpec, getSpecSubgraph, listSpecs, getSpecSource,
    listUnrealizedSpecs, listUnspecifiedCode, relinkRealizations,
    // NICHT in tools/handlers/spec-tools.ts aufnehmen — siehe deleteSpec.
    deleteSpec,
    // Exportiert für tests/spec-rebind.test.js: der Rebind ist genau die
    // Stelle, an der ein Fehler nichts kaputtmacht, sondern still nichts
    // mehr verbindet — der teuerste Fehlertyp, den es hier gibt.
    linkRealization, parseUidHint,
    // Exportiert für tests/spec-task-links.test.js.
    emitTask, ensureDiagramEpic };

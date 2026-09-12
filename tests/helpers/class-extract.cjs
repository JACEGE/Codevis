/**
 * Von echtem Quelltext zum Klassendiagramm — ohne Daemon, ohne Datenbank.
 *
 * Die vorhandenen Klassendiagramm-Tests greifen an zwei Enden an: eine
 * Fake-Session liefert fertige Zeilen an readClassModel (class-diagram.test.js,
 * class-attributes.test.js), oder eine Tree-sitter-Query wird einzeln
 * übersetzt (class-inheritance.test.js). Dazwischen liegt die Stelle, an der
 * beim Diagramm tatsaechlich etwas verlorengeht: Code, den der Extraktor anders
 * liest, als er dasteht. Wer nur die Enden prüft, sieht eine leere Zeilenmenge
 * und hält sie für eine leere Klasse.
 *
 * Deshalb hier der ganze Weg: Quelltext -> Tree-sitter -> die echten Extraktoren
 * aus graph_builder.js -> Knoten und Kanten, wie sie im Graphen ständen ->
 * readClassModel -> renderClassDiagram.
 *
 * Die Extraktoren geben ihr Ergebnis nicht zurück, sie SCHREIBEN es per
 * session.run(). Deshalb ist die Session hier kein Stummel, sondern ein
 * Mitschnitt: sie liest MERGE/SET/MATCH aus dem Cypher und baut daraus einen
 * kleinen In-Memory-Graphen. Was der Builder nicht schreibt, existiert hier
 * genauso wenig wie in der echten Datenbank — und genau das soll sichtbar
 * werden.
 *
 * Bewusst NICHT gemockt: die Grammatiken. Ein Test gegen einen nachgebauten
 * Parser bestätigt nur die eigene Annahme.
 */

"use strict";

const { __testing__ } = require("../../scripts/graph_builder.js");
const { readClassModel } = require("../../scripts/diagram/class_model.cjs");
const { renderClassDiagram } = require("../../scripts/diagram/class_render.cjs");
const { parseSource } = require("../../scripts/parser/parse-source.cjs");

const { LANG_CONFIGS, resolveGrammarWasm, safeQuery } = __testing__;

let Parser, Language, Query;
const langCache = new Map();

/** Die Integer-Huelle, die der Builder über graphMod.int() erwartet. */
const fakeGraphMod = { int: (n) => ({ __int: n, toNumber: () => Number(n), valueOf: () => Number(n) }) };

const plain = (v) => (v && typeof v === "object" && "__int" in v ? Number(v.__int) : v);

async function loadLanguage(ext) {
    if (!Parser) {
        ({ Parser, Language, Query } = require("web-tree-sitter"));
        await Parser.init();
    }
    if (langCache.has(ext)) return langCache.get(ext);
    const config = LANG_CONFIGS[ext];
    if (!config) throw new Error(`no LANG_CONFIG for '${ext}' — language not supported by the builder`);
    const lang = await Language.load(resolveGrammarWasm(config.wasm));
    const entry = { config, lang };
    langCache.set(ext, entry);
    return entry;
}

/**
 * Session-Mitschnitt.
 *
 * Interessant sind nur die Knotenarten, die im Klassendiagramm vorkommen:
 * Class, Function/Method, Variable mit scope='field' und die INHERITS-Kante.
 * Alles andere wird gezählt und verworfen — ein Test soll an einer fehlenden
 * Klasse scheitern, nicht an einem nicht nachgebauten Import.
 */
function recordingSession() {
    const classes = [];      // { name, file, startLine, endLine, labels }
    const functions = [];    // { name, file, className, signature, params, startLine }
    const fields = [];       // { name, className, file, declaredType, scope }
    const inherits = [];     // { child, childFile, parent }
    const decorators = [];   // { target, refs }
    const other = [];        // jede nicht nachgebaute Anweisung, fuer die Diagnose

    const rows = (list) => ({ records: list.map((row) => ({ get: (k) => (k in row ? row[k] : null) })) });

    return {
        graph: { classes, functions, fields, inherits, decorators, other },
        async run(cypher, params = {}) {
            const p = Object.fromEntries(Object.entries(params).map(([k, v]) => [k, plain(v)]));
            const flat = cypher.replace(/\s+/g, " ").trim();
            const has = (s) => flat.includes(s);

            // ── Lesende Abfragen zuerst ──────────────────────────────────────
            // Der Katalog entscheidet, ob eine Basisklasse als echte Klasse oder
            // als ExternalBase endet. Gäbe die Session hier nichts zurück,
            // wäre JEDE Vererbung extern — ein Fehler, den der Harness selbst
            // erzeugt, und in dem eine echte Fehlersuche verhungert.
            if (has("MATCH (c:Class) RETURN c.uid AS uid")) {
                return rows(classes.map((c) => ({ uid: c.uid, name: c.name, file: c.file })));
            }
            // Der Dekorator-Extraktor sucht sich seine Ziele über diesen
            // Katalog; ohne Antwort hängt er seine Referenzen an nichts.
            if (has("(f:Function") && has("RETURN f.name AS name") && has("f.uid")) {
                return rows(functions.map((f) => ({ uid: f.uid, name: f.name, file: f.file })));
            }
            if (has("[:IMPORTS]->") || has("[:IMPORTS_SYMBOL]->") || has("[:EXPORTS")) {
                return rows([]); // eine Datei allein importiert nichts
            }

            // ── Schreibende Anweisungen ──────────────────────────────────────
            if (/MERGE \(cls:Class/.test(flat)) {
                classes.push({
                    uid: p.uid, name: p.className, file: p.path,
                    kind: p.kind ?? null,
                    startLine: p.startLine ?? null, endLine: p.endLine ?? null,
                    labels: /MERGE \(cls:(Class[A-Za-z:]*)/.exec(flat)?.[1] || "Class",
                });
            } else if (/MERGE \(func:Function/.test(flat)) {
                functions.push({
                    name: p.funcName, file: p.path,
                    className: p.className ?? null,
                    // Seit der Besitzer zum Schlüssel des Knotens gehört, ist er
                    // das Feld, an dem sich die Zuordnung ablesen lässt. Bei
                    // einer ausgelagerten C++-Definition steht hier die Klasse
                    // aus dem Qualifizierer, während className leer bleibt --
                    // die Klasse liegt ja in einer anderen Datei.
                    owner: p.owner ?? null,
                    signature: p.signature ?? null,
                    params: p.params ?? null,
                    returnType: p.returnType ?? null,
                    startLine: p.startLine ?? null,
                    isAsync: p.isAsync ?? null,
                });
            } else if (has("MERGE (cls)-[:DECLARES]->(v)")) {
                const field = fields.find((f) => f.elementId === p.elementId && f.file === p.path);
                if (field) field.className = p.className;
            } else if (has("scope: 'field'") || p.scope === "field") {
                fields.push({
                    name: p.varName ?? p.name, className: p.className ?? null,
                    file: p.path, elementId: p.elementId,
                    declaredType: p.declaredType ?? null, scope: "field",
                });
            } else if (has("SET n.decorators = $refs")) {
                decorators.push({ target: p.target, refs: p.refs || [] });
            } else if (has("[:INHERITS]->")) {
                // Die aufgelöste Variante nennt die Basis nur über ihre uid;
                // der Name steht dann in der bereits mitgeschriebenen Klasse.
                const resolved = p.baseUid ? classes.find((c) => c.uid === p.baseUid) : null;
                inherits.push({
                    child: p.className ?? p.child, childFile: p.path,
                    parent: p.baseName ?? resolved?.name ?? p.parent ?? p.base,
                    parentUid: p.baseUid ?? null,
                    // Der Unterschied, auf den es im Diagramm ankommt: eine
                    // aufgelöste Basis bekommt ein Kästchen mit Inhalt, eine
                    // externe ein leeres mit <<external>>.
                    external: has("ExternalBase"),
                });
            } else {
                other.push({ cypher: flat.slice(0, 120), params: p });
            }
            return { records: [] };
        },
    };
}

/**
 * Was der Builder aus einer Datei in den Graphen schreibt.
 *
 * @param {string} source Quelltext
 * @param {string} file   Pfad, unter dem er im Graphen stuende (Endung wählt die Grammatik)
 */
async function extractFromSource(source, file) {
    const ext = "." + file.split(".").pop();
    const { config, lang } = await loadLanguage(ext);
    const parser = new Parser();
    parser.setLanguage(lang);
    const tree = parseSource(parser, source, file);

    // Jede *Query der Sprachkonfiguration übersetzen, nicht eine Auswahl: der
    // Builder liest sie alle aus demselben Objekt, und eine vergessene bedeutet
    // hier nicht "nicht getestet", sondern "stillschweigend leer".
    const cached = { lang, rosLang: config.rosLang || null };
    for (const key of Object.keys(config)) {
        if (key.endsWith("Query")) cached[key] = config[key] ? safeQuery(lang, config[key]) : null;
    }

    // Der Klassenkatalog des Builders ist ein prozessweiter Memo-Cache. Ohne
    // dieses Zurücksetzen sieht der zweite Testfall die Klassen des ersten und
    // löst Basisklassen auf, die in seinem Quelltext gar nicht vorkommen --
    // aus `class A extends Node` wird eine Kante auf ein `Node` aus einem
    // fremden Fall. Der Fehler fällt nur bei geänderter Testreihenfolge auf,
    // also fällt er ohne das hier irgendwann und unerklärlich auf.
    __testing__.invalidateClassResolution();

    const session = recordingSession();
    const classBounds = await __testing__.extractClasses(session, cached, tree, file, fakeGraphMod);
    const funcBounds = await __testing__.extractFunctions(session, cached, tree, file, fakeGraphMod, classBounds);
    await __testing__.extractAllVariables(session, cached, tree, file, funcBounds, classBounds);
    if (cached.classInheritanceQuery) {
        await __testing__.extractClassInheritance(session, cached, tree, file);
    }
    if (cached.decoratorQuery && __testing__.extractDecorators) {
        await __testing__.extractDecorators(session, cached, tree, file);
    }

    return {
        file, source, tree, config,
        classBounds, funcBounds,
        parseError: tree.rootNode.hasError,
        ...session.graph,
    };
}

/**
 * Eine Session, die dem Klassenmodell genau den mitgeschnittenen Graphen
 * vorlegt. Die Zuordnung Query-Fragment -> Zeilen spiegelt class_model.cjs;
 * ändert sich dort eine Abfrage, muss sie hier mitgehen.
 */
function sessionFrom(extracted) {
    const { classes, functions, fields, inherits, file } = extracted;

    const methods = functions.filter((fn) => fn.className);

    const rowsFor = (raw) => {
        const q = raw.replace(/\s+/g, " ").trim();

        if (q.includes("(c:Class)-[:DECLARES]->(v:Variable)")) {
            return fields.map((f) => ({
                cls: f.className, clsFile: file, attr: f.name,
                declaredType: f.declaredType, startLine: null,
            }));
        }
        // Zwei Abfragen teilen sich dasselbe Muster (c:Class)-[:CONTAINS]->
        // (f:Function): die Methodenliste und die Besitzertabelle für
        // INSTANTIATES. Auseinandergehalten werden sie an der Spalte, die nur
        // eine der beiden zurückgibt.
        if (q.includes("(c:Class)-[:CONTAINS]->(f:Function)")) {
            if (q.includes("f.file AS fnFile")) {
                return methods.map((fn) => ({ cls: fn.className, clsFile: file, fn: fn.name, fnFile: file }));
            }
            return methods.map((fn) => ({
                cls: fn.className, clsFile: file, fn: fn.name,
                signature: fn.signature, startLine: fn.startLine,
                // Dekoratoren hängen am Namen, so wie der Extraktor sie
                // schreibt: Getter und Setter einer @property teilen ihn sich.
                decorators: (extracted.decorators || [])
                    .filter((d) => d.target === fn.name)
                    .flatMap((d) => d.refs),
                returnType: fn.returnType ?? null,
            }));
        }
        if (q.includes("(a:Class)-[:INHERITS]->(b:Class)")) {
            return inherits.filter((r) => !r.external).map((r) => ({
                aName: r.child, aFile: r.childFile ?? file, bName: r.parent, bFile: file,
            }));
        }
        if (q.includes("(a:Class)-[:INHERITS]->(b:ExternalBase)")) {
            return inherits.filter((r) => r.external).map((r) => ({
                aName: r.child, aFile: r.childFile ?? file, bName: r.parent,
            }));
        }
        if (q.includes("MATCH (c:Class)") && q.includes("RETURN c.name AS name")) {
            return classes.map((c) => ({ name: c.name, file: c.file, startLine: c.startLine, kind: c.kind }));
        }
        // INSTANTIATES und CALLS schreibt dieser Harness (noch) nicht mit —
        // leere Zeilen sind hier die ehrliche Antwort, keine stille Null.
        return [];
    };

    return {
        async run(cypher) {
            const rows = rowsFor(cypher);
            return { records: rows.map((row) => ({ get: (k) => (k in row ? row[k] : null) })) };
        },
    };
}

/** Quelltext -> gerendertes Diagramm, in einem Schritt. */
async function diagramFromSource(source, file, opts = {}) {
    const extracted = await extractFromSource(source, file);
    const model = await readClassModel(sessionFrom(extracted), opts);
    return {
        extracted,
        model,
        mermaid: renderClassDiagram(model, { ...opts, format: "mermaid" }),
        plantuml: renderClassDiagram(model, { ...opts, format: "plantuml" }),
    };
}

module.exports = { extractFromSource, sessionFrom, diagramFromSource, loadLanguage, recordingSession };

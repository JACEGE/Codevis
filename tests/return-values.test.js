#!/usr/bin/env node
/**
 * Rückgabe-Ausdrücke, durch die echten tree-sitter-Grammatiken.
 *
 * Warum dieser Test existiert: bis zum 16.08.2026 legte `extractReturns` seine
 * Knoten unter dem Label `Variable` an. Das brach nichts und fiel deshalb
 * nicht auf — es vergiftete nur still jede Abfrage auf Variablen. Gemessen an
 * den gebauten Graphen kamen 9,4 % aller `Variable`-Knoten in CodeVis und
 * 8,6 % im Zielprojekt von hier, ohne Zeilennummer und mit einem auf 60
 * Zeichen abgeschnittenen Ausdruck als Namen.
 *
 * Geprüft wird gegen eine aufzeichnende Stub-Session: der Test bleibt
 * hermetisch, und das erzeugte Cypher lässt sich direkt lesen.
 */

const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");

const { Parser, Language } = require("web-tree-sitter");
const {
    LANG_CONFIGS, safeQuery, resolveGrammarWasm,
    extractFunctions, extractReturns, invalidateClassResolution,
} = require("../scripts/graph_builder.js").__testing__;

/** Zeichnet jedes Cypher-Statement auf, statt eine Datenbank anzufassen. */
function stubSession() {
    const calls = [];
    return {
        calls,
        async run(cypher, params = {}) {
            calls.push({ cypher: cypher.replace(/\s+/g, " ").trim(), params });
            return { records: [] };
        },
        /** Die angelegten Rückgabe-Knoten. */
        returnValues() {
            return calls
                // Production queries commonly start with MATCH and create the
                // ReturnValue later in the same statement. Match the semantic
                // operation rather than one particular whitespace/layout form.
                .filter((c) => c.cypher.includes("MERGE (rv:ReturnValue"))
                .map((c) => ({
                    name: c.params.cleanName,
                    startLine: c.params.startLine,
                    elementId: c.params.elementId,
                    uid: c.params.uid,
                    file: c.params.path,
                }));
        },
        /** Jedes Statement, das irgendeinen :Variable-Knoten anlegt. */
        variableWrites() {
            return calls.filter((c) => /MERGE \(\w+:Variable\b/.test(c.cypher));
        },
        returnEdges() {
            return calls.filter((c) => c.cypher.includes("[:RETURNS]->"));
        },
    };
}

async function runReturns(source, ext, fileName) {
    invalidateClassResolution();
    await Parser.init();
    const cfg = LANG_CONFIGS[ext];
    const lang = await Language.load(resolveGrammarWasm(cfg.wasm));
    const parser = new Parser();
    parser.setLanguage(lang);
    const tree = parser.parse(source);

    const cached = {
        lang,
        funcQuery: safeQuery(lang, cfg.funcQuery),
        returnQuery: safeQuery(lang, cfg.returnQuery),
    };
    // safeQuery schluckt eine kaputte Abfrage und gibt null zurück — dann
    // extrahiert der Builder wortlos nichts. Das hier ist die einzige Stelle,
    // an der das auffällt.
    assert.ok(cached.returnQuery, `${ext}: returnQuery ist nicht kompiliert`);

    const session = stubSession();
    const graphMod = { int: (n) => n };
    const funcBounds = await extractFunctions(session, cached, tree, fileName, graphMod, []);
    await extractReturns(session, cached, tree, fileName, funcBounds);
    return session;
}

const JS_SOURCE = `
function alpha(rows) {
    return rows.filter(Boolean).map(String);
}

function beta(value, fallback) {
    return value >= 0 ? value : fallback;
}

function gamma() {
    return null;
}

function delta() {
    return null;
}

function epsilon(rows) {
    return rows.map((r) => r.id);
}
`;

const PY_SOURCE = `
import statistics

def summarise(values):
    return {"n": len(values), "mean": statistics.fmean(values), "spread": max(values) - min(values)}

def safe_mean(vals):
    return statistics.fmean(vals) if vals else None
`;

describe("Rückgabewerte bekommen ein eigenes Label", () => {
    let js;
    before(async () => { js = await runReturns(JS_SOURCE, ".js", "src/report.js"); });

    it("legt ReturnValue-Knoten an und keine Variablen", () => {
        assert.ok(js.returnValues().length >= 4, "keine ReturnValue-Knoten entstanden");
        // Der eigentliche Regressionsschutz: extractReturns darf das
        // Variablen-Label nicht mehr anfassen.
        assert.deepEqual(js.variableWrites(), []);
    });

    it("schreibt die Zeilennummer mit, die vorher weggeworfen wurde", () => {
        // startLine geht als ladybug.int durch, genau wie in extractVariables —
        // im Test kommt deshalb der Integer-Wrapper an, nicht die nackte Zahl.
        const zahl = (v) => v?.toNumber?.() ?? Number(v);
        for (const rv of js.returnValues()) {
            assert.ok(Number.isInteger(zahl(rv.startLine)) && zahl(rv.startLine) > 0,
                `startLine fehlt bei ${JSON.stringify(rv.name)}`);
        }
        // Die beiden `return null` stehen auf verschiedenen Zeilen.
        const nullZeilen = js.returnValues().filter((rv) => rv.name === "null").map((rv) => zahl(rv.startLine));
        assert.notEqual(nullZeilen[0], nullZeilen[1]);
    });

    it("gibt jedem Knoten eine uid und eine ortsbasierte elementId", () => {
        for (const rv of js.returnValues()) {
            assert.ok(rv.uid, `uid fehlt bei ${JSON.stringify(rv.name)}`);
            assert.match(rv.elementId, /^return:\d+:\d+$/);
        }
    });

    it("hält zwei gleichlautende Rückgaben auseinander", () => {
        // `return null` steht zweimal im Quelltext. Über den Text gemerged wäre
        // das EIN Knoten für ZWEI Funktionen — genau der alte Fehler.
        const nulls = js.returnValues().filter((rv) => rv.name === "null");
        assert.equal(nulls.length, 2);
        assert.notEqual(nulls[0].elementId, nulls[1].elementId);
    });

    it("hängt jeden Knoten über RETURNS an seinen Erzeuger", () => {
        assert.equal(js.returnEdges().length, js.returnValues().length);
        for (const e of js.returnEdges()) {
            assert.match(e.cypher, /MERGE \((?:func|f)\)-\[:RETURNS\]->\(rv\)/);
        }
    });

    it("erfasst zusammengesetzte Ausdrücke statt sie zu verwerfen", () => {
        const namen = js.returnValues().map((rv) => rv.name);
        assert.ok(namen.some((n) => n.includes("filter")),
            `Kettenausdruck fehlt in ${JSON.stringify(namen)}`);
        assert.ok(namen.some((n) => n.includes("?")),
            `Bedingter Ausdruck fehlt in ${JSON.stringify(namen)}`);
    });

    it("überspringt Rückgaben mit Pfeilfunktion — bestehende Regel, hier festgehalten", () => {
        // isValidReturnExpr verwirft alles mit `=>`. `return rows.map((r) => r.id)`
        // taucht deshalb nirgends im Graphen auf. Das ist nicht Teil dieses
        // Fixes, aber es ist eine stille Lücke: die Funktion sieht dadurch aus,
        // als gäbe sie nichts zurück.
        const namen = js.returnValues().map((rv) => rv.name);
        assert.equal(namen.some((n) => n.includes("=>")), false);
        assert.equal(namen.some((n) => n.includes("r.id")), false);
    });
});

describe("Rückgabewerte in Python", () => {
    let py;
    before(async () => { py = await runReturns(PY_SOURCE, ".py", "scripts/aggregate.py"); });

    it("legt auch hier ReturnValue an und keine Variablen", () => {
        assert.ok(py.returnValues().length >= 2);
        assert.deepEqual(py.variableWrites(), []);
    });

    it("erfasst das Dict-Literal und den bedingten Ausdruck", () => {
        const namen = py.returnValues().map((rv) => rv.name);
        // Beides stand im echten Zielprojekt als :Variable im Graphen.
        assert.ok(namen.some((n) => n.startsWith("{")), JSON.stringify(namen));
        assert.ok(namen.some((n) => n.includes("if vals else None")), JSON.stringify(namen));
    });

    it("kürzt lange Ausdrücke auf 60 Zeichen", () => {
        for (const rv of py.returnValues()) {
            assert.ok(rv.name.length <= 60, `${rv.name.length} Zeichen: ${rv.name}`);
        }
    });
});

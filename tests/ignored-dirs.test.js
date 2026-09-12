/**
 * Was ein Build NICHT indizieren darf.
 *
 * Der Anlass war ein echter Lauf gegen ein Python-Projekt: von den ersten 329
 * erfassten Dateien kamen 329 aus `.venv/Lib/site-packages` und keine einzige
 * aus dem Projekt selbst. Gemessen standen 4.297 Bibliotheksdateien gegen 56
 * eigene — Faktor 77. Weil `.venv` alphabetisch vorn liegt, sah man zuerst
 * ausschliesslich fremden Code und hätte den Build für richtig gehalten.
 *
 * Die Ursache war eine Annahme, die nur für ein Ökosystem gilt: JavaScript legt
 * seine Abhängigkeiten in `node_modules` NEBEN den Code, Python legt sie als
 * virtuelle Umgebung MITTEN hinein. Die Ignorierliste kannte den ersten Fall
 * und nicht den zweiten.
 *
 * Der Test prüft deshalb nicht die Liste gegen sich selbst, sondern gegen die
 * Verzeichnisnamen, die die verbreiteten Ökosysteme tatsächlich anlegen. Eine
 * neue Sprache in LANG_CONFIGS ohne den zugehörigen Artefaktordner faellt hier
 * auf, bevor sie jemandes Graphen flutet.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");

const { __testing__ } = require("../scripts/graph_builder.js");
const { findFiles } = __testing__;

describe("ignorierte Verzeichnisse", () => {
    it("überspringt Abhängigkeiten aller Ökosysteme, nicht nur node_modules", () => {
        const root = mkdtempSync(join(tmpdir(), "codevis-ignored-"));
        try {
            // Eine Datei im Projekt, je eine in jedem Abhängigkeitsordner.
            mkdirSync(join(root, "src"), { recursive: true });
            writeFileSync(join(root, "src", "app.py"), "def main():\n    pass\n");

            const artefaktOrdner = [
                ["node_modules", "lib.js"],
                [".venv", "dep.py"],
                ["venv", "dep.py"],
                ["site-packages", "dep.py"],
                [".tox", "dep.py"],
                ["__pycache__", "dep.py"],
                [".pytest_cache", "dep.py"],
                [".mypy_cache", "dep.py"],
            ];
            for (const [dir, file] of artefaktOrdner) {
                mkdirSync(join(root, dir), { recursive: true });
                writeFileSync(join(root, dir, file), "def x():\n    pass\n");
            }

            const found = (findFiles(root, [".py", ".js"], [], { includeTests: false }) || [])
                .map((p) => String(p).split("\\").join("/"));

            const fremd = found.filter((p) => artefaktOrdner.some(([dir]) => p.includes(`/${dir}/`)));
            assert.deepStrictEqual(
                fremd, [],
                `diese Abhängigkeitsordner wurden mitindiziert: ${fremd.join(", ")}`
            );
            assert.ok(
                found.some((p) => p.endsWith("src/app.py")),
                "die eigene Datei des Projekts muss gefunden werden"
            );
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    // Die Liste vergleicht einen einzelnen Verzeichnisnamen. Ein Eintrag mit
    // Schrägstrich kann deshalb nie treffen und wäre ein toter Eintrag, der
    // Sicherheit vortäuscht — genau das ist mir beim Ergänzen passiert.
    it("enthält keine Einträge, die nie treffen können", () => {
        const mitSchraegstrich = [...__testing__.IGNORED_DIRS ?? []].filter((d) => String(d).includes("/"));
        assert.deepStrictEqual(
            mitSchraegstrich, [],
            `diese Einträge können nie greifen, weil nur einzelne Verzeichnisnamen verglichen werden: ${mitSchraegstrich.join(", ")}`
        );
    });
});

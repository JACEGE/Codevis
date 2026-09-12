/**
 * Was als Testdatei gilt — an einer Stelle.
 *
 * Die Frage wurde dreimal unterschiedlich beantwortet: der Builder entscheidet
 * am DATEINAMEN, ob eine Datei überhaupt in den Graphen kommt, während die
 * Impact-Analyse am PFAD entscheidet, ob ein bereits vorhandener Knoten als
 * Test zählt. Die beiden Impact-Fassungen kannten dabei nur die
 * Verzeichniskonventionen und `foo.test.js`; die drei Regeln des Builders --
 * `test_mcp.ts`, `foo_test.py`, `*.d.ts` -- fehlten ihnen.
 *
 * Ergebnis: Was der Builder als Test AUSSCHLIESST, war nicht das, was Impact
 * als Test ZÄHLT. Eine `test_helper.py` landete gar nicht erst im Graphen,
 * eine `helper_test.py` schon -- und galt dort dann als Produktivcode.
 *
 * Die beiden Ebenen bleiben getrennt, weil sie verschiedene Fragen sind: der
 * Builder sieht nur den Dateinamen, Impact hat den ganzen Pfad. Sie teilen sich
 * aber die Namensregeln, damit sie nicht wieder auseinanderlaufen.
 */

"use strict";

/**
 * Namenskonventionen für Testdateien, ohne Verzeichnis.
 *
 * Das ist die Fassung, die der Builder seit je verwendet; sie bleibt
 * unverändert, weil sie darüber entscheidet, welche Dateien im Graphen
 * landen. Eine Erweiterung hier wäre kein Aufräumen, sondern eine stille
 * Änderung am Inhalt jedes Graphen.
 */
function isTestBasename(basename) {
    const name = String(basename || "");
    return /\.(test|spec)\.[mc]?[jt]sx?$/.test(name)   // foo.test.ts, foo.spec.jsx
        || /^test[_-]/.test(name)                       // test_mcp.ts, test-utils.js
        || /_test\.(py|go|rb)$/.test(name)              // python/go/ruby convention
        || /\.d\.ts$/.test(name);                       // type decls, no real code
}

/**
 * Dieselben Namensregeln plus die Verzeichniskonventionen.
 *
 * `tests/`, `test/` und `__tests__/` an beliebiger Stelle im Pfad zählen, und
 * `.spec.` wird hier großzügiger gelesen als beim Builder (jede Endung, nicht
 * nur JS/TS) -- eine Datei, die schon im Graphen steht, soll eher als Test
 * erkannt werden als übersehen.
 */
function isTestPath(filePath) {
    const p = String(filePath || "").replace(/\\/g, "/");
    if (!p) return false;
    if (/(^|\/)(tests?|__tests__)(\/|$)/i.test(p)) return true;
    if (/\.(test|spec)\.[^/]+$/i.test(p)) return true;
    return isTestBasename(p.split("/").pop());
}

module.exports = { isTestBasename, isTestPath };

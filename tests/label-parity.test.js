/**
 * Zwei Listen, die laut ihrer eigenen Kommentare übereinstimmen müssen.
 *
 * `SPEC_LABELS` steht in frontend/src/nodePalette.js und in server/bridge.js,
 * `DEFAULT_OFF` dort als `hiddenTypes`. Beide Seiten tragen einen
 * ausgeschriebenen Vertrag ("Muss mit … übereinstimmen") und hatten keinen
 * Test — die Reihenfolge war bereits auseinandergelaufen.
 *
 * Die Reihenfolge selbst ist harmlos: beide Listen werden ausschließlich als
 * Menge benutzt (Set-Zugehörigkeit, Summierung). Gefaehrlich wäre ein
 * fehlendes oder zusätzliches Label, und genau das prüft dieser Test. Ein
 * Spec-Label, das die Bridge kennt und die Palette nicht, fällt aus dem einen
 * Filterschalter heraus: der Knoten bleibt sichtbar, obwohl die Ebene
 * abgeschaltet ist, und ist einzeln nicht schaltbar.
 *
 * Gelesen wird aus dem Quelltext, nicht per import: bridge.js startet beim
 * Laden einen Server, und die Palette ist ein ES-Modul im Frontend-Baum.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");

const ROOT = resolve(__dirname, "..");

/** Die String-Literale einer Array-Zuweisung, ohne das Modul zu laden. */
function literalArray(file, anchor) {
    const src = readFileSync(resolve(ROOT, file), "utf8");
    const at = src.indexOf(anchor);
    assert.ok(at >= 0, `Anker '${anchor}' nicht in ${file} gefunden — umbenannt?`);
    const open = src.indexOf("[", at);
    const close = src.indexOf("]", open);
    return [...src.slice(open + 1, close).matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);
}

describe("Label-Listen zwischen Bridge und Frontend", () => {
    it("SPEC_LABELS enthaelt beidseitig dieselben Labels", () => {
        const bridge = literalArray("server/bridge.js", "const SPEC_LABELS");
        const palette = literalArray("frontend/src/nodePalette.js", "export const SPEC_LABELS");

        assert.ok(bridge.length > 0, "in der Bridge wurden keine Labels gefunden");
        const onlyBridge = bridge.filter((l) => !palette.includes(l));
        const onlyPalette = palette.filter((l) => !bridge.includes(l));

        assert.deepStrictEqual(onlyBridge, [], `nur die Bridge kennt: ${onlyBridge.join(", ")}`);
        assert.deepStrictEqual(onlyPalette, [], `nur die Palette kennt: ${onlyPalette.join(", ")}`);
    });

    it("die per Voreinstellung ausgeblendeten Typen stimmen ueberein", () => {
        const bridge = literalArray("server/bridge.js", "hiddenTypes:");
        const palette = literalArray("frontend/src/nodePalette.js", "export const DEFAULT_OFF");

        assert.deepStrictEqual(
            [...bridge].sort(), [...palette].sort(),
            "Bridge und Frontend blenden unterschiedliche Typen aus — der Graph zeigt beim ersten Laden etwas anderes als das Filterpanel behauptet"
        );
    });
});

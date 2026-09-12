/**
 * puml_blocks.js — Was in einem PlantUML-Diagramm KEIN Diagramminhalt ist.
 *
 * PlantUML kennt mehrzeilige Bloecke, die nur Darstellung oder Prosa tragen:
 *
 *     note over A, B          skinparam usecase {          legend right
 *       Freitext, gern mit      BackgroundColor #C8E6C9      Freitext
 *       A -> B im Satz          BorderColor     #2E7D32    end legend
 *     end note                }
 *
 * Alle vier Parser hier sind zeilenbasiert und hatten keinen Zustand: sie
 * überspringen die KOPFZEILE eines solchen Blocks und lassen den Rumpf
 * durchlaufen. Der landet dann in den Regeln für echten Inhalt, und weil die
 * absichtlich tolerant sind, matcht er auch:
 *
 *   `BackgroundColor<<done>> #C8E6C9`  →  `<<` gilt als Pfeil  →  zwei
 *   Use Cases namens "BackgroundColor" und "done>> #C8E6C9" plus eine
 *   include-Beziehung zwischen ihnen. Genau so trat es in einem realen Graphen auf.
 *
 *   `Signed: negative == penetration`  →  passt auf die Inline-Member-Regel
 *   des Klassenparsers  →  eine Klasse "Signed" mit der Methode dahinter.
 *
 * Es kracht nie, es entstehen nur Knoten, die niemand geschrieben hat — und die
 * wandern weiter in Bindungsvorschlaege, Reconcile und Epics. Deshalb hier, an
 * einer Stelle, für alle Parser.
 *
 * Einzeilige Formen bleiben ausdruecklich draussen aus der Blocklogik:
 *   `note left of A : Text`   — hat einen Doppelpunkt
 *   `note "Text" as N1`       — hat einen Anführungsstrich-Text
 * Beide sind mit ihrer Zeile fertig. Wer sie als Blockanfang liest, frisst den
 * Rest des Diagramms bis zu einem `end note`, das nie kommt.
 */

"use strict";

const NOTE_OPEN = /^(note|hnote|rnote)\b/i;
const NOTE_END = /^end\s*note\b/i;
const LEGEND_OPEN = /^legend\b/i;
const LEGEND_END = /^end\s*legend\b/i;
const SKINPARAM_OPEN = /^skinparam\b/i;

/**
 * Baut einen Zustandsbehafteten Filter.
 *
 * @returns {(line: string) => boolean} true, wenn die Zeile zu einem
 *   Nicht-Inhalts-Block gehört (Kopf, Rumpf oder Ende) und der Parser sie
 *   überspringen soll.
 */
function createBlockSkipper() {
    let mode = null;     // 'note' | 'legend' | 'braces'
    let depth = 0;       // nur fuer 'braces': skinparam-Bloecke duerfen schachteln

    return function skipLine(rawLine) {
        const line = String(rawLine).trim();
        if (!line) return false;

        if (mode === "note") {
            if (NOTE_END.test(line)) mode = null;
            return true;
        }
        if (mode === "legend") {
            if (LEGEND_END.test(line)) mode = null;
            return true;
        }
        if (mode === "braces") {
            depth += (line.match(/\{/g) || []).length;
            depth -= (line.match(/\}/g) || []).length;
            if (depth <= 0) { mode = null; depth = 0; }
            return true;
        }

        if (NOTE_OPEN.test(line)) {
            // Einzeiler erkennt man am Doppelpunkt oder am Text in
            // Anführungszeichen — beides gibt es im Blockkopf nicht.
            if (!line.includes(":") && !/"/.test(line)) mode = "note";
            return true;
        }
        if (LEGEND_OPEN.test(line)) {
            if (!line.includes(":")) mode = "legend";
            return true;
        }
        if (SKINPARAM_OPEN.test(line)) {
            const open = (line.match(/\{/g) || []).length;
            const close = (line.match(/\}/g) || []).length;
            if (open > close) { mode = "braces"; depth = open - close; }
            return true;
        }
        return false;
    };
}

module.exports = { createBlockSkipper };

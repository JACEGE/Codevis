/**
 * puml_class_parser.js — Pure parser for PlantUML CLASS diagrams.
 *
 * Turns class-diagram text into a normalized object describing classes (with
 * their methods/fields) and the relations between them. NO Neo4j, NO I/O.
 *
 * Output shape:
 *   {
 *     title: string | null,
 *     classes: [ {
 *       name, kind,
 *       methods: [ { name, visibility, params, paramList, returns, signature } ],
 *       fields:  [ { name, visibility, type, signature } ],
 *     } ],
 *     relations: [ {
 *       from, to, type,              // inherits|association|composition|aggregation|dependency
 *       label,                       // Text hinter dem Doppelpunkt, oder null
 *       fromMultiplicity, toMultiplicity,
 *       raw,                         // die Zeile, wie sie im Diagramm steht
 *     } ]
 *   }
 *
 * `inherits` covers both `<|--` (extends) and `<|..` (implements): the code
 * graph's INHERITS edge does not distinguish the two, so the overlay treats
 * them alike.
 */

"use strict";

const { createBlockSkipper } = require("./puml_blocks.js");

const CLASS_KEYWORDS = new Set(["class", "interface", "abstract", "enum", "entity", "struct", "protocol"]);

function stripStereotype(s) {
    return s.replace(/<<.*?>>/g, "").replace(/<[^>]*>/g, "").trim(); // drop <<stereotype>> and <Generics>
}

/**
 * Parse `+name(args) : Type` / `-validate()` / `field : Type` into a member
 * descriptor.
 *
 * Parameter und Rückgabetyp werden MITGENOMMEN. Vorher blieb von
 * `+ geocode(address) : Location` nur `geocode` uebrig — ein Agent, der die
 * Klasse bauen soll, erfaehrt daraus, DASS es die Methode gibt, und nichts
 * darüber, was sie entgegennimmt oder zurückgibt. Genau die Angabe steht im
 * Diagramm, sie wurde nur weggeworfen.
 */
function parseMember(line) {
    let t = line.trim();
    if (!t || t === "{" || t === "}") return null;
    t = t.replace(/\{(static|abstract)\}/gi, " ").trim(); // Modifier-Tags raus, Rest bleibt
    let visibility = "package";
    const vc = t[0];
    if (vc === "+") visibility = "public";
    else if (vc === "-") visibility = "private";
    else if (vc === "#") visibility = "protected";
    else if (vc === "~") visibility = "package";
    if ("+-#~".includes(vc)) t = t.slice(1).trim();

    const callIdx = t.indexOf("(");
    if (callIdx >= 0) {
        // method: identifier right before '('
        const head = t.slice(0, callIdx).trim();
        const m = head.match(/([A-Za-z_$][A-Za-z0-9_$]*)\s*$/);
        if (!m) return null;
        const closeIdx = t.lastIndexOf(")");
        const params = closeIdx > callIdx ? t.slice(callIdx + 1, closeIdx).trim() : "";
        // Rückgabetyp steht hinter der Klammer (`(…) : Location`) oder — in
        // der C++/Java-Schreibweise — VOR dem Namen (`Location geocode(…)`).
        const tail = closeIdx >= 0 ? t.slice(closeIdx + 1).trim().replace(/^:\s*/, "") : "";
        const prefix = head.slice(0, head.length - m[1].length).trim();
        const returns = tail || prefix || null;
        return {
            kind: "method", name: m[1], visibility,
            params: params || null,
            paramList: splitParams(params),
            returns,
            signature: `${m[1]}(${params})${returns ? " : " + returns : ""}`,
        };
    }
    // field: `name : Type` or `Type name`
    const fm = t.match(/^([A-Za-z_$][A-Za-z0-9_$]*)\s*:\s*(.*)$/);
    if (fm) {
        const type = fm[2].trim() || null;
        return { kind: "field", name: fm[1], visibility, type,
                 signature: type ? `${fm[1]} : ${type}` : fm[1] };
    }
    const fm2 = t.match(/^(.*?)([A-Za-z_$][A-Za-z0-9_$]*)\s*$/);
    if (fm2) {
        const type = fm2[1].trim() || null;
        return { kind: "field", name: fm2[2], visibility, type,
                 signature: type ? `${fm2[2]} : ${type}` : fm2[2] };
    }
    return null;
}

/** `center, category, radius=5` → ['center', 'category', 'radius=5']; Generics bleiben heil. */
function splitParams(params) {
    if (!params) return [];
    const out = [];
    let depth = 0, current = "";
    for (const ch of params) {
        if ("([{<".includes(ch)) depth++;
        else if (")]}>".includes(ch)) depth--;
        if (ch === "," && depth <= 0) { out.push(current.trim()); current = ""; continue; }
        current += ch;
    }
    if (current.trim()) out.push(current.trim());
    return out.filter(Boolean);
}

/**
 * Zerlegt eine Beziehungszeile am Pfeil.
 *
 * `Order "1" *-- "0..*" LineItem : enthält`
 *   → { left:'Order', leftMultiplicity:'1', arrow:'*--',
 *       right:'LineItem', rightMultiplicity:'0..*', label:'enthält' }
 *
 * Gibt null, wenn die Zeile keinen Pfeil hat. Der Pfeil muss aus mindestens
 * zwei Pfeilzeichen bestehen — ein einzelner Bindestrich steht in Klassennamen
 * (`My-Class`) und darf nicht trennen.
 */
function splitRelation(line) {
    const am = line.match(/[<>|*o.\\/-]{2,}/);
    if (!am) return null;
    const arrow = am[0];
    // `..` als Trenner nur, wenn daneben wirklich ein Pfeil steht: `Foo..Bar`
    // ohne Pfeilspitze ist keine Beziehung, sondern ein qualifizierter Name.
    if (!/[<>|*o-]/.test(arrow)) return null;

    let left = line.slice(0, am.index).trim();
    let rest = line.slice(am.index + arrow.length).trim();

    // Label steht hinter dem ersten Doppelpunkt RECHTS vom Pfeil.
    let label = null;
    const colon = rest.indexOf(":");
    if (colon >= 0) {
        label = rest.slice(colon + 1).trim() || null;
        rest = rest.slice(0, colon).trim();
    }

    // Multiplizitaeten kleben in Anführungszeichen am Pfeil.
    let leftMultiplicity = null, rightMultiplicity = null;
    const lm = left.match(/"([^"]*)"\s*$/);
    if (lm) { leftMultiplicity = lm[1].trim() || null; left = left.slice(0, lm.index).trim(); }
    const rm = rest.match(/^"([^"]*)"/);
    if (rm) { rightMultiplicity = rm[1].trim() || null; rest = rest.slice(rm[0].length).trim(); }

    if (!left || !rest) return null;
    return { left, right: rest, arrow, label, leftMultiplicity, rightMultiplicity };
}

/** Classify a relation arrow into a relation type. */
function relationType(arrow) {
    if (arrow.includes("<|") || arrow.includes("|>")) return "inherits";
    if (arrow.includes("*")) return "composition";
    if (arrow.includes("o")) return "aggregation";
    if (arrow.includes("..")) return "dependency";
    return "association";
}

function parsePumlClass(text) {
    const classes = [];
    const byName = new Map();
    const relations = [];
    let title = null;
    let current = null; // class currently being filled (inside { })

    const ensureClass = (name, kind) => {
        const clean = stripStereotype(name).replace(/"/g, "").trim();
        if (byName.has(clean)) {
            const c = byName.get(clean);
            if (kind && c.kind === "class" && kind !== "class") c.kind = kind;
            return c;
        }
        const c = { name: clean, kind: kind || "class", methods: [], fields: [] };
        byName.set(clean, c);
        classes.push(c);
        return c;
    };

    const skipBlock = createBlockSkipper();

    for (const raw of String(text).split(/\r?\n/)) {
        let line = raw.replace(/'.*$/, "").trim();
        if (!line) continue;
        // VOR dem Klassenrumpf: eine Note innerhalb von `class X { … }` würde
        // sonst Zeile für Zeile als Member gelesen.
        if (skipBlock(line)) continue;
        const lower = line.toLowerCase();
        if (lower === "@startuml" || lower === "@enduml") continue;
        if (lower.startsWith("title ")) { title = line.slice(6).trim(); continue; }
        if (lower === "left to right direction" || lower.startsWith("hide ")) continue;

        // Inside a class body?
        if (current) {
            if (line === "}" || line.endsWith("}")) {
                const inner = line.slice(0, line.indexOf("}")).trim();
                if (inner) { const mem = parseMember(inner); if (mem) addMember(current, mem); }
                current = null;
                continue;
            }
            const mem = parseMember(line);
            if (mem) addMember(current, mem);
            continue;
        }

        const firstWord = lower.split(/\s+/)[0];

        // Class declaration: `class X {`, `interface X`, `abstract class X`, `enum X`
        if (CLASS_KEYWORDS.has(firstWord)) {
            let rest = line.replace(/^\w+\s+/, "");
            let kind = firstWord === "abstract" ? "abstract" : firstWord;
            if (firstWord === "abstract") rest = rest.replace(/^class\s+/i, "");
            const hasBrace = rest.includes("{");
            let header = hasBrace ? rest.slice(0, rest.indexOf("{")) : rest;
            // strip `as Alias`, generics, stereotypes
            header = header.replace(/\s+as\s+\S+/i, "");
            const name = stripStereotype(header).trim();
            const c = ensureClass(name, kind);
            if (hasBrace) {
                current = c;
                const after = rest.slice(rest.indexOf("{") + 1).trim();
                if (after && after !== "}") {
                    if (after.endsWith("}")) {
                        const mem = parseMember(after.slice(0, -1)); if (mem) addMember(c, mem);
                    } else { const mem = parseMember(after); if (mem) addMember(c, mem); }
                }
                if (after.endsWith("}")) current = null;
            }
            continue;
        }

        // Inline member: `ClassName : +method()`
        const inlineMem = line.match(/^(\S+)\s*:\s*(.+)$/);
        if (inlineMem && !/[<>|*o.]-|-[-<>|*o.]/.test(line)) {
            const c = ensureClass(inlineMem[1], null);
            const mem = parseMember(inlineMem[2]);
            if (mem) addMember(c, mem);
            continue;
        }

        // Relation: `A <|-- B`, `A --> B : label`, `A "1" *-- "0..*" B`, `A ..|> B`.
        //
        // Am Pfeil geteilt statt am Token: Multiplizitaeten (`"1"`, `"0..*"`)
        // und das Label hinter dem Doppelpunkt gehen dabei nicht verloren.
        // Vorher wurde alles in Anführungszeichen vorab ausgeleert und das
        // Label zwar gematcht, aber nie benutzt — im Graphen stand danach nur
        // noch "association", ohne zu sagen WAS assoziiert ist.
        const parsedRel = splitRelation(line);
        if (parsedRel) {
            const left = stripStereotype(parsedRel.left).replace(/"/g, "").trim();
            const right = stripStereotype(parsedRel.right).replace(/"/g, "").trim();
            if (!left || !right) continue;
            ensureClass(left, null);
            ensureClass(right, null);
            const type = relationType(parsedRel.arrow);
            // Inheritance direction: the `<|` side is the parent.
            // `A <|-- B`  => parent A, child B   (child --|> parent)
            let from = left, to = right; // default: from --(type)--> to
            let fromMultiplicity = parsedRel.leftMultiplicity;
            let toMultiplicity = parsedRel.rightMultiplicity;
            if (type === "inherits" && (parsedRel.arrow.startsWith("<") || parsedRel.arrow.includes("<|"))) {
                from = right; to = left;                                  // child=right extends parent=left
                fromMultiplicity = parsedRel.rightMultiplicity;
                toMultiplicity = parsedRel.leftMultiplicity;
            }
            relations.push({
                from, to, type,
                label: parsedRel.label,
                fromMultiplicity, toMultiplicity,
                raw: line,
            });
            continue;
        }
    }

    return { title, classes, relations };

    function addMember(c, mem) {
        if (mem.kind === "method") {
            if (!c.methods.some(m => m.name === mem.name)) {
                c.methods.push({ name: mem.name, visibility: mem.visibility,
                                 params: mem.params, paramList: mem.paramList,
                                 returns: mem.returns, signature: mem.signature });
            }
        } else if (!c.fields.some(f => f.name === mem.name)) {
            c.fields.push({ name: mem.name, type: mem.type,
                            visibility: mem.visibility, signature: mem.signature });
        }
    }
}

module.exports = { parsePumlClass, parseMember, relationType, stripStereotype };

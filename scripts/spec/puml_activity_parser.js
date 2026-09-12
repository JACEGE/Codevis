/**
 * puml_activity_parser.js — Pure parser for PlantUML ACTIVITY diagrams
 * (new `:Action;` style and old `(*) --> "Action"` style).
 *
 * Output:
 *   { title, actions: [ { name, method, guard, order } ] }
 *
 * `name`   — the raw action text ("Charge Payment").
 * `method` — a callable candidate derived from it ("chargePayment"); the
 *            overlay matches this against the bound process function's callees
 *            using a normalised (lowercase, alphanumeric-only) comparison, so
 *            prose steps still line up with camelCase/snake_case functions.
 * `guard`  — the enclosing if/while/repeat branch label, if any.
 */

"use strict";

const { createBlockSkipper } = require("./puml_blocks.js");

/** Turn an action label into a callable candidate. */
function actionToMethod(text) {
    let t = String(text).trim().replace(/;+$/, "").trim();
    // already an identifier or call? keep its name
    const idm = t.match(/^([A-Za-z_$][A-Za-z0-9_$]*)\s*(\(.*\))?\s*$/);
    if (idm) return idm[1];
    // otherwise camelCase the words
    const words = t.match(/[A-Za-z0-9]+/g);
    if (!words || !words.length) return null;
    return words[0].toLowerCase() + words.slice(1).map(w => w[0].toUpperCase() + w.slice(1).toLowerCase()).join("");
}

const CONTROL = new Set(["start", "stop", "end", "kill", "detach", "fork", "fork again", "end fork", "split", "split again", "end split"]);

function parsePumlActivity(text) {
    const actions = [];
    const guardStack = [];
    let title = null;
    let order = 0;

    const pushAction = (raw) => {
        const name = String(raw).trim().replace(/;+$/, "").trim();
        if (!name) return;
        actions.push({
            name,
            method: actionToMethod(name),
            guard: guardStack.length ? guardStack.join(" / ") : null,
            order: order++,
        });
    };

    const skipBlock = createBlockSkipper();

    for (const raw of String(text).split(/\r?\n/)) {
        let line = raw.replace(/'.*$/, "").trim();
        if (!line) continue;
        // note/legend/skinparam samt Rumpf — siehe puml_blocks.js.
        if (skipBlock(line)) continue;
        const lower = line.toLowerCase();
        if (lower === "@startuml" || lower === "@enduml") continue;
        if (lower.startsWith("title ")) { title = line.slice(6).trim(); continue; }
        if (lower.startsWith("hide ")) continue;
        if (/^partition\b/i.test(line) || line === "{" || line === "}") continue;
        if (CONTROL.has(lower)) continue;
        if (lower === "(*)" || /^\(\*\)/.test(line) === false && lower === "stop") continue;

        // branch control
        let m = line.match(/^if\s*\(([^)]*)\)/i);
        if (m) { guardStack.push(m[1].trim() || "if"); continue; }
        m = line.match(/^elseif\s*\(([^)]*)\)/i);
        if (m) { if (guardStack.length) guardStack[guardStack.length - 1] = m[1].trim() || "elseif"; continue; }
        m = line.match(/^else\b\s*(?:\(([^)]*)\))?/i);
        if (m) { if (guardStack.length) guardStack[guardStack.length - 1] = (m[1] || "else").trim(); continue; }
        if (/^endif\b/i.test(lower)) { guardStack.pop(); continue; }
        m = line.match(/^while\s*\(([^)]*)\)/i);
        if (m) { guardStack.push(m[1].trim() || "while"); continue; }
        if (/^endwhile\b/i.test(lower)) { guardStack.pop(); continue; }
        if (/^repeat\s+while\b/i.test(lower) || /^repeatwhile\b/i.test(lower)) { guardStack.pop(); continue; }
        if (/^repeat\b/i.test(lower)) { guardStack.push("repeat"); continue; }

        // new-style action: :Action; (may contain colons inside, ends with ;)
        m = line.match(/^:(.*);\s*$/);
        if (m) { pushAction(m[1]); continue; }

        // old-style: (*) --> "Action"  /  "A" --> "B"  /  Action --> Action
        m = line.match(/^(.+?)\s*-+\s*(?:\[[^\]]*\])?\s*>+\s*(.+)$/);
        if (m) {
            for (const side of [m[1], m[2]]) {
                let tok = side.trim().replace(/^"|"$/g, "");
                if (tok === "(*)" || /^\(\*\)/.test(tok)) continue; // start/end marker
                // strip a trailing arrow label fragment after a stray colon
                tok = tok.replace(/\s*:\s*.*$/, "").trim();
                if (tok && !/^\(\*/.test(tok)) {
                    // avoid duplicating an action already added as the previous target
                    if (!actions.length || actions[actions.length - 1].name !== tok) pushAction(tok);
                }
            }
            continue;
        }
    }

    return { title, actions };
}

module.exports = { parsePumlActivity, actionToMethod };

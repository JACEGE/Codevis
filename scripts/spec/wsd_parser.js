/**
 * wsd_parser.js — Pure parser for PlantUML / WebSequenceDiagrams (.wsd)
 * sequence diagrams.
 *
 * Turns sequence-diagram text into a normalized object describing the
 * participants and the ordered messages between them. NO Neo4j, NO I/O —
 * pure functions only, so it is trivially unit-testable and never starts a
 * build when required (same discipline as scripts/graph_builder.js helpers).
 *
 * Output shape:
 *   {
 *     title: string | null,
 *     participants: [ { alias, display, kind, implicit } ],
 *     messages:     [ { order, from, to, label, method, dashed, async, guard } ]
 *   }
 *
 * `from`/`to` are participant aliases (the token used in the diagram).
 * `method` is the best-effort callable name derived from the message label
 * (e.g. "save()" -> "save"), or null when the label is free text. This is
 * what the conformance overlay matches against Function {name} / CALLS.
 */

"use strict";

const { createBlockSkipper } = require("./puml_blocks.js");

// Participant-declaring keywords in PlantUML.
const PARTICIPANT_KINDS = new Set([
    "participant", "actor", "boundary", "control", "entity", "database",
    "collections", "queue",
]);

// Block keywords that open a guarded group (alt/opt/loop/...). They carry an
// optional condition label which we attach to the messages inside as `guard`.
const BLOCK_OPEN = new Set(["alt", "opt", "loop", "par", "break", "critical", "group"]);
// Lines we recognize but intentionally ignore for message extraction.
const IGNORE_DIRECTIVES = new Set([
    "autonumber", "activate", "deactivate", "destroy", "create", "note",
    "hnote", "rnote", "ref", "box", "end box", "skinparam", "hide", "show",
    "newpage", "==", "...", "|||",
]);

/** Strip a wrapping pair of double quotes, if present. */
function unquote(s) {
    const t = s.trim();
    if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1);
    return t;
}

/** Remove PlantUML activation markers (+/-) and stereotype noise from a token. */
function cleanParticipantToken(tok) {
    let t = tok.trim();
    // leading/trailing activation markers: "+B", "-A", "B++"
    t = t.replace(/^[+\-*!]+/, "").replace(/[+\-*!]+$/, "").trim();
    return unquote(t);
}

/**
 * Derive a callable method name from a message label.
 *   "save()"        -> "save"
 *   "getUser(id)"   -> "getUser"
 *   "save"          -> "save"
 *   "fetch data"    -> null   (free text, not a single identifier)
 *   "GET /users"    -> null
 */
function deriveMethod(label) {
    if (!label) return null;
    const t = label.trim();
    // identifier optionally followed by ( ... )
    const m = t.match(/^([A-Za-z_$][A-Za-z0-9_$]*)\s*(\(.*\))?\s*$/);
    if (m) return m[1];
    return null;
}

/**
 * Match a message line and return { left, arrow, right } or null.
 * Arrow = one or two dashes, optionally bracketed by direction/loss chars
 * (<, >, x, o, \, /). Examples: ->  -->  ->>  <--  ->x  -->>
 */
function matchArrow(line) {
    const m = line.match(/^(.+?)\s*((?:<{1,2}|[xo\\/])?-{1,2}(?:>{1,2}|[xo\\/])?)\s*(.+)$/);
    if (!m) return null;
    const arrow = m[2];
    // Must actually point somewhere — a bare "--" divider is not a message.
    if (!/[<>xo\\/]/.test(arrow)) return null;
    return { left: m[1], arrow, right: m[3] };
}

/**
 * Parse .wsd / PlantUML sequence text into the normalized object.
 * @param {string} text
 * @returns {{title: string|null, participants: Array, messages: Array}}
 */
function parseWsd(text) {
    const participants = []; // ordered
    const byAlias = new Map();
    const messages = [];
    const guardStack = [];
    let title = null;
    let order = 0;

    const ensureParticipant = (alias, kind, display, implicit) => {
        const key = alias;
        if (byAlias.has(key)) {
            const p = byAlias.get(key);
            if (display && !p.display) p.display = display;
            if (kind && p.implicit && !implicit) { p.kind = kind; p.implicit = false; }
            return p;
        }
        const p = { alias: key, display: display || null, kind: kind || "participant", implicit: !!implicit };
        byAlias.set(key, p);
        participants.push(p);
        return p;
    };

    const skipBlock = createBlockSkipper();
    const rawLines = String(text).split(/\r?\n/);
    for (let raw of rawLines) {
        // Strip PlantUML single-quote comments and trim.
        let line = raw.replace(/'.*$/, "").trim();
        if (!line) continue;

        // note/legend/skinparam samt Rumpf. `note` stand zwar in
        // IGNORE_DIRECTIVES, aber das trifft nur die Kopfzeile: der Rumpf lief
        // weiter bis zum Nachrichten-Matcher, und ein Satz wie
        // "Device -> host boundary." wurde zu einer Nachricht samt zwei
        // erfundenen Teilnehmern.
        if (skipBlock(line)) continue;

        const lower = line.toLowerCase();

        // Wrappers / no-ops
        if (lower === "@startuml" || lower === "@enduml") continue;
        if (lower === "@startwsd" || lower === "@endwsd") continue;

        // title
        if (lower.startsWith("title ")) { title = line.slice(6).trim(); continue; }

        // Block control: open / else / end
        const firstWord = lower.split(/\s+/)[0];
        if (BLOCK_OPEN.has(firstWord)) {
            const cond = line.slice(firstWord.length).trim();
            guardStack.push(cond || firstWord);
            continue;
        }
        if (firstWord === "else") {
            const cond = line.slice(4).trim();
            if (guardStack.length) guardStack[guardStack.length - 1] = cond || "else";
            else guardStack.push(cond || "else");
            continue;
        }
        // Bare `end` closes a block (alt/opt/loop/...). `end box` / `end note` /
        // `end ref` close non-guard constructs and must NOT pop the guard stack.
        if (firstWord === "end") { if (lower === "end") guardStack.pop(); continue; }

        // Participant declarations: `participant "Display" as Alias` / `actor User`
        if (PARTICIPANT_KINDS.has(firstWord)) {
            // Drop a trailing `order N` ordering hint so it doesn't leak into the alias.
            const rest = line.slice(firstWord.length).trim().replace(/\s+order\s+\d+\s*$/i, "");
            const asMatch = rest.match(/^(.*?)\s+as\s+(\S+)\s*$/i);
            if (asMatch) {
                const display = unquote(asMatch[1]);
                const alias = cleanParticipantToken(asMatch[2]);
                ensureParticipant(alias, firstWord, display, false);
            } else {
                const tok = cleanParticipantToken(rest);
                // `participant "Web Server"` with no alias → alias = display text
                ensureParticipant(tok, firstWord, /\s/.test(rest) ? unquote(rest) : null, false);
            }
            continue;
        }

        // Ignore known directives that are not messages.
        if (IGNORE_DIRECTIVES.has(firstWord)) continue;

        // Message line? Strip arrow styling (`-[#red]>`, `-[#0000FF,bold]>`)
        // from the part BEFORE the label colon so it doesn't break arrow
        // matching — labels (after the colon) are left untouched.
        const cIdx = line.indexOf(":");
        const head = (cIdx >= 0 ? line.slice(0, cIdx) : line).replace(/\[#?[^\]]*\]/g, "");
        const arrowParts = matchArrow(head + (cIdx >= 0 ? line.slice(cIdx) : ""));
        if (!arrowParts) continue; // unknown / unsupported line → skip silently

        const { left, arrow, right } = arrowParts;
        // Split target from label on the FIRST colon only.
        const colonIdx = right.indexOf(":");
        const rightTarget = colonIdx >= 0 ? right.slice(0, colonIdx) : right;
        const label = colonIdx >= 0 ? right.slice(colonIdx + 1).trim() : "";

        const leftTok = cleanParticipantToken(left);
        const rightTok = cleanParticipantToken(rightTarget);
        if (!leftTok || !rightTok) continue;

        const reverse = arrow.trim().startsWith("<");
        const dashed = arrow.includes("--");
        const async = arrow.includes(">>");

        const from = reverse ? rightTok : leftTok;
        const to = reverse ? leftTok : rightTok;

        ensureParticipant(from, null, null, true);
        ensureParticipant(to, null, null, true);

        messages.push({
            order: order++,
            from,
            to,
            label,
            method: deriveMethod(label),
            dashed,
            async,
            guard: guardStack.length ? guardStack.join(" / ") : null,
        });
    }

    return { title, participants, messages };
}

module.exports = { parseWsd, deriveMethod, matchArrow, cleanParticipantToken, unquote };

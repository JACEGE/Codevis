/**
 * puml_usecase_parser.js — Pure parser for PlantUML USE-CASE diagrams.
 *
 * Output:
 *   {
 *     title,
 *     actors:   [ { name, display } ],
 *     usecases: [ { id, name } ],                 // id = alias or name (the reference token)
 *     associations: [ { actor, usecase } ],       // actor performs use case
 *     relations: [ { from, to, type } ]           // type: include | extend | generalize
 *   }
 *
 * Use cases can be written as `usecase "Name" as UC1`, `(Name)`, or `(Name) as UCp`.
 * Actors as `actor Name`, `actor "Display" as A`, or `:Name:`.
 */

"use strict";

const { createBlockSkipper } = require("./puml_blocks.js");

function unquote(s) {
    const t = (s || "").trim();
    return (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) ? t.slice(1, -1) : t;
}
function stripParens(s) {
    const t = (s || "").trim();
    return (t.startsWith("(") && t.endsWith(")")) ? t.slice(1, -1).trim() : t;
}

// include/extend can be written `: include`, `: <<include>>`, `<<extends>>`, etc.
function relationKind(arrow, label) {
    const l = (label || "").toLowerCase();
    if (l.includes("include")) return "include";
    if (l.includes("extend")) return "extend";
    if (arrow.includes("|>")) return "generalize";
    if (arrow.includes("..") || arrow.includes(".>")) return "include"; // dashed dependency default
    return "association";
}

function parsePumlUseCase(text) {
    const actors = [];
    const actorByKey = new Map();
    const usecases = [];
    const ucByKey = new Map(); // id or name -> canonical usecase obj
    const associations = [];
    const relations = [];
    let title = null;

    const addActor = (name, display) => {
        const key = name;
        if (actorByKey.has(key)) return actorByKey.get(key);
        const a = { name: key, display: display || null };
        actorByKey.set(key, a);
        actors.push(a);
        return a;
    };
    const addUseCase = (id, name) => {
        const canonId = id || name;
        if (ucByKey.has(canonId)) return ucByKey.get(canonId);
        // also resolve by name
        if (name && ucByKey.has(name)) return ucByKey.get(name);
        const uc = { id: canonId, name: name || canonId };
        usecases.push(uc);
        ucByKey.set(canonId, uc);
        if (name) ucByKey.set(name, uc);
        return uc;
    };
    const resolveRef = (tok) => {
        // returns { kind: 'actor'|'usecase', key } for an endpoint token
        let t = tok.trim();
        if (t.startsWith(":") && t.endsWith(":")) { // :Actor:
            const nm = t.slice(1, -1).trim();
            addActor(nm, null);
            return { kind: "actor", key: nm };
        }
        if (t.startsWith("(") && t.endsWith(")")) { // (Use Case)
            const nm = stripParens(t);
            const uc = addUseCase(nm, nm);
            return { kind: "usecase", key: uc.id };
        }
        t = unquote(t);
        if (actorByKey.has(t)) return { kind: "actor", key: t };
        if (ucByKey.has(t)) return { kind: "usecase", key: ucByKey.get(t).id };
        // unknown bare token — default to use case (most diagram tokens are UCs)
        const uc = addUseCase(t, t);
        return { kind: "usecase", key: uc.id };
    };

    const skipBlock = createBlockSkipper();

    for (const raw of String(text).split(/\r?\n/)) {
        let line = raw.replace(/'.*$/, "").trim();
        if (!line) continue;
        // note/legend/skinparam samt Rumpf. Ohne das las die Beziehungsregel
        // unten `BackgroundColor<<done>> #C8E6C9` als Pfeil und legte zwei
        // Use Cases samt include-Beziehung daraus an.
        if (skipBlock(line)) continue;
        const lower = line.toLowerCase();
        if (lower === "@startuml" || lower === "@enduml") continue;
        if (lower.startsWith("title ")) { title = line.slice(6).trim(); continue; }
        if (lower === "left to right direction" || lower === "top to bottom direction") continue;
        if (lower.startsWith("hide ")) continue;
        // grouping containers — keep their members flat for v1
        if (/^(rectangle|package|folder|frame|node|cloud)\b/i.test(line)) continue;
        if (line === "}" || line === "{") continue;

        // actor declaration
        let m = line.match(/^actor\s+(.*)$/i);
        if (m) {
            const rest = m[1].trim();
            const asM = rest.match(/^(.*?)\s+as\s+(\S+)\s*$/i);
            if (asM) addActor(asM[2].trim(), unquote(asM[1]));
            else addActor(unquote(rest), /\s/.test(rest) ? unquote(rest) : null);
            continue;
        }
        // :Actor: shorthand on its own line
        m = line.match(/^:([^:]+):\s*$/);
        if (m) { addActor(m[1].trim(), null); continue; }

        // usecase declaration
        m = line.match(/^usecase\s+(.*)$/i);
        if (m) {
            // Ein Stereotyp am Zeilenende (`… as UC1 <<done>>`) liess die
            // as-Regel scheitern, und dann wurde die GANZE Zeile zum Namen des
            // Use Case — inklusive Anführungszeichen, Alias und Stereotyp.
            // In einem betroffenen Graphen standen dadurch 38 Knoten für 16 Use Cases.
            const rest = m[1].replace(/<<[^>]*>>/g, "").trim();
            const asM = rest.match(/^(.*?)\s+as\s+(\S+)\s*$/i);
            if (asM) {
                const a = unquote(asM[1]), b = asM[2].trim();
                // `usecase "Name" as UC1`  OR  `usecase UC1 as "Name"`
                if (/^".*"$/.test(asM[1])) addUseCase(b, a);          // alias=b, name=a
                else addUseCase(a, unquote(b.replace(/^\(|\)$/g, ""))); // alias=a, name=b
            } else {
                const nm = stripParens(unquote(rest));
                addUseCase(nm, nm);
            }
            continue;
        }
        // bare `(Use Case) as UCp`
        m = line.match(/^\(([^)]+)\)\s+as\s+(\S+)\s*$/i);
        if (m) { addUseCase(m[2].trim(), m[1].trim()); continue; }
        // bare `(Use Case)` on its own line
        m = line.match(/^\(([^)]+)\)\s*$/);
        if (m) { addUseCase(m[1].trim(), m[1].trim()); continue; }

        // relation / association line: LHS arrow RHS [: label]
        const rel = line.match(/^(.+?)\s*([<>|.\\\/-]{2,})\s*(.+?)\s*(?::\s*(.*))?$/);
        if (rel) {
            const left = rel[1].trim(), arrow = rel[2], right = rel[3].trim(), label = rel[4] || "";
            if (!/[<>]/.test(arrow) && !arrow.includes("--")) continue;
            const reverse = arrow.trim().startsWith("<");
            const a = resolveRef(reverse ? right : left);
            const b = resolveRef(reverse ? left : right);
            const kind = relationKind(arrow, label);
            if (a.kind === "actor" && b.kind === "usecase") {
                associations.push({ actor: a.key, usecase: b.key });
            } else if (a.kind === "usecase" && b.kind === "actor") {
                associations.push({ actor: b.key, usecase: a.key });
            } else if (a.kind === "usecase" && b.kind === "usecase") {
                relations.push({ from: a.key, to: b.key, type: kind === "association" ? "include" : kind });
            }
            continue;
        }
    }

    return { title, actors, usecases, associations, relations };
}

module.exports = { parsePumlUseCase, relationKind, stripParens };

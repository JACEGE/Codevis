/**
 * class_render.cjs — render a class model as PlantUML or Mermaid.
 *
 * Pure: model in, string out. No database, no filesystem — so the escaping and
 * layout rules are unit-testable, which matters because both output formats
 * fail loudly and unhelpfully on a single unescaped character.
 *
 * PlantUML is the format that round-trips: `import_spec` parses it back, so a
 * diagram generated from code can be reconciled against a hand-written spec to
 * find drift. Mermaid is what a browser renders without a server.
 */

"use strict";

/**
 * Stable, syntax-safe identifier per class.
 *
 * Both formats choke on the characters that appear in real class keys (`/`,
 * `.`, `:`, spaces), and two classes of the same name in different files must
 * not collapse into one box — hence an index-based id with the readable name
 * kept as the display label.
 */
function buildIds(classes) {
    const ids = new Map();
    classes.forEach((c, i) => ids.set(c.key, `C${i}`));
    return ids;
}

/** Escape a display string for a quoted PlantUML/Mermaid label. */
function label(text) {
    return String(text == null ? "" : text).replace(/"/g, "'").replace(/[\r\n]+/g, " ");
}

/**
 * A box needs a name a reader can point at, and Mermaid needs one to lay the box
 * out at all: measured in a browser, `class C0[""]` is a parse error that kills
 * the whole diagram and `class C0["  "]` fails later with "svg element not in
 * render tree". The model only drops names that are falsy, so a blank one from
 * an extractor reaches this point — one bad box must not cost the other forty.
 */
function classLabel(name) {
    return label(name).trim() || "(unnamed)";
}

/** Add a source hint only where the readable class name is ambiguous. */
function displayLabels(classes) {
    const counts = new Map();
    for (const c of classes) counts.set(c.name, (counts.get(c.name) || 0) + 1);
    return new Map(classes.map((c) => {
        const suffix = counts.get(c.name) > 1 && c.file ? ` — ${c.file}` : "";
        return [c.key, classLabel(`${c.name}${suffix}`)];
    }));
}

/**
 * Method line. The stored signature is preferred over a bare name, but it is
 * capped: a builder that recorded a 300-character signature would otherwise
 * push the diagram past any sane width.
 *
 * A signature that starts at the parameter list (`(self, x)`, which is what a
 * params-only capture produces) gets the name put back in front of it: a member
 * with nothing before the parentheses is not a method line either format can
 * read, and Mermaid aborts on a bare `()`.
 */
function methodLine(method, maxLen = 80) {
    let sig = String(method.signature || `${method.name}()`).replace(/\s+/g, " ").trim();
    if (sig.startsWith("(")) sig = `${method.name}${sig}`;
    return label(sig.length > maxLen ? `${sig.slice(0, maxLen - 1)}…` : sig);
}

/** Attribute line: `name: Type` where the source declared one, else the name. */
function attributeLine(attr, maxLen = 60) {
    const type = attr.declaredType ? String(attr.declaredType).replace(/\s+/g, " ").trim() : "";
    const text = type ? `${attr.name}: ${type}` : String(attr.name);
    return label(text.length > maxLen ? `${text.slice(0, maxLen - 1)}…` : text);
}

/**
 * PlantUML reads its member text as creole markup, so a Python dunder is not
 * inert: `__init__` is `__…__`, creole for UNDERLINE, and the box ends up
 * showing an underlined "init" — the one method name every Python class has.
 * `**kwargs` is creole bold for the same reason.
 *
 * `~` escapes the character after it, so prefixing each marker pair breaks it
 * without altering what the reader sees. Mermaid has no creole and is left
 * alone; its own hazard is the colon, handled by mermaidMember().
 */
function plantumlMember(text) {
    return String(text).replace(/(__|\*\*|\/\/|""|~~|--)/g, "~$1");
}

function renderPlantuml(model, { title = "Class Diagram" } = {}) {
    const ids = buildIds(model.classes);
    const labels = displayLabels(model.classes);
    const L = [`@startuml`, `title ${label(title)}`, `skinparam classAttributeIconSize 0`, ``];

    for (const c of model.classes) {
        const id = ids.get(c.key);
        const stereotype = c.external ? " <<external>>" : c.kind === "enumeration" ? " <<enumeration>>" : "";
        const attrs = [
            ...(c.attributes || []).map((a) => `  ${plantumlMember(attributeLine(a))}`),
            ...(c.hiddenAttributes ? [`  .. ${c.hiddenAttributes} more ..`] : []),
        ];
        const methods = [
            ...(c.methods || []).map((m) => `  ${plantumlMember(methodLine(m))}`),
            // The cap is stated in the diagram itself: a truncated class must not
            // read as a complete one.
            ...(c.hiddenMethods ? [`  .. ${c.hiddenMethods} more ..`] : []),
        ];
        // `--` draws UML's compartment line. Only when both halves exist, so a
        // pure data class does not get a rule under nothing.
        const body = attrs.length && methods.length
            ? [...attrs, "  --", ...methods]
            : [...attrs, ...methods];
        L.push(body.length
            ? `class "${labels.get(c.key)}" as ${id}${stereotype} {\n${body.join("\n")}\n}`
            : `class "${labels.get(c.key)}" as ${id}${stereotype}`);
    }

    L.push("");
    for (const r of model.relations) {
        const from = ids.get(r.from);
        const to = ids.get(r.to);
        if (!from || !to) continue;
        if (r.kind === "inherits") L.push(`${from} --|> ${to}`);
        // A field of that type is structure, not behaviour, so it gets UML's
        // solid association line rather than a dashed dependency.
        else if (r.kind === "association") L.push(`${from} --> ${to}`);
        // «create» is the UML stereotype for a constructor dependency; a plain
        // "uses" would lose the distinction between building an object and
        // calling into one.
        else if (r.kind === "creates") L.push(`${from} ..> ${to} : <<create>>`);
        else L.push(`${from} ..> ${to} : uses`);
    }

    L.push(`@enduml`);
    return L.join("\n");
}

/**
 * Mermaid's class-member syntax is `ClassId : member`, so the colon is the
 * separator itself and a member text that contains one ends the statement early.
 * Mermaid offers no escape for it, and the whole diagram dies on the first
 * offender: "Parse error ... Expecting 'NEWLINE', 'EOF', got 'COLON'".
 *
 * Signatures carry colons in every language worth graphing — C++ namespaces
 * (`sensor_msgs::msg::LaserScan`), TypeScript and annotated Python parameters
 * (`run(a: string)`). So this is not an exotic case; one C++ method was enough
 * to leave the Classes tab permanently empty.
 *
 * `::` becomes `.`, which is how the same qualification is written in most other
 * languages and stays readable. A remaining single colon becomes a space, which
 * is Mermaid's own convention for members anyway (`+run(a string) void`). The
 * PlantUML output is untouched — it has no such restriction and keeps the exact
 * signature, so nothing is lost for anyone who needs it verbatim.
 *
 * Literal angle brackets parse, but Mermaid then treats them as HTML and drops
 * the generic argument from the SVG. Typographic brackets keep it visible.
 * Braces and tildes remain unchanged; PlantUML keeps the exact signature.
 */
function mermaidMember(text) {
    let member = String(text).replace(/::/g, ".").replace(/[:;]/g, " ");
    // Resolve inner pairs first so nested generics remain visible too. Requiring
    // an identifier after `<` avoids changing arrows and comparison operators.
    let previous;
    do {
        previous = member;
        member = member.replace(/<([A-Za-z_][^<>]*)>/g, "‹$1›");
    } while (member !== previous);
    return escapeMermaidUnderscores(
        jsPrivateToMermaidPrivate(
            dropUnopenedParens(
                member.replace(/\s+/g, " ").trim()
            )
        )
    );
}

/**
 * `#` bedeutet in Mermaid protected, in JavaScript privat — das genaue
 * Gegenteil.
 *
 * Mermaid liest das erste Zeichen eines Members als Sichtbarkeit (`+` public,
 * `-` private, `#` protected, `~` package). Eine JS-Klasse mit `#hidden()`
 * bekam damit ein Schloss-Symbol, das dem Leser sagt: von aussen unzugaenglich,
 * von Unterklassen schon — obwohl `#`-Felder gerade in Unterklassen NICHT
 * sichtbar sind. Die Auskunft war nicht ungenau, sie war falsch herum.
 *
 * `-` ist Mermaids Zeichen für genau das, was `#` in JavaScript heißt. Der
 * Name bleibt unverändert; nur das Sichtbarkeitszeichen wird übersetzt.
 */
function jsPrivateToMermaidPrivate(text) {
    return text.startsWith("#") ? `-${text.slice(1)}` : text;
}

/**
 * A closing parenthesis with nothing open in front of it takes Mermaid down.
 *
 * Measured, not guessed: `C0 : a)` throws "Cannot read properties of undefined
 * (reading 'startsWith')" — Mermaid decides a member is a method by the presence
 * of a parenthesis and then runs a regex that cannot match, so it dies inside
 * its own parser and the diagram never renders. `a(b)c)` and `run(a` are fine,
 * so the trigger is precisely the unopened `)`. Dropping those keeps everything
 * balanced without touching a signature that was well-formed to begin with —
 * including one the length cap chopped, which loses closers, never openers.
 *
 * The semicolon above is the same class of hazard and simpler: anywhere in a
 * member it is a lexical error ("Unrecognized text"), and a declaration that
 * still carries its terminator (`virtual void area() = 0;`) is ordinary output
 * for a header-style extractor. It becomes a space, like the colon.
 *
 * A leading `(` goes the same way: a parameter list with no name in front of it
 * is not a member Mermaid can read either — a bare `()` crashes it identically.
 * methodLine() already puts the name back for a params-only signature, so what
 * reaches this point that way is a degenerate name, not a signature.
 */
function dropUnopenedParens(text) {
    let depth = 0;
    let out = "";
    for (const ch of text.replace(/^\(+/, "")) {
        if (ch === "(") depth += 1;
        else if (ch === ")") {
            if (depth === 0) continue;
            depth -= 1;
        }
        out += ch;
    }
    return out;
}

/**
 * `__init__` reaches the browser intact but comes out as "init".
 *
 * Mermaid styles a doubled underscore the way Markdown does, so the pair around
 * a Python dunder is consumed as emphasis markup and the underscores never
 * render — on every class, since `__init__` is the one method nearly all of
 * them have. `#95;` is Mermaid's own entity code for an underscore and is
 * immune to that pass. Applied only to doubled underscores, so ordinary
 * `_private` names keep their plain, readable form.
 */
function escapeMermaidUnderscores(text) {
    return text.replace(/__/g, "#95;#95;");
}

function renderMermaid(model, { title = "Class Diagram" } = {}) {
    const ids = buildIds(model.classes);
    const labels = displayLabels(model.classes);
    const L = [`---`, `title: ${label(title)}`, `---`, `classDiagram`];

    // A `classDiagram` with no body is a parse error in Mermaid, so a model
    // with no classes would throw in the browser instead of simply drawing
    // nothing — and the tab would report a parse error where the honest answer
    // is "nothing matched". Reachable from the UI: the path-prefix filter and
    // the 'only connected' checkbox can both narrow the model down to zero.
    // scripts/ros/ros_diagram.js does the same for the same reason.
    if (!model.classes.length) {
        L.push('  class Empty["No classes found in the graph"]');
        return L.join("\n");
    }

    for (const c of model.classes) {
        const id = ids.get(c.key);
        L.push(`  class ${id}["${labels.get(c.key)}"]`);
        if (c.external) L.push(`  <<external>> ${id}`);
        else if (c.kind === "enumeration") L.push(`  <<enumeration>> ${id}`);
        // Attributes first: Mermaid sorts members into compartments itself,
        // putting parenthesised entries in the method half.
        for (const a of c.attributes || []) L.push(`  ${id} : ${mermaidMember(attributeLine(a))}`);
        if (c.hiddenAttributes) L.push(`  ${id} : .. ${c.hiddenAttributes} more ..`);
        for (const m of c.methods || []) L.push(`  ${id} : ${mermaidMember(methodLine(m))}`);
        if (c.hiddenMethods) L.push(`  ${id} : .. ${c.hiddenMethods} more ..`);
    }

    for (const r of model.relations) {
        const from = ids.get(r.from);
        const to = ids.get(r.to);
        if (!from || !to) continue;
        // Mermaid draws generalisation from parent to child.
        if (r.kind === "inherits") L.push(`  ${to} <|-- ${from}`);
        else if (r.kind === "association") L.push(`  ${from} --> ${to}`);
        else if (r.kind === "creates") L.push(`  ${from} ..> ${to} : creates`);
        else L.push(`  ${from} ..> ${to} : uses`);
    }

    return L.join("\n");
}

/**
 * @param {object} model  Output of readClassModel.
 * @param {object} [opts] `format` ('plantuml' | 'mermaid'), `title`.
 */
function renderClassDiagram(model, opts = {}) {
    const format = opts.format || "plantuml";
    if (format === "mermaid") return renderMermaid(model, opts);
    if (format === "plantuml") return renderPlantuml(model, opts);
    throw new Error(`Unknown diagram format '${format}'. Use 'plantuml' or 'mermaid'.`);
}

module.exports = {
    renderClassDiagram, renderPlantuml, renderMermaid,
    methodLine, attributeLine, mermaidMember, plantumlMember, label, classLabel,
};

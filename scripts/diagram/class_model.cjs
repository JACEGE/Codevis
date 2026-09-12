/**
 * class_model.cjs — read a UML class model out of the code graph.
 *
 * Language-agnostic on purpose: it consumes the graph's own vocabulary
 * (`Class`, `Class-[:CONTAINS]->Function`, `INHERITS`, `CALLS`) rather than
 * anything a particular parser produced, so every language the builder already
 * understands gets a class diagram without a second implementation.
 *
 * Split from class_render.cjs so the model can be inspected, tested and
 * rendered twice (PlantUML *and* Mermaid) without touching the database again.
 *
 * Scope: this reads what the graph knows — classes, their methods AND their
 * attributes (`Class-[:DECLARES]->Variable {scope:'field'}`), inheritance,
 * instantiation, and the associations implied by a field's declared type.
 * A class with an empty attribute compartment here genuinely declares no
 * fields; it is not a gap in the extraction.
 */

"use strict";

/** Unwrap a driver value (Ladybug integers arrive as wrapper objects). */
function val(record, key) {
    let v;
    try {
        v = record.get(key);
    } catch (_) {
        return null;
    }
    if (v === undefined) return null;
    if (v && typeof v.toNumber === "function") return v.toNumber();
    return v;
}

/** Identity of a class in the graph: the same natural key the builder merges on. */
function classKey(name, file) {
    return `${name}|${file || ""}`;
}

/**
 * Identity of an external base — deliberately NOT `classKey(name, "")`.
 *
 * A project class whose file the builder never recorded gets exactly that key,
 * and the two then merge: an unresolved library `Node` would attach itself to
 * the codebase's own `Node`, the `<<external>>` box would disappear, and the
 * diagram would draw an inheritance edge into project code that the graph never
 * held. The marker cannot occur in a path, so the collision is impossible.
 */
function externalBaseKey(name) {
    return `${name}|<external>`;
}

/** Identity of a function, used to join CALLS edges onto their owning class. */
/**
 * Identitaet einer Funktion, so wie der Builder sie vergibt.
 *
 * Der Besitzer gehört dazu. Ohne ihn teilten sich eine Basisklasse und ihre
 * Ableitung einen Schlüssel, sobald beide `__init__` hiessen — und da im
 * Diagramm die creates-Kante über diesen Schlüssel ihrem Besitzer zugeordnet
 * wird, zeigte sie danach auf die falsche Klasse.
 */
function funcKey(name, file, owner) {
    return `${owner || ""}|${name}|${file || ""}`;
}

/**
 * Ist diese Funktion in Wahrheit ein Attribut?
 *
 * `@property` macht aus einem Methodenaufruf einen Wertzugriff -- `p.label`,
 * nicht `p.label()`. Getter und Setter tragen denselben Namen, standen also als
 * zwei Zeilen mit widerspruechlichen Signaturen im Kasten.
 *
 * Die Dekoratoren stehen am Knoten, weil der Builder sie ohnehin schreibt; das
 * hier ist deshalb eine Modellentscheidung und keine zweite Extraktion. Neben
 * `property` zählen `cached_property` (dasselbe mit Zwischenspeicher) und die
 * an den Namen gebundenen Formen `<name>.setter` und `<name>.deleter`, die
 * Python für die Gegenstücke verlangt.
 */
function isPropertyAccessor(decorators, name) {
    if (!decorators) return false;
    const list = Array.isArray(decorators) ? decorators : [decorators];
    for (const raw of list) {
        if (typeof raw !== "string") continue;
        // `@functools.cached_property` und `@abc.abstractproperty` tragen ihren
        // Modulpfad mit; entschieden wird am letzten Glied.
        const deco = raw.replace(/\(.*$/s, "").trim();
        const last = deco.split(".").pop();
        if (last === "property" || last === "cached_property" || last === "abstractproperty") return true;
        if (deco === `${name}.setter` || deco === `${name}.deleter`) return true;
    }
    return false;
}

/** Source order for members, with the name as a tie-break so it is total. */
function byLineThenName(a, b) {
    return (a.startLine ?? 0) - (b.startLine ?? 0) || String(a.name).localeCompare(String(b.name));
}

/** Test sources are useful on demand, but should not dominate architecture. */
function isTestFile(file) {
    const normalized = String(file || "").replace(/\\/g, "/");
    return /(^|\/)(tests?|__tests__)(\/|$)/i.test(normalized)
        || /\.(?:test|spec)\.[^/]+$/i.test(normalized);
}

/**
 * Read the class model.
 *
 * @param {object} session Open graph session.
 * @param {object} [opts]
 * @param {string} [opts.pathPrefix]        Only classes under this path prefix.
 * @param {boolean} [opts.includeMethods=true]
 * @param {number} [opts.maxMethods=12]     Methods listed per class before the
 *        rest is summarised as `... N more`. A 60-method class otherwise turns
 *        the diagram into an unreadable wall.
 * @param {boolean} [opts.includeUses=true] Derive `A ..> B` from calls between
 *        the classes' methods.
 * @param {boolean} [opts.onlyConnected=false] Drop classes with no relation at
 *        all — useful on large graphs where isolated helper classes dominate.
 * @returns {Promise<{classes: Array, relations: Array, stats: object}>}
 */
async function readClassModel(session, opts = {}) {
    const {
        pathPrefix = null,
        includeMethods = true,
        maxMethods = 12,
        includeAttributes = true,
        maxAttributes = 12,
        includeUses = true,
        onlyConnected = false,
        includeTests = true,
    } = opts;

    const inScope = (file) => !pathPrefix || (file || "").startsWith(pathPrefix);

    // A negative cap slices from the END of the list and then reports more
    // hidden members than the class even has (`maxMethods: -2` on a 3-method
    // class claimed 5 hidden) — a diagram that lies about its own truncation is
    // worse than one that shows nothing, so the caller's number is clamped.
    const cap = (n) => (Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : Infinity);
    const methodCap = cap(maxMethods);
    const attributeCap = cap(maxAttributes);

    // --- classes ------------------------------------------------------------
    const classRes = await session.run(`
        MATCH (c:Class)
        RETURN c.name AS name, c.file AS file, c.startLine AS startLine, c.kind AS kind
    `);
    const classes = new Map();
    for (const r of classRes.records) {
        const name = val(r, "name");
        const file = val(r, "file");
        if (!name || !inScope(file) || (!includeTests && isTestFile(file))) continue;
        const key = classKey(name, file);
        if (classes.has(key)) continue;
        classes.set(key, {
            key,
            name,
            file,
            startLine: val(r, "startLine"),
            external: false,
            kind: val(r, "kind") || null,
            attributes: [],
            hiddenAttributes: 0,
            methods: [],
            hiddenMethods: 0,
        });
    }

    // --- attributes ----------------------------------------------------------
    // A dataclass declares its entire shape as fields and has no methods at all,
    // so without these the seven value classes of a typical model layer render
    // as empty boxes that look like extraction failures.
    if (includeAttributes) {
        const attrRes = await session.run(`
            MATCH (c:Class)-[:DECLARES]->(v:Variable)
            WHERE v.scope = 'field'
            RETURN c.name AS cls, c.file AS clsFile,
                   v.name AS attr, v.declaredType AS declaredType, v.startLine AS startLine
        `);
        for (const r of attrRes.records) {
            const owner = classes.get(classKey(val(r, "cls"), val(r, "clsFile")));
            if (!owner) continue;
            const name = val(r, "attr");
            if (!name) continue;
            owner.attributes.push({
                name,
                declaredType: val(r, "declaredType") || null,
                startLine: val(r, "startLine"),
            });
        }
        // Zusammengefasst und gedeckelt wird erst NACH den Methoden: eine
        // @property kommt aus der Methodenabfrage und ist trotzdem ein
        // Attribut. Würde hier schon geschnitten, entkaeme sie Dedup und
        // Obergrenze und stuende als einzige Zeile außerhalb der Kappung.
    }

    // --- methods ------------------------------------------------------------
    if (includeMethods) {
        const methodRes = await session.run(`
            MATCH (c:Class)-[:CONTAINS]->(f:Function)
            RETURN c.name AS cls, c.file AS clsFile,
                   f.name AS fn, f.signature AS signature, f.startLine AS startLine,
                   f.decorators AS decorators, f.return_type AS returnType
        `);
        for (const r of methodRes.records) {
            const owner = classes.get(classKey(val(r, "cls"), val(r, "clsFile")));
            if (!owner) continue;
            const name = val(r, "fn");
            if (!name) continue;
            // Eine @property IST ein Attribut. Für den Aufrufer ist `p.label`
            // ein Wert, kein Aufruf — genau deshalb schreibt man sie. Im
            // Diagramm standen Getter und Setter dagegen als zwei Zeilen
            // desselben Namens mit widerspruechlichen Signaturen (`label(self)`
            // und `label(self, v)`), also als etwas, das es im Quelltext nicht
            // gibt. Der Rückgabetyp des Getters ist der Typ des Attributs.
            if (isPropertyAccessor(val(r, "decorators"), name)) {
                owner.attributes.push({
                    name,
                    declaredType: val(r, "returnType") || null,
                    startLine: val(r, "startLine"),
                });
                continue;
            }
            owner.methods.push({
                name,
                signature: val(r, "signature") || `${name}()`,
                startLine: val(r, "startLine"),
            });
        }
        for (const cls of classes.values()) {
            // Source order, so the diagram reads like the file does — with the
            // name breaking ties, so that two methods on the same line (or none
            // at all) do not leave the order to the database.
            cls.methods.sort(byLineThenName);
            // Eine überladene TypeScript-Methode ist drei Definitionen in der
            // Grammatik und damit drei Zeilen im Graphen, aber EINE Methode für
            // den Leser. Ungefiltert stand `run` dreimal untereinander in der
            // Box und verdraengte unter maxMethods echte andere Methoden.
            //
            // Behalten wird die erste in Quellreihenfolge: bei TypeScript ist
            // das die erste deklarierte Überladung, nicht die
            // Implementierungssignatur mit ihrem `any`. Gleichnamige Methoden
            // sind hier nie zwei verschiedene Dinge — der Builder merged
            // Function-Knoten ohnehin auf {name, file}.
            const byName = new Map();
            for (const m of cls.methods) if (!byName.has(m.name)) byName.set(m.name, m);
            cls.methods = [...byName.values()];
            if (cls.methods.length > methodCap) {
                cls.hiddenMethods = cls.methods.length - methodCap;
                cls.methods = cls.methods.slice(0, methodCap);
            }
        }
    }

    // Attribute erst jetzt zusammenfassen und deckeln — die @property-Einträge
    // aus der Methodenabfrage sind hier mit drin.
    if (includeAttributes) {
        for (const cls of classes.values()) {
            // One entry per field name: a field assigned in two branches
            // (`self._ts` in __init__ and again in a reset path) is one field,
            // and the earliest assignment is the one that reads as declaration.
            // The name is a tie-break, not decoration: fields whose startLine the
            // extractor never recorded all compare equal, so without it the sort
            // falls back to the order the database happened to return rows in —
            // and with a cap in play that decides WHICH fields the diagram shows.
            cls.attributes.sort(byLineThenName);
            const byName = new Map();
            for (const a of cls.attributes) {
                const prev = byName.get(a.name);
                if (!prev) byName.set(a.name, a);
                else if (!prev.declaredType && a.declaredType) byName.set(a.name, a);
            }
            cls.attributes = [...byName.values()];
            if (cls.attributes.length > attributeCap) {
                cls.hiddenAttributes = cls.attributes.length - attributeCap;
                cls.attributes = cls.attributes.slice(0, attributeCap);
            }
        }
    }

    // --- inheritance --------------------------------------------------------
    // Two edges, because the builder writes two: to a real Class when the base
    // was found in the codebase, to an ExternalBase node when it comes from a
    // library (`rclcpp::Node`, `React.Component`). The external one carries the
    // architecture just as much — it says what framework a class plugs into.
    const relations = [];
    const seenRelations = new Set();
    const addRelation = (from, to, kind) => {
        const id = `${from}|${kind}|${to}`;
        if (from === to || seenRelations.has(id)) return;
        seenRelations.add(id);
        relations.push({ from, to, kind });
    };

    const inhRes = await session.run(`
        MATCH (a:Class)-[:INHERITS]->(b:Class)
        RETURN a.name AS aName, a.file AS aFile, b.name AS bName, b.file AS bFile
    `);
    for (const r of inhRes.records) {
        const from = classKey(val(r, "aName"), val(r, "aFile"));
        const to = classKey(val(r, "bName"), val(r, "bFile"));
        if (!classes.has(from) || !classes.has(to)) continue;
        addRelation(from, to, "inherits");
    }

    const extRes = await session.run(`
        MATCH (a:Class)-[:INHERITS]->(b:ExternalBase)
        RETURN a.name AS aName, a.file AS aFile, b.name AS bName
    `);
    for (const r of extRes.records) {
        const from = classKey(val(r, "aName"), val(r, "aFile"));
        if (!classes.has(from)) continue;
        const baseName = val(r, "bName");
        if (!baseName) continue;
        // One box per external name, shared by every file that extends it — but
        // in its own key space, so it can never be mistaken for a project class
        // whose file the builder left empty. See externalBaseKey().
        const to = externalBaseKey(baseName);
        if (!classes.has(to)) {
            // An external base is a name we know only from an extends clause —
            // its members live in a library the graph never parsed, so the empty
            // compartments here are honest rather than a truncation.
            classes.set(to, {
                key: to, name: baseName, file: null, startLine: null,
                external: true, attributes: [], hiddenAttributes: 0,
                methods: [], hiddenMethods: 0,
            });
        }
        addRelation(from, to, "inherits");
    }

    // --- creation ------------------------------------------------------------
    // `new Foo()` inside a method of Bar is the association a reader expects to
    // see first, and it is the one a call-based analysis misses entirely: a
    // constructor call is not a method call. Drawn as its own kind so the
    // diagram can distinguish "creates" from "calls into".
    const ownerOfFunction = new Map();
    const ownerRes = await session.run(`
        MATCH (c:Class)-[:CONTAINS]->(f:Function)
        RETURN c.name AS cls, c.file AS clsFile,
               f.name AS fn, f.file AS fnFile, f.owner AS fnOwner
    `);
    for (const r of ownerRes.records) {
        const owner = classKey(val(r, "cls"), val(r, "clsFile"));
        if (!classes.has(owner)) continue;
        const fn = funcKey(val(r, "fn"), val(r, "fnFile"), val(r, "fnOwner"));
        const prev = ownerOfFunction.get(fn);
        // Seit der Builder die besitzende Klasse in den Schlüssel eines
        // Function-Knotens aufnimmt, ist diese Zuordnung eindeutig. Der
        // deterministische Tie-Break bleibt trotzdem stehen: er kostet nichts
        // und faengt aeltere Graphen ab, in denen `owner` noch fehlt und zwei
        // Klassen sich einen Knoten teilen. Ohne ihn folgte der Pfeil damals
        // der Zeilenreihenfolge der Datenbank — derselbe Code ergab von Lauf zu
        // Lauf ein anderes Bild.
        if (prev === undefined || owner < prev) ownerOfFunction.set(fn, owner);
    }

    const createsRes = await session.run(`
        MATCH (f:Function)-[:INSTANTIATES]->(t:Class)
        RETURN f.name AS fn, f.file AS fnFile, f.owner AS creatorOwner,
               t.name AS target, t.file AS targetFile
    `);
    for (const r of createsRes.records) {
        const from = ownerOfFunction.get(funcKey(val(r, "fn"), val(r, "fnFile"), val(r, "creatorOwner")));
        const to = classKey(val(r, "target"), val(r, "targetFile"));
        if (!from || !classes.has(to)) continue;
        addRelation(from, to, "creates");
    }

    // --- association ---------------------------------------------------------
    // A field whose declared type is another class IS the association UML draws
    // as a solid arrow — `Waypoint.poi: POI` is a has-a, not a call. The builder
    // already writes it as USES_TYPE with role 'field'; read the same edge here
    // rather than re-deriving it, so the diagram and the graph cannot disagree.
    const assocRes = await session.run(`
        MATCH (a:Class)-[e:USES_TYPE]->(b:Class)
        WHERE e.role = 'field'
        RETURN a.name AS aName, a.file AS aFile, b.name AS bName, b.file AS bFile
    `);
    for (const r of assocRes.records) {
        const from = classKey(val(r, "aName"), val(r, "aFile"));
        const to = classKey(val(r, "bName"), val(r, "bFile"));
        if (!classes.has(from) || !classes.has(to)) continue;
        // Inheritance already says more than "holds one of these".
        if (seenRelations.has(`${from}|inherits|${to}`)) continue;
        addRelation(from, to, "association");
    }

    // --- usage ---------------------------------------------------------------
    // Derived from method-level CALLS, joined in JS rather than as a four-hop
    // Cypher pattern: the join is trivial here, and a multi-hop pattern would
    // have to survive the Ladybug Cypher translation intact to be trustworthy.
    if (includeUses) {
        const callRes = await session.run(`
            MATCH (a:Function)-[:CALLS]->(b:Function)
            RETURN a.name AS aName, a.file AS aFile, a.owner AS aOwner,
                   b.name AS bName, b.file AS bFile, b.owner AS bOwner
        `);
        for (const r of callRes.records) {
            const from = ownerOfFunction.get(funcKey(val(r, "aName"), val(r, "aFile"), val(r, "aOwner")));
            const to = ownerOfFunction.get(funcKey(val(r, "bName"), val(r, "bFile"), val(r, "bOwner")));
            if (!from || !to || from === to) continue;
            // One arrow per pair, strongest wins: inheritance says more than
            // creation, creation says more than "calls something in there".
            if (seenRelations.has(`${from}|inherits|${to}`)) continue;
            if (seenRelations.has(`${from}|creates|${to}`)) continue;
            if (seenRelations.has(`${from}|association|${to}`)) continue;
            addRelation(from, to, "uses");
        }
    }

    // --- assembly ------------------------------------------------------------
    let list = [...classes.values()];
    if (onlyConnected) {
        const connected = new Set(relations.flatMap((r) => [r.from, r.to]));
        list = list.filter((c) => connected.has(c.key));
    }
    const keptKeys = new Set(list.map((c) => c.key));
    const keptRelations = relations.filter((r) => keptKeys.has(r.from) && keptKeys.has(r.to));

    list.sort((a, b) => (a.file || "").localeCompare(b.file || "") || a.name.localeCompare(b.name));

    return {
        classes: list,
        relations: keptRelations,
        stats: {
            classes: list.filter((c) => !c.external).length,
            externalBases: list.filter((c) => c.external).length,
            attributes: list.reduce((n, c) => n + c.attributes.length + c.hiddenAttributes, 0),
            methods: list.reduce((n, c) => n + c.methods.length + c.hiddenMethods, 0),
            inheritance: keptRelations.filter((r) => r.kind === "inherits").length,
            creates: keptRelations.filter((r) => r.kind === "creates").length,
            associations: keptRelations.filter((r) => r.kind === "association").length,
            uses: keptRelations.filter((r) => r.kind === "uses").length,
        },
    };
}

module.exports = { readClassModel, classKey, externalBaseKey, funcKey, isTestFile };

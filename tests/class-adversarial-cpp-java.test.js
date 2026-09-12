/**
 * Was das Klassendiagramm aus C, C++ und Java macht — gegen Quelltext, der es
 * überfordern soll.
 *
 * Der Unterschied zu tests/class-inheritance.test.js und
 * tests/class-diagram.test.js: dort wird eine einzelne Query oder ein fertiges
 * Modell geprüft. Hier läuft die ganze Strecke über
 * tests/helpers/class-extract.cjs — echter Quelltext, echte Grammatik, echte
 * Extraktoren, echtes Rendering. Nur so fällt der Fall auf, in dem die Query
 * kompiliert, der Extraktor durchläuft und trotzdem ein leeres Kästchen
 * herauskommt.
 *
 * Jeder Testfall hier hat einmal versagt. Die Kommentare sagen jeweils, WAS im
 * Code steht und WAS stattdessen im Diagramm ankam.
 *
 * Lauf: node --test tests/class-adversarial-cpp-java.test.js
 */

"use strict";

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const {
    diagramFromSource,
    extractFromSource,
    loadLanguage,
    recordingSession,
} = require("./helpers/class-extract.cjs");
const { __testing__ } = require("../scripts/graph_builder.js");

/**
 * Der Klassenkatalog von resolveClassCandidate ist ein Modul-Cache, kein
 * Sitzungszustand. Ohne das Zurücksetzen sieht Datei Nr. 2 noch die Klassen
 * von Datei Nr. 1, löst eine Basis auf eine uid auf, die es in ihrem Graphen
 * nicht gibt, und der Test scheitert an einer Kante ohne Namen statt an der
 * Sache, die er prüfen soll. Der echte Build ruft dasselbe zwischen den
 * Durchläufen auf.
 */
beforeEach(() => __testing__.invalidateClassResolution());

/** Methodennamen einer Klasse, so wie sie im Graphen stehen. */
const methodsOf = (extracted, className) =>
    extracted.functions.filter((fn) => fn.className === className).map((fn) => fn.name).sort();

/** Klassennamen, alphabetisch — die Reihenfolge im Graphen ist Quelltextreihenfolge. */
const classNames = (extracted) => extracted.classes.map((c) => c.name).sort();

/** `Kind->Basis`-Paare, getrennt nach aufgelöst und extern. */
const edges = (extracted) =>
    extracted.inherits.map((r) => `${r.child}->${r.parent}${r.external ? "!" : ""}`).sort();

/** Der Klassenname, den eine Out-of-line-Definition mitbringt (`void A::run()` -> A). */
const scopeOf = (extracted, funcName) =>
    (extracted.funcBounds.find((fb) => fb.name === funcName) || {}).scope ?? null;

describe("C++ reference fields and direct construction", () => {
    it("records a reference data member", async () => {
        const r = await extractFromSource(
            "class Catalog {}; class Checkout { Catalog& catalog_; };\n",
            "checkout.hpp"
        );
        assert.deepEqual(
            r.fields.filter((f) => f.className === "Checkout").map((f) => [f.name, f.declaredType]),
            [["catalog_", "Catalog"]]
        );
    });

    it("captures direct temporary construction as an instantiation candidate", async () => {
        const { config, lang } = await loadLanguage(".cpp");
        const r = await extractFromSource(
            "class Order {}; Order checkout() { return Order(); }\n",
            "checkout.cpp"
        );
        const query = __testing__.safeQuery(lang, config.instantiationQuery);
        assert.ok(query, "C++ instantiation query must compile");
        const names = query.matches(r.tree.rootNode).flatMap((m) => m.captures)
            .filter((c) => c.name === "class_name").map((c) => c.node.text);
        assert.ok(names.includes("Order"), `direct construction missing: ${JSON.stringify(names)}`);
    });
});

// ============================================================
// C++
// ============================================================

describe("C++ — Methoden, die im Header nur deklariert sind", () => {
    it("nimmt deklarierte Member als Methoden der Klasse auf", async () => {
        // Der Normalfall eines C++-Projekts: der Header trägt die Klasse, die
        // Rumpfe stehen in der .cpp. Ein `function_definition` ist eine Methode
        // aber nur MIT Rumpf — deshalb hatte jede Klasse, die man im Header
        // ansieht, exakt null Methoden, und das Diagramm bestand aus leeren
        // Kästchen mit korrekten Namen.
        const r = await diagramFromSource(
            `class AEB {
 public:
  void init();
  bool tick(double dt);
 private:
  int compute() const;
};
`,
            "aeb.hpp"
        );
        assert.deepEqual(methodsOf(r.extracted, "AEB"), ["compute", "init", "tick"]);
        assert.match(r.mermaid, /init\(\)/);
        assert.match(r.mermaid, /tick\(double dt\)/);
    });

    it("unterscheidet einen deklarierten Member von einem Funktionszeiger-Feld", async () => {
        // `int (*cb)(int);` sieht einem Methodenkopf zum Verwechseln aehnlich.
        // Er ist aber ein Datenmember, und ihn als Methode zu führen wäre eine
        // erfundene Struktur.
        const r = await extractFromSource(
            "class A { int (*cb)(int); public: void run(); };\n",
            "a.hpp"
        );
        assert.deepEqual(methodsOf(r, "A"), ["run"]);
    });

    it("erfindet ausserhalb eines Klassenrumpfs keine Methode aus dem Most-Vexing-Parse", async () => {
        // `Widget w(1);` ist syntaktisch nicht von einer Funktionsdeklaration zu
        // unterscheiden. Die Muster für deklarierte Member sind deshalb an
        // field_declaration_list verankert; ohne das entstuende hier eine
        // Funktion namens `w`.
        const r = await extractFromSource(
            "class Widget { public: void run(); };\nvoid setup() { Widget w(1); }\n",
            "a.cpp"
        );
        assert.equal(r.functions.some((fn) => fn.name === "w"), false,
            `aus einer Variablendeklaration wurde eine Funktion: ${JSON.stringify(r.functions.map((f) => f.name))}`);
    });
});

describe("C++ — Konstruktor, Destruktor, Operator", () => {
    it("fuehrt Konstruktor und Destruktor als Methoden der Klasse", async () => {
        // Beide sind in der Grammatik `declaration` statt `field_declaration`
        // (kein Rückgabetyp) und der Destruktorname ist ein eigener Knoten.
        // Vorher: die Klasse zeigte ihre gewoehnlichen Methoden, aber nicht die
        // beiden, die sagen, wie man sie überhaupt bekommt und loswird.
        const r = await diagramFromSource(
            "class Buffer { public: Buffer(); explicit Buffer(int cap); ~Buffer(); void put(int v); };\n",
            "buffer.hpp"
        );
        assert.deepEqual(methodsOf(r.extracted, "Buffer"), ["Buffer", "Buffer", "put", "~Buffer"]);
        // Mermaid verträgt die Tilde in einem Membernamen — geprüft gegen den
        // echten Renderer in tests/class-mermaid-render.test.js.
        assert.match(r.mermaid, /~Buffer\(\)/);
    });

    it("sieht einen defaulted Destruktor", async () => {
        // `virtual ~A() = default;` ist KEINE Deklaration, sondern ein
        // function_definition — die `= default`-Klausel zählt als Rumpf. Es
        // fiel damit durch beide Raster gleichzeitig.
        const r = await extractFromSource(
            "class A { public: A() = default; virtual ~A() = default; };\n",
            "a.hpp"
        );
        assert.deepEqual(methodsOf(r, "A"), ["A", "~A"]);
    });

    it("fuehrt ueberladene Operatoren als Methoden", async () => {
        // `operator=` ist ein operator_name, kein field_identifier. Für eine
        // Klasse mit eigener Ressourcenverwaltung fehlte damit genau die Haelfte
        // ihrer oeffentlichen Schnittstelle.
        const r = await extractFromSource(
            `class A {
 public:
  A& operator=(const A& o);
  bool operator==(const A& o) const;
  int operator[](int i) { return i; }
};
`,
            "a.hpp"
        );
        assert.deepEqual(methodsOf(r, "A"), ["operator=", "operator==", "operator[]"]);
    });

    it("erkennt einen Destruktor auch als Out-of-line-Definition", async () => {
        const r = await extractFromSource("A::A() {}\nA::~A() {}\n", "a.cpp");
        assert.deepEqual(r.functions.map((fn) => fn.name).sort(), ["A", "~A"]);
        assert.equal(scopeOf(r, "~A"), "A");
    });
});

describe("C++ — Out-of-line-Definitionen und Namensraeume", () => {
    /**
     * Header und Implementierung sind ZWEI Dateien, und der Harness parst eine
     * pro Aufruf. Was im echten Build beides zusammenführt, ist
     * linkOutOfLineMethods in scripts/graph_builder.js: es liest den `scope` aus
     * funcBounds und hängt die Funktion per CONTAINS an die aufgelöste Klasse.
     * Der Test prüft deshalb genau die Eingabe, auf die sich dieser Schritt
     * stützt — steht dort kein scope, hat linkOutOfLineMethods nichts, womit es
     * arbeiten könnte.
     */
    it("liefert der .cpp den Klassennamen aus `void Cls::run()` mit", async () => {
        const header = await extractFromSource("class AEB { public: void init(); };\n", "aeb.hpp");
        assert.deepEqual(methodsOf(header, "AEB"), ["init"]);

        const impl = await extractFromSource("void AEB::init() {}\n", "aeb.cpp");
        assert.equal(scopeOf(impl, "init"), "AEB");
    });

    it("findet die Methode auch, wenn die Klasse in einem Namensraum liegt", async () => {
        // `void perception::AEB::init() {}` ist in der Grammatik eine KETTE aus
        // qualified_identifier, kein Knoten mit drei Feldern. Das einstufige
        // Muster passte nicht — und die Funktion landete nicht etwa mit falschem
        // Besitzer im Graphen, sondern gar nicht. Für ein ROS-Paket, das seine
        // Klassen grundsaetzlich in einen Namensraum legt, hiess das: kein
        // einziger Methodenrumpf im Graphen.
        const r = await extractFromSource("void perception::AEB::init() {}\n", "aeb.cpp");
        assert.deepEqual(r.functions.map((fn) => fn.name), ["init"]);
        // Der scope muss die KLASSE sein, nicht der äußere Namensraum — nur
        // die kann resolveClassCandidate auf ein Kästchen abbilden.
        assert.equal(scopeOf(r, "init"), "AEB");
    });

    it("findet sie auch bei zwei Namensraum-Ebenen", async () => {
        const r = await extractFromSource("void a::b::AEB::init() {}\n", "aeb.cpp");
        assert.deepEqual(r.functions.map((fn) => fn.name), ["init"]);
        assert.equal(scopeOf(r, "init"), "AEB");
    });

    it("nimmt eine Definition innerhalb eines `namespace`-Blocks mit", async () => {
        const r = await extractFromSource("namespace ns { void AEB::init() {} }\n", "aeb.cpp");
        assert.equal(scopeOf(r, "init"), "AEB");
    });

    // War eine dokumentierte Grenze: die Schachtelung stand ausgeschrieben da,
    // für zwei und für drei Ebenen, und jede weitere hätte ein weiteres Muster
    // gekostet. Statt eines vierten erfasst die Query jetzt den ganzen
    // qualifizierten Namen und zerlegt ihn — damit gibt es keine Tiefengrenze
    // mehr. Der Test prüft deshalb bis fünf Ebenen: nicht weil fünf vorkommen,
    // sondern weil ein Rückfall auf ausgeschriebene Muster genau daran auffiele.
    it("nimmt eine Definition beliebiger Namensraum-Tiefe mit", async () => {
        for (const src of [
            "void AEB::init() {}\n",
            "void ns::AEB::init() {}\n",
            "void a::b::AEB::init() {}\n",
            "void a::b::c::AEB::init() {}\n",
            "void a::b::c::d::AEB::init() {}\n",
        ]) {
            const r = await extractFromSource(src, "aeb.cpp");
            assert.deepEqual(r.functions.map((fn) => fn.name), ["init"], src.trim());
            assert.equal(scopeOf(r, "init"), "AEB", src.trim());
        }
    });

    // Der Zerlegungsweg darf freie Funktionen nicht einsammeln: ohne `::` gibt
    // es keinen vorletzten Abschnitt, und der Besitzer muss leer bleiben.
    it("laesst eine freie Funktion ohne Besitzer", async () => {
        const r = await extractFromSource("void freie() {}\n", "aeb.cpp");
        assert.deepEqual(r.functions.map((fn) => fn.name), ["freie"]);
        assert.ok(!r.functions[0].owner, "eine freie Funktion darf keiner Klasse zugeordnet werden");
    });

    it("bringt eine Template-Methode ihren Klassennamen mit", async () => {
        const r = await extractFromSource(
            "template<class T> void Box<T>::put(T t) {}\n",
            "box.cpp"
        );
        assert.equal(scopeOf(r, "put"), "Box<T>");
    });
});

describe("C++ — Vererbung", () => {
    it("zeichnet eine Basisklasse MIT Template-Argumenten", async () => {
        // `class C : public Base<int>` ist in der Grammatik ein template_type —
        // weder type_identifier noch qualified_identifier. Die Kante fehlte
        // damit vollständig; das ist keine Vereinfachung wie das Abschneiden
        // der Argumente, sondern ein stiller Totalausfall für jede CRTP-,
        // Policy- oder enable_shared_from_this-Basis.
        const r = await diagramFromSource(
            "class Base {};\nclass C : public Base<int> {};\n",
            "c.hpp"
        );
        assert.deepEqual(edges(r.extracted), ["C->Base"]);
        assert.match(r.mermaid, /<\|--/);
    });

    it("zeichnet die Basis eines Templates", async () => {
        const r = await extractFromSource(
            "template<class T> class Base {};\ntemplate<class T> class Box : public Base<T> { public: void put(T t); };\n",
            "box.hpp"
        );
        assert.deepEqual(edges(r), ["Box->Base"]);
        assert.deepEqual(methodsOf(r, "Box"), ["put"]);
    });

    it("zeichnet eine qualifizierte Template-Basis auf ihren letzten Namensteil", async () => {
        // Bewusste Vereinfachung: `std::enable_shared_from_this<T>` wird zu
        // `enable_shared_from_this`. Ohne das Muster fehlte die Kante ganz.
        const r = await extractFromSource(
            "class Node : public std::enable_shared_from_this<Node> {};\n",
            "node.hpp"
        );
        assert.deepEqual(edges(r), ["Node->enable_shared_from_this!"]);
    });

    it("haelt Mehrfach-, virtuelle und private Vererbung auseinander", async () => {
        // Kein Fund, sondern die Absicherung, dass die neuen Muster die alten
        // nicht verdraengen: die Zugriffsart interessiert das Diagramm nicht,
        // die Zahl der Kanten sehr wohl.
        const r = await extractFromSource(
            `class A {};
class B {};
class C : public A, private B {};
class D : public virtual A {};
struct S : A {};
`,
            "h.hpp"
        );
        assert.deepEqual(edges(r), ["C->A", "C->B", "D->A", "S->A"]);
    });
});

describe("C++/C — was eine Klasse ist und was nur eine Erwaehnung", () => {
    it("macht aus einer Vorwaertsdeklaration keine Klasse", async () => {
        // `class Fwd;` hat keinen Rumpf und damit nichts zu zeigen. Schlimmer
        // als das leere Kästchen war die Nebenwirkung: bei
        // resolveClassCandidate gewann diese lokale Huelle die
        // "same file"-Runde gegen die echte Klasse in der Nachbardatei.
        const r = await extractFromSource(
            "class Fwd;\nclass Real { public: void go(); };\n",
            "a.hpp"
        );
        assert.deepEqual(classNames(r), ["Real"]);
    });

    it("laesst den Zeilenbereich einer Struktur von einem Selbstbezug unangetastet", async () => {
        // `struct Node* next;` IST in der Grammatik ein struct_specifier. Weil
        // extractClasses bei jedem Treffer `SET cls.startLine/endLine` schreibt,
        // überschrieb die Erwähnung im Feld den echten Bereich: die Klasse
        // Node stand im Graphen als Zeile 2 bis 2 — also auf ihrem eigenen Feld.
        const r = await extractFromSource("struct Node {\n  struct Node* next;\n};\n", "n.c");
        assert.deepEqual(r.classes.map((c) => [c.name, c.startLine, c.endLine]), [["Node", 1, 3]]);
    });

    it("macht aus einem Parametertyp keine Klasse", async () => {
        const r = await extractFromSource("void f(struct Foo* p);\nstruct Bar;\n", "f.c");
        assert.deepEqual(classNames(r), []);
    });

    it("benennt eine anonyme typedef-Struktur nach ihrem direkten Alias", async () => {
        // The alias supplies the name, while the anonymous struct supplies
        // the bounds. Named structs keep their existing, single query path.
        const r = await extractFromSource("typedef struct { int y; } Named;\n", "n.c");
        assert.deepEqual(classNames(r), ["Named"]);
    });

    it("gibt einem definierten C++-Enum einen Typknoten", async () => {
        // Values and enumeration stereotypes are covered end-to-end in
        // class-parser-release-gaps.test.js; a forward declaration stays out.
        const r = await extractFromSource("enum class Mode { Fast, Slow };\n", "m.hpp");
        assert.deepEqual(classNames(r), ["Mode"]);
    });
});

// ============================================================
// Attribute — das zweite Fach des Klassenkästchens
// ============================================================

/**
 * extractAllVariables schreibt die Attribute; der Harness ruft ihn nicht auf,
 * weil er nur Klassen, Funktionen und Vererbung mitschreibt. Hier wird er mit
 * denselben Bausteinen zusätzlich gefahren — nicht nachgebaut, sondern
 * dieselbe exportierte Funktion, die der Build benutzt.
 *
 * Die Besitzkante steht in einer eigenen Anweisung (`MERGE (cls)-[:DECLARES]->`),
 * die der Mitschnitt unter `other` ablegt. Sie wird hier zurückgelesen, damit
 * der Test nicht nur "ein Feld existiert" sagt, sondern "dieses Feld gehört
 * dieser Klasse".
 */
async function fieldsOf(source, file) {
    const ext = "." + file.split(".").pop();
    const { config, lang } = await loadLanguage(ext);
    const { Parser } = require("web-tree-sitter");
    const parser = new Parser();
    parser.setLanguage(lang);
    const tree = parser.parse(source);

    const cached = { lang };
    for (const key of Object.keys(config)) {
        if (key.endsWith("Query")) cached[key] = config[key] ? __testing__.safeQuery(lang, config[key]) : null;
    }

    const graphMod = { int: (n) => ({ __int: n, toNumber: () => Number(n) }) };
    const session = recordingSession();
    const classBounds = await __testing__.extractClasses(session, cached, tree, file, graphMod);
    const funcBounds = await __testing__.extractFunctions(session, cached, tree, file, graphMod, classBounds);
    await __testing__.extractAllVariables(session, cached, tree, file, funcBounds, classBounds);

    // Der Mitschnitt kürzt den Cypher-Text auf 120 Zeichen, das `MERGE
    // (cls)-[:DECLARES]->(v)` am Ende ist darin nicht mehr enthalten — die
    // Anweisung wird deshalb an ihren Parametern erkannt. elementId ist
    // `name:zeile:spalte`; der Name davor genuegt, weil kein Testfall denselben
    // Feldnamen zweimal vergibt.
    const owners = new Map();
    for (const row of session.graph.other) {
        if (row.params.className && row.params.elementId) {
            owners.set(String(row.params.elementId).split(":")[0], row.params.className);
        }
    }
    return session.graph.fields.map((f) => ({
        name: f.name,
        declaredType: f.declaredType,
        className: f.className ?? owners.get(f.name) ?? null,
    }));
}

describe("C/C++ — Attribute", () => {
    it("nimmt die Datenmember einer C++-Klasse auf", async () => {
        // Ein Member ist eine `field_declaration` mit `field_identifier`, kein
        // init_declarator und kein identifier — die Variablen-Query kannte nur
        // die beiden letzteren. Ergebnis: JEDE C- und C++-Klasse hatte null
        // Attribute, während Java über variable_declarator hereinkam. Das
        // Diagramm zeigte damit Methodenlisten ohne jeden Zustand.
        const fields = await fieldsOf(
            `class Tracker {
  int count_;
  double gain_ = 1.0;
  std::string name_;
  int buffer_[8];
  Node* head_;
};
`,
            "tracker.hpp"
        );
        assert.deepEqual(fields.map((f) => f.name).sort(),
            ["buffer_", "count_", "gain_", "head_", "name_"]);
        // Der deklarierte Typ ist das, was das Attributfach lesbar macht.
        const byName = Object.fromEntries(fields.map((f) => [f.name, f.declaredType]));
        assert.equal(byName.count_, "int");
        assert.equal(byName.name_, "std::string");
        assert.equal(byName.head_, "Node");
    });

    it("macht aus einem C-Struct mit Funktionszeigern Felder, keine Methoden", async () => {
        // Die Frage, die sich bei reinem C stellt: `int (*init)(void);` ist die
        // C-Schreibweise für eine vtable. Syntaktisch ist es aber ein
        // Datenmember, und ohne Datenflussanalyse ist alles andere geraten.
        // Vorher war es weder das eine noch das andere: die Struktur, die aus
        // nichts als Feldern besteht, war ein vollständig leeres Kästchen.
        const src = `struct Ops {
  int (*init)(void);
  void (*shutdown)(int code);
  int flags;
  struct Node* next;
  char name[8];
};
`;
        const fields = await fieldsOf(src, "ops.c");
        assert.deepEqual(fields.map((f) => f.name).sort(),
            ["flags", "init", "name", "next", "shutdown"]);

        const r = await extractFromSource(src, "ops.c");
        assert.deepEqual(methodsOf(r, "Ops"), [],
            "ein Funktionszeiger-Feld darf keine Methode erfinden");
    });

    it("haengt die Felder an ihre Klasse", async () => {
        const fields = await fieldsOf("struct P { int x; int y; };\n", "p.c");
        assert.deepEqual([...new Set(fields.map((f) => f.className))], ["P"]);
    });
});

// ============================================================
// Java
// ============================================================

describe("Java — Interfaces", () => {
    it("gibt einem Interface ein eigenes Kaestchen samt Methoden", async () => {
        // Ein `interface` ist eine eigene Deklarationsart, die classQuery kannte
        // nur class_declaration. Die Interface-Methoden hingen als freie
        // Funktionen in der Datei, und das Interface selbst hatte kein Kästchen
        // — obwohl es in einem UML-Klassendiagramm der zentrale Kasten ist.
        const r = await diagramFromSource(
            "interface Runner { void run(); void stop(); }\n",
            "Runner.java"
        );
        assert.deepEqual(classNames(r.extracted), ["Runner"]);
        assert.deepEqual(methodsOf(r.extracted, "Runner"), ["run", "stop"]);
    });

    it("loest `implements` auf ein Interface DERSELBEN Datei auf", async () => {
        // Weil das Interface kein Class-Knoten war, fand resolveClassCandidate
        // nichts und schrieb eine ExternalBase: das Diagramm zeichnete `Runner`
        // als leeres <<external>>-Kästchen, obwohl es zehn Zeilen weiter oben
        // mit vollem Inhalt stand.
        const r = await diagramFromSource(
            "interface Runner { void run(); }\nclass Job implements Runner { public void run() {} }\n",
            "Job.java"
        );
        assert.deepEqual(edges(r.extracted), ["Job->Runner"]);
        assert.equal(r.mermaid.includes("<<external>>"), false,
            `ein Interface derselben Datei darf nicht extern sein:\n${r.mermaid}`);
    });

    it("zeichnet beide Interfaces bei `implements A, B`", async () => {
        const r = await extractFromSource(
            "interface A {}\ninterface B {}\nclass C implements A, B {}\n",
            "C.java"
        );
        assert.deepEqual(edges(r), ["C->A", "C->B"]);
    });

    it("zeichnet `interface B extends A`", async () => {
        // Die Interface-Hierarchie hatte null Kanten: `extends_interfaces` hängt
        // an interface_declaration und trägt anders als `super_interfaces`
        // keinen Feldnamen.
        const r = await extractFromSource(
            "interface A { void a(); }\ninterface B extends A { void b(); }\n",
            "B.java"
        );
        assert.deepEqual(edges(r), ["B->A"]);
    });
});

describe("Java — record, enum, Konstruktoren", () => {
    it("gibt einem Record ein Kaestchen mit seinen Methoden", async () => {
        // Vorher: kein Kästchen, und `sum` hing besitzerlos in der Datei.
        const r = await diagramFromSource(
            "record Point(int x, int y) { int sum() { return x + y; } }\n",
            "Point.java"
        );
        assert.deepEqual(classNames(r.extracted), ["Point"]);
        assert.deepEqual(methodsOf(r.extracted, "Point"), ["sum"]);
    });

    it("gibt einem Enum mit Rumpf ein Kaestchen", async () => {
        const r = await extractFromSource(
            "enum Color { RED, GREEN; String label() { return name(); } }\n",
            "Color.java"
        );
        assert.deepEqual(classNames(r), ["Color"]);
        assert.deepEqual(methodsOf(r, "Color"), ["label"]);
    });

    it("zeichnet `enum E implements I`", async () => {
        const r = await extractFromSource(
            "interface I { }\nenum E implements I { A, B }\n",
            "E.java"
        );
        assert.deepEqual(edges(r), ["E->I"]);
    });

    it("fuehrt Konstruktoren als Methoden", async () => {
        // Ein Konstruktor ist eine constructor_declaration, keine
        // method_declaration. Im Diagramm fehlte damit genau die Zeile, die
        // sagt, wie man an ein Objekt der Klasse kommt.
        const r = await diagramFromSource(
            "class Job { Job() {} Job(int id) {} void run() {} }\n",
            "Job.java"
        );
        assert.deepEqual(methodsOf(r.extracted, "Job"), ["Job", "Job", "run"]);
        // Im Kästchen steht der Konstruktor einmal, nicht zweimal: die
        // Identitaet eines Function-Knotens ist {name, file}, Überladungen
        // fallen im Graphen zusammen. Das ist eine Grenze des Modells, keine der
        // Sprachkonfiguration — vorher fehlte die Zeile ganz.
        assert.match(r.mermaid, /C\d+ : Job\(\)/);
    });
});

describe("Java — verschachtelte und generische Faelle", () => {
    it("haelt die Methode einer anonymen Klasse von der aeusseren Klasse fern", async () => {
        // Die anonyme Klasse liegt im Byte-Bereich von `Job`. Nur weil zwischen
        // ihr und der Klasse eine Methode steht, wird sie nicht als Member von
        // Job geführt — sonst hätte Job zwei Methoden namens `run`.
        const r = await extractFromSource(
            "class Job { void start() { Runnable r = new Runnable() { public void run() {} }; } }\n",
            "Job.java"
        );
        assert.deepEqual(methodsOf(r, "Job"), ["start"]);
    });

    it("gibt der inneren Klasse ihre eigenen Methoden", async () => {
        const r = await extractFromSource(
            "class Outer { class Inner { void go() {} } void run() {} }\n",
            "Outer.java"
        );
        assert.deepEqual(classNames(r), ["Inner", "Outer"]);
        assert.deepEqual(methodsOf(r, "Inner"), ["go"]);
        assert.deepEqual(methodsOf(r, "Outer"), ["run"]);
    });

    it("loest eine generische Basis auf ihren Rohtyp auf", async () => {
        // Bewusste Vereinfachung: die Typargumente werden abgeschnitten. Der
        // Test hält fest, dass daraus eine ECHTE Kante wird und nicht bloss
        // eine externe Huelle.
        const r = await extractFromSource(
            "class Repo<T> {}\nclass JobRepo extends Repo<Job> {}\n",
            "JobRepo.java"
        );
        assert.deepEqual(edges(r), ["JobRepo->Repo"]);
    });

    it("bleibt bei einer Basis aus einem fremden Paket extern", async () => {
        // Die Gegenprobe zum Interface-Fall: was hier nicht steht, darf auch
        // nicht erfunden werden.
        const r = await extractFromSource(
            "class Job implements java.lang.Runnable { public void run() {} }\n",
            "Job.java"
        );
        assert.deepEqual(edges(r), ["Job->Runnable!"]);
    });
});

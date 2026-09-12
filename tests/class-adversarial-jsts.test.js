/**
 * Was JavaScript und TypeScript an der Klassendiagramm-Strecke vorbeischmuggeln.
 *
 * class-inheritance.test.js prüft eine einzelne Query gegen die echte
 * Grammatik, class-diagram.test.js und class-attributes.test.js prüfen Modell
 * und Renderer gegen fertige Zeilen. Beide Enden können grün sein, während
 * dazwischen eine ganze Klassenart verlorengeht: der Extraktor fragt nach einer
 * Knotenart, die die Grammatik für diesen Quelltext gar nicht vergibt, schreibt
 * folglich nichts, und das Diagramm zeigt ein aufgeräumtes Bild von der Haelfte
 * des Codes. Genau das war hier für `abstract class`, `interface` und jeden
 * Klassen-Ausdruck der Fall.
 *
 * Deshalb läuft hier die ganze Strecke über tests/helpers/class-extract.cjs:
 * Quelltext -> echte Grammatik -> echte Extraktoren -> Modell -> Diagramm. Ein
 * Test fällt hier nur dann um, wenn im Diagramm wirklich etwas fehlt.
 *
 * Die als `todo` markierten Fälle sind belegte Lücken, keine vergessenen
 * Tests: sie stehen dort mit dem Grund, warum sie sich NICHT über die
 * Sprach-Queries schließen lassen.
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { extractFromSource, diagramFromSource } = require('./helpers/class-extract.cjs');
const { __testing__ } = require('../scripts/graph_builder.js');

// Der Klassenkatalog des Builders ist ein modul-globaler Cache (graph_builder.js,
// `classCatalogCache`). Ohne das Zurücksetzen saehe der zweite Test die Klassen
// des ersten, und `extends B` löste sich gegen eine Klasse aus einer völlig
// fremden Datei auf — jede Aussage über "aufgelöst oder extern" wäre Zufall.
beforeEach(() => __testing__.invalidateClassResolution());

/** Namen der geschriebenen Klassenknoten, sortiert. */
const classNames = (extracted) => extracted.classes.map((c) => c.name).sort();

/** `Kind<-Basis`, ein `?` markiert eine nicht aufgelöste (externe) Basis. */
const edges = (extracted) =>
    extracted.inherits.map((i) => `${i.child}<-${i.parent}${i.external ? '?' : ''}`).sort();

/** Methodennamen, die im Graphen wirklich AN dieser Klasse hängen. */
const methodsOf = (extracted, className) =>
    extracted.functions.filter((f) => f.className === className).map((f) => f.name);

describe('JS/TS — Klassen, die keine class_declaration sind', () => {
    it('.js — ein Klassen-Ausdruck ist eine Klasse, samt Basis', async () => {
        // `const Store = class extends Base {}` ist die Fabrik-Schreibweise, mit
        // der jede zweite Bibliothek ihre Klassen exportiert. Die Grammatik
        // vergibt dafür `class`, nicht `class_declaration` — vorher stand im
        // Diagramm weder der Kasten noch der Pfeil, und ein Leser schloss daraus,
        // es gebe keine Ableitung von Base.
        const r = await extractFromSource(
            'const Store = class extends Base { }\nclass Base { }\n',
            'store.js'
        );

        assert.deepStrictEqual(classNames(r), ['Base', 'Store']);
        assert.deepStrictEqual(edges(r), ['Store<-Base'], 'aufgeloest, nicht extern');
        assert.deepStrictEqual(r.other, [], 'der Mitschnitt hat nichts uebersehen');
    });

    it('.js — eine benannte Klasse im Ausdruck heisst wie sie selbst, und zwar einmal', async () => {
        // Bei `const A = class Inner extends B {}` gibt es zwei Kandidaten für
        // den Namen. Beide zu nehmen erzeugte aus einer Klasse zwei Kaesten mit
        // je einem halben Pfeil. Der `!name`-Zweig der Query greift nur für die
        // anonyme Form, deshalb gewinnt hier der Name der Klasse selbst.
        const r = await extractFromSource(
            'const A = class Inner extends B { }\nclass B { }\n',
            'a.js'
        );

        assert.deepStrictEqual(classNames(r), ['B', 'Inner']);
        assert.deepStrictEqual(edges(r), ['Inner<-B']);
    });

    it('.ts — abstract class ist eine eigene Knotenart und war komplett unsichtbar', async () => {
        // `abstract class` parst als abstract_class_declaration. Solange nur
        // class_declaration abgefragt wurde, fehlte in einer typischen
        // TS-Hierarchie ausgerechnet die Klasse, an der alles hängt: kein
        // Kasten, keine extends-Kante, keine implements-Kante, und ihre
        // Methoden hingen an gar keiner Klasse.
        const r = await extractFromSource(
            'abstract class Repo extends Base implements Store {\n'
            + '  abstract find(id: string): Item;\n'
            + '  all(): Item[] { return []; }\n'
            + '}\n'
            + 'class Base { }\n'
            + 'interface Store { find(id: string): Item; }\n',
            'repo.ts'
        );

        assert.ok(classNames(r).includes('Repo'), 'die abstrakte Klasse steht im Graphen');
        assert.deepStrictEqual(edges(r), ['Repo<-Base', 'Repo<-Store']);
        assert.deepStrictEqual(
            methodsOf(r, 'Repo').sort(),
            ['all', 'find'],
            'auch die abstrakte Methode ohne Rumpf gehoert der Klasse'
        );
    });

    it('.ts — ein interface ist ein Kasten mit Methoden, kein Nichts', async () => {
        // Das Modell zeichnet `implements` schon lange als Vererbung. Solange
        // aber kein interface_declaration erfasst wurde, zeigte dieser Pfeil auf
        // ein leeres <<external>>-Kästchen — obwohl das Interface drei Zeilen
        // tiefer in derselben Datei stand.
        const r = await extractFromSource(
            'interface Store {\n  find(id: string): Item;\n  all(): Item[];\n}\n'
            + 'class SqlStore implements Store { }\n',
            'store.ts'
        );

        assert.deepStrictEqual(classNames(r), ['SqlStore', 'Store']);
        assert.deepStrictEqual(methodsOf(r, 'Store').sort(), ['all', 'find']);
        assert.deepStrictEqual(
            edges(r),
            ['SqlStore<-Store'],
            'die Basis ist aufgeloest — ohne den Interface-Knoten waere sie extern'
        );
    });

    it('.ts — interface extends interface haengt an keiner class_heritage', async () => {
        // Eine Schnittstellen-Hierarchie steht unter `extends_type_clause`, nicht
        // unter `class_heritage`. Sie fehlte deshalb vollständig, während die
        // implements-Kante daneben gezeichnet wurde.
        const r = await extractFromSource(
            'interface Shape { area(): number; }\n'
            + 'interface Square extends Shape, ns.Tagged { side: number; }\n',
            'shapes.ts'
        );

        assert.deepStrictEqual(
            edges(r),
            ['Square<-Shape', 'Square<-Tagged?'],
            'die lokale Basis aufgeloest, die importierte als externe Basis'
        );
    });

    it('.ts — enum und type alias bleiben draussen', async () => {
        // Gegenprobe zur Interface-Erweiterung: der Klassenbegriff soll sich
        // nicht auf alles ausdehnen, was in TypeScript einen Typnamen bindet.
        const r = await extractFromSource(
            'enum Colour { Red, Green }\ntype Point = { x: number };\n',
            'types.ts'
        );

        assert.deepStrictEqual(classNames(r), []);
    });
});

describe('JS/TS — Basisklassen, die nicht dastehen wo die Query suchte', () => {
    it('.js — eine Mixin-Fabrik erbt von ihren Argumenten, nicht von der Fabrik', async () => {
        // `class A extends mixin(B, C)` ist der übliche Weg, in JS mehrfach zu
        // erben. Vorher entstand gar keine Kante. Der Fabrikname `mixin` ist
        // bewusst NICHT die Basis: geerbt wird von B und C.
        const r = await extractFromSource(
            'class A extends mixin(B, C) { }\nclass B { }\nclass C { }\n',
            'mix.js'
        );

        assert.deepStrictEqual(edges(r), ['A<-B', 'A<-C']);
        assert.ok(!edges(r).some((e) => e.includes('mixin')), 'die Fabrik ist keine Basisklasse');
    });

    it('.js — eine Fabrik ohne Klassenargumente erfindet keine Basis', async () => {
        // Die Kehrseite derselben Regel: `extends makeBase({ … })` nennt keine
        // Klasse, also darf auch keine im Diagramm auftauchen. Lieber keine Kante
        // als eine geratene.
        const r = await extractFromSource('class A extends makeBase({ x: 1 }) { }\n', 'mix.js');

        assert.deepStrictEqual(classNames(r), ['A']);
        assert.deepStrictEqual(edges(r), []);
    });

    it('.js — eine geklammerte Basis ist immer noch eine Basis', async () => {
        const r = await extractFromSource('class A extends (B) { }\nclass B { }\n', 'paren.js');

        assert.deepStrictEqual(edges(r), ['A<-B']);
    });

    it('.ts — abstract class erbt auch ueber eine Mixin-Fabrik', async () => {
        const r = await extractFromSource(
            'abstract class A extends mixin(B, C) { }\nclass B { }\nclass C { }\n',
            'mix.ts'
        );

        assert.deepStrictEqual(edges(r), ['A<-B', 'A<-C']);
    });

    it('.ts — implements mit qualifiziertem Namen ging verloren', async () => {
        // `implements ns.I` steht als nested_type_identifier da. Ohne die
        // Alternative bekam die unqualifizierte Schnittstelle daneben eine Kante
        // und die qualifizierte keine — im selben Kopf derselben Klasse.
        const r = await extractFromSource(
            'class A implements Local, ns.Remote { }\ninterface Local { }\n',
            'impl.ts'
        );

        assert.deepStrictEqual(edges(r), ['A<-Local', 'A<-Remote?']);
    });

    it('.js/.ts — der bekannte Baseline-Fall bleibt wie er war', async () => {
        // Absicherung gegen die neuen Query-Muster: sie dürfen den einfachen
        // Fall weder verdoppeln noch verschieben.
        const js = await extractFromSource(
            'class A extends B { }\nclass C extends ns.D { }\nclass Plain { }\n',
            'base.js'
        );
        assert.deepStrictEqual(edges(js), ['A<-B?', 'C<-D?']);
        assert.deepStrictEqual(classNames(js), ['A', 'C', 'Plain']);

        __testing__.invalidateClassResolution();
        const tsx = await extractFromSource(
            'class Widget extends React.Component implements Renderable { }\n',
            'w.tsx'
        );
        // React.Component wird bewusst auf den letzten Namensteil gekürzt
        // (graph_builder.js, extractClassInheritance).
        assert.deepStrictEqual(edges(tsx), ['Widget<-Component?', 'Widget<-Renderable?']);
    });
});

describe('JS/TS — Methoden, deren Name nicht dort steht wo die Query suchte', () => {
    it('.js — eine #private-Methode fehlte komplett', async () => {
        // Der Name trägt (private_property_identifier), nicht
        // (property_identifier). Die Klasse zeigte deshalb nur ihre
        // oeffentliche Haelfte — und `jsTsFunctionSemantics`' Regel
        // "Name beginnt mit # => private" konnte nie greifen, weil kein solcher
        // Name je bis dorthin kam.
        const r = await extractFromSource(
            'class A {\n  #secret = 1;\n  #hidden() { return this.#secret; }\n  pub() { }\n}\n',
            'a.js'
        );

        assert.deepStrictEqual(methodsOf(r, 'A').sort(), ['#hidden', 'pub']);
    });

    it('.ts — dasselbe fuer TypeScript', async () => {
        const r = await extractFromSource(
            'class A {\n  #hidden(): number { return 1; }\n  pub(): void { }\n}\n',
            'a.ts'
        );

        assert.deepStrictEqual(methodsOf(r, 'A').sort(), ['#hidden', 'pub']);
    });

    it('.js — ein Symbol-Methodenname kommt ohne Klammern an', async () => {
        // `[Symbol.iterator]()` steht in einem computed_property_name. Erfasst
        // wird dessen Inhalt: hiesse die Methode "[Symbol.iterator]", stuenden
        // die eckigen Klammern im Diagrammkasten.
        const r = await extractFromSource(
            'class A {\n  [Symbol.iterator]() { }\n  static [Symbol.hasInstance](x) { }\n}\n',
            'a.js'
        );

        assert.deepStrictEqual(
            methodsOf(r, 'A').sort(),
            ['Symbol.hasInstance', 'Symbol.iterator']
        );
    });

    it('.js — ein berechneter Name ohne feste Bedeutung bleibt draussen', async () => {
        // `['dyn' + suffix]()` hat zur Analysezeit keinen Namen. Ein erfundener
        // wäre schlechter als keiner.
        const r = await extractFromSource(
            "class A {\n  ['dyn' + suffix]() { }\n  fest() { }\n}\n",
            'a.js'
        );

        assert.deepStrictEqual(methodsOf(r, 'A'), ['fest']);
    });

    it('.ts — der Rueckgabetyp brachte seinen eigenen Doppelpunkt mit', async () => {
        // Ohne @return_type-Capture fiel extractFunctions auf
        // childForFieldName('return_type') zurück; dessen Text ist die
        // type_annotation INKLUSIVE Doppelpunkt. Die Signatur wurde daraus zu
        // `find(id: string): : Item` — im PlantUML-Kasten sichtbar, in Mermaid
        // nur deshalb nicht, weil der Renderer Doppelpunkte ohnehin entfernt.
        const r = await diagramFromSource(
            'class Repo {\n  find(id: string): Item { return null; }\n}\n',
            'repo.ts'
        );

        const method = r.model.classes[0].methods[0];
        assert.strictEqual(method.signature, 'find(id: string): Item');
        assert.ok(!r.plantuml.includes(': :'), 'kein doppelter Doppelpunkt im Diagramm');
    });

    it('.ts — eine Signatur ohne Rueckgabetyp bleibt ohne Anhaengsel', async () => {
        // Gegenprobe: der optionale Capture darf die Methode nicht verschlucken.
        const r = await extractFromSource('class A {\n  go(x: number) { }\n}\n', 'a.ts');

        assert.deepStrictEqual(methodsOf(r, 'A'), ['go']);
        assert.strictEqual(r.functions[0].signature, 'go(x: number)');
    });

    it('.js — ein statischer Block ist keine Methode', async () => {
        // Gegenprobe zu den neuen method_definition-Alternativen: ein
        // class_static_block trägt keinen Namen und darf keinen erfinden.
        const r = await extractFromSource('class A {\n  static { A.x = 1; }\n}\n', 'a.js');

        assert.deepStrictEqual(classNames(r), ['A']);
        assert.deepStrictEqual(methodsOf(r, 'A'), []);
    });
});

describe('JS/TS — das gerenderte Diagramm', () => {
    it('.ts — abstrakte Basis, Interface und Implementierung stehen als eine Hierarchie da', async () => {
        const r = await diagramFromSource(
            'interface Store { find(id: string): Item; }\n'
            + 'abstract class Repo implements Store {\n'
            + '  abstract find(id: string): Item;\n'
            + '}\n'
            + 'class SqlRepo extends Repo {\n'
            + '  find(id: string): Item { return null; }\n'
            + '}\n',
            'repo.ts'
        );

        assert.deepStrictEqual(
            r.model.classes.map((c) => c.name).sort(),
            ['Repo', 'SqlRepo', 'Store'],
            'drei Kaesten — vorher war nur SqlRepo darunter'
        );
        assert.strictEqual(r.model.stats.inheritance, 2);
        assert.ok(!r.model.classes.some((c) => c.external), 'nichts landet als <<external>>');
        // Mermaid zeichnet Vererbung als `Basis <|-- Kind`.
        assert.strictEqual((r.mermaid.match(/<\|--/g) || []).length, 2);
    });

    it('.js — die Klasse aus dem Ausdruck erscheint im Diagramm', async () => {
        const r = await diagramFromSource(
            'const Store = class extends Base { }\nclass Base { }\n',
            'store.js'
        );

        assert.ok(r.mermaid.includes('"Store"'), 'der Kasten steht da');
        assert.ok(r.mermaid.includes('<|--'), 'und der Vererbungspfeil auch');
    });
});

describe('JS/TS — belegte Luecken', () => {
    it('.js — eine anonyme Default-Export-Klasse bekommt den Dateinamen', async () => {
        const r = await extractFromSource('export default class extends B {\n  run() { }\n}\n', 'a.js');

        assert.deepStrictEqual(classNames(r), ['a']);
    });

    // War eine belegte Lücke: der Aufstieg traf `lexical_declaration` (ein
    // FUNCTION_CONTAINER_TYPE), bevor er den `class`-Knoten erreichte, und
    // verwarf die Methode als verschachtelte Funktion. Der Kasten stand im
    // Diagramm und war leer. `class` steht jetzt in CLASS_CONTAINER_TYPES.
    it('.js — Methoden eines Klassen-Ausdrucks haengen an ihrer Klasse', async () => {
        const r = await extractFromSource('const A = class extends B {\n  run() { }\n}\n', 'a.js');

        assert.deepStrictEqual(methodsOf(r, 'A'), ['run']);
    });

    // Der teuerste der Fälle: `export_statement` steht in
    // FUNCTION_CONTAINER_TYPES, während `abstract_class_declaration` und
    // `interface_declaration` in CLASS_CONTAINER_TYPES fehlten. Ohne `export`
    // funktionierte dieselbe Deklaration, was den Fehler wie ein Problem mit
    // Interfaces aussehen liess statt wie eines mit dem Aufstieg — und in
    // echtem TypeScript ist praktisch jedes Interface exportiert.
    it('.ts — `export abstract class` und `export interface` behalten ihre Methoden', async () => {
        const r = await extractFromSource(
            'export abstract class A { m(): void { } }\nexport interface I { n(): void; }\n',
            'a.ts'
        );

        assert.deepStrictEqual(methodsOf(r, 'A'), ['m']);
        assert.deepStrictEqual(methodsOf(r, 'I'), ['n']);
    });

    // War doppelt blockiert: die Query erfasste das Muster nicht, und selbst mit
    // Treffer wäre der Kasten leer geblieben, weil `pair` in
    // FUNCTION_CONTAINER_TYPES steht. Seit `class` eine Klassengrenze ist,
    // stoppt der Aufstieg dort, bevor er `pair` erreicht.
    it('.js — ein Klassen-Ausdruck als Objekteigenschaft bekommt Kasten und Methoden', async () => {
        const r = await extractFromSource(
            'const ns = { A: class extends B { run() { } } };\nclass B { }\n',
            'a.js'
        );

        assert.deepStrictEqual(classNames(r), ['A', 'B']);
        assert.deepStrictEqual(methodsOf(r, 'A'), ['run']);
    });

    // Der Extraktor schreibt korrekt drei Function-Knoten — die Grammatik sieht
    // drei Definitionen. Für den Leser ist es eine Methode, und drei
    // identische Zeilen verdraengten unter maxMethods echte andere. Das
    // Zusammenfassen gehört deshalb ins Modell, nicht in die Query.
    it('.ts — ueberladene Signaturen ergeben eine Zeile, nicht drei', async () => {
        const r = await diagramFromSource(
            'class A {\n'
            + '  run(x: string): string;\n'
            + '  run(x: number): number;\n'
            + '  run(x: any): any { return x; }\n'
            + '}\n',
            'a.ts'
        );

        assert.strictEqual(r.model.classes[0].methods.length, 1);
    });

    // Nicht "sieht haesslich aus", sondern falsch herum: Mermaid liest ein
    // führendes `#` als protected, also "von Unterklassen erreichbar" — das
    // Gegenteil dessen, was ein `#`-Member in JavaScript ist. Übersetzt wird
    // in Mermaids Zeichen für privat, der Name bleibt unangetastet.
    it('.js — eine #private Methode wird als privat gezeichnet, nicht als protected', async () => {
        const r = await diagramFromSource('class A {\n  #hidden() { }\n}\n', 'a.js');

        const member = r.mermaid.split('\n').find((l) => l.includes('hidden'));
        assert.ok(member, 'die private Methode fehlt ganz');
        assert.ok(!/:\s*#/.test(member), `Mermaid liest das # als protected: ${member}`);
        assert.match(member, /:\s*-hidden/, `erwartet Mermaids privat-Zeichen: ${member}`);
    });

    it('.ts — accessor und normale Felder erscheinen als Attribute', async () => {
        const r = await diagramFromSource(
            'class A {\n  accessor count = 0;\n  plain = 1;\n}\n',
            'a.ts'
        );

        assert.deepStrictEqual(
            r.model.classes[0].attributes.map((a) => a.name).sort(),
            ['count', 'plain']
        );
        assert.equal(r.extracted.parseError, false);
    });
});

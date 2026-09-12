#!/usr/bin/env node
/**
 * Tests für scripts/spec/puml_blocks.js und seine Wirkung in allen vier
 * Parsern.
 *
 * Der Fehler, den diese Tests festhalten, kracht nie: PlantUML-Bloecke ohne
 * Diagramminhalt (note, legend, skinparam { }) wurden nur in ihrer KOPFZEILE
 * übersprungen, der Rumpf lief in die Inhaltsregeln. Weil die tolerant sind,
 * entstanden daraus Knoten und Beziehungen, die niemand geschrieben hat — und
 * die wandern weiter in Bindungen, Reconcile und Epics.
 *
 * Die Fixtures sind deshalb genau die Formen, die das ausgelöst haben:
 * ein skinparam-Block mit `<<…>>` (liest sich wie ein Pfeil) und eine Note mit
 * einem Pfeil und einem `Wort: Text` im Rumpf.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { createBlockSkipper } = require("../scripts/spec/puml_blocks.js");
const { parsePumlClass } = require("../scripts/spec/puml_class_parser.js");
const { parsePumlUseCase } = require("../scripts/spec/puml_usecase_parser.js");
const { parseWsd } = require("../scripts/spec/wsd_parser.js");
const { parsePumlActivity } = require("../scripts/spec/puml_activity_parser.js");

describe("createBlockSkipper", () => {
    it("ueberspringt einen Note-Block samt Rumpf", () => {
        const skip = createBlockSkipper();
        assert.equal(skip("note over A, B"), true);
        assert.equal(skip("A -> B im Fliesstext"), true);
        assert.equal(skip("Signed: negative == penetration"), true);
        assert.equal(skip("end note"), true);
        assert.equal(skip("A -> B : echt()"), false, "danach geht es normal weiter");
    });

    it("laesst einzeilige Notes in Ruhe — sie duerfen keinen Block oeffnen", () => {
        const skip = createBlockSkipper();
        assert.equal(skip("note left of A : hi"), true, "die Zeile selbst ist trotzdem kein Inhalt");
        assert.equal(skip("A -> B : run()"), false, "kein Block offen");

        const skip2 = createBlockSkipper();
        assert.equal(skip2('note "Freitext" as N1'), true);
        assert.equal(skip2("A -> B : run()"), false, "auch die as-Form oeffnet keinen Block");
    });

    it("zaehlt Klammern in skinparam-Bloecken", () => {
        const skip = createBlockSkipper();
        assert.equal(skip("skinparam usecase {"), true);
        assert.equal(skip("BackgroundColor<<done>> #C8E6C9"), true);
        assert.equal(skip("}"), true);
        assert.equal(skip("usecase \"Echt\" as UC1"), false);
    });

    it("skinparam als Einzeiler bleibt ein Einzeiler", () => {
        const skip = createBlockSkipper();
        assert.equal(skip("skinparam monochrome true"), true);
        assert.equal(skip("class Foo {"), false, "kein Block offen geblieben");
    });

    it("legend … end legend", () => {
        const skip = createBlockSkipper();
        assert.equal(skip("legend right"), true);
        assert.equal(skip("gruen = fertig"), true);
        assert.equal(skip("end legend"), true);
        assert.equal(skip("class Foo"), false);
    });
});

describe("Klassenparser — Bloecke erzeugen keine Klassen", () => {
    const text = `@startuml
class Order {
  +submit()
}
note top of Order
  Signed: negative == penetration
  Order -> LineItem im Satz
end note
skinparam class {
  BackgroundColor<<done>> #C8E6C9
}
@enduml`;
    const r = parsePumlClass(text);

    it("kennt nur die deklarierte Klasse", () => {
        assert.deepEqual(r.classes.map(c => c.name), ["Order"]);
    });
    it("erfindet keine Beziehung aus dem Notentext", () => {
        assert.equal(r.relations.length, 0);
    });
});

describe("Use-Case-Parser — skinparam-Block und Stereotypen", () => {
    const text = `@startuml
skinparam usecase {
  BackgroundColor<<done>> #C8E6C9
  BorderColor<<done>>     #2E7D32
}
actor "Nutzer" as U
usecase "Adresse eingeben" as UC1 <<done>>
usecase "Analyse starten"  as UC7 <<wip>>
U --> UC1
U --> UC7
@enduml`;
    const r = parsePumlUseCase(text);

    it("legt keine Use Cases aus dem Style-Block an", () => {
        const names = r.usecases.map(u => u.id);
        assert.ok(!names.some(n => /BackgroundColor|BorderColor|#/.test(n)),
            `Style-Reste in ${JSON.stringify(names)}`);
    });

    it("liest Alias und Anzeigenamen trotz Stereotyp am Zeilenende", () => {
        assert.deepEqual(r.usecases.map(u => u.id).sort(), ["UC1", "UC7"]);
        const uc1 = r.usecases.find(u => u.id === "UC1");
        assert.equal(uc1.name, "Adresse eingeben");
    });

    it("zaehlt jeden Use Case genau einmal", () => {
        assert.equal(r.usecases.length, 2);
    });
});

describe("Sequenzparser — Note-Rumpf ist keine Nachricht", () => {
    const text = `@startuml
participant Device
participant Cluster
note over Device, Cluster
  Device -> host boundary. The trajectory is already in the frame.
end note
Device -> Cluster : send(frame)
@enduml`;
    const r = parseWsd(text);

    it("nimmt nur die echte Nachricht", () => {
        assert.equal(r.messages.length, 1);
        assert.equal(r.messages[0].label, "send(frame)");
    });

    it("erfindet keine Teilnehmer aus dem Notentext", () => {
        assert.deepEqual(r.participants.map(p => p.alias).sort(), ["Cluster", "Device"]);
    });
});

describe("Aktivitaetsparser — Note-Rumpf ist keine Aktion", () => {
    const text = `@startuml
start
:Adresse pruefen;
note right
  :Das hier ist Prosa;
end note
:Score berechnen;
stop
@enduml`;
    const r = parsePumlActivity(text);

    it("nimmt nur die echten Aktionen", () => {
        assert.deepEqual(r.actions.map(a => a.name), ["Adresse pruefen", "Score berechnen"]);
    });
});

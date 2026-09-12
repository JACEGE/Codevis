#!/usr/bin/env node
/**
 * Unit tests for the PlantUML class-diagram parser and the class overlay.
 * Pure, no database.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { parsePumlClass } = require("../scripts/spec/puml_class_parser.js");
const { computeClassRegions } = require("../scripts/spec/reconcile_class.js");

describe("parsePumlClass — domain fixture", () => {
    const text = fs.readFileSync(path.join(__dirname, "fixtures", "domain.puml"), "utf8");
    const r = parsePumlClass(text);
    const byName = Object.fromEntries(r.classes.map(c => [c.name, c]));

    it("reads title and class kinds", () => {
        assert.equal(r.title, "Domain Model");
        assert.equal(byName.BaseEntity.kind, "abstract");
        assert.equal(byName.Repository.kind, "interface");
        assert.equal(byName.Order.kind, "class");
    });

    it("extracts methods with visibility, separating fields", () => {
        const names = byName.Order.methods.map(m => m.name);
        assert.ok(names.includes("submit"));
        assert.ok(names.includes("validate"));
        assert.ok(byName.Order.fields.some(f => f.name === "total"));
        const validate = byName.Order.methods.find(m => m.name === "validate");
        assert.equal(validate.visibility, "private");
    });

    it("captures inheritance with child→parent direction", () => {
        const inh = r.relations.filter(x => x.type === "inherits");
        // BaseEntity <|-- Order  => child Order, parent BaseEntity
        assert.ok(inh.some(x => x.from === "Order" && x.to === "BaseEntity"));
        // Repository <|.. OrderRepo => child OrderRepo, parent Repository
        assert.ok(inh.some(x => x.from === "OrderRepo" && x.to === "Repository"));
    });

    it("classifies composition and association", () => {
        assert.ok(r.relations.some(x => x.type === "composition" && x.to === "LineItem"));
        assert.ok(r.relations.some(x => x.type === "association"));
    });
});

describe("parsePumlClass — was der Agent zum Bauen braucht", () => {
    // Genau die Formen aus einem echten Diagramm: Argumente, Rückgabetyp,
    // Feldtyp, Multiplizitaeten und ein Beziehungslabel. Vorher blieb davon nur
    // der nackte Name uebrig — ein Worker wusste, DASS es die Methode gibt, und
    // nichts darüber, was sie entgegennimmt.
    const text = `@startuml
class GeocodeService {
  + geocode(address) : Location
  - _build_query(category, radius=5) : str
  # cache : dict
  timeout
}
GeocodeService "1" --> "0..*" Location : liefert
FlaskApp ..> GeocodeService : benutzt
@enduml`;
    const r = parsePumlClass(text);
    const svc = r.classes.find(c => c.name === "GeocodeService");

    it("behaelt Parameter und Rueckgabetyp", () => {
        const geocode = svc.methods.find(m => m.name === "geocode");
        assert.equal(geocode.params, "address");
        assert.deepEqual(geocode.paramList, ["address"]);
        assert.equal(geocode.returns, "Location");
        assert.equal(geocode.signature, "geocode(address) : Location");
        assert.equal(geocode.visibility, "public");
    });

    it("trennt mehrere Parameter, Defaultwerte bleiben dran", () => {
        const q = svc.methods.find(m => m.name === "_build_query");
        assert.deepEqual(q.paramList, ["category", "radius=5"]);
        assert.equal(q.returns, "str");
        assert.equal(q.visibility, "private");
    });

    it("behaelt Feldtypen, auch ohne Typangabe", () => {
        const cache = svc.fields.find(f => f.name === "cache");
        assert.equal(cache.type, "dict");
        assert.equal(cache.visibility, "protected");
        const timeout = svc.fields.find(f => f.name === "timeout");
        assert.equal(timeout.type, null, "ohne `: Typ` bleibt der Typ leer statt geraten");
    });

    it("behaelt Label und Multiplizitaeten der Beziehung", () => {
        const assoc = r.relations.find(x => x.type === "association" && x.to === "Location");
        assert.equal(assoc.from, "GeocodeService");
        assert.equal(assoc.label, "liefert");
        assert.equal(assoc.fromMultiplicity, "1");
        assert.equal(assoc.toMultiplicity, "0..*");
    });

    it("erkennt die gestrichelte Abhaengigkeit samt Label", () => {
        const dep = r.relations.find(x => x.type === "dependency");
        assert.equal(dep.from, "FlaskApp");
        assert.equal(dep.to, "GeocodeService");
        assert.equal(dep.label, "benutzt");
    });
});

describe("computeClassRegions", () => {
    const classes = [
        { name: "Order", methods: [{ name: "submit" }, { name: "validate" }, { name: "cancel" }] },
    ];
    const bindings = { Order: { uid: "u:order", name: "Order" } };

    it("splits methods into conforms / missing / extra (scoped)", () => {
        const r = computeClassRegions({
            classes, bindings,
            codeMethods: { Order: [{ uid: "f1", name: "submit" }, { uid: "f2", name: "ship" }] },
            relations: [], inherits: [],
        });
        assert.deepEqual(r.methodConforms.map(m => m.method), ["submit"]);
        assert.ok(r.methodMissing.some(m => m.method === "validate"));
        assert.ok(r.methodMissing.some(m => m.method === "cancel"));
        assert.deepEqual(r.methodExtra.map(m => m.method), ["ship"]); // code has it, diagram doesn't
    });

    it("reports a header declaration and implementation as one extra method", () => {
        const r = computeClassRegions({
            classes: [{ name: "Order", methods: [] }], bindings,
            codeMethods: { Order: [{ uid: "header", name: "Order" }, { uid: "impl", name: "Order" }] },
            relations: [], inherits: [],
        });
        assert.deepEqual(r.methodExtra, [{ class: "Order", method: "Order" }]);
    });

    it("checks inheritance against INHERITS edges", () => {
        const r = computeClassRegions({
            classes: [{ name: "Order", methods: [] }, { name: "BaseEntity", methods: [] }],
            bindings: { Order: { uid: "u:order" }, BaseEntity: { uid: "u:base" } },
            codeMethods: {},
            relations: [{ from: "Order", to: "BaseEntity", type: "inherits" }],
            inherits: [{ fromUid: "u:order", toUid: "u:base" }],
        });
        assert.equal(r.summary.inheritsConforms, 1);
        assert.equal(r.summary.inheritsMissing, 0);
    });

    it("binding gate: unbound class is a question, not drift", () => {
        const r = computeClassRegions({
            classes: [{ name: "Ghost", methods: [{ name: "x" }] }],
            bindings: {}, codeMethods: {}, relations: [], inherits: [],
        });
        assert.deepEqual(r.unbound, ["Ghost"]);
        assert.equal(r.summary.methodMissing, 0);
    });
});

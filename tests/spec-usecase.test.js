#!/usr/bin/env node
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { parsePumlUseCase } = require("../scripts/spec/puml_usecase_parser.js");
const { computeUseCaseRegions } = require("../scripts/spec/reconcile_usecase.js");

describe("parsePumlUseCase — shop fixture", () => {
    const text = fs.readFileSync(path.join(__dirname, "fixtures", "usecases.puml"), "utf8");
    const r = parsePumlUseCase(text);

    it("reads title and actors", () => {
        assert.equal(r.title, "Shop");
        assert.ok(r.actors.some(a => a.name === "Customer"));
        assert.ok(r.actors.some(a => a.name === "Admin"));
    });

    it("reads use cases with alias + display name", () => {
        const uc1 = r.usecases.find(u => u.id === "UC1");
        assert.equal(uc1.name, "Submit Order");
        assert.ok(r.usecases.some(u => u.name === "View Catalog"));
    });

    it("captures actor associations", () => {
        assert.ok(r.associations.some(a => a.actor === "Customer" && a.usecase === "UC1"));
        assert.ok(r.associations.some(a => a.actor === "Admin" && a.usecase === "UC2"));
    });

    it("captures include relations between use cases", () => {
        assert.ok(r.relations.some(x => x.from === "UC1" && x.to === "UC2" && x.type === "include"));
    });
});

describe("computeUseCaseRegions", () => {
    const usecases = [{ id: "UC1", name: "Submit Order" }, { id: "UC2", name: "Cancel Order" }];

    it("splits implemented vs unimplemented", () => {
        const r = computeUseCaseRegions({
            usecases,
            bindings: { UC1: { uid: "u:submit", name: "submitOrder" } },
            relations: [], calls: [],
        });
        assert.deepEqual(r.implemented.map(u => u.id), ["UC1"]);
        assert.deepEqual(r.unimplemented.map(u => u.id), ["UC2"]);
    });

    it("checks include relations against CALLS", () => {
        const r = computeUseCaseRegions({
            usecases,
            bindings: { UC1: { uid: "u:submit" }, UC2: { uid: "u:cancel" } },
            relations: [{ from: "UC1", to: "UC2", type: "include" }],
            calls: [{ fromUid: "u:submit", toUid: "u:cancel" }],
        });
        assert.equal(r.summary.relationConforms, 1);
        assert.equal(r.summary.relationMissing, 0);
    });

    it("flags an include relation with no matching call as missing", () => {
        const r = computeUseCaseRegions({
            usecases,
            bindings: { UC1: { uid: "u:submit" }, UC2: { uid: "u:cancel" } },
            relations: [{ from: "UC1", to: "UC2", type: "include" }],
            calls: [],
        });
        assert.equal(r.summary.relationMissing, 1);
    });
});

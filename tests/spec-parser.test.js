#!/usr/bin/env node
/**
 * Unit tests for scripts/spec/wsd_parser.js — the pure .wsd / PlantUML
 * sequence-diagram parser behind the spec-overlay feature.
 *
 * Pure functions only: requiring the parser must not touch the database or the
 * filesystem.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { parseWsd, deriveMethod, matchArrow, cleanParticipantToken } =
    require("../scripts/spec/wsd_parser.js");

describe("deriveMethod", () => {
    it("strips call parens", () => {
        assert.equal(deriveMethod("save()"), "save");
        assert.equal(deriveMethod("getUser(id, opts)"), "getUser");
    });
    it("accepts a bare identifier", () => {
        assert.equal(deriveMethod("charge"), "charge");
    });
    it("returns null for free text", () => {
        assert.equal(deriveMethod("fetch data"), null);
        assert.equal(deriveMethod("GET /users"), null);
        assert.equal(deriveMethod(""), null);
    });
});

describe("matchArrow", () => {
    it("matches solid and dashed arrows", () => {
        assert.ok(matchArrow("A -> B : x"));
        assert.ok(matchArrow("A --> B : x"));
        assert.ok(matchArrow("A ->> B : x"));
    });
    it("rejects a bare divider", () => {
        assert.equal(matchArrow("== Section =="), null);
    });
});

describe("cleanParticipantToken", () => {
    it("strips activation markers and quotes", () => {
        assert.equal(cleanParticipantToken("+B"), "B");
        assert.equal(cleanParticipantToken('"Web Server"'), "Web Server");
    });
});

describe("parseWsd — checkout fixture", () => {
    const text = fs.readFileSync(
        path.join(__dirname, "fixtures", "checkout.wsd"), "utf8");
    const result = parseWsd(text);

    it("reads the title", () => {
        assert.equal(result.title, "Checkout Flow");
    });

    it("collects declared participants with aliases and kinds", () => {
        const byAlias = Object.fromEntries(result.participants.map(p => [p.alias, p]));
        assert.ok(byAlias.User);
        assert.equal(byAlias.User.kind, "actor");
        assert.equal(byAlias.Checkout.display, "Checkout Controller");
        assert.equal(byAlias.OrderRepo.kind, "database");
        // None of the declared ones should be implicit.
        for (const a of ["User", "Checkout", "PaymentService", "OrderRepo"]) {
            assert.equal(byAlias[a].implicit, false, `${a} should be declared`);
        }
    });

    it("extracts ordered messages with from/to/method", () => {
        const submit = result.messages[0];
        assert.equal(submit.from, "User");
        assert.equal(submit.to, "Checkout");
        assert.equal(submit.method, "submitOrder");

        const charge = result.messages.find(m => m.method === "charge");
        assert.equal(charge.from, "Checkout");
        assert.equal(charge.to, "PaymentService");
    });

    it("marks dashed returns", () => {
        const receipt = result.messages.find(m => m.label === "Receipt");
        assert.equal(receipt.dashed, true);
        assert.equal(receipt.from, "PaymentService");
        assert.equal(receipt.to, "Checkout");
    });

    it("attaches guards from alt/else blocks", () => {
        const save = result.messages.find(m => m.method === "save");
        assert.equal(save.guard, "payment ok");
        const showError = result.messages.find(m => m.method === "showError");
        assert.equal(showError.guard, "payment failed");
    });

    it("keeps messages outside blocks unguarded", () => {
        const confirmation = result.messages.find(m => m.label === "confirmation");
        assert.equal(confirmation.guard, null);
    });
});

describe("parseWsd — robustness", () => {
    it("handles reverse arrows by swapping direction", () => {
        const r = parseWsd("B <- A : ping()");
        assert.equal(r.messages[0].from, "A");
        assert.equal(r.messages[0].to, "B");
    });

    it("auto-adds undeclared participants as implicit", () => {
        const r = parseWsd("X -> Y : go()");
        const y = r.participants.find(p => p.alias === "Y");
        assert.equal(y.implicit, true);
    });

    it("does not crash on notes, autonumber and empty lines", () => {
        const r = parseWsd("autonumber\n\nnote left of A: hi\nA -> B : run()\n");
        assert.equal(r.messages.length, 1);
        assert.equal(r.messages[0].method, "run");
    });
});

describe("parseWsd — real-world PlantUML syntax", () => {
    it("handles coloured/styled arrows", () => {
        const r = parseWsd("A -[#red]> B : charge()");
        assert.equal(r.messages.length, 1);
        assert.equal(r.messages[0].from, "A");
        assert.equal(r.messages[0].to, "B");
        assert.equal(r.messages[0].method, "charge");
    });

    it("keeps dashed semantics on a styled return arrow", () => {
        // PlantUML dashed coloured arrow: one dash, then the style, then `->`.
        const r = parseWsd("B -[#0000FF]-> A : Receipt");
        assert.equal(r.messages[0].dashed, true);
        assert.equal(r.messages[0].from, "B");
        assert.equal(r.messages[0].to, "A");
    });

    it("preserves a label that contains brackets", () => {
        const r = parseWsd("A -> B : fetch [cached]");
        assert.equal(r.messages[0].label, "fetch [cached]");
    });

    it("`end box` does not corrupt the guard stack", () => {
        const r = parseWsd(
            "alt success\n" +
            "box \"internal\"\n" +
            "A -> B : inside()\n" +
            "end box\n" +
            "A -> B : stillInside()\n" +
            "end\n" +
            "A -> B : outside()\n");
        assert.equal(r.messages.find(m => m.method === "inside").guard, "success");
        // Before the fix `end box` popped "success", so this was wrongly null.
        assert.equal(r.messages.find(m => m.method === "stillInside").guard, "success");
        assert.equal(r.messages.find(m => m.method === "outside").guard, null);
    });

    it("strips a trailing `order N` from a participant declaration", () => {
        const r = parseWsd("participant Foo order 10\nFoo -> Bar : x()");
        assert.ok(r.participants.some(p => p.alias === "Foo"), "alias should be clean 'Foo'");
        assert.ok(!r.participants.some(p => /order/.test(p.alias)));
    });

    it("handles self-messages", () => {
        const r = parseWsd("A -> A : recurse()");
        assert.equal(r.messages[0].from, "A");
        assert.equal(r.messages[0].to, "A");
        assert.equal(r.messages[0].method, "recurse");
    });
});

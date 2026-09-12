#!/usr/bin/env node
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { parsePumlActivity, actionToMethod } = require("../scripts/spec/puml_activity_parser.js");
const { computeActivityRegions, norm } = require("../scripts/spec/reconcile_activity.js");

describe("actionToMethod", () => {
    it("camelCases prose", () => {
        assert.equal(actionToMethod("Charge Payment"), "chargePayment");
        assert.equal(actionToMethod("Validate Cart"), "validateCart");
    });
    it("keeps identifiers/calls", () => {
        assert.equal(actionToMethod("charge()"), "charge");
        assert.equal(actionToMethod("validate"), "validate");
    });
});

describe("parsePumlActivity — checkout fixture", () => {
    const text = fs.readFileSync(path.join(__dirname, "fixtures", "checkout_activity.puml"), "utf8");
    const r = parsePumlActivity(text);
    const byMethod = Object.fromEntries(r.actions.map(a => [a.method, a]));

    it("reads title and the actions in order", () => {
        assert.equal(r.title, "Checkout");
        const methods = r.actions.map(a => a.method);
        assert.deepEqual(methods, ["validateCart", "chargePayment", "saveOrder", "showError", "sendConfirmation"]);
    });

    it("does not treat start/stop as actions", () => {
        assert.ok(!r.actions.some(a => /start|stop/i.test(a.name)));
    });

    it("attaches branch guards", () => {
        assert.equal(byMethod.validateCart.guard, null);          // before the if
        assert.equal(byMethod.chargePayment.guard, "valid?");      // inside if
        assert.equal(byMethod.showError.guard, "no");              // inside else
        assert.equal(byMethod.sendConfirmation.guard, null);       // after endif
    });
});

describe("computeActivityRegions", () => {
    const actions = [
        { name: "Charge Payment", method: "chargePayment" },
        { name: "Save Order", method: "saveOrder" },
        { name: "Send Confirmation", method: "sendConfirmation" },
    ];

    it("matches actions to process callees (normalised)", () => {
        const r = computeActivityRegions({
            actions, processBound: true,
            processCallees: [{ name: "charge_payment" }, { name: "saveOrder" }, { name: "log" }],
        });
        assert.equal(r.summary.conforms, 2);                       // chargePayment~charge_payment, saveOrder
        assert.ok(r.missing.some(m => m.method === "sendConfirmation"));
        assert.ok(r.extra.some(e => e.callee === "log"));          // scoped extra
    });

    it("keeps colliding normalised callees and uses an exact name to find the undocumented one", () => {
        const r = computeActivityRegions({
            actions: [{ name: "Charge Payment", method: "chargePayment" }],
            processBound: true,
            processCallees: [{ name: "charge_payment" }, { name: "chargePayment" }],
        });
        assert.equal(r.summary.conforms, 1);
        assert.deepEqual(r.extra, [{ callee: "charge_payment" }]);
    });

    it("reports equally good normalised matches as ambiguous instead of guessing", () => {
        const r = computeActivityRegions({
            actions: [{ name: "Charge Payment", method: "chargePayment" }],
            processBound: true,
            processCallees: [{ name: "charge-payment" }, { name: "charge_payment" }],
        });
        assert.equal(r.summary.ambiguous, 1);
        assert.deepEqual(r.ambiguous[0].candidates, ["charge-payment", "charge_payment"]);
        assert.equal(r.summary.missing, 0);
        assert.equal(r.summary.extra, 0, "ambiguous candidates are not definite drift");
    });

    it("binding gate: an unbound process is a question, not drift", () => {
        const r = computeActivityRegions({ actions, processBound: false, processCallees: [] });
        assert.equal(r.unbound, true);
        assert.equal(r.summary.missing, 0);
    });
});

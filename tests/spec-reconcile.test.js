#!/usr/bin/env node
/**
 * Unit tests for scripts/spec/reconcile.js — the three-region overlay logic
 * with the binding gate and scoping guards. Pure, no database.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { computeRegions } = require("../scripts/spec/reconcile.js");

// A small bound world: Checkout (2 methods) and PaymentService (1 method).
function world() {
    return {
        bindings: {
            Checkout: { uid: "u:checkout", name: "Checkout", kind: "Class" },
            Payment: { uid: "u:payment", name: "PaymentService", kind: "Class" },
        },
        members: {
            Checkout: [
                { uid: "fn:submit", name: "submitOrder" },
                { uid: "fn:retry", name: "retry" },
            ],
            Payment: [{ uid: "fn:charge", name: "charge" }],
        },
    };
}

describe("computeRegions — conformance ①", () => {
    it("marks a message as conforming when the CALLS edge exists", () => {
        const w = world();
        const r = computeRegions({
            ...w,
            messages: [{ from: "Checkout", to: "Payment", method: "charge", order: 0 }],
            calls: [{ fromUid: "fn:submit", toUid: "fn:charge" }],
        });
        assert.equal(r.summary.conforms, 1);
        assert.equal(r.summary.missing, 0);
        assert.equal(r.summary.extra, 0);
    });

    it("matches any overload instead of keeping only the last same-named method", () => {
        const w = world();
        w.members.Payment = [
            { uid: "fn:send-int", name: "send" },
            { uid: "fn:send-string", name: "send" },
        ];
        const r = computeRegions({
            ...w,
            messages: [{ from: "Checkout", to: "Payment", method: "send", order: 0 }],
            calls: [{ fromUid: "fn:submit", toUid: "fn:send-int" }],
        });
        assert.equal(r.summary.conforms, 1, "an existing call to either overload must conform");
        assert.equal(r.summary.missing, 0);
        assert.deepEqual(r.conforms[0].calleeUids, ["fn:send-int"]);
    });
});

describe("computeRegions — missing ②", () => {
    it("flags not_called when the method exists but no edge calls it", () => {
        const w = world();
        const r = computeRegions({
            ...w,
            messages: [{ from: "Checkout", to: "Payment", method: "charge", order: 0 }],
            calls: [],
        });
        assert.equal(r.summary.missing, 1);
        assert.equal(r.missing[0].reason, "not_called");
    });

    it("flags no_method when the target lacks the method entirely", () => {
        const w = world();
        const r = computeRegions({
            ...w,
            messages: [{ from: "Checkout", to: "Payment", method: "refund", order: 0 }],
            calls: [],
        });
        assert.equal(r.missing[0].reason, "no_method");
    });
});

describe("computeRegions — extra ③ (drift) with scoping", () => {
    it("reports an undocumented call between two bound participants", () => {
        const w = world();
        const r = computeRegions({
            ...w,
            messages: [], // nothing documented
            calls: [{ fromUid: "fn:submit", toUid: "fn:charge" }],
        });
        assert.equal(r.summary.extra, 1);
        assert.equal(r.extra[0].fromAlias, "Checkout");
        assert.equal(r.extra[0].toAlias, "Payment");
        assert.equal(r.extra[0].calleeName, "charge");
    });

    it("does NOT report a documented call as extra", () => {
        const w = world();
        const r = computeRegions({
            ...w,
            messages: [{ from: "Checkout", to: "Payment", method: "charge", order: 0 }],
            calls: [{ fromUid: "fn:submit", toUid: "fn:charge" }],
        });
        assert.equal(r.summary.extra, 0);
        assert.equal(r.summary.conforms, 1);
    });

    it("SCOPING: ignores calls leaving the bound scope (the 95% case)", () => {
        const w = world();
        const r = computeRegions({
            ...w,
            messages: [],
            calls: [
                { fromUid: "fn:submit", toUid: "fn:external" }, // toUid not bound
                { fromUid: "fn:unknown", toUid: "fn:charge" },  // fromUid not bound
            ],
        });
        assert.equal(r.summary.extra, 0, "out-of-scope calls must not be drift");
    });

    it("ignores internal calls within the same participant", () => {
        const w = world();
        const r = computeRegions({
            ...w,
            messages: [],
            calls: [{ fromUid: "fn:submit", toUid: "fn:retry" }], // both Checkout
        });
        assert.equal(r.summary.extra, 0);
    });
});

describe("computeRegions — binding gate", () => {
    it("an unbound endpoint produces a question, never drift", () => {
        const w = world();
        const r = computeRegions({
            ...w,
            messages: [
                { from: "Checkout", to: "User", method: "notify", order: 0 }, // User unbound
            ],
            calls: [],
        });
        assert.deepEqual(r.unbound, ["User"]);
        assert.equal(r.summary.missing, 0, "unbound must not be counted as missing");
        assert.equal(r.skipped[0].reason, "unbound_endpoint");
    });

    it("free-text messages are skipped, not flagged", () => {
        const w = world();
        const r = computeRegions({
            ...w,
            messages: [
                { from: "Checkout", to: "Payment", method: null, label: "do the thing", order: 0 },
            ],
            calls: [],
        });
        assert.equal(r.summary.missing, 0);
        assert.equal(r.skipped[0].reason, "free_text");
    });
});

describe("computeRegions — return arrows", () => {
    it("a dashed return is NOT checked as a call", () => {
        const w = world();
        // Payment --> Checkout : Receipt  is a RETURN, not a call. It must not
        // be reconciled as "Payment calls Checkout.Receipt".
        const r = computeRegions({
            ...w,
            messages: [
                { from: "Payment", to: "Checkout", method: "Receipt", dashed: true, order: 0 },
            ],
            calls: [],
        });
        assert.equal(r.summary.missing, 0, "a return must not become a missing call");
        assert.equal(r.summary.conforms, 0);
        assert.ok(r.skipped.some((s) => s.reason === "return"));
    });

    it("a solid call alongside a return: only the call is checked", () => {
        const w = world();
        const r = computeRegions({
            ...w,
            messages: [
                { from: "Checkout", to: "Payment", method: "charge", dashed: false, order: 0 },
                { from: "Payment", to: "Checkout", method: "Receipt", dashed: true, order: 1 },
            ],
            calls: [{ fromUid: "fn:submit", toUid: "fn:charge" }],
        });
        assert.equal(r.summary.conforms, 1);
        assert.equal(r.summary.missing, 0);
    });
});


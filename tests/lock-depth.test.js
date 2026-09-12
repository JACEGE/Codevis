#!/usr/bin/env node
/**
 * The depth a caller asks for is the depth they get.
 *
 * lock_subgraph used to compute its hop depth with
 *   parseInt(String(args.depth || 2), 10) || 2
 * which turned an explicit 0 into 2 twice over. Every worker that followed this
 * project's own rule ("lock with depth=0 when editing a single component") still
 * locked two hops and blocked others for no reason.
 *
 * Run: node --test tests/lock-depth.test.js
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { normalizeDepth, MAX_DEPTH } = require("../tools/lib/lock-depth.cjs");

describe("normalizeDepth", () => {
    it("keeps an explicit 0 (the regression this exists for)", () => {
        assert.equal(normalizeDepth(0, 2), 0);
        assert.equal(normalizeDepth("0", 2), 0);
    });

    it("falls back when no value was given", () => {
        assert.equal(normalizeDepth(undefined, 2), 2);
        assert.equal(normalizeDepth(null, 2), 2);
        assert.equal(normalizeDepth(undefined, 0), 0);
    });

    it("falls back on an unreadable value rather than guessing 0", () => {
        // NaN and 0 are different cases: "I could not read this" must not
        // silently become "lock nothing but the origin".
        assert.equal(normalizeDepth("abc", 2), 2);
        assert.equal(normalizeDepth({}, 2), 2);
        assert.equal(normalizeDepth("", 2), 2);
    });

    it("passes ordinary depths through", () => {
        assert.equal(normalizeDepth(1, 2), 1);
        assert.equal(normalizeDepth(3, 2), 3);
        assert.equal(normalizeDepth("4", 2), 4);
    });

    it("clamps to the allowed range", () => {
        assert.equal(normalizeDepth(-5, 2), 0);
        assert.equal(normalizeDepth(99, 2), MAX_DEPTH);
    });

    it("accepts a numeric string with trailing text the way parseInt does", () => {
        // Documented, not endorsed: MCP arguments arrive as JSON, so this is a
        // theoretical input. Pinned so a future rewrite notices if it changes.
        assert.equal(normalizeDepth("2abc", 5), 2);
    });
});

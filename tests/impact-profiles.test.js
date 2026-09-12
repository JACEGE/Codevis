"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { PROFILES, resolveImpactOptions } = require("../scripts/impact/impact_profiles.cjs");

test("impact profiles are ordered, bounded and immutable", () => {
    assert.deepEqual(Object.keys(PROFILES), ["fast", "balanced", "deep"]);
    assert.ok(PROFILES.fast.depth < PROFILES.balanced.depth);
    assert.ok(PROFILES.balanced.depth < PROFILES.deep.depth);
    assert.ok(PROFILES.fast.maxNodes < PROFILES.deep.maxNodes);
    assert.equal(Object.isFrozen(PROFILES.fast), true);
});

test("balanced is the default and explicit safe options override profiles", () => {
    assert.equal(resolveImpactOptions({}).profile, "balanced");
    const options = resolveImpactOptions({ profile: "deep", depth: 3, relations: ["CALLS"] });
    assert.equal(options.direction, "both"); assert.equal(options.depth, 3); assert.deepEqual(options.relations, ["CALLS"]);
    assert.throws(() => resolveImpactOptions({ profile: "unbounded" }), /Unknown impact profile/);
});

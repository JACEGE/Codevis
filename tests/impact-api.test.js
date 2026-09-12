"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { parseImpactRequest } = require("../server/impact-api.cjs");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");

test("impact API validates and bounds public request parameters", () => {
    assert.deepEqual(parseImpactRequest({ nodeId: "abc", direction: "both", depth: 3, relations: ["CALLS"] }), {
        seed: { id: "abc" }, profile: "balanced", direction: "both", depth: 3, relations: ["CALLS"],
    });
    assert.throws(() => parseImpactRequest({}), /nodeId or name/);
    assert.throws(() => parseImpactRequest({ name: "x", depth: 20 }), /depth/);
    assert.throws(() => parseImpactRequest({ name: "x", relations: ["CALLS] DELETE"] }), /relations/);
    assert.throws(() => parseImpactRequest({ name: "x", profile: "unbounded" }), /profile/);
});

test("bridge exposes the shared impact service and ambiguity status", () => {
    const bridge = readFileSync(resolve(__dirname, "../server/bridge.js"), "utf8");
    assert.match(bridge, /app\.post\('\/api\/impact'/);
    assert.match(bridge, /runImpactRequest/);
    assert.match(bridge, /AMBIGUOUS_SEED' \? 409/);
    assert.match(bridge, /publicWorkspaceName\(dbKey\)/);
});

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

test("impact CLI parses bounded selectors and renders evidence", async () => {
    const { parseArgs, renderImpact } = await import("../lib/commands/impact.mjs");
    const opts = parseArgs(["save", "--file", "src/a.js", "--direction", "both", "--depth", "3", "--json"]);
    assert.equal(opts.name, "save"); assert.equal(opts.file, "src/a.js"); assert.equal(opts.depth, 3); assert.equal(opts.profile, "balanced"); assert.equal(opts.json, true);
    assert.equal(parseArgs(["save", "--profile", "deep"]).depth, null);
    assert.throws(() => parseArgs(["save", "--depth", "99"]), /--depth/);
    const text = renderImpact({ seed: { name: "save", label: "Function", file: "src/a.js", startLine: 1 }, profile: "fast", direction: "in", depth: 1,
        graphFreshness: { state: "current" }, impacted: [{ name: "caller", label: "Function", file: "src/b.js", startLine: 2,
            distance: 1, confidence: "exact", paths: [[{ relType: "CALLS", direction: "in" }]] }],
        attachments: { tests: [], tasks: [], specs: [], knowledge: [] },
        testSelection: { selected: [], note: "No tests were identified; this does not prove safety." },
        knowledgeReview: { candidates: [] }, truncation: { truncated: false } });
    assert.match(text, /Impact of save/); assert.match(text, /caller/); assert.match(text, /CALLS/);
    assert.match(text, /Profile: fast/);
    assert.match(text, /does not prove safety/);
});

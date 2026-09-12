"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { validateExtractorConfig, validateExtractorConfigs } = require("../scripts/parser/extractor_contract.cjs");
const { __testing__ } = require("../scripts/graph_builder.js");

test("every bundled language extractor satisfies the public contract", () => {
    const descriptions = validateExtractorConfigs(__testing__.LANG_CONFIGS);
    assert.deepEqual(Object.keys(descriptions).sort(), Object.keys(__testing__.LANG_CONFIGS).sort());
    assert.equal(descriptions[".js"].capabilities.jsx, true);
    assert.equal(descriptions[".sh"].capabilities.jsx, false);
    assert.deepEqual(descriptions, __testing__.EXTRACTOR_CAPABILITIES);
});

test("invalid extractor fields fail early with actionable messages", () => {
    const errors = validateExtractorConfig("javascript", { wasm: "", funcQuery: 42, callQuery: 4, typoQuery: "(x)" });
    assert.ok(errors.some((error) => error.includes("extension")));
    assert.ok(errors.some((error) => error.includes("wasm")));
    assert.ok(errors.some((error) => error.includes("funcQuery")));
    assert.ok(errors.some((error) => error.includes("callQuery")));
    assert.ok(errors.some((error) => error.includes("unknown field 'typoQuery'")));
    assert.throws(() => validateExtractorConfigs({ ".x": { wasm: "x.wasm", astQuery: "(_) @ast_node", funcQuery: "(x)", callQuery: 4 } }),
        (error) => error.code === "INVALID_EXTRACTOR_CONFIG" && /\.x: callQuery/.test(error.message));
});

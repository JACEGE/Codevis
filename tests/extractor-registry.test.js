"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createExtractorRegistry } = require("../scripts/parser/extractor_registry.cjs");

const config = { wasm: "grammar.wasm", funcQuery: "(function) @func_node", callQuery: "", astQuery: "(_) @ast_node" };

test("registry validates, registers and aliases immutable extractor configs", () => {
    const backing = {};
    const registry = createExtractorRegistry(backing);
    registry.register(".demo", config, { aliases: [".demo2"] });
    assert.equal(registry.get(".demo"), registry.get(".demo2"));
    assert.equal(backing[".demo"], registry.get(".demo"));
    assert.equal(Object.isFrozen(registry.get(".demo")), true);
    assert.deepEqual(registry.extensions(), [".demo", ".demo2"]);
    assert.equal(registry.capabilities()[".demo"].capabilities.func, true);
});

test("registry rejects duplicates and malformed extensions before mutation", () => {
    const backing = {};
    const registry = createExtractorRegistry(backing);
    registry.register(".demo", config);
    assert.throws(() => registry.register(".demo", config), /already registered/);
    assert.throws(() => registry.register("demo", config), (error) => error.code === "INVALID_EXTRACTOR_CONFIG");
    assert.deepEqual(Object.keys(backing), [".demo"]);
});

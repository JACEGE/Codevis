const test = require("node:test");
const assert = require("node:assert/strict");
const { SOURCE_EXTENSIONS } = require("../lib/source-files.cjs");
const { __testing__: { LANG_CONFIGS } } = require("../scripts/graph_builder.js");

test("shared source discovery supports exactly the parser registry's extensions", () => {
    assert.deepEqual([...SOURCE_EXTENSIONS].sort(), Object.keys(LANG_CONFIGS).sort());
});

#!/usr/bin/env node

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { NODE_TABLES, REL_SPECS, REL_PROP_UNION, parseColumns } = require("../scripts/ladybug_schema.cjs");

describe("ladybug schema fold-in columns", () => {
    it("declares columns for Hook and Async secondary labels", () => {
        const columns = new Map(parseColumns(NODE_TABLES[0]).map((column) => [column.name, column.type]));
        assert.equal(columns.get("isHook"), "BOOLEAN");
        assert.equal(columns.get("isAsync"), "BOOLEAN");
    });
});

describe("TOUCHED relationship schema", () => {
    it("declares the relationship and its documentary properties", () => {
        assert.ok(REL_SPECS.TOUCHED);
        const columns = new Map(parseColumns(`X(${REL_PROP_UNION.join(", ")})`).map((column) => [column.name, column.type]));
        assert.equal(columns.get("at"), "INT64");
        assert.equal(columns.get("kind"), "STRING");
    });
});

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");

test("impact MCP tool is registered for full and worker servers", () => {
    const server = readFileSync(resolve(__dirname, "../tools/mcp_server.ts"), "utf8");
    assert.match(server, /import \{ impactTools \}/);
    assert.match(server, /fullModules = \[[^\]]*impactTools/);
    assert.match(server, /workerToolNames[\s\S]*"impact"/);
    const handler = readFileSync(resolve(__dirname, "../tools/handlers/impact-tools.ts"), "utf8");
    assert.match(handler, /name: "impact"/);
    assert.match(handler, /analyzeImpactFromSession/);
    assert.match(handler, /nodeId[\s\S]*elementId/);
});

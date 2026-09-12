"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");

test("inspector impact UI uses the shared bridge result and exposes evidence quality", () => {
    const component = readFileSync(resolve(__dirname, "../frontend/src/components/ImpactSection.jsx"), "utf8");
    assert.match(component, /\/api\/impact/);
    assert.match(component, /graphFreshness/);
    assert.match(component, /truncation/);
    assert.match(component, /testSelection/);
    assert.match(component, /knowledgeReview/);
    assert.match(component, /analysisQuality/);
    assert.match(component, /\['fast', 'balanced', 'deep'\]/);
    assert.match(component, /Analyzing impact/);
    const inspector = readFileSync(resolve(__dirname, "../frontend/src/components/InspectorSidebar.jsx"), "utf8");
    assert.match(inspector, /import ImpactSection/);
    assert.match(inspector, /<ImpactSection nodeId=\{debugNode\} db=\{db\}/);
});

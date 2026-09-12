#!/usr/bin/env node
/**
 * Guards the full-rebuild preserve list in scripts/graph_builder.js.
 *
 * The failure mode this exists for is silent: a new Spec* label gets added to
 * the importer, nobody touches the DETACH DELETE query, and from then on every
 * full rebuild deletes those nodes. Nothing throws, no test fails, the diagram
 * just quietly loses part of itself. That is exactly what happened to
 * SpecField — it was never in the list, so class attributes were wiped on
 * every rebuild for as long as class-diagram import existed.
 *
 * So instead of asserting a hardcoded list (which would rot the same way),
 * this reads the labels the importer ACTUALLY creates out of spec_db.cjs and
 * asserts the preserve list covers them.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { PRESERVED_LABELS } = require("../scripts/graph_builder.js");

const SPEC_DB = path.resolve(__dirname, "../scripts/spec/spec_db.cjs");

// Labels the importer creates, read from the CREATE/MERGE patterns themselves.
function createdSpecLabels() {
    const src = fs.readFileSync(SPEC_DB, "utf8");
    const labels = new Set();
    for (const m of src.matchAll(/\b(?:CREATE|MERGE)\s*\(\s*\w*\s*:\s*(Spec\w+)/g)) {
        labels.add(m[1]);
    }
    return [...labels].sort();
}

describe("full-rebuild preserve list", () => {
    it("covers every Spec* label the importer creates", () => {
        const created = createdSpecLabels();

        // Sanity: if the regex stops matching, the test would pass vacuously.
        assert.ok(
            created.length >= 15,
            `expected to find the Spec* labels in ${SPEC_DB}, found ${created.length} ` +
            `— the CREATE/MERGE shape probably changed and this test went blind`,
        );

        const missing = created.filter((l) => !PRESERVED_LABELS.includes(l));
        assert.deepEqual(
            missing,
            [],
            `these labels are created by the spec importer but NOT preserved on full ` +
            `rebuild — they will be silently deleted: ${missing.join(", ")}`,
        );
    });

    it("preserves SpecField specifically (regression)", () => {
        // Class attributes. Missing from the list from day one; a full rebuild
        // dropped every attribute of every imported class diagram.
        assert.ok(PRESERVED_LABELS.includes("SpecField"));
    });

    it("has no duplicate entries", () => {
        assert.equal(
            new Set(PRESERVED_LABELS).size,
            PRESERVED_LABELS.length,
            "duplicate label in PRESERVED_LABELS",
        );
    });

    it("keeps the non-Spec authored labels", () => {
        // Task/Knowledge/BraindumpSession are authored by agents and users and
        // exist nowhere but the graph — losing them is unrecoverable.
        for (const l of ["Task", "Epic", "Idea", "Knowledge", "Annotation", "BraindumpSession"]) {
            assert.ok(PRESERVED_LABELS.includes(l), `${l} must survive a rebuild`);
        }
    });
});

#!/usr/bin/env node
/**
 * Regression tests for the Ladybug driver's deliberately single-statement
 * transaction compatibility surface. These stay in-process: replacing run()
 * lets the test prove the guard fires before a second statement reaches the
 * daemon, without starting or touching a database.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { _Session: Session } = require("../server/ladybug-driver.cjs");

describe("ladybug-driver transaction fallback", () => {
    it("stops an executeWrite callback after its first applied SET", async () => {
        const session = new Session("target");
        const applied = [];
        session.run = async (cypher) => {
            applied.push(cypher);
            return { records: [], summary: {} };
        };

        await assert.rejects(
            session.executeWrite(async (tx) => {
                await tx.run("MATCH (n) SET n.first = true");
                await tx.run("MATCH (n) SET n.second = true");
            }),
            /executeWrite callback issued more than one tx\.run\(\).*single-statement form/,
        );
        assert.deepEqual(applied, ["MATCH (n) SET n.first = true"]);
    });

    it("keeps existing single-statement executeWrite callbacks working", async () => {
        const session = new Session("target");
        session.run = async (cypher) => cypher;

        const result = await session.executeWrite(
            (tx) => tx.run("MATCH (n) SET n.seen = true"),
        );
        assert.equal(result, "MATCH (n) SET n.seen = true");
    });
});

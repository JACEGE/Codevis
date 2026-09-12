/**
 * A neo4j-shaped session backed by a REAL, throwaway Ladybug database.
 *
 * The spec layer had zero DB-level coverage: all five spec test files exercise
 * pure parser functions, so nothing ever checked that the queries in
 * spec_db.cjs actually survive translation and run. That is precisely how a
 * missing label in the rebuild preserve list, and read-time-only edges, went
 * unnoticed.
 *
 * This deliberately does NOT go through the daemon (spawning one per test is
 * slow and stateful). It reproduces the two things the driver+daemon do to a
 * query — translate() it, then resolve the CREATE identity sentinels — and
 * then executes it in-process. So the query text under test is the same text
 * production runs; only the transport differs.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { translate } = require("../../server/ladybug-translate.cjs");
const { applySchema } = require("../../scripts/ladybug_schema.cjs");

const TEST_MAX_DB_SIZE_BYTES = 1024 * 1024 * 1024;

// Mirrors the driver's Integer shim: callers do `.toNumber()` on counts.
function wrap(v) {
    if (typeof v === "bigint") {
        return { toNumber: () => Number(v), toString: () => v.toString(), valueOf: () => Number(v) };
    }
    return v;
}

class TestSession {
    constructor(conn) {
        this.conn = conn;
        this.seq = 0;
    }

    async run(cypher, params = {}) {
        const { cypher: translated, injectNow, creates } = translate(cypher);
        const out = { ...params };
        if (injectNow && !("__now" in out)) out.__now = Date.now();
        // CREATE identity: the translator injects $__uidN/$__seqN per CREATE
        // node pattern; the daemon resolves them off a per-db counter.
        for (const c of creates || []) {
            if (c.seqParam) out[c.seqParam] = ++this.seq;
            if (c.uidParam) out[c.uidParam] = String(c.prefix) + String(this.seq);
        }

        let result;
        if (Object.keys(out).length) {
            const prepared = await this.conn.prepare(translated);
            if (!prepared.isSuccess()) {
                throw new Error(`prepare failed: ${prepared.getErrorMessage()}\n--- query ---\n${translated}`);
            }
            result = await this.conn.execute(prepared, out);
        } else {
            result = await this.conn.query(translated);
        }
        const last = Array.isArray(result) ? result[result.length - 1] : result;
        const rows = await last.getAll();
        return {
            records: rows.map((row) => ({
                keys: Object.keys(row),
                get: (k) => wrap(row[k]),
            })),
        };
    }

    async close() {}

    async withTransaction(operation) {
        const { LocalSession } = require('../../server/ladybug-local-session.cjs');
        return LocalSession.prototype.withTransaction.call(this, operation);
    }
}

/**
 * Opens a fresh schema-applied database in a temp dir.
 * Returns { session, cleanup }. Always call cleanup().
 */
async function openTestDb() {
    const kuzu = require("@ladybugdb/core");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codevis-spec-test-"));
    // Ladybug's default maximum maps an 8 TiB address range. A test file can
    // open many short-lived databases before the OS releases every mapping,
    // which exhausts CI address space even though each fixture stores very
    // little data. Keep disposable test databases deliberately bounded.
    const db = new kuzu.Database(
        path.join(dir, "db"),
        0,
        true,
        false,
        TEST_MAX_DB_SIZE_BYTES,
    );
    const conn = new kuzu.Connection(db);
    await applySchema(conn, { log: () => {} });

    return {
        session: new TestSession(conn),
        async cleanup() {
            try { await conn.close?.(); } catch { /* best effort */ }
            try { await db.close?.(); } catch { /* best effort */ }
            // Windows keeps the mmap'd files locked briefly after close; a
            // failed rmdir must not fail the test it belongs to.
            try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
        },
    };
}

module.exports = { openTestDb };

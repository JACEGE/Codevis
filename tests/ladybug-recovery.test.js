"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { isWalFailure, quarantineRecoveryArtifacts } = require("../server/ladybug-recovery.cjs");
test("WAL recovery recognizes replay failures and quarantines only recovery artifacts", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codevis-recovery-"));
    try {
        const dbPath = path.join(dir, "ladybug-meta");
        fs.writeFileSync(dbPath, "main database");
        for (const suffix of [".wal", ".wal.checkpoint", ".shadow"]) fs.writeFileSync(`${dbPath}${suffix}`, suffix);
        assert.equal(isWalFailure(new Error("Corrupted wal file. Read out invalid WAL record type")), true);
        assert.equal(isWalFailure(new Error("Table CodeNode does not exist")), false);
        const moved = quarantineRecoveryArtifacts(dbPath, 123);
        assert.equal(moved.length, 3);
        assert.equal(fs.readFileSync(dbPath, "utf8"), "main database");
        for (const suffix of [".wal", ".wal.checkpoint", ".shadow"]) {
            assert.equal(fs.existsSync(`${dbPath}${suffix}`), false);
            assert.equal(fs.existsSync(`${dbPath}${suffix}.corrupt-123`), true);
        }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

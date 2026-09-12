"use strict";
const fs = require("node:fs");
const RECOVERY_SUFFIXES = Object.freeze([".wal", ".wal.checkpoint", ".shadow"]);
function isWalFailure(error) { return /\bwal\b|wal file|wal record/i.test(error?.message || ""); }
function quarantineRecoveryArtifacts(dbPath, timestamp = Date.now()) {
    const moved = [];
    for (const suffix of RECOVERY_SUFFIXES) {
        const source = `${dbPath}${suffix}`;
        if (!fs.existsSync(source)) continue;
        const destination = `${source}.corrupt-${timestamp}`;
        fs.renameSync(source, destination);
        moved.push({ source, destination });
    }
    return moved;
}
module.exports = { RECOVERY_SUFFIXES, isWalFailure, quarantineRecoveryArtifacts };

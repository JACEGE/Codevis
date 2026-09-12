#!/usr/bin/env node
// Enumerate test files explicitly so discovery does not depend on shell glob
// expansion or Node's directory handling. Fixtures and helpers are excluded.

import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const testDir = join(root, "tests");

const files = readdirSync(testDir)
    .filter((name) => name.endsWith(".test.js"))
    .sort()
    .map((name) => join("tests", name));

if (files.length === 0) {
    console.error(`No test files found in ${testDir}.`);
    process.exit(1);
}

const result = spawnSync(
    process.execPath,
    ["--test", "--test-concurrency=1", ...files, ...process.argv.slice(2)],
    { cwd: root, stdio: "inherit" }
);

// A signal leaves status null; an interrupted test run must fail.
process.exit(result.status ?? 1);

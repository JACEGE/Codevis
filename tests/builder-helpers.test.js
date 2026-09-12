#!/usr/bin/env node
/**
 * Unit tests for the pure helper functions in scripts/graph_builder.js —
 * the functions behind the launch-week bugs:
 *   - toGraphPath/relGraphPath: graph paths are ALWAYS forward slashes
 *   - uidToHex16: unique, stable 16-bit subnet hashes for string uids
 *     (the old parseInt() collapsed every uid to 0x000f and one lock
 *     grabbed the whole graph)
 *   - makeIpv6: address assembly
 *   - resolveImportPath: import resolution against stored paths, never
 *     resolving a file to itself (config-shim self-edge)
 *
 * Pure functions only — requiring graph_builder.js must NOT start a build
 * (guarded by require.main).
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const {
    toGraphPath,
    uidToHex16,
    hex4,
    makeIpv6,
    resolveImportPath,
    __testing__,
} = require("../scripts/graph_builder.js");

describe("toGraphPath", () => {
    it("leaves forward-slash paths untouched", () => {
        assert.equal(toGraphPath("tools/lib/locks.ts"), "tools/lib/locks.ts");
    });

    it("normalizes platform separators to forward slashes", () => {
        // On Windows path.sep is '\\' and conversion must happen; on POSIX
        // the input never contains backslashes in the first place.
        if (path.sep === "\\") {
            assert.equal(toGraphPath("tools\\lib\\locks.ts"), "tools/lib/locks.ts");
        } else {
            assert.equal(toGraphPath("tools/lib/locks.ts"), "tools/lib/locks.ts");
        }
    });
});

describe("uidToHex16", () => {
    it("hashes the WHOLE uid — Label||key=value uids must not collide by prefix", () => {
        // The old parseInt(uid.slice(0,4), 16) mapped every 'File||…' and
        // 'Function||…' uid to 0x000f. These four share long prefixes and
        // must still land in different subnets.
        const hashes = new Set([
            uidToHex16("Function||name=extractCalls||file=scripts/graph_builder.js"),
            uidToHex16("Function||name=extractCallbacks||file=scripts/graph_builder.js"),
            uidToHex16("File||path=scripts/graph_builder.js"),
            uidToHex16("File||path=server/bridge.js"),
        ]);
        assert.equal(hashes.size, 4, "expected 4 distinct subnet hashes");
    });

    it("is deterministic", () => {
        const uid = "Function||name=transitionLocks||file=tools/lib/locks.ts";
        assert.equal(uidToHex16(uid), uidToHex16(uid));
    });

    it("stays within 16 bits and handles empty input", () => {
        assert.equal(uidToHex16(""), 0);
        assert.equal(uidToHex16(null), 0);
        for (const uid of ["a", "Task||taskId=task-1", "x".repeat(500)]) {
            const h = uidToHex16(uid);
            assert.ok(h >= 0 && h <= 0xffff, `hash out of range: ${h}`);
        }
    });
});

describe("makeIpv6", () => {
    it("assembles the hierarchy into 8 groups", () => {
        const addr = makeIpv6(1, 0xabb8, 0xd810);
        assert.equal(addr, "fd00:0001:abb8:d810:0000:0000:0000:0000");
    });

    it("hex4 pads and masks to 16 bits", () => {
        assert.equal(hex4(0xf), "000f");
        assert.equal(hex4(0x1abcd), "abcd"); // masked to 16 bits
    });
});

describe("resolveImportPath", () => {
    const files = new Set([
        "codevis.config.js",
        "server/bridge.js",
        "server/ladybug-driver.cjs",
        "tools/lib/locks.ts",
        "tools/lib/index.ts",
    ]);

    it("resolves a relative import against stored forward-slash paths", () => {
        const r = resolveImportPath("'./ladybug-driver.cjs'", "server/bridge.js", files);
        assert.equal(r.resolved, "server/ladybug-driver.cjs");
        assert.equal(r.isExternal, false);
    });

    it("resolves directory imports to index files", () => {
        const r = resolveImportPath("'../lib'", "tools/handlers/task-tools.ts", files);
        assert.equal(r.resolved, "tools/lib/index.ts");
    });

    it("treats bare specifiers as external modules", () => {
        const r = resolveImportPath("'express'", "server/bridge.js", files);
        assert.equal(r.isExternal, true);
        assert.equal(r.moduleName, "express");
    });

    it("never resolves a file to itself (config shim self-edge)", () => {
        // codevis.config.js requires './codevis.config.cjs'; extension
        // stripping maps that back onto the shim itself — must NOT resolve.
        const r = resolveImportPath("'./codevis.config.cjs'", "codevis.config.js", files);
        assert.notEqual(r.resolved, "codevis.config.js");
    });
});

describe("findFiles exclude globs", () => {
    it("prunes matching directories and files while keeping siblings", () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "codevis-exclude-"));
        try {
            fs.mkdirSync(path.join(root, "src", "doc"), { recursive: true });
            fs.mkdirSync(path.join(root, "src", "app"), { recursive: true });
            fs.writeFileSync(path.join(root, "src", "doc", "generated.js"), "");
            fs.writeFileSync(path.join(root, "src", "app", "bundle.min.js"), "");
            fs.writeFileSync(path.join(root, "src", "app", "main.js"), "");

            const excludeMatchers = __testing__.compileExcludeMatchers(["**/doc/**", "**/*.min.js"]);
            const files = __testing__.findFiles(path.join(root, "src"), [".js"], [], {
                baseDir: root,
                excludeMatchers,
            }).map((file) => path.relative(root, file).replace(/\\/g, "/"));

            assert.deepEqual(files, ["src/app/main.js"]);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});

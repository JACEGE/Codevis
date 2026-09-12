/**
 * read_snapshot_cli.cjs — dump one graph's snapshot to a JSON file.
 *
 * Usage: node read_snapshot_cli.cjs <workspace> <outFile>
 *        (with CODEVIS_PROJECT_DIR pointing at the project that owns the graph)
 *
 * Why a separate process instead of a function call: server/codevis-paths.cjs
 * resolves the project root, data dir and daemon port ONCE at module load, and
 * Node caches the module. A single process therefore can only ever talk to one
 * database. `diff-graph` needs two — the current checkout and the branch under
 * review — so each read runs in its own process with its own environment.
 *
 * The result goes to a file rather than stdout: a structural snapshot of a
 * real repository is tens of megabytes of JSON, which is a pipe-buffer problem
 * waiting to happen.
 */

"use strict";

const fs = require("fs");
const path = require("path");

const ladybug = require("../../server/ladybug-driver.cjs");

const paths = require("../../server/codevis-paths.cjs");
const { readSnapshot } = require("./graph_snapshot.cjs");

async function main() {
    const ws = process.argv[2] || "target";
    const outFile = process.argv[3];
    if (!outFile) {
        console.error("usage: read_snapshot_cli.cjs <workspace> <outFile>");
        process.exit(2);
    }

    const config = paths.loadConfig();
    const wsConfig = config.workspaces && config.workspaces[ws];
    if (!wsConfig) {
        console.error(`Unknown workspace '${ws}'. Known: ${Object.keys(config.workspaces || {}).join(", ")}`);
        process.exit(2);
    }

    const driver = ladybug.driver(
        (wsConfig.dbUri || wsConfig.neo4jUri),
        ladybug.auth.basic(wsConfig.auth.user, wsConfig.auth.pass)
    );
    const session = driver.session();
    try {
        const snap = await readSnapshot(session, { label: `${ws}@${paths.PROJECT_ROOT}` });
        fs.mkdirSync(path.dirname(outFile), { recursive: true });
        fs.writeFileSync(outFile, JSON.stringify({
            label: snap.label,
            projectRoot: paths.PROJECT_ROOT,
            nodes: [...snap.nodes.values()],
            edges: [...snap.edges.values()],
        }), "utf8");
        console.error(`[snapshot] ${snap.nodes.size} nodes, ${snap.edges.size} edges -> ${outFile}`);
    } finally {
        await session.close();
        await driver.close();
    }
}

main().catch((e) => {
    console.error(e.message || e);
    process.exit(1);
});

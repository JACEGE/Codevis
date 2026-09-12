#!/usr/bin/env node
/**
 * codevis diff-graph <ref> [--base <ref>] — diff two commits' code graphs.
 *
 * A textual diff shows the lines a branch touched. This shows what those lines
 * did to the structure: which functions, classes and modules appeared or
 * vanished, which edges (calls, imports, renders, state access) were created or
 * cut, and — the part no patch can show — which UNCHANGED code is now wired to
 * the change.
 *
 * How it works, for BOTH sides:
 *   1. `git worktree add` the commit into a cache dir, so the working tree is
 *      never touched and the review needs no stash/checkout dance.
 *   2. Build a full graph of that worktree into its OWN data dir. Separate dir
 *      = separate daemon = separate single-writer lock; the project's live
 *      graph keeps working while this runs.
 *   3. Read a structural snapshot and compare by natural key (label + name +
 *      file). Not by uid: uids come from a per-database sequence counter and
 *      are meaningless across two builds.
 *
 * Step 2 runs for the base as well, deliberately, instead of reusing the
 * project's live graph. The live graph is maintained incrementally and still
 * carries nodes for deleted files, so comparing it against a fresh build
 * reports hundreds of differences that no commit caused.
 *
 * Worktree and graph are cached under .codevis/diff/<sha>, so the base is built
 * once and every later run against it is fast. `--rebuild` forces a fresh
 * build, `--clean` removes both sides' caches afterwards.
 */

import { resolve, dirname, join, sep } from "path";
import { fileURLToPath } from "url";
import { execFileSync, spawnSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { createRequire } from "module";
import { createHash } from "crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(__dirname, "../..");
const require = createRequire(import.meta.url);
const ui = require("../terminal-ui.cjs");
const { normalizeWorkspaceName, publicWorkspaceName } = require("../workspace-names.cjs");

const { diffSnapshots, renderText, renderMermaid } = require(
    resolve(packageRoot, "scripts/diff/graph_diff.cjs")
);

export function parseArgs(argv) {
    const opts = {
        ref: null, base: "HEAD", ws: "target", format: "text", out: null,
        rebuild: false, clean: false, keepDaemon: false, limit: 25,
    };
    const valueAfter = (index, flag) => {
        const value = argv[index + 1];
        if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value`);
        return value;
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--base") opts.base = valueAfter(i++, a);
        else if (a === "--ws") opts.ws = normalizeWorkspaceName(valueAfter(i++, a));
        else if (a === "--format") opts.format = valueAfter(i++, a);
        else if (a === "--out") opts.out = valueAfter(i++, a);
        else if (a === "--limit") {
            const value = Number(valueAfter(i++, a));
            if (!Number.isInteger(value) || value < 1) throw new Error("--limit must be a positive integer");
            opts.limit = value;
        }
        else if (a === "--rebuild") opts.rebuild = true;
        else if (a === "--clean") opts.clean = true;
        else if (a === "--keep-daemon") opts.keepDaemon = true;
        else if (a.startsWith("-")) throw new Error(`Unknown option: ${a}`);
        else if (!opts.ref) opts.ref = a;
        else throw new Error(`Unexpected argument: ${a}`);
    }
    if (!opts.ref) throw new Error("Missing <ref>. Usage: codevis diff-graph <branch|commit> [--ws project_db|codevis_db]");
    if (!["text", "mermaid", "json"].includes(opts.format)) {
        throw new Error(`Unknown --format '${opts.format}'. Use text, mermaid or json.`);
    }
    return opts;
}

function git(args, cwd) {
    const r = spawnSync("git", args, { cwd, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${(r.stderr || "").trim()}`);
    return (r.stdout || "").trim();
}

/**
 * Stop the daemon that served the diff graph.
 *
 * Deliberately delayed: the daemon flushes its WAL into the main database file
 * after ~3s of inactivity (LADYBUG_CHECKPOINT_IDLE_MS). Killing it before that
 * leaves an un-checkpointed WAL, which replays as a corrupt WAL on the next
 * open and quarantines everything written since the last checkpoint — i.e. the
 * cached graph this command just spent minutes building.
 */
async function stopDiffDaemon(dataDir) {
    const pidfile = join(dataDir, ".ladybug-daemon.pid");
    if (!existsSync(pidfile)) return;
    let pid = null;
    try {
        const raw = readFileSync(pidfile, "utf8").trim();
        const parsed = JSON.parse(raw);
        pid = Number.isInteger(parsed) ? parsed : parsed.pid;
    } catch (_) {
        return;
    }
    if (!pid) return;
    await new Promise((r) => setTimeout(r, 4000));
    try {
        process.kill(pid, "SIGTERM");
    } catch (_) { /* already gone */ }
}

/**
 * Files whose content decides what a build puts in the graph.
 *
 * The cache key is the commit — but a graph is a function of the commit AND the
 * builder that read it. Change an extractor, and a cached graph from an hour ago
 * is no longer comparable to one built now: the diff then reports the builder's
 * evolution as if the branch had caused it. That is the same class of error as
 * comparing the live graph against a fresh build, and it is harder to spot
 * because both sides look freshly built.
 */
const BUILDER_INPUTS = [
    "scripts/graph_builder.js",
    "scripts/ladybug_schema.cjs",
    "scripts/extractors.cjs",
    "scripts/ros/ros_model.js",
];

/** Fingerprint of the builder + the extractor settings that apply to this run. */
function builderFingerprint(packageRoot, extractorsEnabled) {
    const hash = createHash("sha256");
    for (const rel of BUILDER_INPUTS) {
        const p = resolve(packageRoot, rel);
        hash.update(rel);
        // A missing input is itself a distinguishing fact — record it rather than
        // skipping, so an older checkout does not fingerprint like a newer one.
        hash.update(existsSync(p) ? readFileSync(p) : "<absent>");
    }
    hash.update(JSON.stringify(extractorsEnabled || {}));
    return hash.digest("hex").slice(0, 16);
}

/**
 * Environment for a build/read against an isolated graph. Blanking the explicit
 * overrides matters: inheriting LADYBUG_META_PATH or a fixed daemon port from
 * the caller would point the diff build at the project's LIVE database and
 * corrupt the very graph it is supposed to leave alone.
 */
function isolatedEnv(worktree, dataDir) {
    return {
        ...process.env,
        CODEVIS_PROJECT_DIR: worktree,
        CODEVIS_DATA_DIR: dataDir,
        LADYBUG_DAEMON_PORT: "",
        LADYBUG_PIDFILE: "",
        LADYBUG_META_PATH: "",
        LADYBUG_TARGET_PATH: "",
    };
}

/**
 * Read a build marker. Markers written before fingerprinting was added hold a
 * bare ISO timestamp — those are treated as "unknown builder", which forces one
 * rebuild rather than trusting a graph whose origin cannot be established.
 */
function readMarker(path) {
    if (!existsSync(path)) return null;
    try {
        const parsed = JSON.parse(readFileSync(path, "utf8"));
        return typeof parsed === "object" && parsed ? parsed : { builtAt: String(parsed), fingerprint: null };
    } catch (_) {
        return { builtAt: null, fingerprint: null };
    }
}

export default async function diffGraph(argv) {
    const opts = parseArgs(argv);
    const paths = require(resolve(packageRoot, "server/codevis-paths.cjs"));
    const projectRoot = paths.PROJECT_ROOT;
    const cacheRoot = join(projectRoot, ".codevis", "diff");
    const snapDir = join(cacheRoot, "snapshots");
    mkdirSync(snapDir, { recursive: true });

    // Both sides must be built by the same builder with the same extractor
    // settings, or the diff describes the tool rather than the branch.
    const { resolveExtractors } = require(resolve(packageRoot, "scripts/extractors.cjs"));
    const config = paths.loadConfig();
    const fingerprint = builderFingerprint(packageRoot, resolveExtractors(config, opts.ws).enabled);

    /**
     * Check out a ref and build a full graph of it in its own data dir.
     *
     * Both sides of the diff go through this, and that is the point. The first
     * version compared the project's LIVE graph against a fresh build, which
     * produced hundreds of phantom changes: the live graph is maintained
     * incrementally, still holds nodes for deleted files, and resolves some
     * call targets differently than a from-scratch run. Comparing two graphs
     * built the same way from clean checkouts is the only way the output means
     * "the branch did this" rather than "these graphs were built differently".
     */
    const materialize = (ref, tag) => {
        const sha = git(["rev-parse", "--verify", `${ref}^{commit}`], projectRoot);
        const short = sha.slice(0, 12);
        const subject = git(["log", "-1", "--format=%s", sha], projectRoot);
        const worktree = join(cacheRoot, `wt-${short}`);
        const dataDir = join(cacheRoot, `db-${short}`);
        const built = join(dataDir, `.built-${short}`);

        if (opts.rebuild) {
            if (existsSync(worktree)) git(["worktree", "remove", "--force", worktree], projectRoot);
            if (existsSync(dataDir)) rmSync(dataDir, { recursive: true, force: true });
        }
        if (!existsSync(worktree)) {
            console.log(`[${tag}] checking out ${short} (${subject})`);
            git(["worktree", "add", "--detach", worktree, sha], projectRoot);
        }
        const cached = readMarker(built);
        if (cached && cached.fingerprint === fingerprint) {
            console.log(`[${tag}] reusing cached graph for ${short} (--rebuild to force)`);
        } else {
            if (cached) {
                console.log(`[${tag}] cached graph for ${short} was built by a different builder version — rebuilding`);
                rmSync(dataDir, { recursive: true, force: true });
                mkdirSync(dataDir, { recursive: true });
            }
            console.log(`[${tag}] building graph for ${short} — full build, this takes a while`);
            mkdirSync(dataDir, { recursive: true });
            execFileSync("node", [resolve(packageRoot, "scripts/graph_builder.js"), opts.ws], {
                cwd: worktree,
                stdio: "inherit",
                env: isolatedEnv(worktree, dataDir),
            });
            writeFileSync(built, JSON.stringify({ builtAt: new Date().toISOString(), fingerprint }), "utf8");
        }
        return { ref, sha, short, subject, worktree, dataDir };
    };

    const reader = resolve(packageRoot, "scripts/diff/read_snapshot_cli.cjs");
    const readSnapshotOf = (side) => {
        const file = join(snapDir, `${opts.ws}-${side.short}.json`);
        execFileSync("node", [reader, opts.ws, file], {
            cwd: side.worktree,
            stdio: ["ignore", "inherit", "inherit"],
            env: isolatedEnv(side.worktree, side.dataDir),
        });
        const raw = JSON.parse(readFileSync(file, "utf8"));
        return {
            label: raw.label,
            nodes: new Map(raw.nodes.map((n) => [n.key, n])),
            edges: new Map(raw.edges.map((e) => [e.key, e])),
        };
    };

    console.log(`${ui.title("CodeVis", "structural graph diff")}\n${ui.section("Compare")}`);
    console.log(`  base             ${opts.base}`);
    console.log(`  ref              ${opts.ref}`);
    console.log(`  workspace        ${publicWorkspaceName(opts.ws)}\n`);

    const base = materialize(opts.base, "base");
    const head = materialize(opts.ref, "head");
    if (base.sha === head.sha) throw new Error(`--base and <ref> resolve to the same commit (${base.short}).`);

    console.log(`${ui.badge("READ", "cyan")} snapshots`);
    const baseSnap = readSnapshotOf(base);
    const headSnap = readSnapshotOf(head);

    console.log(`${ui.badge("DIFF", "cyan")} comparing\n`);
    const diff = diffSnapshots(baseSnap, headSnap);

    const output = opts.format === "json"
        ? JSON.stringify(diff, null, 2)
        : opts.format === "mermaid"
            ? renderMermaid(diff)
            : renderText(diff, { limit: opts.limit });

    if (opts.out) {
        const target = resolve(projectRoot, opts.out);
        // Containment: an --out of '../../etc/x' must not write outside the
        // project. Same rule the rest of CodeVis applies to agent-supplied paths.
        if (target !== projectRoot && !target.startsWith(projectRoot + sep)) {
            throw new Error(`--out must stay inside the project: ${opts.out}`);
        }
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, output, "utf8");
        console.log(`${ui.badge("SAVED", "green")} ${opts.out}`);
    } else {
        console.log(output);
    }

    // Both sides ran their own daemon; neither should outlive the command
    // (--keep-daemon leaves them up when you want to query the graphs yourself).
    if (!opts.keepDaemon) {
        for (const side of [base, head]) await stopDiffDaemon(side.dataDir);
    }

    if (opts.clean) {
        for (const side of [base, head]) {
            git(["worktree", "remove", "--force", side.worktree], projectRoot);
            rmSync(side.dataDir, { recursive: true, force: true });
        }
        console.log(`\ncache for ${base.short} and ${head.short} removed`);
    } else {
        console.log(`\ncache kept in ${cacheRoot} — re-runs are instant, '--clean' removes it`);
    }
}

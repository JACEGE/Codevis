/**
 * doctor.cjs — turn collected facts about a CodeVis installation into findings.
 *
 * Pure: facts in, findings + text out. No I/O, so every diagnosis rule is
 * unit-testable without daemons, ports or a database.
 *
 * The rules come from failures that actually happened rather than from a
 * checklist: a daemon that died because its derived port belonged to a Windows
 * service, a driver that refused its own daemon over a drive-letter case
 * mismatch, a pidfile pointing at a process that no longer exists, and several
 * daemons sharing one database directory where only one can hold the lock.
 * Each of those looked identical from the outside — "did not become healthy" —
 * which is why they belong in a command instead of in someone's memory.
 */

"use strict";

const { colorEnabled, paint, link, title, section, badge } = require("../../lib/terminal-ui.cjs");

const LEVELS = { ok: "ok", warn: "warn", error: "error" };

/** Compare two directory paths the way the daemon identity check has to. */
function sameDir(a, b, platform = process.platform) {
    if (!a || !b) return false;
    const norm = (p) => (platform === "win32" ? String(p).replace(/\\/g, "/").toLowerCase() : String(p));
    return norm(a).replace(/\/+$/, "") === norm(b).replace(/\/+$/, "");
}

/**
 * @param {object} facts
 * @param {string} facts.dataDir
 * @param {number} facts.preferredPort  Port derived from the project path.
 * @param {object|null} facts.pidfile   { pid, port, dataDir } or null.
 * @param {boolean} facts.pidAlive
 * @param {Array<{port: number, ok: boolean, pid: number, dataDir: string|null, canQuery: boolean|null}>} facts.daemons
 * @param {{port: number, reachable: boolean}} facts.bridge
 * @param {Array<{name: string, exists: boolean, sizeBytes: number, mtime: string|null}>} facts.databases
 * @param {string[]} facts.quarantinedWals
 * @param {string} [facts.platform]
 * @returns {Array<{level: string, title: string, detail: string}>}
 */
function diagnose(facts) {
    const findings = [];
    const platform = facts.platform || process.platform;
    const mine = (facts.daemons || []).filter((d) => d.ok && sameDir(d.dataDir, facts.dataDir, platform));

    if (facts.usingLegacyDataDir && !facts.explicitDataDir) {
        findings.push({
            level: LEVELS.warn,
            title: "Legacy data directory in use",
            detail: `This checkout still uses '${facts.dataDir}' because it contains an existing database. `
                + "This compatibility path remains supported. To migrate, stop attached clients and CodeVis first, "
                + "then follow docs/USER_WORKFLOW.md; or keep this location by setting CODEVIS_DATA_DIR explicitly.",
        });
    }

    // --- daemon reachability ------------------------------------------------
    if (mine.length === 0) {
        findings.push({
            level: LEVELS.warn,
            title: "No daemon serving this project",
            detail: "Nothing is listening for this data directory. That is normal when nothing has "
                + "touched the graph yet — the driver starts one on demand. If a query still fails, "
                + "the port section below shows what is occupying the ports it would use.",
        });
    }

    // --- several daemons, one database --------------------------------------
    // Only one can hold the single-writer lock; the others answer /health and
    // then fail every query, which reads like a broken database.
    if (mine.length > 1) {
        findings.push({
            level: LEVELS.error,
            title: `${mine.length} daemons share this data directory`,
            detail: `Ports ${mine.map((d) => d.port).join(", ")} all serve ${facts.dataDir}. Only the one `
                + "holding the database lock can answer queries; the rest fail every request. Stop the "
                + "ones that cannot query (see 'lock' below) and point the pidfile at the survivor.",
        });
    }

    const lockless = mine.filter((d) => d.canQuery === false);
    if (lockless.length > 0 && mine.length > 1) {
        findings.push({
            level: LEVELS.error,
            title: "Daemon(s) without the database lock",
            detail: `Port(s) ${lockless.map((d) => d.port).join(", ")} answer /health but cannot read the `
                + "database. Anything routed to them fails with a lock error that looks like corruption "
                + "but is not.",
        });
    }

    // --- pidfile ------------------------------------------------------------
    if (facts.pidfile && !facts.pidAlive) {
        findings.push({
            level: LEVELS.warn,
            title: "Stale pidfile",
            detail: `The pidfile names pid ${facts.pidfile.pid}, which is not running. A driver reads this `
                + "first, finds nothing, and spawns a replacement — harmless, but it hides which daemon "
                + "is really serving the graph.",
        });
    }
    if (facts.pidfile && facts.pidAlive) {
        const target = mine.find((d) => d.port === facts.pidfile.port);
        if (!target) {
            findings.push({
                level: LEVELS.error,
                title: "Pidfile points at the wrong port",
                detail: `The pidfile says port ${facts.pidfile.port}, but no daemon for this project answers `
                    + "there. Clients that trust the pidfile will not find the running daemon.",
            });
        } else if (target.canQuery === false) {
            findings.push({
                level: LEVELS.error,
                title: "Pidfile points at a daemon that cannot read the database",
                detail: `Port ${target.port} is published as the daemon for this project but does not hold `
                    + "the lock. Every query routed through the pidfile fails.",
            });
        }
    }

    // --- identity mismatch --------------------------------------------------
    // The daemon's reported dataDir is its identity. A path that differs only in
    // case is the same directory on Windows but a different string — which is
    // exactly how a project ended up refusing its own daemon.
    for (const d of mine) {
        if (d.dataDir && d.dataDir !== facts.dataDir) {
            findings.push({
                level: LEVELS.warn,
                title: `Daemon on port ${d.port} reports a differently spelled path`,
                detail: `It reports '${d.dataDir}', this process resolved '${facts.dataDir}'. Same directory, `
                    + "different spelling — usually a drive-letter case difference between the shell and "
                    + "CODEVIS_PROJECT_DIR in .mcp.json. Harmless now (the comparison is case-insensitive "
                    + "on Windows), but it is worth making the two agree.",
            });
        }
    }

    // --- ports held by something else ---------------------------------------
    const foreign = (facts.daemons || []).filter((d) => d.ok && d.dataDir && !sameDir(d.dataDir, facts.dataDir, platform));
    if (foreign.length > 0) {
        findings.push({
            level: LEVELS.ok,
            title: "Another project's daemon nearby",
            detail: `Port(s) ${foreign.map((d) => d.port).join(", ")} serve a different data directory. `
                + "That is fine — ports are derived per project and bumped on collision.",
        });
    }

    if (facts.bridge?.reachable && facts.bridge.projectRoot && facts.bridge.dataDir && (
        !sameDir(facts.bridge.projectRoot, facts.projectRoot, platform)
        || !sameDir(facts.bridge.dataDir, facts.dataDir, platform)
    )) {
        findings.push({
            level: "error",
            title: "Bridge belongs to another project",
            detail: `The bridge on port ${facts.bridge.port} reports project '${facts.bridge.projectRoot}' `
                + `and data dir '${facts.bridge.dataDir}', but this CLI expects '${facts.projectRoot}' `
                + `and '${facts.dataDir}'. Stop that bridge and restart the dashboard from this project.`,
        });
    }
    if (facts.preferredPortBlockedBy) {
        const fallback = facts.pidAlive && mine.find((d) => d.canQuery === true
            && d.port !== facts.preferredPort && d.port === facts.pidfile?.port && d.pid === facts.pidfile?.pid);
        findings.push({
            level: fallback ? LEVELS.ok : LEVELS.warn,
            title: `Preferred port ${facts.preferredPort} is not usable`,
            detail: fallback
                ? `${facts.preferredPortBlockedBy}. The daemon is healthy on port ${fallback.port}, published in the pidfile. No port change is needed.`
                : `${facts.preferredPortBlockedBy}. The daemon skips to the next free port and publishes `
                + "the one it actually bound in the pidfile, so this is only a problem if a client "
                + "re-derives the port instead of reading the pidfile.",
        });
    }

    // --- build in progress --------------------------------------------------
    // Worth its own finding because it explains away every other oddity below:
    // a full build deletes the code nodes before rewriting them, so counts read
    // low or inconsistent while it runs.
    if (facts.build && facts.build.alive) {
        findings.push({
            level: LEVELS.ok,
            title: `A ${facts.build.mode || ""} build is running on '${facts.build.workspace}'`.replace("  ", " "),
            detail: `Started ${facts.build.startedAt} (pid ${facts.build.pid}). Node counts are a moving `
                + "target until it finishes, and a full build empties the code nodes first — so an "
                + "incomplete graph right now is expected, not damage.",
        });
    }
    if (facts.build && !facts.build.alive) {
        findings.push({
            level: LEVELS.warn,
            title: "A build did not finish",
            detail: `The marker from pid ${facts.build.pid} (started ${facts.build.startedAt}) is still there, `
                + "but that process is gone. The graph is whatever the build had written when it died — "
                + "run the build again before trusting it.",
        });
    }

    // --- database files -----------------------------------------------------
    for (const db of facts.databases || []) {
        if (!db.exists) {
            if (facts.workMode === "planning" && db.name === "project_db") {
                findings.push({
                    level: LEVELS.ok,
                    title: "Planning mode — no code graph required",
                    detail: "Tasks, Epics, Knowledge and Specs create the project database when first used. "
                        + "Switch after code exists with 'codevis init code', then run 'codevis build full'.",
                });
                continue;
            }
            findings.push({
                level: LEVELS.warn,
                title: `No ${db.name} database yet`,
                detail: "Run 'codevis build' to create it. Until then every query returns nothing, which "
                    + "is easy to mistake for a broken graph.",
            });
        } else if (db.identity?.mismatch) {
            findings.push({
                level: LEVELS.error,
                title: `${db.name} belongs to different source directories`,
                detail: `Recorded: ${JSON.stringify(db.identity.recorded?.sourceDirs || [])}. `
                    + `Configured now: ${JSON.stringify(db.identity.expected?.sourceDirs || [])}. `
                    + "Move the database aside or restore the recorded sourceDir before building.",
            });
        } else if (db.identity && !db.identity.recorded) {
            findings.push({
                level: LEVELS.warn,
                title: `${db.name} identity is unverified`,
                detail: "No readable workspace marker was found, so the stored graph's source identity is unknown. "
                    + (db.identity.expected?.sourceDirs?.length
                        ? `Verify that the existing graph belongs to the configured sources before running 'codevis build ${db.name}' to record its identity.`
                        : "No source directories are configured. Identify the stored graph's project and configure its sources before rebuilding; an empty configuration cannot verify this graph."),
            });
        }
    }
    const recoveryFiles = facts.quarantinedRecoveryFiles ?? facts.quarantinedWals ?? [];
    if (recoveryFiles.length > 0) {
        findings.push({
            level: LEVELS.warn,
            title: `${recoveryFiles.length} quarantined ${facts.quarantinedRecoveryFiles ? "recovery" : "WAL"} file(s)`,
            detail: "Recovery artifacts were set aside after earlier WAL replay failures. Their presence does not establish current corruption; "
                + "this diagnostic cannot determine which writes, if any, are missing. Preserve these files for recovery review: "
                + recoveryFiles.join(", "),
        });
    }

    // --- bridge -------------------------------------------------------------
    if (facts.bridge && !facts.bridge.reachable) {
        findings.push({
            level: LEVELS.ok,
            title: "Bridge not running",
            detail: `Nothing answers on port ${facts.bridge.port}. Start it with 'codevis dashboard' if you `
                + "want the browser UI; the MCP tools do not need it.",
        });
    }

    return findings;
}

function shouldUseColor(stream = process.stdout, env = process.env) {
    return colorEnabled(stream, env);
}

function colorize(value, tone, enabled) {
    return paint(value, tone, enabled);
}

function distributionBar(value, max, width = 18) {
    const filled = max > 0 ? Math.max(1, Math.round((value / max) * width)) : 0;
    return `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
}

/** Human-readable report. JSON output is produced separately by the command. */
function render(facts, findings, options = {}) {
    const color = options.color ?? shouldUseColor(options.stream, options.env);
    const L = [];
    const kv = (k, v) => L.push(`  ${k.padEnd(16)} ${v}`);
    const bytes = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${n} B`);
    const heading = (name) => L.push(section(name, { color }));
    const state = (text, tone) => badge(text, tone, { color });

    L.push(title("CodeVis", "workspace health", { color }));
    heading("Workspace");
    kv("project", facts.projectRoot);
    kv("work mode", facts.workMode === "planning" ? "PLANNING (code builds disabled)" : "CODE GRAPH");
    kv("data dir", facts.dataDir);
    kv("config", facts.configPath || "(none found)");
    L.push("");

    heading("Services");
    kv("preferred port", String(facts.preferredPort));
    kv("pidfile", facts.pidfile
        ? `pid ${facts.pidfile.pid}, port ${facts.pidfile.port}${facts.pidAlive ? "" : "  (process gone)"}`
        : "(none)");
    const mine = (facts.daemons || []).filter((d) => d.ok && sameDir(d.dataDir, facts.dataDir, facts.platform));
    if (mine.length === 0) {
        kv("daemon", `${state("IDLE", "yellow")} none for this project`);
    } else {
        for (const d of mine) {
            const lock = d.canQuery === true ? "holds DB lock" : d.canQuery === false ? "NO lock — queries fail" : "lock unknown";
            const tone = d.canQuery === false ? "red" : d.canQuery === true ? "green" : "yellow";
            kv(`daemon :${d.port}`, `${state(d.canQuery === false ? "ERROR" : "ONLINE", tone)} pid ${d.pid}, ${lock}`);
        }
    }
    kv("bridge", `${state(facts.bridge.reachable ? "ONLINE" : "IDLE", facts.bridge.reachable ? "green" : "yellow")} port ${facts.bridge.port}`);
    if (facts.bridge.reachable) {
        const url = `http://localhost:${facts.bridge.port}`;
        kv("dashboard", link(url, url, options.stream, options.env));
    }
    L.push("");

    heading("Databases");
    if (facts.build && facts.build.alive) {
        kv("build", `RUNNING — ${facts.build.mode} build of '${facts.build.workspace}', pid ${facts.build.pid}, since ${facts.build.startedAt}`);
    }
    for (const db of facts.databases || []) {
        kv(db.name, db.exists ? `${bytes(db.sizeBytes)}   last written ${db.mtime}` : "not built yet");
        if (db.counts) {
            const top = Object.entries(db.counts).sort((a, b) => b[1] - a[1]).slice(0, 6);
            const max = top[0]?.[1] || 0;
            if (top.length === 0) kv("", "(empty)");
            for (const [label, n] of top) {
                const bar = colorize(distributionBar(n, max), "cyan", color);
                L.push(`    ${String(label).padEnd(14)} ${bar} ${String(n).padStart(7)}`);
            }
        }
    }
    L.push("");

    if (findings.length === 0) {
        L.push("No problems found.");
        return L.join("\n");
    }

    heading("Findings");
    const icon = {
        error: colorize("✗", "red", color),
        warn: colorize("!", "yellow", color),
        ok: colorize("•", "green", color),
    };
    for (const f of findings) {
        L.push(`  ${icon[f.level] || "·"} ${f.title}`);
        for (const line of wrap(f.detail, 76)) L.push(`      ${line}`);
    }
    return L.join("\n");
}

/** Wrap text to a width, so the report stays readable in a narrow terminal. */
function wrap(text, width) {
    const words = String(text).split(/\s+/);
    const lines = [];
    let line = "";
    for (const w of words) {
        if (line && (line.length + 1 + w.length) > width) {
            lines.push(line);
            line = w;
        } else {
            line = line ? `${line} ${w}` : w;
        }
    }
    if (line) lines.push(line);
    return lines;
}

module.exports = { diagnose, render, sameDir, wrap, distributionBar, shouldUseColor, LEVELS };

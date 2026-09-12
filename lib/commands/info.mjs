#!/usr/bin/env node
/**
 * codevis info — where is this project's graph, who is serving it, is it healthy.
 *
 * Answers the questions that otherwise require reading source: which port did
 * the daemon derive, which one did it actually bind, is the pidfile still
 * accurate, is anything else sitting on those ports, how big is the database and
 * when was it last written.
 *
 * `--json` prints the raw facts for scripting; the default is a report with
 * findings, so a broken setup names itself instead of surfacing as a generic
 * "daemon did not become healthy".
 */

import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";
import { existsSync, readFileSync, statSync, readdirSync } from "fs";
import { createRequire } from "module";
import http from "http";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(__dirname, "../..");
const require = createRequire(import.meta.url);

const { diagnose, render, sameDir } = require(resolve(packageRoot, "scripts/diag/doctor.cjs"));
const { RECOVERY_SUFFIXES } = require(resolve(packageRoot, "server/ladybug-recovery.cjs"));

/** How many ports above the derived one the daemon may bump to (see tryListen). */
const PORT_BUMP_RANGE = 10;

function httpJson(port, path, timeoutMs = 800) {
    return new Promise((resolveP) => {
        const req = http.request({ host: "127.0.0.1", port, path, method: "GET", timeout: timeoutMs }, (res) => {
            let body = "";
            res.on("data", (c) => { body += c; });
            res.on("end", () => {
                try {
                    resolveP({ status: res.statusCode, json: JSON.parse(body) });
                } catch (_) {
                    resolveP({ status: res.statusCode, json: null });
                }
            });
        });
        req.on("error", (e) => resolveP({ error: e.code || e.message }));
        req.on("timeout", () => { req.destroy(); resolveP({ error: "timeout" }); });
        req.end();
    });
}

/** Ask a daemon to run a trivial query — the only way to see who holds the lock. */
function canQuery(port, db, timeoutMs = 4000) {
    return new Promise((resolveP) => {
        const payload = JSON.stringify({ db, cypher: "MATCH (n) RETURN count(n) AS c LIMIT 1" });
        const req = http.request({
            host: "127.0.0.1", port, path: "/cypher", method: "POST", timeout: timeoutMs,
            headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
        }, (res) => {
            let body = "";
            res.on("data", (c) => { body += c; });
            res.on("end", () => {
                try {
                    const result = JSON.parse(body);
                    resolveP(res.statusCode === 200 && !result.error && Array.isArray(result.records));
                } catch (_) {
                    resolveP(false);
                }
            });
        });
        req.on("error", () => resolveP(null));
        req.on("timeout", () => { req.destroy(); resolveP(null); });
        req.write(payload);
        req.end();
    });
}

function readPidfile(pidfile) {
    if (!existsSync(pidfile)) return null;
    try {
        const raw = readFileSync(pidfile, "utf8").trim();
        const parsed = JSON.parse(raw);
        // Pre-2026-07 daemons wrote a bare pid, which is also valid JSON.
        return Number.isInteger(parsed) ? { pid: parsed, port: null, dataDir: null } : parsed;
    } catch (_) {
        return null;
    }
}

/**
 * The marker a running build writes into the data dir.
 *
 * `alive` matters as much as the marker's existence: a build that was killed
 * leaves the file behind, and reporting that as "build running" would be worse
 * than saying nothing.
 */
function readBuildMarker(markerPath) {
    if (!existsSync(markerPath)) return null;
    try {
        const raw = JSON.parse(readFileSync(markerPath, "utf8"));
        return { ...raw, alive: isAlive(raw.pid) };
    } catch (_) {
        return null;
    }
}

function isAlive(pid) {
    if (!pid) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        // EPERM means it exists but belongs to someone else — still alive.
        return e.code === "EPERM";
    }
}

function fileFacts(name, path) {
    if (!existsSync(path)) return { name, path, exists: false, sizeBytes: 0, mtime: null };
    const st = statSync(path);
    return { name, path, exists: true, sizeBytes: st.size, mtime: st.mtime.toISOString().replace("T", " ").slice(0, 19) };
}

export default async function info(argv) {
    const unknown = argv.filter((arg) => arg !== "--json");
    if (unknown.length) throw new Error(`Unknown option: ${unknown[0]}`);
    const asJson = argv.includes("--json");
    const paths = require(resolve(packageRoot, "server/codevis-paths.cjs"));
    const config = paths.loadConfig();

    const pidfile = readPidfile(paths.PIDFILE);
    const build = readBuildMarker(join(paths.DATA_DIR, ".build-in-progress"));
    const facts = {
        build,
        workMode: config.workMode === "planning" ? "planning" : "code",
        projectRoot: paths.PROJECT_ROOT,
        dataDir: paths.DATA_DIR,
        usingLegacyDataDir: paths.USING_LEGACY_DATA_DIR,
        explicitDataDir: Boolean(process.env.CODEVIS_DATA_DIR),
        configPath: ["codevis.config.cjs", "codevis.config.js"]
            .map((n) => join(paths.PROJECT_ROOT, n))
            .find((p) => existsSync(p)) || null,
        preferredPort: paths.DAEMON_PORT,
        pidfile,
        pidAlive: isAlive(pidfile && pidfile.pid),
        platform: process.platform,
        daemons: [],
        bridge: { port: paths.BRIDGE_PORT, reachable: false },
        databases: [],
        quarantinedWals: [],
        quarantinedRecoveryFiles: [],
    };

    // Scan the port the daemon prefers plus the range it may bump into, so a
    // daemon that had to skip an occupied port is still found.
    const ports = new Set();
    for (let p = paths.DAEMON_PORT; p <= 65535 && p < paths.DAEMON_PORT + PORT_BUMP_RANGE; p++) ports.add(p);
    if (pidfile && pidfile.port) ports.add(pidfile.port);

    for (const port of [...ports].sort((a, b) => a - b)) {
        const res = await httpJson(port, "/health");
        if (!res.json || res.json.ok !== true) {
            // Distinguish "nothing there" from "something refuses us": a port held
            // by a Windows service answers EACCES, and a daemon that dies on it
            // without retrying is invisible otherwise.
            if (port === paths.DAEMON_PORT && res.error && res.error !== "ECONNREFUSED") {
                facts.preferredPortBlockedBy = `port ${port} is occupied or refused (${res.error})`;
            }
            continue;
        }
        facts.daemons.push({
            port,
            ok: true,
            pid: res.json.pid,
            dataDir: res.json.dataDir || null,
            canQuery: null,
        });
    }

    // Only ask the ones that claim our data dir — a foreign daemon's lock state
    // is none of our business.
    for (const d of facts.daemons) {
        if (sameDir(d.dataDir, facts.dataDir)) {
            d.canQuery = await canQuery(d.port, "meta");
        }
    }

    const bridgeRes = await httpJson(facts.bridge.port, "/api/status");
    facts.bridge.reachable = bridgeRes.status === 200 && Boolean(bridgeRes.json);
    facts.bridge.projectRoot = bridgeRes.json?.projectRoot || null;
    facts.bridge.dataDir = bridgeRes.json?.dataDir || null;
    facts.bridge.pid = bridgeRes.json?.pid || null;

    for (const [name, path] of Object.entries(paths.DB_PATHS)) {
        const publicName = name === "target" ? "project_db" : name === "meta" ? "codevis_db" : name;
        const db = fileFacts(publicName, path);
        db.identity = paths.workspaceIdentityStatus(config, name);
        const daemon = facts.daemons.find((d) => d.canQuery === true);
        if (db.exists && daemon) db.counts = await labelCounts(daemon.port, name);
        facts.databases.push(db);
    }

    if (existsSync(facts.dataDir)) {
        facts.quarantinedRecoveryFiles = readdirSync(facts.dataDir).filter((f) =>
            RECOVERY_SUFFIXES.some((suffix) => f.includes(`${suffix}.corrupt-`)));
        facts.quarantinedWals = facts.quarantinedRecoveryFiles.filter((f) => f.includes(".wal.corrupt-"));
    }

    const findings = diagnose(facts);
    // Keep the same exit status in both human-readable and JSON output.
    if (findings.some((f) => f.level === "error")) process.exitCode = 1;
    if (asJson) {
        console.log(JSON.stringify({ facts, findings }, null, 2));
        return;
    }
    console.log(render(facts, findings));
}

/** Node counts per label, best-effort — a diagnostic must never fail on this. */
async function labelCounts(port, db) {
    return new Promise((resolveP) => {
        const payload = JSON.stringify({ db, cypher: "MATCH (n:CodeNode) RETURN n.label AS label, count(*) AS n" });
        const req = http.request({
            host: "127.0.0.1", port, path: "/cypher", method: "POST", timeout: 8000,
            headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
        }, (res) => {
            let body = "";
            res.on("data", (c) => { body += c; });
            res.on("end", () => {
                try {
                    const rows = JSON.parse(body).records || [];
                    const out = {};
                    for (const row of rows) {
                        const label = row.label;
                        const n = row.n && typeof row.n === "object" ? Number(row.n.__int64 ?? row.n.low ?? 0) : Number(row.n);
                        if (label) out[label] = n;
                    }
                    resolveP(out);
                } catch (_) {
                    resolveP(null);
                }
            });
        });
        req.on("error", () => resolveP(null));
        req.on("timeout", () => { req.destroy(); resolveP(null); });
        req.write(payload);
        req.end();
    });
}

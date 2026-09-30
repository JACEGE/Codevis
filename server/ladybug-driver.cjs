/**
 * ladybug-driver.cjs
 * ─────────────────────────────────────────────────────────────────────────
 * Embedded Ladybug client backed by server/ladybug-daemon.cjs.
 * Production callers select a database explicitly:
 *
 *     const ladybug = require('./server/ladybug-driver.cjs');
 *     const d = ladybug.workspace('project_db');
 *     const s = d.session();
 *     const result = await s.run('MATCH (n:Function) RETURN elementId(n) AS id');
 *
 * The record/transaction interface and Cypher translator are active Ladybug
 * infrastructure. The legacy driver(uri, auth) entry point remains for older
 * integrations; it does not connect to an external database server.
 *
 * Surface implemented (confirmed against server/bridge.js, tools/handlers/*,
 * scripts/runtime_profiler.js):
 *   - module.exports.workspace(name)
 *   - module.exports.driver(uri, authObj) (legacy)
 *   - module.exports.auth.basic(user, pass)
 *   - module.exports.int(x)                       (Integer-like wrapper)
 *   - driver.session()  -> { run(cypher, params), close(), executeWrite(fn),
 *                            executeRead(fn) }
 *   - driver.close()
 *   - run(...) resolves to { records, summary:{} }
 *       records: Array<Record> AND the result object is iterable over records
 *       Record: .get(key), .keys (array), .has(key), iterable over values,
 *               .toObject()
 *   - Integer codec: every INT64/BigInt returned from the DB is wrapped in an
 *     Integer wrapper: { toNumber(), toString(), valueOf(), low, high }.
 *     Strings/booleans/null pass through; arrays/lists pass through with their
 *     int elements wrapped too.
 *
 * Translation + daemon plumbing:
 *   - run() calls translate(cypher); if injectNow, binds __now=Date.now().
 *   - params are serialised: Integer wrappers and Integer shims are
 *     converted to JS BigInt (so Ladybug binds them as INT64); plain JS
 *     numbers that are integers are also sent as BigInt to match INT64 columns.
 *   - POSTs {db, cypher, params} to the daemon over loopback HTTP.
 *   - AUTO-SPAWN/ATTACH: on first use, GET /health; if down, spawn the daemon
 *     detached and poll /health for ~5s, then proceed. A pidfile + health
 *     check means a second client attaches instead of double-spawning.
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const { translate } = require('./ladybug-translate.cjs');
const { normalizeWorkspaceName } = require('../lib/workspace-names.cjs');

// ── Daemon endpoint config ───────────────────────────────────────────────────
// Shared with ladybug-daemon.cjs so client and daemon cannot disagree about the
// port or the data dir — see server/codevis-paths.cjs.
const paths = require('./codevis-paths.cjs');
const PROJECT_ROOT = paths.PROJECT_ROOT;
const DATA_DIR = paths.DATA_DIR;
const DAEMON_PORT = paths.DAEMON_PORT;
const DAEMON_HOST = paths.HOST;
const DAEMON_SCRIPT = path.join(__dirname, 'ladybug-daemon.cjs');
const PIDFILE = paths.PIDFILE;

// Writes need at-most-once delivery (see run()'s retry path). Mirrors the
// daemon's WRITE_RE so both sides agree on what counts as a mutating query.
const WRITE_RE = /\b(CREATE|MERGE|SET|DELETE|REMOVE|DROP|COPY)\b/i;

// ── 64-bit Integer wrapper ───────────────────────────────────────────────
// The app calls `.toNumber()`, `.toString()`, and relies on `valueOf()` for
// arithmetic/comparison. We back it with a BigInt to stay lossless for values
// beyond 2^53. Converting to a JS Number with .toNumber() can lose precision.
class Integer {
    constructor(bigintValue) {
        this._v = typeof bigintValue === 'bigint' ? bigintValue : BigInt(bigintValue);
    }
    toNumber() { return Number(this._v); }
    toInt() { return Number(this._v); }
    toString(radix) { return this._v.toString(radix); }
    toBigInt() { return this._v; }
    valueOf() { return Number(this._v); }
    // JSON.stringify support: emit a plain Number when safe (epoch-millis, seq
    // ids, counts all fit), else a decimal string. Without this, res.json() on a
    // row containing an INT64 field throws "Do not know how to serialize a BigInt".
    toJSON() {
        const n = Number(this._v);
        return Number.isSafeInteger(n) ? n : this._v.toString();
    }
    get low() { return Number(BigInt.asIntN(32, this._v)); }
    get high() { return Number(this._v >> 32n); }
    equals(other) {
        const o = other instanceof Integer ? other._v : BigInt(other);
        return this._v === o;
    }
    get [Symbol.toStringTag]() { return 'Integer'; }
}

/** int(x): wrap a JS number / string / bigint into an Integer. */
function int(x) {
    if (x instanceof Integer) return x;
    if (typeof x === 'bigint') return new Integer(x);
    if (typeof x === 'number') return new Integer(BigInt(Math.trunc(x)));
    if (typeof x === 'string') return new Integer(BigInt(x));
    if (x && typeof x.toBigInt === 'function') return new Integer(x.toBigInt());
    throw new Error(`ladybug.int(): cannot convert ${typeof x}`);
}

// ── Decode daemon wire values into graph result values ────────────────────
// The daemon tags INT64/BigInt as { __int64: "<decimal>" }. Rebuild Integer
// shims; recurse into arrays and plain objects (lists / maps).
function decodeValue(v) {
    if (v === null || v === undefined) return v;
    if (Array.isArray(v)) return v.map(decodeValue);
    if (typeof v === 'object') {
        if (typeof v.__int64 === 'string') {
            return new Integer(BigInt(v.__int64));
        }
        // plain map/object → decode each field
        const out = {};
        for (const k of Object.keys(v)) out[k] = decodeValue(v[k]);
        return out;
    }
    return v; // string | number | boolean
}

// ── Encode params for the daemon (INT64-aware) ───────────────────────────────
// Callers pass either plain JS values, Integer wrappers, or arrays
// thereof. Ladybug binds JS BigInt to INT64 columns. To keep INT64 comparisons
// (e.g. `WHERE id(n) IN $ids`, lock timestamps) correct, integers are sent as
// BigInt. Wire transport is JSON, which can't carry BigInt, so we tag the same
// way the daemon does and the daemon will receive native values via a reviver.
//
// We must NOT coerce floats to BigInt. Only safe integers / Integer wrappers
// become INT64; other numbers stay as JS numbers (DOUBLE).
function encodeParam(v) {
    if (v === null || v === undefined) return v;
    if (v instanceof Integer) return { __int64: v.toString() };
    if (typeof v === 'bigint') return { __int64: v.toString() };
    if (typeof v === 'number') {
        if (Number.isInteger(v)) return { __int64: String(v) };
        return v; // float → DOUBLE
    }
    // Accept compatible Integer wrappers from external callers.
    if (typeof v === 'object' && !Array.isArray(v)
        && typeof v.toNumber === 'function'
        && typeof v.low === 'number' && typeof v.high === 'number') {
        return { __int64: v.toString() };
    }
    if (Array.isArray(v)) return v.map(encodeParam);
    if (typeof v === 'object') {
        const out = {};
        for (const k of Object.keys(v)) out[k] = encodeParam(v[k]);
        return out;
    }
    return v; // string | boolean
}

function encodeParams(params) {
    const out = {};
    if (!params) return out;
    for (const k of Object.keys(params)) out[k] = encodeParam(params[k]);
    return out;
}

// ── HTTP to daemon ───────────────────────────────────────────────────────────

function httpGet(pathname, timeoutMs = 1000, port = activePort) {
    return new Promise((resolve, reject) => {
        const req = http.request(
            { host: DAEMON_HOST, port, path: pathname, method: 'GET', timeout: timeoutMs },
            (res) => {
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
            },
        );
        req.on('timeout', () => { req.destroy(new Error('timeout')); });
        req.on('error', reject);
        req.end();
    });
}

function httpPostJson(pathname, obj, timeoutMs = 120000) {
    const body = JSON.stringify(obj);
    return new Promise((resolve, reject) => {
        const req = http.request(
            {
                host: DAEMON_HOST,
                port: activePort,
                path: pathname,
                method: 'POST',
                timeout: timeoutMs,
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body),
                },
            },
            (res) => {
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => {
                    const raw = Buffer.concat(chunks).toString('utf8');
                    try {
                        resolve({ status: res.statusCode, json: JSON.parse(raw || '{}') });
                    } catch (e) {
                        reject(new Error(`bad daemon response (${res.statusCode}): ${raw.slice(0, 200)}`));
                    }
                });
            },
        );
        req.on('timeout', () => { req.destroy(new Error('daemon request timeout')); });
        req.on('error', reject);
        req.end(body);
    });
}

// ── Auto-spawn / attach ───────────────────────────────────────────────────────
let ensurePromise = null;

/**
 * The port we actually talk to. Starts at the port derived from the project, but
 * a daemon already serving this data dir wins — see discoverRunningPort().
 */
let activePort = paths.DAEMON_PORT;

/** Port every pre-2026-07 daemon listened on, before ports became per-project. */
const LEGACY_PORT = 7600;

/**
 * Ask whoever is listening on `port` who they are.
 *
 * Returns 'mine' | 'foreign' | 'dead'.
 *
 * "Something answered /health" is NOT good enough. Ports are derived from the
 * project path and bumped on collision, and pidfiles go stale — so the process
 * on a given port may well belong to a different project. Trusting it means
 * silently reading someone else's graph. The daemon therefore reports the data
 * dir it owns, and we only accept a match.
 *
 * `viaPidfile` covers daemons predating that field: they report no dataDir, but
 * we only reached them through the pidfile *inside our own data dir*, so they
 * are ours by construction. A dataDir-less daemon found by guessing a port gets
 * no such benefit of the doubt.
 */
/**
 * Compare two data-dir paths for "is this the same directory".
 *
 * Windows hands the same path back with a differing drive-letter case depending
 * on how the process was launched (`C:\...` from the shell, `c:\...` from the
 * CODEVIS_PROJECT_DIR written into .mcp.json), and `path.resolve` preserves that
 * case rather than normalising it. A raw `===` therefore declared the project's
 * OWN daemon foreign, so the driver spawned another one — which could not take
 * the single-writer lock the first one already held, failed every query, and was
 * replaced by yet another on the next call. `resolvePort` already lowercases for
 * exactly this reason; this is the same rule applied to the identity check.
 */
function sameDataDir(a, b) {
    // Physical identity: the same directory reached through a symlink
    // (macOS /tmp -> /private/tmp) or with different letter case on a
    // case-insensitive volume otherwise looked like a foreign daemon, and the
    // client spawned a second one that could only exit again.
    const norm = (p) => {
        let r;
        try { r = fs.realpathSync.native(p); } catch (_) { r = path.resolve(p); }
        return process.platform === 'win32' ? r.toLowerCase() : r;
    };
    return norm(a) === norm(b);
}

// Probes a candidate port without touching the shared `activePort`: requests
// already in flight read it, and a temporary switch sent them to the probed
// (possibly foreign) daemon. Only a daemon that owns our data dir is adopted.
async function probe(port, { viaPidfile = false } = {}) {
    try {
        const { status, body } = await httpGet('/health', 800, port);
        if (status !== 200) return 'dead';
        const health = JSON.parse(body);
        if (health.ok !== true) return 'dead';

        const mine = typeof health.dataDir === 'string'
            ? sameDataDir(health.dataDir, DATA_DIR)
            : viaPidfile; // legacy daemon reached through our own pidfile
        if (!mine) return 'foreign';
        activePort = port;
        return 'mine';
    } catch (_) {
        return 'dead';
    }
}

/**
 * The port a daemon that already owns this data dir is listening on, or null.
 *
 * The single-writer invariant is about the *database directory*, not the port.
 * Spawning because nothing answers on our preferred port would open a second
 * daemon on a database another daemon already holds — which is how a Kuzu
 * database gets corrupted. The pidfile lives in the data dir, so it is the
 * authoritative answer to "who owns this DB".
 */
async function discoverRunningPort() {
    let raw;
    try {
        raw = fs.readFileSync(PIDFILE, 'utf8').trim();
    } catch (_) {
        return null; // no pidfile → nobody claims this data dir
    }
    if (!raw) return null;

    let candidate = null;
    if (/^\d+$/.test(raw)) {
        // Bare pid → daemon from before per-project ports, which by definition
        // listened on the fixed port. Note a bare pid is also *valid JSON* (a
        // number), so this must be checked before parsing, not in a catch block.
        candidate = LEGACY_PORT;
    } else {
        try {
            const parsed = JSON.parse(raw);
            if (parsed && Number.isInteger(parsed.port)) candidate = parsed.port;
        } catch (_) {
            return null; // unreadable pidfile → treat as absent
        }
    }
    if (candidate === null) return null;

    // Stale pidfile (daemon died without cleaning up) → 'dead', and we spawn.
    return (await probe(candidate, { viaPidfile: true })) === 'mine' ? candidate : null;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * Ensure a daemon owning THIS data dir is reachable, spawning one if needed.
 * Memoised so concurrent run()s share a single spawn attempt.
 *
 * Order matters. The pidfile is asked first because it is the only authoritative
 * answer to "does someone already own this database": the preferred port is a
 * hash of the project path, so a foreign daemon can be sitting on it, and a
 * health check alone cannot tell the difference.
 */
/** Where a spawned daemon's stdout/stderr is captured. */
function daemonLogPath() {
    return process.env.LADYBUG_DAEMON_LOG || path.join(DATA_DIR, 'daemon.log');
}

/**
 * Turn the tail of the daemon logfile into something actionable to append to the
 * "did not become healthy" error, and recognise the one failure that is neither
 * a bug nor fixable from inside Node: the prebuilt @ladybugdb/core binary
 * needs a newer glibc than the host has (RHEL/Rocky 8 ships 2.28, the binary
 * wants >= 2.32). That one is worth naming explicitly — the raw linker error is
 * unrecognisable unless you already know what you are looking at.
 */
function daemonFailureHint(logPath) {
    let tail = '';
    try {
        const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
        tail = lines.slice(-15).join('\n');
    } catch (_) {
        return ` No output captured (expected ${logPath}).`;
    }
    if (!tail) return ` The daemon logged nothing (${logPath}).`;

    let hint = '';
    if (/GLIBC_|libstdc\+\+|version `?GLIBC/i.test(tail)) {
        hint =
            '\n\nThis host\'s glibc is too old for the prebuilt @ladybugdb/core binary. ' +
            'Run the daemon in a container with a newer glibc instead — mount the project ' +
            'at the SAME absolute path as on the host, because the daemon port is derived ' +
            'from it (see server/codevis-paths.cjs).';
    }
    return ` Last output from ${logPath}:\n${tail}${hint}`;
}

/**
 * A raw ECONNRESET only describes the socket, not the actionable failure.
 * It commonly occurs when the detached daemon exits or when several daemons
 * for one data directory race and the pidfile points at one without the DB
 * lock. Preserve the original error as the cause, but make the CLI output tell
 * the user where the evidence and the purpose-built diagnosis live.
 */
function daemonConnectionError(error) {
    const logPath = daemonLogPath();
    const detail = error && (error.code || error.message) || 'connection lost';
    const wrapped = new Error(
        `CodeVis lost the Ladybug database connection twice (${detail}). ` +
        `The graph update did not complete and the graph may now be stale.\n` +
        `Run "codevis info" in the project root to check for competing daemons, ` +
        `a wrong pidfile, or a database-lock problem.\n` +
        `Daemon log: ${logPath}`,
        { cause: error },
    );
    wrapped.code = error && error.code;
    return wrapped;
}

/** Hash of the schema this code expects; the daemon reports its own in /health. */
function wantedSchemaFingerprint() {
    const schema = require('../scripts/ladybug_schema.cjs');
    return crypto.createHash('sha256').update(schema.DDL.join('\n')).digest('hex').slice(0, 16);
}

/**
 * Does the attached daemon lack a table or column this code queries?
 *
 * A daemon outlives the code that started it: a project whose MCP server still
 * ran an older CodeVis kept an older daemon, and a newer dashboard then got
 * "Table HAS_PHASE does not exist" and drew an empty graph. The daemon only
 * adds its OWN schema when it opens a database, so it has to be restarted from
 * this code. A different fingerprint alone is no reason: a newer daemon serves
 * an older client fine, and restarting it would only start the two versions
 * taking turns. Only a missing table or column is. Unreadable catalog → false.
 */
async function daemonLacksSchema() {
    try {
        const health = JSON.parse((await httpGet('/health', 1000)).body);
        if (health.schemaFingerprint === wantedSchemaFingerprint()) return false;
        const schema = require('../scripts/ladybug_schema.cjs');
        const names = async (cypher) => {
            const { status, json } = await httpPostJson('/cypher', { db: 'target', cypher, params: {} }, 30000);
            if (status !== 200 || !Array.isArray(json?.records)) throw new Error(json?.error || `status ${status}`);
            return new Set(json.records.map((r) => r.name));
        };
        const tables = await names('CALL show_tables() RETURN name');
        if (Object.keys(schema.REL_SPECS).some((type) => !tables.has(type))) return true;
        const columns = await names(`CALL table_info('CodeNode') RETURN name`);
        if (schema.parseColumns(schema.NODE_TABLES[0]).some((c) => !columns.has(c.name))) return true;
        // Every rel table is built from the same property union, so one stands for all.
        const relColumns = await names(`CALL table_info('TOUCHED') RETURN name`);
        return schema.parseColumns(`X(${schema.REL_PROP_UNION.join(', ')})`).some((c) => !relColumns.has(c.name));
    } catch (_) {
        return false;
    }
}

function ensureDaemon() {
    if (ensurePromise) return ensurePromise;
    ensurePromise = (async () => {
        // 1. Someone already owns our data dir → attach. A second writer on the
        //    same Kuzu database is the one thing this daemon exists to prevent.
        // 2. No pidfile, but a daemon serving our data dir may still be up on the
        //    port we would derive (pidfile lost, same project). Accept it only if
        //    it confirms our data dir — a 'foreign' answer means someone else's
        //    project hashed onto this port, and we must NOT talk to it.
        if (await discoverRunningPort() || await probe(paths.DAEMON_PORT) === 'mine') {
            if (!await daemonLacksSchema()) return;
            // Older daemon: stop it cleanly (checkpoints the WAL) and spawn one
            // from this code, whose open path adds the missing schema.
            process.stderr.write('[ladybug] running daemon predates this CodeVis schema; restarting it\n');
            const { stopped, reason } = await stopDaemon();
            if (!stopped) throw new Error(`Could not restart the outdated ladybug daemon: ${reason}. Run "codevis stop" in the project, then retry.`);
        }

        // 3. Spawn. Env is passed through so test overrides (LADYBUG_*_PATH,
        //    LADYBUG_PIDFILE) reach the daemon. CODEVIS_PROJECT_DIR is pinned to
        //    the root *we* resolved: the detached child must not re-derive a
        //    different project from its own cwd. We do NOT pin the port — if it
        //    is taken, the daemon bumps and publishes the port it actually bound.
        //
        //    stderr goes to a logfile rather than 'ignore'. When the daemon dies
        //    on startup, the reason is ALWAYS on its stderr — a missing native
        //    symbol, an unreadable data dir, a glibc too old for the prebuilt
        //    @ladybugdb/core binary. Discarding it left only "did not become
        //    healthy within 5s", which names the symptom and hides every cause;
        //    diagnosing it meant re-running the daemon by hand to see what we
        //    had just thrown away.
        const logPath = daemonLogPath();
        let stderrFd = 'ignore';
        try {
            fs.mkdirSync(path.dirname(logPath), { recursive: true });
            stderrFd = fs.openSync(logPath, 'a');
        } catch (_) { /* unwritable data dir → fall back to discarding */ }

        const child = spawn(process.execPath, [DAEMON_SCRIPT], {
            detached: true,
            stdio: ['ignore', stderrFd, stderrFd],
            env: { ...process.env, CODEVIS_PROJECT_DIR: PROJECT_ROOT },
        });
        child.unref();
        // The child holds its own duplicate of the descriptor; ours would
        // otherwise keep an fd open in every long-lived client process.
        // Scheitert das Schließen, bleibt genau ein Deskriptor offen, den
        // das Prozessende ohnehin freigibt. Ein Wurf hier würde stattdessen
        // den Start des Daemons abbrechen, der bereits läuft.
        if (typeof stderrFd === 'number') { try { fs.closeSync(stderrFd); } catch (_) {} }

        // Poll the pidfile for the port the daemon really bound (may be our
        // preferred port + N after a collision), and verify it is serving us.
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
            await sleep(150);
            if (await discoverRunningPort()) return;
        }
        throw new Error(
            'ladybug daemon did not become healthy within 5s.' + daemonFailureHint(logPath)
        );
    })().catch((e) => {
        ensurePromise = null; // allow retry on next call
        throw e;
    });
    return ensurePromise;
}

// ── DB selection (meta vs target) ─────────────────────────────────────────────
// Only the legacy driver(uri, auth) API uses URI heuristics. Production code
// calls workspace(name), which validates the name and bypasses this mapping.
// Keep old integrations working without moving or opening different DB files.
const META_URI_HINTS = [
    process.env.CODEVIS_META_URI || process.env.NEO4J_META_URI || 'bolt://localhost:7688',
];

function pickDb(uri, authObj) {
    if (!uri) return 'target';
    if (META_URI_HINTS.includes(uri)) return 'meta';
    // Heuristic fallbacks: a "meta" hint in the uri or the password.
    const u = String(uri).toLowerCase();
    if (u.includes('7688') || u.includes('meta')) return 'meta';
    if (authObj && typeof authObj.password === 'string' && /meta/i.test(authObj.password)) return 'meta';
    return 'target';
}

// ── Record / Result shapes ────────────────────────────────────────────────────

class Record {
    constructor(obj) {
        this._obj = obj || {};
        this.keys = Object.keys(this._obj);
        this.length = this.keys.length;
        // Records also expose values by index; build an ordered array.
        this._values = this.keys.map((k) => this._obj[k]);
    }
    get(key) {
        if (typeof key === 'number') return this._values[key];
        return this._obj[key];
    }
    has(key) { return Object.prototype.hasOwnProperty.call(this._obj, key); }
    toObject() { return { ...this._obj }; }
    forEach(fn) { this.keys.forEach((k, i) => fn(this._obj[k], k, this)); }
    // Iterate over record field values.
    *[Symbol.iterator]() { yield* this._values; }
}

class Result {
    constructor(records, summary) {
        this.records = records;
        this.summary = summary || {};
    }
    // Results are async-iterable; the app mostly uses .records, but we make
    // the result iterable over records for `for (const r of result)` ergonomics.
    *[Symbol.iterator]() { yield* this.records; }
}

// ── Session ───────────────────────────────────────────────────────────────────

class Session {
    constructor(dbKey) {
        this._db = dbKey;
        this._closed = false;
    }

    async runReadOnly(cypher, params = {}) {
        require('./query-security.cjs').assertReadOnlyQuery(cypher);
        return this.run(cypher, params, { readOnly: true });
    }

    get workspace() { return require('../lib/workspace-names.cjs').publicWorkspaceName(this._db); }

    async changeOperation(options) {
        if (this._closed) throw new Error('session is closed');
        await ensureDaemon();
        const { status, json } = await httpPostJson('/changes/operation', {
            db: this._db, options, reqId: crypto.randomUUID(),
        });
        if (status === 404) throw new Error('Restart CodeVis to load Change workflow support.');
        if (status !== 200 || json.error) throw new Error(json.error || 'Change operation HTTP ' + status);
        return json.result;
    }

    async importSpecAtomic(options) {
        if (this._closed) throw new Error('session is closed');
        await ensureDaemon();
        const { status, json } = await httpPostJson('/spec/import', {
            db: this._db, options, reqId: crypto.randomUUID(),
        });
        if (status === 404) throw new Error('The running daemon predates atomic spec imports. Run codevis stop, then retry.');
        if (status !== 200 || json.error) throw new Error(json.error || `Spec import HTTP ${status}`);
        return json.result;
    }

    async epicMembershipAtomic(options) {
        if (this._closed) throw new Error('session is closed');
        await ensureDaemon();
        const { status, json } = await httpPostJson('/epics/membership', {
            db: this._db, options, reqId: crypto.randomUUID(),
        });
        if (status === 404) throw new Error('The running daemon predates atomic epic updates. Run codevis stop, then retry.');
        if (status !== 200 || json.error) throw new Error(json.error || `Epic update HTTP ${status}`);
        return json.result;
    }

    async syncGraphFileAtomic(snapshot) {
        if (this._closed) throw new Error('session is closed');
        await ensureDaemon();
        const { status, json } = await httpPostJson('/graph/sync-file', {
            db: this._db, snapshot, reqId: crypto.randomUUID(),
        });
        if (status === 404) throw new Error('The running daemon predates atomic graph file synchronization. Run codevis stop, then retry.');
        if (status !== 200 || json.error) throw new Error(json.error || `Graph file synchronization HTTP ${status}`);
        return json.result;
    }

    async syncKnowledgeAtomic(documents) {
        if (this._closed) throw new Error('session is closed');
        await ensureDaemon();
        const { status, json } = await httpPostJson('/knowledge/sync', {
            db: this._db, documents, reqId: crypto.randomUUID(),
        });
        if (status === 404) throw new Error('The running daemon predates atomic Markdown synchronization. Run codevis stop, then retry.');
        if (status !== 200 || json.error) throw new Error(json.error || `Knowledge synchronization HTTP ${status}`);
        return json.result;
    }

    async taskClaimAtomic(options) {
        if (this._closed) throw new Error('session is closed');
        await ensureDaemon();
        const { status, json } = await httpPostJson('/tasks/claims', {
            db: this._db, options, reqId: crypto.randomUUID(),
        });
        if (status === 404) throw new Error('The running daemon predates atomic task claims. Run codevis stop, then retry.');
        if (status !== 200 || json.error) throw new Error(json.error || `Task claim HTTP ${status}`);
        return json.result;
    }

    async run(cypher, params = {}, { readOnly = false } = {}) {
        if (this._closed) throw new Error('session is closed');

        const { cypher: translated, injectNow, creates } = translate(cypher);

        const outParams = encodeParams(params);
        if (injectNow && !('__now' in outParams) && !('__now' in (params || {}))) {
            // Bind the timestamp() replacement to current epoch-millis (INT64).
            outParams.__now = { __int64: String(Date.now()) };
        }
        // CREATE identity: the translator injected $__uidN / $__seqN placeholders
        // for each CREATE node pattern (single-table PK + id() replacement). Bind
        // them to sentinels the daemon resolves against its per-db seq counter
        // (seq = counter++, uid = prefix + seq) so handler CREATEs stay untouched.
        if (creates && creates.length) {
            for (const c of creates) {
                if (c.seqParam) outParams[c.seqParam] = { __nextseq: true };
                // MERGE rewrites compute uid in-query (no uidParam); only CREATE
                // injections need the uid sentinel.
                if (c.uidParam) outParams[c.uidParam] = { __newuid: c.prefix };
            }
        }

        // Write idempotency: the retry below re-POSTs the identical query on a
        // connection-level failure, but a daemon can COMMIT a write and only then
        // drop the response (reset mid-response). Re-running the write would
        // allocate fresh seq/uid sentinels daemon-side → a DUPLICATE node. So we
        // stamp every write with a request-id generated ONCE here; the daemon
        // remembers recent committed ids per DB and replays the original result
        // for a repeat instead of executing again. Reads carry no id and retry
        // freely; a write whose POST never reached the daemon has no cached id
        // there either, so it too retries and executes exactly once.
        const postBody = { db: this._db, cypher: translated, params: outParams };
        if (WRITE_RE.test(translated)) postBody.reqId = crypto.randomUUID();
        // A separate endpoint fails closed against an older daemon. An unknown
        // JSON flag on /cypher could otherwise silently execute a writable query.
        const endpoint = readOnly ? '/cypher/read-only' : '/cypher';

        await ensureDaemon();

        let status, json;
        try {
            ({ status, json } = await httpPostJson(endpoint, postBody));
        } catch (e) {
            // Daemon died AFTER our memoised ensureDaemon resolved (long-lived
            // processes like the bridge would otherwise error forever). Reset
            // the memo so ensureDaemon health-checks/respawns, then retry once.
            // Connection-level failures only — a request TIMEOUT may still be
            // executing in the daemon, and re-sending a write would double it.
            // The retry reuses postBody's reqId so a committed write is deduped.
            if (!/ECONNREFUSED|ECONNRESET|socket hang up/i.test(e.message || '')) throw e;
            ensurePromise = null;
            await ensureDaemon();
            try {
                ({ status, json } = await httpPostJson(endpoint, postBody));
            } catch (retryError) {
                if (/ECONNREFUSED|ECONNRESET|socket hang up/i.test(retryError.message || '')) {
                    throw daemonConnectionError(retryError);
                }
                throw retryError;
            }
        }

        if (readOnly && status === 404) {
            throw new Error('The running CodeVis daemon predates read-only queries. Run codevis stop, then retry.');
        }
        if (json && json.error) {
            throw new Error(`[ladybug] ${json.error}\n  query: ${translated}`);
        }
        if (status !== 200) {
            throw new Error(`[ladybug] daemon HTTP ${status}`);
        }

        const rawRows = Array.isArray(json.records) ? json.records : [];
        const records = rawRows.map((row) => {
            // Decode the row's tagged values, then wrap as a Record.
            const decoded = {};
            for (const k of Object.keys(row)) decoded[k] = decodeValue(row[k]);
            return new Record(decoded);
        });

        return new Result(records, {});
    }

    /**
     * Ladybug's JS binding exposes implicit statement transactions, but no
     * transaction object that can safely remain open across HTTP requests.
     * Pretending otherwise is dangerous: two tx.run() calls can interleave, and
     * the first write cannot be rolled back if the callback later fails.
     *
     * Fail loudly on a second statement instead. This keeps every supported
     * callback atomic at the engine/WAL level and tells future callers to fold
     * their operation into one Cypher statement. The counter increments before
     * forwarding, so concurrent or un-awaited second calls cannot slip through.
     */
    async _executeSingleStatement(fn, mode) {
        let runs = 0;
        const tx = {
            run: (cypher, params) => {
                runs++;
                if (runs > 1) {
                    throw new Error(
                        `[ladybug] ${mode} callback issued more than one tx.run(); ` +
                        'Ladybug supports only the single-statement form. ' +
                        'Combine the operation into one Cypher statement.',
                    );
                }
                return mode === 'executeRead' ? this.runReadOnly(cypher, params) : this.run(cypher, params);
            },
        };
        return fn(tx);
    }
    async executeWrite(fn) {
        return this._executeSingleStatement(fn, 'executeWrite');
    }
    async executeRead(fn) {
        return this._executeSingleStatement(fn, 'executeRead');
    }

    async close() { this._closed = true; }
}

// ── Driver ────────────────────────────────────────────────────────────────────

class Driver {
    constructor(uri, authObj, db = pickDb(uri, authObj)) {
        this._uri = uri;
        this._auth = authObj;
        this._db = db;
    }
    // Sessions inherit the driver's workspace. Select another database by
    // opening another workspace, not through session options.
    session() { return new Session(this._db); }
    async close() { /* connections live in the daemon; nothing to tear down here */ }
    async verifyConnectivity() { await ensureDaemon(); return { address: `${DAEMON_HOST}:${activePort}` }; }
    async getServerInfo() { return { address: `${DAEMON_HOST}:${activePort}` }; }
}

// ── Public module surface ──────────────────────────────

/** Open an embedded workspace explicitly, without network addresses or credentials. */
function workspace(name = 'project_db') {
    return new Driver(undefined, undefined, normalizeWorkspaceName(name));
}

// Compatibility entry point for older integrations using synthetic URIs.
function driver(uri, authObj /*, config */) {
    return new Driver(uri, authObj);
}

const auth = {
    basic(user, password /*, realm */) {
        return { scheme: 'basic', principal: user, credentials: password, password };
    },
};

/**
 * Bring an already-running daemon's schema up to date with the code's.
 *
 * The daemon adds missing tables and columns when it OPENS a database, and never
 * again — but it is a long-lived background process that routinely outlives an
 * upgrade. Pull a version that stores a new node property, leave the daemon
 * running, and the next build fails with "Binder exception: Cannot find property
 * X", partway through, after a full build has already emptied the graph.
 *
 * Calling this before a build makes that self-healing rather than something
 * every user has to know. Additive only, so it is a no-op when nothing changed.
 *
 * Never throws: an older daemon has no such route, and failing to reconcile is
 * not a reason to refuse a build that would very likely have worked anyway.
 * Returns true when the daemon confirmed it, false otherwise.
 */
async function reconcileDaemonSchema(dbKey) {
    try {
        await ensureDaemon();
        const wantedFingerprint = wantedSchemaFingerprint();
        const health = await httpGet('/health', 1000);
        let runningFingerprint = null;
        // Unlesbare Antwort heißt: Fingerabdruck bleibt null, stimmt also
        // nicht mit dem gewünschten überein, und der Daemon wird neu
        // gestartet. Das ist genau der Weg, den ein alter oder kaputter Daemon
        // nehmen soll -- der leere Zweig ist hier die Entscheidung, nicht ihr
        // Fehlen.
        try { runningFingerprint = JSON.parse(health.body).schemaFingerprint || null; } catch (_) {}
        if (runningFingerprint !== wantedFingerprint) {
            // A daemon from an older package cannot reconcile columns it does
            // not know exist. Restart it cleanly before any destructive full-
            // build query, then the open path applies the current schema.
            await stopDaemon();
            ensurePromise = null;
            await ensureDaemon();
        }
        const { status, json } = await httpPostJson('/schema/reconcile', { db: dbKey });
        return status === 200 && !!json && !json.error;
    } catch (_) {
        return false;
    }
}

/**
 * Ask the daemon to stop cleanly, and wait until it is gone.
 *
 * Windows cannot deliver SIGTERM to a detached process, so the signal handlers
 * are unreachable there and every stop is a hard kill that abandons the WAL.
 * This is the portable path: the daemon checkpoints and closes its databases
 * before exiting. Returns { stopped, reason }.
 */
async function stopDaemon({ timeoutMs = 20000 } = {}) {
    const port = await discoverRunningPort();
    if (!port) return { stopped: false, reason: 'no daemon is serving this project' };

    // Talk to that port directly rather than through httpPostJson/probe. Those
    // route via the module-level `activePort`, which the rest of the driver
    // moves around as it discovers, attaches and retries — fine for queries,
    // but here it meant the shutdown could be aimed at a port other than the one
    // we had just identified, and the poll could then be watching a third. A
    // stop that reports failure while the daemon is in fact gone (or the other
    // way round) is worse than no command at all, so this path owns its port.
    // `Connection: close` on every request, deliberately. Node's global agent
    // keeps sockets alive, and a live socket is one the daemon's server.close()
    // would wait on — so polling /health with keep-alive holds the shutdown open
    // and the poll never sees it finish. The watcher must not prop up the thing
    // it is watching.
    const askOnce = (method, pathname) => new Promise((resolve) => {
        const req = http.request(
            {
                host: DAEMON_HOST, port, path: pathname, method, timeout: 3000,
                agent: false, headers: { Connection: 'close' },
            },
            (res) => {
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
            },
        );
        req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: '' }); });
        // A reset here is not an error: the daemon exiting is exactly what we
        // asked for, and /health below is what actually decides the outcome.
        req.on('error', () => resolve({ status: 0, body: '' }));
        req.end(method === 'POST' ? '{}' : undefined);
    });

    // Which daemon we are stopping, so success can be judged by ITS departure.
    const before = await askOnce('GET', '/health');
    let targetPid = null;
    let identity;
    try { identity = JSON.parse(before.body); } catch (_) { /* unidentifiable service */ }
    if (before.status !== 200 || !identity || !sameDataDir(identity.dataDir, DATA_DIR)) {
        return { stopped: false, reason: `the service on port ${port} no longer identifies as this project's daemon` };
    }
    if (Number.isInteger(identity.pid) && identity.pid > 0) targetPid = identity.pid;

    const shutdownRes = await askOnce('POST', '/shutdown');
    // 404 means a daemon from before this route existed. It cannot be stopped
    // cleanly at all, and saying so is more useful than timing out.
    if (shutdownRes.status === 404) {
        return { stopped: false, targetPid, reason: `the running daemon on port ${port} predates 'codevis stop' and has no shutdown endpoint` };
    }

    // "Is anything listening?" is the wrong question, and asking it made this
    // report failure on a stop that had worked perfectly. Every attached client
    // — the MCP server, the bridge, a dashboard — calls ensureDaemon(), so the
    // moment the daemon goes down one of them spawns a replacement, which binds
    // the same port within milliseconds. The port stays busy; the daemon we were
    // asked to stop is nonetheless gone, and it checkpointed on the way out,
    // which is the entire point. So judge by pid.
    // An unanswered /health is not proof either: the daemon stops answering
    // while it still drains queries and checkpoints, holding the database and
    // its instance marker. Reporting success then let the caller spawn a
    // replacement that exited at once ("another daemon owns …"). Wait for the
    // process itself to be gone.
    const processGone = (pid) => {
        if (pid == null) return true;
        try { process.kill(pid, 0); return false; }
        catch (e) { return e.code === 'ESRCH'; }
    };
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const h = await askOnce('GET', '/health');
        if (h.status !== 200 && processGone(targetPid)) return { stopped: true, stoppedPid: targetPid };
        let pid = null;
        try { pid = JSON.parse(h.body).pid; } catch (_) { /* keep waiting */ }
        if (targetPid != null && pid != null && pid !== targetPid) {
            return { stopped: true, replacedBy: pid, stoppedPid: targetPid };
        }
        await new Promise((r) => setTimeout(r, 200));
    }
    if (!processGone(targetPid)) {
        // shuttingDown: it accepted /shutdown and is still checkpointing. A kill
        // now is exactly the WAL loss the clean stop exists to avoid.
        return { stopped: false, targetPid, shuttingDown: shutdownRes.status === 200,
            reason: `daemon (pid ${targetPid}) is still running after ${timeoutMs}ms; it finishes in-flight queries and checkpoints before exiting` };
    }
    return { stopped: false, targetPid, reason: `still responding on port ${port} after ${timeoutMs}ms` };
}

module.exports = {
    workspace,
    driver,
    auth,
    int,
    Integer,
    reconcileDaemonSchema,
    stopDaemon,
    // expose internals for testing / advanced embedding
    _pickDb: pickDb,
    _ensureDaemon: ensureDaemon,
    _encodeParams: encodeParams,
    _decodeValue: decodeValue,
    _daemonConnectionError: daemonConnectionError,
    _Session: Session,
};

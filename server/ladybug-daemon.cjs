/**
 * ladybug-daemon.cjs
 * ─────────────────────────────────────────────────────────────────────────
 * A small, long-lived process that OWNS the Ladybug database files and serves
 * Cypher queries over local HTTP. It is the ONLY process that opens the DBs
 * for writing — Ladybug/Kuzu is single-writer, so all access funnels through
 * here. The neo4j-compat client (server/ladybug-driver.cjs) spawns/attaches
 * to this daemon and POSTs already-translated Cypher.
 *
 * Responsibilities:
 *   - Open two Databases: `meta` (data/ladybug-meta) and `target`
 *     (data/ladybug-target). target may not exist yet → opened lazily and
 *     guarded so a missing target DB never crashes the daemon.
 *   - One Connection per DB. Queries to a given DB are serialised through an
 *     async mutex (a promise chain) — correctness over throughput. Kuzu
 *     connections are not safe to hammer concurrently for writes; serialising
 *     keeps transactions ordered.
 *   - HTTP server on 127.0.0.1 (loopback only):
 *       POST /cypher  {db, cypher, params}  -> {records: [...]}
 *       GET  /health                         -> 200 {ok:true}
 *   - Parameter binding: conn.query(str) does NOT accept a params object.
 *     For parameterised queries we MUST conn.prepare(cypher) then
 *     conn.execute(prepared, paramsObject). Plain (no-param) queries use the
 *     faster conn.query() path.
 *   - Writes a pidfile (data/.ladybug-daemon.pid). On clean SIGTERM/SIGINT it
 *     closes every connection + database (which checkpoints the WAL) and
 *     removes the pidfile.
 *
 * Env (all optional — defaults come from server/codevis-paths.cjs, which anchors
 * everything to the analysed project so parallel projects get parallel daemons):
 *   CODEVIS_PROJECT_DIR   the project owning the graph  (default: nearest ancestor with a codevis config)
 *   CODEVIS_DATA_DIR      data dir                      (default: <project>/.codevis)
 *   LADYBUG_DAEMON_PORT   preferred port                (default: 7600 + hash(project) % 400;
 *                                                        bumped on collision, actual port in the pidfile)
 *   LADYBUG_META_PATH     default <data>/ladybug-meta
 *   LADYBUG_TARGET_PATH   default <data>/ladybug-target
 *   LADYBUG_PIDFILE       default <data>/.ladybug-daemon.pid
 *
 *   (the *_PATH overrides exist so tests can point the daemon at a temp DB
 *    WITHOUT ever touching the real ladybug-meta, which is owned by the
 *    schema-migration process.)
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const lbug = require('@ladybugdb/core');
const { isWalFailure, quarantineRecoveryArtifacts } = require('./ladybug-recovery.cjs');

// ── Paths / config ──────────────────────────────────────────────────────────
// Resolved against the *project*, not the package — see server/codevis-paths.cjs.
//
// Note both graphs live under the project: `target` is its code, `meta` its
// tasks/knowledge/specs. Keeping meta in the package directory would put a
// user's task board inside node_modules — shared between unrelated projects and
// deleted by the next `npm install`.
const paths = require('./codevis-paths.cjs');

const DATA_DIR = paths.DATA_DIR;
const PORT = paths.DAEMON_PORT;
const HOST = paths.HOST;
const DB_PATHS = paths.DB_PATHS;
const PIDFILE = paths.PIDFILE;
const INSTANCEFILE = process.env.LADYBUG_INSTANCEFILE || `${PIDFILE}.instance`;
const SCHEMA_FINGERPRINT = (() => {
    const schema = require('../scripts/ladybug_schema.cjs');
    return crypto.createHash('sha256').update(schema.DDL.join('\n')).digest('hex').slice(0, 16);
})();

/**
 * Claim this data directory before binding a port or opening Ladybug.
 *
 * Port bumping handles unrelated processes and hash collisions, but it must
 * never turn two simultaneous CodeVis starts for ONE data directory into two
 * daemons on adjacent ports. The database lock is acquired too late to prevent
 * that split-brain state: the loser still answers /health and can overwrite the
 * pidfile. An exclusive marker makes election atomic across processes.
 */
function processExists(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); return true; }
    catch (e) { return e.code === 'EPERM'; }
}

/**
 * Best-effort wall-clock start time for a process.
 *
 * A PID alone is not an identity: after a daemon exits, Windows (and Unix)
 * eventually reuses its number. If the old instance marker survives a crash,
 * processExists() then mistakes an unrelated process for the daemon forever.
 * Comparing start times distinguishes the reused PID without weakening the
 * single-writer guard. Unknown/unqueryable processes deliberately return null
 * so callers can fail closed and keep treating the marker as owned.
 */
function processStartedAt(pid) {
    try {
        let raw;
        if (process.platform === 'win32') {
            raw = require('node:child_process').execFileSync(
                'powershell.exe',
                [
                    '-NoProfile',
                    '-NonInteractive',
                    '-Command',
                    `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`,
                ],
                // A cold PowerShell start on a GitHub Windows runner can take
                // more than two seconds. Timing out here makes a decades-old
                // marker look current and prevents the daemon from starting.
                { encoding: 'utf8', timeout: 10000, windowsHide: true },
            ).trim();
        } else {
            raw = require('node:child_process').execFileSync(
                'ps',
                ['-o', 'lstart=', '-p', String(pid)],
                { encoding: 'utf8', timeout: 2000 },
            ).trim();
        }
        const timestamp = Date.parse(raw);
        return Number.isFinite(timestamp) ? timestamp : null;
    } catch (_) {
        return null;
    }
}

function instanceOwnerIsCurrent(owner) {
    if (!owner || !processExists(owner.pid)) return false;

    const markerStartedAt = Date.parse(owner.startedAt);
    const ownerStartedAt = processStartedAt(owner.pid);
    if (!Number.isFinite(markerStartedAt) || !Number.isFinite(ownerStartedAt)) {
        return true; // Cannot disprove ownership: preserve the single-writer guard.
    }

    // The marker is written shortly after its daemon process starts. A process
    // that started later than the marker inherited a reused PID and cannot own
    // it. Allow a little resolution/clock skew between Node, PowerShell and ps.
    return ownerStartedAt <= markerStartedAt + 5000;
}

function claimInstance() {
    fs.mkdirSync(path.dirname(INSTANCEFILE), { recursive: true });
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const fd = fs.openSync(INSTANCEFILE, 'wx');
            try {
                fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, dataDir: DATA_DIR, startedAt: new Date().toISOString() }));
            } finally {
                fs.closeSync(fd);
            }
            return true;
        } catch (e) {
            if (e.code !== 'EEXIST') throw e;
            let owner = null;
            try { owner = JSON.parse(fs.readFileSync(INSTANCEFILE, 'utf8')); } catch (_) { /* stale/broken marker */ }
            if (instanceOwnerIsCurrent(owner)) {
                console.error(`[ladybug-daemon ${process.pid}] another daemon (pid ${owner.pid}) already owns ${DATA_DIR}; exiting`);
                return false;
            }
            // open('wx') wins before the winner has written its JSON. Treat a
            // fresh empty/partial marker as an election in progress, not stale:
            // unlinking it here lets both contenders claim successfully.
            if (!owner) {
                let ageMs = 0;
                try { ageMs = Date.now() - fs.statSync(INSTANCEFILE).mtimeMs; } catch (_) { /* disappeared */ }
                if (ageMs < 10000) {
                    console.error(`[ladybug-daemon ${process.pid}] another daemon is claiming ${DATA_DIR}; exiting`);
                    return false;
                }
            }
            try { fs.unlinkSync(INSTANCEFILE); } catch (_) { /* another contender reclaimed it */ }
        }
    }
    return false;
}

function removeInstance() {
    try {
        const owner = JSON.parse(fs.readFileSync(INSTANCEFILE, 'utf8'));
        if (String(owner.pid) === String(process.pid)) fs.unlinkSync(INSTANCEFILE);
    } catch (_) { /* absent or no longer ours */ }
}

if (!claimInstance()) process.exit(0);

// ── DB handle registry ───────────────────────────────────────────────────────
// Each entry: { db, conn, mutex } created lazily on first use.
const handles = Object.create(null);

/**
 * A per-DB async mutex implemented as a promise chain. Every query awaits the
 * previous one before running, guaranteeing serial execution against a single
 * Ladybug connection.
 */
function makeMutex() {
    let tail = Promise.resolve();
    return function runExclusive(fn) {
        const result = tail.then(() => fn());
        // Keep the chain alive even if a job rejects (swallow here; the caller
        // still receives the rejection via `result`).
        tail = result.then(() => undefined, () => undefined);
        return result;
    };
}

/**
 * Get (or lazily open) the handle for a db key. A missing target DB directory
 * is fine — Ladybug will create it on first write. But to honour the "open
 * lazily/guard" requirement and to never block startup, we open here on first
 * request and surface any error to that request only.
 */
async function getHandle(dbKey) {
    if (!(dbKey in DB_PATHS)) {
        throw new Error(`Unknown db '${dbKey}'. Expected one of: ${Object.keys(DB_PATHS).join(', ')}`);
    }
    // Memoise the OPEN PROMISE, not just the finished handle: two concurrent
    // first requests must not both run db.init() on the same files (double-open
    // corrupts/locks the single-writer DB). A failed open clears the slot so
    // the next request can retry.
    if (handles[dbKey]) return handles[dbKey];
    if (!getHandle._opening) getHandle._opening = Object.create(null);
    if (getHandle._opening[dbKey]) return getHandle._opening[dbKey];

    getHandle._opening[dbKey] = openHandle(dbKey).then(
        (h) => { handles[dbKey] = h; delete getHandle._opening[dbKey]; return h; },
        (e) => { delete getHandle._opening[dbKey]; throw e; },
    );
    return getHandle._opening[dbKey];
}

async function openHandle(dbKey) {
    const dbPath = DB_PATHS[dbKey];
    let db = new lbug.Database(dbPath);
    try {
        await db.init();
    } catch (e) {
        // A hard kill mid-write can leave a corrupted WAL behind; replay then
        // fails (or wedges) on every subsequent open. The WAL only contains
        // un-checkpointed transactions — moving it aside loses those but keeps
        // the main DB file consistent, which beats a permanently unopenable DB.
        if (isWalFailure(e)) {
            const moved = quarantineRecoveryArtifacts(dbPath);
            if (!moved.length) throw e;
            const walPath = moved[0].source;
            const quarantine = moved[0].destination;
            log(`WARN db '${dbKey}': WAL replay failed (${e.message}); moving ${walPath} → ${quarantine} and retrying`);
            db = new lbug.Database(dbPath);
            await db.init();
        } else {
            throw e;
        }
    }
    let conn = new lbug.Connection(db);
    await conn.init();

    // Bootstrap the schema on a FRESH database so a new user never has to run any
    // DDL by hand — `npm install` + run is enough. If the CodeNode table is
    // missing, apply the full single-table schema.
    //
    // On an EXISTING database, reconcile instead: tables and columns added to
    // ladybug_schema.cjs since this database was created would otherwise never
    // reach it, and every query touching them fails with "Table X does not
    // exist" until the user deletes their data directory and rebuilds the entire
    // graph. The schema is append-only, so reconciling only ever creates what is
    // missing and can never drop data.
    const { applySchema, reconcileSchema } = require('../scripts/ladybug_schema.cjs');
    let fresh = false;
    try {
        await conn.query('MATCH (n:CodeNode) RETURN n LIMIT 1');
        // The database already exists — but the schema in the code may have grown
        // since it was created. Rel tables are only ever created by the bootstrap
        // above, so a newly added edge type reached a FRESH database and nothing
        // else: every write of it failed with "Table X does not exist", mid-build,
        // after the full-mode wipe had already emptied the graph. Creating what is
        // missing on open makes adding an edge type a code change instead of a
        // migration everybody forgets.
        await ensureRelTables(conn, dbKey);
        await ensureNodeColumns(conn, dbKey);
        await ensureRelColumns(conn, dbKey);
    } catch (e) {
        if (isWalFailure(e)) {
            // Beide Handles zeigen auf eine Datenbank, deren WAL gerade als
            // beschädigt erkannt wurde. Dass ein Schließen darauf scheitert,
            // ist der Normalfall und kein zusätzlicher Befund -- die Diagnose
            // steht schon fest, gleich darauf wird quarantäniert.
            try { await conn.close(); } catch (_) {}
            try { await db.close(); } catch (_) {}
            const moved = quarantineRecoveryArtifacts(dbPath);
            if (!moved.length) throw e;
            log(`WARN db '${dbKey}': first catalog query exposed WAL damage (${e.message}); quarantined ${moved.map((item) => item.source).join(', ')} and retrying once`);
            db = new lbug.Database(dbPath);
            await db.init();
            conn = new lbug.Connection(db);
            await conn.init();
            await conn.query('MATCH (n:CodeNode) RETURN n LIMIT 1');
            await ensureRelTables(conn, dbKey);
            await ensureNodeColumns(conn, dbKey);
            await ensureRelColumns(conn, dbKey);
        } else {
        fresh = true;
        log(`db '${dbKey}': CodeNode table missing → applying schema`);
        await applySchema(conn, { log: () => {} });
        }
    }
    if (!fresh) {
        // Never fatal: an unreconcilable database is still usable for everything
        // that does not touch the new tables, and refusing to open it would be
        // strictly worse than the missing-table error we are trying to avoid.
        try {
            await reconcileSchema(conn, { log: (m) => log(`db '${dbKey}': ${m}`) });
        } catch (e) {
            log(`WARN db '${dbKey}': schema reconcile failed: ${e.message}`);
        }
    }

    const handle = { db, conn, mutex: makeMutex(), path: dbPath, stmtCache: new Map() };
    log(`opened db '${dbKey}' at ${dbPath}`);
    return handle;
}

/**
 * Create rel tables that exist in the schema but not yet in this database.
 *
 * Additive only, on purpose: a missing table is created, an existing one is
 * never touched. Dropping or altering a table would put user data at risk on
 * nothing more than a code update, and a graph is cheap to rebuild but
 * impossible to un-drop.
 *
 * Failures are logged and swallowed. This runs on the open path of every
 * database; a catalog that cannot be read (older engine, unexpected result
 * shape) must not stop the daemon from serving a database that works.
 */
async function ensureRelTables(conn, dbKey) {
    const schema = require('../scripts/ladybug_schema.cjs');
    let existing;
    try {
        const res = await conn.query('CALL show_tables() RETURN name');
        const rows = await res.getAll();
        existing = new Set(rows.map((r) => r.name));
    } catch (e) {
        log(`WARN db '${dbKey}': could not read table catalog (${e.message}) — skipping schema top-up`);
        return;
    }

    const missing = Object.keys(schema.REL_SPECS).filter((type) => !existing.has(type));
    if (missing.length === 0) return;

    for (const type of missing) {
        try {
            await conn.query(schema.stripComments(schema.buildRelDDL(type, schema.REL_SPECS[type])));
        } catch (e) {
            log(`WARN db '${dbKey}': could not create rel table '${type}': ${e.message}`);
        }
    }
    log(`db '${dbKey}': added ${missing.length} missing rel table(s): ${missing.join(', ')}`);
}

/**
 * Add node-table columns that exist in the schema but not yet in this database.
 *
 * Same reasoning as ensureRelTables, and the same failure mode: a new extractor
 * writes a new property, the column was only ever created on a FRESH database,
 * and every existing installation dies mid-build with "Cannot find property X".
 * ALTER TABLE ... ADD is additive and cannot lose data; nothing is ever renamed,
 * retyped or dropped here.
 *
 * The desired columns are parsed out of the schema's own DDL rather than kept in
 * a second list, so the two cannot drift.
 */
async function ensureNodeColumns(conn, dbKey) {
    const schema = require('../scripts/ladybug_schema.cjs');
    const ddl = schema.stripComments(schema.NODE_TABLES[0]);
    const body = ddl.slice(ddl.indexOf('(') + 1, ddl.lastIndexOf(')'));

    const wanted = [];
    for (const rawCol of body.split(',')) {
        const col = rawCol.trim();
        if (!col || /^PRIMARY\s+KEY/i.test(col)) continue;
        const m = /^(`[^`]+`|[A-Za-z_][A-Za-z0-9_]*)\s+(.+)$/.exec(col);
        if (!m) continue;
        const name = m[1].replace(/`/g, '');
        const type = m[2].trim();
        if (/^PRIMARY\s+KEY/i.test(type)) continue;
        wanted.push({ name, type });
    }

    let existing;
    try {
        const res = await conn.query(`CALL table_info('CodeNode') RETURN name`);
        const rows = await res.getAll();
        existing = new Set(rows.map((r) => r.name));
    } catch (e) {
        log(`WARN db '${dbKey}': could not read column catalog (${e.message}) — skipping column top-up`);
        return;
    }

    const missing = wanted.filter((c) => !existing.has(c.name));
    if (missing.length === 0) return;

    const added = [];
    for (const col of missing) {
        try {
            await conn.query(`ALTER TABLE CodeNode ADD \`${col.name}\` ${col.type}`);
            added.push(col.name);
        } catch (e) {
            log(`WARN db '${dbKey}': could not add column '${col.name}': ${e.message}`);
        }
    }
    if (added.length) log(`db '${dbKey}': added ${added.length} missing column(s): ${added.join(', ')}`);
}

/**
 * Add edge properties that exist in the schema but not yet on an existing rel
 * table.
 *
 * The third and last shape of the same problem: ensureRelTables creates a table
 * that is missing entirely, ensureNodeColumns adds node properties — but a rel
 * table that already existed keeps the column set it was created with. Adding a
 * property to REL_PROP_UNION therefore reached new databases only, and writing
 * it on an old one failed with "Cannot find property X for r" in the middle of
 * a build.
 *
 * Every rel table shares one property union (see buildRelDDL), so the desired
 * set is the same for all of them and is read from the schema rather than
 * duplicated here.
 */
async function ensureRelColumns(conn, dbKey) {
    const schema = require('../scripts/ladybug_schema.cjs');
    const wanted = schema.REL_PROP_UNION
        .map((col) => {
            const m = /^(`[^`]+`|[A-Za-z_][A-Za-z0-9_]*)\s+(.+)$/.exec(col.trim());
            return m ? { name: m[1].replace(/`/g, ''), type: m[2].trim() } : null;
        })
        .filter(Boolean);
    if (wanted.length === 0) return;

    const added = [];
    for (const relType of Object.keys(schema.REL_SPECS)) {
        let existing;
        try {
            const res = await conn.query(`CALL table_info('${relType}') RETURN name`);
            const rows = await res.getAll();
            existing = new Set(rows.map((r) => r.name));
        } catch (_) {
            continue; // table absent (ensureRelTables just made it) or not introspectable
        }
        for (const col of wanted) {
            if (existing.has(col.name)) continue;
            try {
                await conn.query(`ALTER TABLE ${relType} ADD \`${col.name}\` ${col.type}`);
                added.push(`${relType}.${col.name}`);
            } catch (e) {
                log(`WARN db '${dbKey}': could not add '${col.name}' to '${relType}': ${e.message}`);
            }
        }
    }
    if (added.length) log(`db '${dbKey}': added ${added.length} missing edge propert(ies): ${added.slice(0, 8).join(', ')}${added.length > 8 ? ' …' : ''}`);
}

// ── Param decoding ───────────────────────────────────────────────────────────
// The compat client tags INT64 params as { __int64: "<decimal>" } so they
// survive JSON transport. Rebuild native BigInt here so Ladybug binds them as
// INT64. Recurse into arrays (e.g. `$ids` for `WHERE id(n) IN $ids`) and maps.
function decodeParamValue(v) {
    if (v === null || v === undefined) return v;
    if (Array.isArray(v)) return v.map(decodeParamValue);
    if (typeof v === 'object') {
        if (typeof v.__int64 === 'string') {
            // This Ladybug build binds INT64 params best as a plain JS Number
            // (BigInt list elements bind incorrectly for `... IN $ids`, and
            // INT64 columns are returned as Number anyway). Use Number when the
            // value is within the safe-integer range — which covers seq ids
            // (0..N) and epoch-millis timestamps — and fall back to BigInt only
            // for genuinely huge values that Number cannot represent exactly.
            const big = BigInt(v.__int64);
            if (big >= -9007199254740991n && big <= 9007199254740991n) {
                return Number(big);
            }
            return big;
        }
        const out = {};
        for (const k of Object.keys(v)) out[k] = decodeParamValue(v[k]);
        return out;
    }
    return v; // string | number | boolean
}

function decodeParams(params) {
    const out = {};
    if (!params || typeof params !== 'object') return out;
    for (const k of Object.keys(params)) out[k] = decodeParamValue(params[k]);
    return out;
}

// ── CREATE identity allocation ────────────────────────────────────────────────
// New nodes created via Cypher CREATE need a fresh `seq` (numeric id() stand-in)
// and `uid` (primary key). Neo4j auto-assigns internal ids; Kuzu does not. The
// translator injects $__uidN/$__seqN placeholders and the compat client binds
// them to sentinels ({__nextseq:true} / {__newuid:'<prefix>'}); we resolve them
// here against a per-db counter so new ids never collide with migrated ones.
async function nextSeq(handle) {
    if (handle.seqCounter === undefined) {
        let maxSeq = -1;
        try {
            const res = await handle.conn.query('MATCH (n:CodeNode) RETURN max(n.seq) AS m');
            const rows = await res.getAll();
            const m = rows && rows[0] ? rows[0].m : null;
            if (m !== null && m !== undefined) maxSeq = Number(m);
        } catch (_) { /* empty/new db → start at 0 */ }
        handle.seqCounter = maxSeq + 1;
    }
    return handle.seqCounter++;
}

// Replace CREATE identity sentinels in `params` in place. One fresh seq per
// __nextseq sentinel, keyed by param suffix ('' for __seq, '2' for __seq2, …)
// so the paired __uid reuses the SAME seq (uid = prefix + seq).
async function resolveIdentitySentinels(handle, params) {
    if (!params || typeof params !== 'object') return;
    const seqBySuffix = {};
    for (const k of Object.keys(params)) {
        const v = params[k];
        if (v && typeof v === 'object' && v.__nextseq === true && k.startsWith('__seq')) {
            const s = await nextSeq(handle);
            seqBySuffix[k.slice('__seq'.length)] = s;
            params[k] = s; // plain Number → bound as INT64
        }
    }
    for (const k of Object.keys(params)) {
        const v = params[k];
        if (v && typeof v === 'object' && typeof v.__newuid === 'string' && k.startsWith('__uid')) {
            const suffix = k.slice('__uid'.length);
            const s = (suffix in seqBySuffix) ? seqBySuffix[suffix] : await nextSeq(handle);
            params[k] = v.__newuid + String(s); // e.g. 'task:' + 137
        }
    }
}

// ── Query execution ──────────────────────────────────────────────────────────

/**
 * Run a (already-translated) Cypher string against the given DB. When `params`
 * has keys we MUST use prepare()+execute(); the plain query() path ignores
 * params entirely. Returns an array of plain row objects keyed by RETURN alias.
 *
 * INT64 columns arrive as JS BigInt (the compat client wraps them); we leave
 * the row values as-is here so the wire stays lossless — see serialiseRows().
 */
async function runCypher(dbKey, cypher, params, readOnly = false) {
    const handle = await getHandle(dbKey);
    if (!readOnly && WRITE_RE.test(cypher)) scheduleCheckpoint(dbKey);
    const tQueued = Date.now();
    return handle.mutex(async () => {
        const tStart = Date.now();
        if (readOnly) {
            const { runReadOnlyQuery } = require('./read-only-query.cjs');
            const { rows, columnNames, columnTypes } = await runReadOnlyQuery(handle.conn, cypher, decodeParams(params));
            return rows.map(row => tagRowInts(row, columnNames, columnTypes));
        }
        // Resolve CREATE identity sentinels first (allocates seq/uid from the
        // per-db counter; runs inside the mutex so the counter is race-free).
        await resolveIdentitySentinels(handle, params);
        const decodedParams = decodeParams(params);
        const hasParams = decodedParams && Object.keys(decodedParams).length > 0;

        let result;
        if (hasParams) {
            // Ladybug $param binding requires a prepared statement. Compiling a
            // statement is by far the most expensive part of a small query, and
            // bulk writers (graph_builder) send the same ~20 query shapes tens of
            // thousands of times — so prepared statements are cached per DB,
            // keyed by the exact Cypher string (params vary per execute, the
            // plan does not). LADYBUG_STMT_CACHE=0 disables the cache (debug
            // escape hatch for native-layer issues).
            if (process.env.LADYBUG_STMT_CACHE === '0') handle.stmtCache.clear();
            let prepared = handle.stmtCache.get(cypher);
            if (!prepared) {
                prepared = await handle.conn.prepare(cypher);
                if (!prepared.isSuccess()) {
                    throw new Error(prepared.getErrorMessage());
                }
                // FIFO eviction: the cache only needs to hold the working set of
                // repeated shapes; one-off ad-hoc queries cycle through the front.
                if (handle.stmtCache.size >= 500) {
                    handle.stmtCache.delete(handle.stmtCache.keys().next().value);
                }
                handle.stmtCache.set(cypher, prepared);
            }
            try {
                result = await handle.conn.execute(prepared, decodedParams);
            } catch (e) {
                // A cached plan can go stale (e.g. after DDL). Re-prepare once;
                // if the query genuinely fails it fails again here and surfaces.
                handle.stmtCache.delete(cypher);
                prepared = await handle.conn.prepare(cypher);
                if (!prepared.isSuccess()) {
                    throw new Error(prepared.getErrorMessage());
                }
                handle.stmtCache.set(cypher, prepared);
                result = await handle.conn.execute(prepared, decodedParams);
            }
        } else {
            result = await handle.conn.query(cypher);
        }

        // A statement may return multiple QueryResults (multi-statement). We
        // only care about the LAST result's rows (matches neo4j single-result
        // semantics for the app's one-statement-per-run usage).
        const last = Array.isArray(result) ? result[result.length - 1] : result;
        const colNames = await last.getColumnNames();
        const colTypes = await last.getColumnDataTypes();
        const rows = await last.getAll();
        if (process.env.LADYBUG_SLOW_LOG) {
            const execMs = Date.now() - tStart;
            if (execMs > Number(process.env.LADYBUG_SLOW_LOG)) {
                log(`SLOW ${execMs}ms (queued ${tStart - tQueued}ms) [${dbKey}] ${cypher.replace(/\s+/g, ' ').slice(0, 160)}`);
            }
        }
        // Tag INT64 values per-column so the client can rebuild Integer shims.
        // (This installed Ladybug build returns INT64 as a plain JS Number, not
        // BigInt, so we MUST drive the tagging off the declared column types.)
        return rows.map((row) => tagRowInts(row, colNames, colTypes));
    });
}

// ── INT64 tagging driven by column data types ────────────────────────────────
// Ladybug here returns INT64 as JS Number (lossy past 2^53) and DOUBLE as
// Number too — indistinguishable by JS type. So we consult getColumnDataTypes()
// and tag any value sitting in an INT64-typed column. Nested list element types
// (e.g. "INT64[]") are handled recursively.
function typeIsInt(t) {
    return /^(INT(8|16|32|64|128)?|UINT(8|16|32|64)?|SERIAL)$/i.test(t);
}

function tagByType(value, typeStr) {
    if (value === null || value === undefined) return value;
    const t = String(typeStr || '');
    // List type "X[]" → element type X
    if (t.endsWith('[]') && Array.isArray(value)) {
        const elemType = t.slice(0, -2);
        return value.map((el) => tagByType(el, elemType));
    }
    if (typeIsInt(t)) {
        // Number or BigInt → tag as int64 (string-encoded, lossless on wire).
        return { __int64: typeof value === 'bigint' ? value.toString() : String(value) };
    }
    // Other scalar / nested struct / map → pass through unchanged.
    return value;
}

function tagRowInts(row, colNames, colTypes) {
    const out = {};
    for (let i = 0; i < colNames.length; i++) {
        const name = colNames[i];
        out[name] = tagByType(row[name], colTypes[i]);
    }
    // Preserve any extra keys not in colNames (defensive).
    for (const k of Object.keys(row)) {
        if (!(k in out)) out[k] = row[k];
    }
    return out;
}

// ── JSON wire serialisation ───────────────────────────────────────────────────
// BigInt is not JSON-serialisable. We tag INT64/BigInt values so the compat
// client can faithfully reconstruct neo4j-Integer-like shims on the other side.
// Shape: { __int64: "<decimal string>" }. Nested arrays/objects are walked.

function tagBigInts(value) {
    if (typeof value === 'bigint') {
        return { __int64: value.toString() };
    }
    if (Array.isArray(value)) {
        return value.map(tagBigInts);
    }
    if (value && typeof value === 'object') {
        // Plain objects (rows, nested maps). Date/other native types from
        // Ladybug come back as primitives or plain objects already.
        const out = {};
        for (const k of Object.keys(value)) {
            out[k] = tagBigInts(value[k]);
        }
        return out;
    }
    return value; // string | number | boolean | null | undefined
}

function serialiseRows(rows) {
    return rows.map(tagBigInts);
}

// ── Write idempotency (request-id dedupe) ─────────────────────────────────────
// A write can COMMIT here and then fail to deliver its response (the client's
// connection resets mid-response). The client retries the identical query with
// the SAME reqId. Re-executing would re-resolve the CREATE identity sentinels
// against the seq counter → fresh seq/uid → a DUPLICATE node for one logical
// create. So we remember the response of each recently committed reqId per DB
// and replay it verbatim for a repeat, without touching the database.
//
// In-memory only, bounded to the most recent N ids per DB (FIFO via Map
// insertion order). A daemon that crashed and respawned starts empty — that
// case can't be deduped in-process anyway; this covers the common reset-mid-
// response against a still-live daemon. Tunable via LADYBUG_DEDUPE_MAX.
const DEDUPE_MAX = parseInt(process.env.LADYBUG_DEDUPE_MAX || '1000', 10);
const dedupeByDb = new Map(); // dbKey -> Map(reqId -> response object)
const inFlightWrites = new Map();

async function deduplicatedWrite(dbKey, reqId, execute) {
    if (!reqId) return execute();
    const key = JSON.stringify([dbKey, reqId]);
    const cached = dedupeGet(dbKey, reqId);
    if (cached) return cached;
    if (inFlightWrites.has(key)) return inFlightWrites.get(key);
    const pending = Promise.resolve().then(execute).then(response => {
        dedupePut(dbKey, reqId, response);
        return response;
    });
    inFlightWrites.set(key, pending);
    try { return await pending; }
    finally { inFlightWrites.delete(key); }
}

function dedupeGet(dbKey, reqId) {
    const m = dedupeByDb.get(dbKey);
    return m ? m.get(reqId) : undefined;
}

function dedupePut(dbKey, reqId, response) {
    if (DEDUPE_MAX <= 0) return;
    let m = dedupeByDb.get(dbKey);
    if (!m) { m = new Map(); dedupeByDb.set(dbKey, m); }
    m.set(reqId, response);
    // Evict the oldest id once the ring is full (front of insertion order).
    if (m.size > DEDUPE_MAX) m.delete(m.keys().next().value);
}

// ── HTTP server ────────────────────────────────────────────────────────────

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', (c) => {
            size += c.length;
            if (size > 32 * 1024 * 1024) { // 32MB guard
                reject(new Error('request body too large'));
                req.destroy();
                return;
            }
            chunks.push(c);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

function sendJson(res, status, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(status, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
}

const server = http.createServer(async (req, res) => {
    try {
        if (!require('./browser-origin.cjs').isAllowedBrowserOrigin(req.headers.origin)) {
            sendJson(res, 403, { error: 'Browser origin is not allowed.' });
            return;
        }
        if (req.method === 'GET' && req.url === '/health') {
            // dataDir identifies WHICH database this daemon owns. A client that
            // only checks "is something alive on this port" can end up talking to
            // another project's daemon (ports collide, pidfiles go stale) and
            // silently read the wrong graph. Clients must match this against
            // their own data dir before trusting us.
            sendJson(res, 200, { ok: true, pid: process.pid, dataDir: DATA_DIR, schemaFingerprint: SCHEMA_FINGERPRINT });
            return;
        }

        if (req.method === 'POST' && req.url === '/graph/sync-file') {
            const { db = 'target', snapshot, reqId } = JSON.parse(await readBody(req));
            const response = await deduplicatedWrite(db, reqId, async () => {
                const handle = await getHandle(db);
                return handle.mutex(async () => {
                    const { LocalSession } = require('./ladybug-local-session.cjs');
                    const session = new LocalSession(handle.conn, () => nextSeq(handle));
                    const result = await require('./graph-file-sync.cjs').syncGraphFile(session, snapshot);
                    scheduleCheckpoint(db);
                    return { result };
                });
            });
            sendJson(res, 200, response);
            return;
        }

        if (req.method === 'POST' && req.url === '/knowledge/sync') {
            const { db = 'target', documents, reqId } = JSON.parse(await readBody(req));
            const response = await deduplicatedWrite(db, reqId, async () => {
                const handle = await getHandle(db);
                return handle.mutex(async () => {
                    const { LocalSession } = require('./ladybug-local-session.cjs');
                    const session = new LocalSession(handle.conn, () => nextSeq(handle));
                    const result = await require('../scripts/knowledge_markdown.cjs').syncKnowledgeDocuments(session, documents);
                    scheduleCheckpoint(db);
                    return { result };
                });
            });
            sendJson(res, 200, response);
            return;
        }

        if (req.method === 'POST' && req.url === '/epics/membership') {
            const { db = 'target', options, reqId } = JSON.parse(await readBody(req));
            const response = await deduplicatedWrite(db, reqId, async () => {
                const handle = await getHandle(db);
                return handle.mutex(async () => {
                    const { LocalSession } = require('./ladybug-local-session.cjs');
                    const session = new LocalSession(handle.conn, () => nextSeq(handle));
                    const result = await require('./epic-membership.cjs').epicMembershipOperation(session, options || {});
                    scheduleCheckpoint(db);
                    return { result };
                });
            });
            sendJson(res, 200, response);
            return;
        }

        if (req.method === 'POST' && req.url === '/tasks/claims') {
            const { db = 'target', options, reqId } = JSON.parse(await readBody(req));
            const response = await deduplicatedWrite(db, reqId, async () => {
                const handle = await getHandle(db);
                return handle.mutex(async () => {
                    const { LocalSession } = require('./ladybug-local-session.cjs');
                    const session = new LocalSession(handle.conn, () => nextSeq(handle));
                    const { taskClaimOperation } = require('./task-claims.cjs');
                    const result = await taskClaimOperation(session, options || {}, require('./codevis-paths.cjs').PROJECT_ROOT);
                    scheduleCheckpoint(db);
                    return { result };
                });
            });
            sendJson(res, 200, response);
            return;
        }

        if (req.method === 'POST' && req.url === '/spec/import') {
            const { db = 'target', options, reqId } = JSON.parse(await readBody(req));
            const response = await deduplicatedWrite(db, reqId, async () => {
                const handle = await getHandle(db);
                return handle.mutex(async () => {
                    const { LocalSession } = require('./ladybug-local-session.cjs');
                    const session = new LocalSession(handle.conn, () => nextSeq(handle));
                    const result = await require('../scripts/spec/spec_db.cjs').importSpec(session, options || {});
                    scheduleCheckpoint(db);
                    return { result };
                });
            });
            sendJson(res, 200, response);
            return;
        }

        if (req.method === 'POST' && (req.url === '/cypher' || req.url === '/cypher/read-only')) {
            const readOnly = req.url === '/cypher/read-only';
            const raw = await readBody(req);
            let payload;
            try {
                payload = JSON.parse(raw || '{}');
            } catch (e) {
                sendJson(res, 400, { error: `invalid JSON body: ${e.message}` });
                return;
            }
            const { db, cypher, params, reqId } = payload;
            if (typeof cypher !== 'string') {
                sendJson(res, 400, { error: 'missing or non-string `cypher`' });
                return;
            }
            const dbKey = db || 'target';
            // Idempotent replay: a retried write carries the reqId of its first
            // attempt. If that already committed, return the original response
            // instead of executing again (which would duplicate the node).
            if (reqId && !readOnly) {
                const cached = dedupeGet(dbKey, reqId);
                if (cached) { sendJson(res, 200, cached); return; }
            }
            try {
                const response = await deduplicatedWrite(dbKey, readOnly ? null : reqId, async () => {
                    const rows = await runCypher(dbKey, cypher, params || {}, readOnly);
                    return { records: serialiseRows(rows) };
                });
                // Only successful writes are remembered; failed queries surface
                // an error and are not retried by the client, so no id is stored.
                sendJson(res, 200, response);
            } catch (e) {
                // Surface query/DB errors to the client; keep daemon alive.
                sendJson(res, 200, { error: e.message || String(e) });
            }
            return;
        }

        // Stop cleanly, from outside the process.
        //
        // The SIGTERM/SIGINT handlers below are the documented way to do this and
        // they work on Unix — but Windows has no signals to deliver. Every stop
        // there (`taskkill`, closing the terminal, Stop-Process) is a hard
        // TerminateProcess, so `shutdown()` never runs, the WAL is never
        // checkpointed, and the next open quarantines it as `*.wal.corrupt-*`
        // with everything since the last checkpoint gone. That is not a rare
        // accident: it happens on every single stop.
        //
        // Loopback-only, like the rest of this server — and no wider a capability
        // than /cypher, which already accepts arbitrary DDL.
        if (req.method === 'POST' && req.url === '/shutdown') {
            // Answer BEFORE exiting, and give the answer time to land. Shutting
            // down straight after res.end() tears down the very socket the reply
            // is travelling on — the client then sees a connection reset and
            // cannot tell a clean stop from a crash. A short delay is enough:
            // the caller is on loopback, and it polls /health afterwards anyway,
            // so this only has to be long enough for the body to be read.
            sendJson(res, 200, { ok: true, pid: process.pid, stopping: true });
            setTimeout(() => shutdown('HTTP /shutdown'), 150);
            return;
        }

        // Re-apply the additive schema reconcile to an ALREADY OPEN database.
        //
        // openDb() adds tables and columns that the schema has grown since the
        // database was created — but only at open time, and a daemon can outlive
        // an upgrade by days. Pull a version with a new node property, keep the
        // running daemon, and the next build dies mid-way with "Binder exception:
        // Cannot find property X" — after a full build has already emptied the
        // graph. The builder calls this first so the upgrade path heals itself
        // instead of requiring everyone to know they must restart the daemon.
        //
        // Additive only, exactly like the open path: nothing is dropped, renamed
        // or retyped, so calling it when there is nothing to do is free.
        if (req.method === 'POST' && req.url === '/schema/reconcile') {
            const raw = await readBody(req);
            let payload;
            try { payload = JSON.parse(raw || '{}'); }
            catch (e) { sendJson(res, 400, { error: `invalid JSON body: ${e.message}` }); return; }
            const dbKey = payload.db || 'target';
            try {
                // Development installs may update the schema file while this
                // long-lived daemon remains alive. Do not reconcile against a
                // stale require-cache snapshot.
                delete require.cache[require.resolve('../scripts/ladybug_schema.cjs')];
                const h = await getHandle(dbKey);
                await h.mutex(async () => {
                    await ensureRelTables(h.conn, dbKey);
                    await ensureNodeColumns(h.conn, dbKey);
                    await ensureRelColumns(h.conn, dbKey);
                });
                sendJson(res, 200, { ok: true, db: dbKey });
            } catch (e) {
                sendJson(res, 200, { error: e.message || String(e) });
            }
            return;
        }

        sendJson(res, 404, { error: 'not found' });
    } catch (e) {
        sendJson(res, 500, { error: e.message || String(e) });
    }
});

// ── Lifecycle ────────────────────────────────────────────────────────────────

function log(msg) {
    // eslint-disable-next-line no-console
    console.error(`[ladybug-daemon ${process.pid}] ${msg}`);
}

/**
 * The pidfile records the port as well as the pid.
 *
 * The database directory — not the port — is what must have a single writer.
 * By publishing the port next to the pid, a client can discover the daemon that
 * already owns this data dir and attach to it, instead of assuming a port and
 * spawning a *second* daemon onto the same (single-writer) database.
 *
 * Written as JSON; older daemons wrote a bare pid, which readers still handle.
 */
function writePidfile(port) {
    try {
        fs.mkdirSync(path.dirname(PIDFILE), { recursive: true });
        // The port we actually bound, not the one we preferred — see tryListen.
        const payload = JSON.stringify({ pid: process.pid, port, dataDir: DATA_DIR });
        fs.writeFileSync(PIDFILE, payload, 'utf8');
    } catch (e) {
        log(`WARN could not write pidfile ${PIDFILE}: ${e.message}`);
    }
}

function removePidfile() {
    try {
        // Only remove if it's ours (defensive against racing daemons).
        const raw = fs.readFileSync(PIDFILE, 'utf8').trim();
        let pid;
        try { pid = JSON.parse(raw).pid; } catch { pid = parseInt(raw, 10); }
        if (String(pid) === String(process.pid)) fs.unlinkSync(PIDFILE);
    } catch (_) { /* already gone */ }
}

let shuttingDown = false;
async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`received ${signal}, closing databases (WAL checkpoint)…`);

    // Stop accepting new connections, hang up on the open ones, and do NOT wait
    // for the socket bookkeeping to settle before getting on with the part that
    // matters.
    //
    // server.close() only stops NEW connections; its callback fires once every
    // existing socket has ended on its own. Keep-alive sockets do not end on
    // their own, and something is always attached — the bridge, the MCP server,
    // or the very client that asked us to stop and is now polling /health to see
    // whether we did. Awaiting that callback therefore deadlocked against the
    // caller: each poll kept a connection alive, which kept close() pending,
    // which kept the daemon answering, which made the caller poll again. The
    // stop timed out and the user reached for a hard kill — losing exactly the
    // WAL checkpoint this function exists to perform.
    //
    // So: ask politely, force the sockets down, and move on. The listening
    // handle is closed synchronously by close(), so nothing new gets in either
    // way, and every response already written has been flushed.
    server.close();
    server.closeIdleConnections?.();
    server.closeAllConnections?.();

    // Pending idle-checkpoint callbacks must not wake up while handles are
    // closing. Explicitly checkpoint here instead of trusting only the native
    // db.close() contract: one Windows incident logged successful close calls
    // but left a corrupt, replay-required meta WAL on the next start.
    for (const timer of pendingCheckpoints.values()) clearTimeout(timer);
    pendingCheckpoints.clear();

    // Close each DB cleanly. db.close() checkpoints the WAL — REQUIRED for
    // durability. Drain the mutex so no query is mid-flight.
    let closeFailures = 0;
    for (const key of Object.keys(handles)) {
        const h = handles[key];
        try {
            await h.mutex(async () => {
                await h.conn.query('CHECKPOINT');
                log(`checkpointed db '${key}'`);
                await h.conn.close();
                await h.db.close();
            });
            const walPath = `${h.path}.wal`;
            const walBytes = (() => {
                try { return fs.statSync(walPath).size; } catch { return 0; }
            })();
            if (walBytes > 0) {
                closeFailures++;
                log(`ERROR db '${key}' closed but WAL still contains ${walBytes} byte(s): ${walPath}`);
            } else {
                log(`closed db '${key}' (WAL empty)`);
            }
        } catch (e) {
            closeFailures++;
            log(`WARN error closing db '${key}': ${e.message}`);
        }
    }

    removePidfile();
    removeInstance();
    log(`shutdown complete${closeFailures ? ` with ${closeFailures} durability error(s)` : ''}`);
    process.exit(closeFailures ? 1 : 0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// The port derived from the project path is only a *preference*: an unrelated
// process (or a project whose path happens to hash the same) may already hold
// it. Bump until we find a free one and publish the port we actually bound in
// the pidfile, so the driver reads it instead of re-deriving and guessing wrong.
let boundPort = PORT;
(function tryListen(attempt) {
    // Clear any leftover 'listening' listener from a previous failed attempt
    // so the success handler only fires once even after a port bump.
    server.removeAllListeners('listening');
    server.once('listening', () => {
        writePidfile(boundPort);
        log(`listening on http://${HOST}:${boundPort}  (meta=${DB_PATHS.meta}, target=${DB_PATHS.target})`);
    });
    server.once('error', (err) => {
        // EACCES belongs here as much as EADDRINUSE. On Windows a port held by a
        // service bound to the dual-stack wildcard (`::`) — or one inside a
        // reserved exclusion range — is refused with EACCES, not EADDRINUSE, so
        // treating only the latter as retryable made the daemon die outright on
        // a port it should simply have skipped. That is not hypothetical: the
        // hash lands on 7680 for at least one real project root, which is
        // Windows Delivery Optimization (DoSvc), and the whole graph stayed
        // unreachable behind a misleading 'did not become healthy' error.
        if ((err.code === 'EADDRINUSE' || err.code === 'EACCES') && attempt < 9 && boundPort < 65535) {
            boundPort++;
            tryListen(attempt + 1);
        } else {
            log(`FATAL could not bind to any port near ${PORT}: ${err.message}`);
            process.exit(1);
        }
    });
    server.listen(boundPort, HOST);
}(0));

// ── Periodic WAL checkpoint ───────────────────────────────────────────────────
// db.close() checkpoints the WAL, but that only runs on a CLEAN shutdown. A hard
// kill (terminal closed, reboot, crash, force-kill) leaves the un-checkpointed
// WAL behind — and a WAL torn mid-write replays as "Corrupted wal file", which
// the open path then quarantines, losing everything written since the last
// checkpoint. Flushing the WAL into the main DB file on a timer bounds that loss
// to one interval and keeps the on-disk WAL small, so an accidental stop has
// little — and consistent — state to lose. CHECKPOINT runs through each handle's
// mutex so it never races an in-flight write. Tunable via LADYBUG_CHECKPOINT_MS
// (0 disables); default 5 min.
const CHECKPOINT_MS = parseInt(process.env.LADYBUG_CHECKPOINT_MS || '300000', 10);
async function checkpointAll() {
    if (shuttingDown) return;
    for (const key of Object.keys(handles)) {
        const h = handles[key];
        try {
            await h.mutex(async () => { await h.conn.query('CHECKPOINT'); });
        } catch (e) {
            log(`WARN checkpoint db '${key}' failed: ${e.message}`);
        }
    }
}
if (CHECKPOINT_MS > 0) {
    // unref() so the timer alone never keeps the process alive.
    setInterval(() => { checkpointAll(); }, CHECKPOINT_MS).unref();
    log(`auto-checkpoint every ${Math.round(CHECKPOINT_MS / 1000)}s`);
}

// ── Checkpoint shortly after writes stop ─────────────────────────────────────
// The periodic checkpoint alone leaves a 5-minute window, and the single biggest
// write burst — a full `codevis build` — fits entirely inside it. Observed: build
// a graph, hard-kill the daemon seconds later, and the whole graph is gone. Not
// "the last few writes": the main DB file had never been checkpointed at all, so
// everything still lived in the WAL, which tore on the kill and got quarantined.
//
// Checkpointing after each write would serialise the bulk path to a crawl, so
// instead the checkpoint is debounced: writes push it out, and it fires once the
// writer goes quiet. A burst of 50k inserts costs one checkpoint, and the
// exposure window shrinks from 5 minutes to a few seconds of idle.
const CHECKPOINT_IDLE_MS = parseInt(process.env.LADYBUG_CHECKPOINT_IDLE_MS || '3000', 10);
const WRITE_RE = /\b(CREATE|MERGE|SET|DELETE|REMOVE|DROP|COPY)\b/i;
const pendingCheckpoints = new Map(); // dbKey -> timer

function scheduleCheckpoint(dbKey) {
    if (CHECKPOINT_IDLE_MS <= 0 || shuttingDown) return;
    clearTimeout(pendingCheckpoints.get(dbKey));
    const t = setTimeout(async () => {
        pendingCheckpoints.delete(dbKey);
        const h = handles[dbKey];
        if (!h || shuttingDown) return;
        try {
            await h.mutex(async () => { await h.conn.query('CHECKPOINT'); });
        } catch (e) {
            log(`WARN idle checkpoint db '${dbKey}' failed: ${e.message}`);
        }
    }, CHECKPOINT_IDLE_MS);
    t.unref(); // never keep the process alive just to checkpoint
    pendingCheckpoints.set(dbKey, t);
}

// Kein module.exports: diese Datei wird ausschließlich gespawnt, nie
// require()-t -- weder von ladybug-driver.cjs (das baut nur den Pfad und
// startet den Prozess) noch von den Tests. Der Export sah wie eine
// Schnittstelle aus, die es nicht gibt: wer sie benutzt hätte, hätte einen
// zweiten Daemon im eigenen Prozess gestartet, auf denselben Datenbankdateien
// wie der laufende.

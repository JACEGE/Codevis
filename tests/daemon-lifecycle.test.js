#!/usr/bin/env node
/**
 * The daemon's lifecycle endpoints, against a REAL daemon process.
 *
 * Both of these were shipped-broken states that no existing test could see,
 * because both are about a process, not about a query:
 *
 *   POST /shutdown          — the daemon checkpoints its write-ahead log when it
 *                             closes and only then. Windows cannot deliver
 *                             SIGTERM to a detached process, so without this
 *                             route every stop there was a hard kill and the WAL
 *                             was abandoned.
 *   POST /schema/reconcile  — the daemon adds tables and columns the schema has
 *                             grown when it OPENS a database, and never again.
 *                             A daemon that outlived an upgrade kept the old
 *                             column set and killed the next build mid-way with
 *                             "Cannot find property X".
 *
 * Everything runs in a temp data dir on its own port, so it cannot touch the
 * project's real graph or fight its daemon for the single-writer lock.
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const http = require("node:http");
const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DAEMON = path.resolve(__dirname, "../server/ladybug-daemon.cjs");

/** A port nothing is listening on right now. */
function freePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.once("error", reject);
        srv.listen(0, "127.0.0.1", () => {
            const { port } = srv.address();
            srv.close(() => resolve(port));
        });
    });
}

/**
 * One request, on its own connection.
 *
 * `Connection: close` is not incidental. Node's global agent keeps sockets
 * alive, and a live socket is one the daemon's server.close() would wait on —
 * so a keep-alive health poll holds the shutdown open and then reports that the
 * shutdown never happened. The watcher must not prop up what it is watching;
 * that bug is what the polling test below exists to catch.
 */
function ask(port, method, pathname, timeoutMs = 3000) {
    return new Promise((resolve) => {
        const req = http.request(
            { host: "127.0.0.1", port, path: pathname, method, timeout: timeoutMs,
              agent: false, headers: { Connection: "close" } },
            (res) => {
                const chunks = [];
                res.on("data", (c) => chunks.push(c));
                res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
            },
        );
        req.on("timeout", () => { req.destroy(); resolve({ status: -1, body: "" }); });
        req.on("error", () => resolve({ status: 0, body: "" }));
        req.end(method === "POST" ? "{}" : undefined);
    });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Spawn a daemon on an isolated data dir; resolves once /health answers. */
async function startDaemon(existingDir = null) {
    const dir = existingDir || fs.mkdtempSync(path.join(os.tmpdir(), "codevis-daemon-test-"));
    const port = await freePort();
    const child = spawn(process.execPath, [DAEMON], {
        env: {
            ...process.env,
            CODEVIS_DATA_DIR: dir,
            LADYBUG_DAEMON_PORT: String(port),
            LADYBUG_PIDFILE: path.join(dir, "daemon.pid"),
            // A checkpoint timer firing mid-test would only add noise.
            LADYBUG_CHECKPOINT_MS: "0",
        },
        stdio: "ignore",
    });

    let exited = false;
    child.on("exit", () => { exited = true; });

    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
        if (exited) throw new Error("daemon exited before it became healthy");
            const h = await ask(port, "GET", "/health", 1000);
        if (h.status === 200) return { child, port, dir, hasExited: () => exited };
        await sleep(200);
    }
    child.kill();
    throw new Error(`daemon did not become healthy on port ${port}`);
}

function cypher(port, db, query, params = {}, reqId) {
    return new Promise((resolve) => {
        const payload = JSON.stringify({ db, cypher: query, params, reqId });
        const req = http.request(
            { host: "127.0.0.1", port, path: "/cypher", method: "POST", timeout: 60000,
              agent: false, headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload), Connection: "close" } },
            (res) => { const chunks = []; res.on("data", (x) => chunks.push(x)); res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) })); },
        );
        req.on("error", (error) => resolve({ status: 0, body: { error: error.message } }));
        req.end(payload);
    });
}

async function waitForExit(d, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (!d.hasExited() && Date.now() < deadline) await sleep(100);
    assert.ok(d.hasExited(), `daemon ${d.child.pid} did not exit within ${timeoutMs}ms`);
}

function cleanup(d) {
    try { if (!d.hasExited()) d.child.kill(); } catch { /* already gone */ }
    // Windows keeps the mapped database files locked briefly after close; a
    // failed rmdir must never fail the test it belongs to.
    try { fs.rmSync(d.dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

describe("daemon lifecycle endpoints", () => {
    it('serializes graph file batches and replays a retry without overwriting newer content', async () => {
        const d = await startDaemon();
        try {
            const send = async (snippet, reqId) => {
                const response = await fetch(`http://127.0.0.1:${d.port}/graph/sync-file`, {
                    method:'POST', headers:{'Content-Type':'application/json',Connection:'close'}, signal:AbortSignal.timeout(15000),
                    body:JSON.stringify({ db:'target', reqId, snapshot:{ file:'c.js', mode:'sync', mtime:snippet==='first'?100:200,
                        functions:[{name:'targetD',startLine:1,endLine:1,snippet,calls:[]}] } }),
                });
                return { status:response.status, body:await response.json() };
            };
            const first = await send('first','graph-batch-first');
            assert.equal(first.status,200,JSON.stringify(first.body));
            assert.equal(first.body.result.newFunctions,1);
            const seeded = await cypher(d.port,'target',`MATCH (d:CodeNode {label:'Function',name:'targetD'})
                CREATE (b:CodeNode {uid:'benchmark-caller',label:'Function',name:'callerB',file:'a.js'}) CREATE (b)-[:CALLS]->(d)`);
            assert.ok(!seeded.body.error,JSON.stringify(seeded.body));
            // Two clients can submit the same retry concurrently; it runs once.
            const newer = await Promise.all([send('second','graph-batch-second'),send('second','graph-batch-second')]);
            assert.equal(newer[0].status,200); assert.deepEqual(newer[0],newer[1]);
            assert.deepEqual(await send('first','graph-batch-first'),first);
            const state = await cypher(d.port,'target',`MATCH (:CodeNode {label:'Function',name:'callerB'})-[:CALLS]->(d:CodeNode {label:'Function',name:'targetD'})
                RETURN d.bodySnippet AS snippet`);
            assert.equal(state.status,200,JSON.stringify(state.body));
            assert.ok(!state.body.error,JSON.stringify(state.body));
            assert.deepEqual(state.body.records,[{snippet:'second'}]);
            await ask(d.port,'POST','/shutdown'); await waitForExit(d);
        } finally { cleanup(d); }
    });

    it('atomically replaces Markdown Knowledge and replays retries without replacing newer content', async () => {
        const d = await startDaemon();
        try {
            const doc = (id, content, references = []) => ({ id, title: id, content, category: 'general',
                sourcePath: `${id}.md`, tags: [], appliesTo: [], tasks: [], references });
            const send = async (documents, reqId) => {
                const res = await fetch(`http://127.0.0.1:${d.port}/knowledge/sync`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json', Connection: 'close' }, signal: AbortSignal.timeout(10000),
                    body: JSON.stringify({ db: 'target', documents, reqId }),
                });
                return { status: res.status, body: await res.json() };
            };
            const first = [doc('keep', 'Before', ['old']), doc('old', 'Old')];
            const retries = await Promise.all([send(first, 'markdown-first'), send(first, 'markdown-first')]);
            assert.equal(retries[0].status, 200);
            assert.deepEqual(retries[0], retries[1]);
            await cypher(d.port, 'target', "CREATE (t:CodeNode {uid:'task', label:'Task', taskId:'incoming'})");
            await cypher(d.port, 'target', "MATCH (t:CodeNode {uid:'task'}), (k:CodeNode {uid:'knowledge-doc:keep'}) CREATE (t)-[:REFERENCES]->(k)");
            assert.equal((await send([{ id: 'invalid' }], 'markdown-invalid')).status, 500);
            assert.equal((await send([doc('keep', 'After')], 'markdown-second')).status, 200);
            assert.deepEqual(await send(first, 'markdown-first'), retries[0]);
            const kept = await cypher(d.port, 'target', "MATCH (:CodeNode {uid:'task'})-[:REFERENCES]->(k:CodeNode) RETURN k.uid AS id, k.content AS content");
            assert.deepEqual(kept.body.records, [{ id: 'knowledge-doc:keep', content: 'After' }]);
            const notes = await cypher(d.port, 'target', "MATCH (k:CodeNode) WHERE k.kind='markdown' RETURN k.uid AS id");
            assert.deepEqual(notes.body.records, [{ id: 'knowledge-doc:keep' }]);
            await ask(d.port, 'POST', '/shutdown');
            await waitForExit(d);
        } finally { cleanup(d); }
    });

    it('serializes epic membership changes, preserves one chain, and replays retries', async () => {
        const d = await startDaemon();
        try {
            const send = async (options, reqId) => {
                const response = await fetch(`http://127.0.0.1:${d.port}/epics/membership`, {
                    method: 'POST', headers: { Connection: 'close' },
                    body: JSON.stringify({ db: 'target', options, reqId }), signal: AbortSignal.timeout(10000),
                });
                const body = await response.json();
                assert.equal(response.status, 200, JSON.stringify(body));
                assert.equal(body.result?.status, 'OK', JSON.stringify(body));
                return body.result;
            };
            for (const [id, label] of [['epic', 'Epic'], ['a', 'Task'], ['b', 'Task'], ['c', 'Task']]) {
                const created = await cypher(d.port, 'target', 'CREATE (:CodeNode {uid:$id,label:$label,taskId:$id})', { id, label });
                assert.ok(!created.body.error, JSON.stringify(created));
            }
            await Promise.all(['a', 'b', 'c'].map(taskId => send({ operation: 'add', epicId: 'epic', taskId })));
            await Promise.all(['a', 'b', 'c'].map(taskId => send({ operation: 'add', epicId: 'epic', taskId })));
            const order = { operation: 'order', epicId: 'epic', taskIds: ['c', 'b', 'a'] };
            const retries = await Promise.all([send(order, 'epic-order'), send(order, 'epic-order')]);
            assert.deepEqual(retries[0], retries[1]);
            const edges = await cypher(d.port, 'target', 'MATCH (a:CodeNode)-[:DEPENDS_ON]->(b:CodeNode) RETURN a.taskId AS a,b.taskId AS b');
            assert.deepEqual(edges.body.records.map(r => [r.a, r.b]).sort(), [['b', 'a'], ['c', 'b']]);
            const other = await cypher(d.port, 'meta', "MATCH (n:CodeNode) WHERE n.label='Task' RETURN n.taskId AS id");
            assert.deepEqual(other.body.records, []);
            await ask(d.port, 'POST', '/shutdown');
            await waitForExit(d);
        } finally { cleanup(d); }
    });

    it('serializes competing task scopes and reports mutual expansion conflicts without waiting', async () => {
        const d = await startDaemon();
        try {
            const send = async (options, reqId) => {
                const response = await fetch(`http://127.0.0.1:${d.port}/tasks/claims`, {
                    method: 'POST', headers: { Connection: 'close' },
                    body: JSON.stringify({ db: 'target', options, reqId }), signal: AbortSignal.timeout(10000),
                });
                const body = await response.json();
                assert.equal(response.status, 200, JSON.stringify(body));
                assert.ok(!body.error, JSON.stringify(body));
                return body.result;
            };
            for (const id of ['race-a','race-b','expand-a','expand-b']) {
                await cypher(d.port, 'target', 'CREATE (:CodeNode {uid:$id,label:\'Task\',taskId:$id,status:\'todo\'})', {id});
            }
            for (const taskId of ['race-a','race-b']) await send({ operation:'plan',taskId,agentId:taskId,files:['claims/shared.js'] });
            const race = await Promise.all(['race-a','race-b'].map(taskId => send({operation:'claim',taskId,agentId:taskId})));
            assert.deepEqual(race.map(r => r.status).sort(), ['LOCK_CONFLICT','OK']);
            for (const taskId of ['expand-a','expand-b']) {
                await send({operation:'plan',taskId,agentId:taskId,files:[`claims/${taskId}.js`]});
                await send({operation:'claim',taskId,agentId:taskId});
            }
            const expansion = await Promise.all(['expand-a','expand-b'].map((taskId,i) => send({
                operation:'expand',taskId,agentId:taskId,files:[`claims/expand-${i ? 'a' : 'b'}.js`,'claims/free.js'],
            })));
            assert.ok(expansion.every(r => r.status === 'LOCK_CONFLICT' && r.action === 'COORDINATE_SCOPE'));
            const snapshot = await cypher(d.port,'target',"MATCH (n:CodeNode) WHERE n.label='TaskScope' AND n.file='claims/free.js' RETURN n.uid AS id");
            assert.deepEqual(snapshot.body.records, []);
            const duplicate = {operation:'expand',taskId:'expand-a',agentId:'expand-a',files:['claims/free.js']};
            const replies = await Promise.all([send(duplicate,'same-expansion'),send(duplicate,'same-expansion')]);
            assert.deepEqual(replies[0],replies[1]);
            assert.equal(replies[0].status,'OK');
            await ask(d.port,'POST','/shutdown');
            await waitForExit(d);
        } finally { cleanup(d); }
    });
    it('coalesces overlapping retries and runs atomic spec imports through the real daemon', async () => {
        const d = await startDaemon();
        try {
            await cypher(d.port, 'target', "CREATE (n:CodeNode {uid:'counter', label:'Counter', seq:0})");
            const query = "MATCH (n:CodeNode {uid:'counter'}) SET n.seq=n.seq+1 RETURN n.seq AS n";
            const replies = await Promise.all(Array.from({ length: 8 }, () => cypher(d.port, 'target', query, {}, 'one-write')));
            assert.ok(replies.every(r => !r.body.error && r.body.records[0].n.__int64 === '1'), JSON.stringify(replies));
            const url = `http://127.0.0.1:${d.port}/spec/import`;
            const options = { specId: 'atomic-spec', kind: 'class', text: '@startuml\nclass Service\n@enduml' };
            const send = async body => (await fetch(url, { method: 'POST', headers: { Connection: 'close' }, body: JSON.stringify(body) })).json();
            const imported = await send({ db: 'target', options, reqId: 'spec-write' });
            assert.equal(imported.result.kind, 'class', JSON.stringify(imported));
            const rejected = await send({ db: 'target', options: { ...options, kind: 'sequence', text: 'A -> B: run()' } });
            assert.match(rejected.error, /new specId/);
            const current = await cypher(d.port, 'target', "MATCH (n:CodeNode) WHERE n.name='atomic-spec' RETURN n.category AS kind");
            assert.deepEqual(current.body.records, [{ kind: 'class' }]);
            await ask(d.port, 'POST', '/shutdown');
            await waitForExit(d);
        } finally { cleanup(d); }
    });
    it("reclaims an old instance marker when its PID has been reused", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codevis-daemon-pid-reuse-"));
        const instanceFile = path.join(dir, "daemon.pid.instance");
        fs.writeFileSync(instanceFile, JSON.stringify({
            pid: process.pid,
            dataDir: dir,
            startedAt: "2000-01-01T00:00:00.000Z",
        }));

        let d;
        try {
            // The test runner is unquestionably alive, but it started decades
            // after the marker claims. Treating PID existence as identity made
            // the child exit here instead of reclaiming the stale marker.
            d = await startDaemon(dir);
            const owner = JSON.parse(fs.readFileSync(instanceFile, "utf8"));
            assert.equal(owner.pid, d.child.pid);

            const stop = await ask(d.port, "POST", "/shutdown", 10000);
            assert.equal(stop.status, 200, stop.body);
            await waitForExit(d);
        } finally {
            if (d) cleanup(d);
            else try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
        }
    });

    it("allows only one daemon per data directory during simultaneous starts", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codevis-daemon-election-"));
        const ports = [await freePort(), await freePort()];
        const children = ports.map((port) => spawn(process.execPath, [DAEMON], {
            env: {
                ...process.env,
                CODEVIS_DATA_DIR: dir,
                LADYBUG_DAEMON_PORT: String(port),
                LADYBUG_PIDFILE: path.join(dir, "daemon.pid"),
                LADYBUG_CHECKPOINT_MS: "0",
            },
            stdio: "ignore",
        }));

        try {
            const deadline = Date.now() + 10000;
            let healthy = [];
            while (Date.now() < deadline) {
                healthy = [];
                for (const port of ports) if ((await ask(port, "GET", "/health", 300)).status === 200) healthy.push(port);
                if (healthy.length === 1 && children.some((child) => child.exitCode !== null)) break;
                await sleep(100);
            }
            assert.equal(healthy.length, 1, `expected one healthy daemon, found ports ${healthy.join(", ")}`);
            assert.equal(children.filter((child) => child.exitCode === null).length, 1, "the losing daemon must exit");
            await ask(healthy[0], "POST", "/shutdown", 10000);
        } finally {
            for (const child of children) try { if (child.exitCode === null) child.kill(); } catch {}
            try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
        }
    });

    describe("WAL checkpoint across restarts", () => {
        let dir;
        let current;
        before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "codevis-wal-restart-")); });
        after(() => {
            if (current) cleanup(current);
            try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Windows may still hold a map briefly */ }
        });

        it("keeps committed writes and never quarantines a WAL after clean shutdown", async () => {
            for (let cycle = 1; cycle <= 3; cycle++) {
                current = await startDaemon(dir);
                const write = await cypher(
                    current.port,
                    "meta",
                    "CREATE (n:CodeNode {uid: $uid, seq: $seq, label: 'Knowledge', name: $name, content: $content}) RETURN n.name AS name",
                    { uid: `Knowledge||wal-cycle-${cycle}`, seq: cycle, name: `wal-cycle-${cycle}`, content: `cycle ${cycle}` },
                );
                assert.equal(write.status, 200, JSON.stringify(write.body));

                const count = await cypher(current.port, "meta", "MATCH (n:CodeNode) WHERE n.label = 'Knowledge' RETURN n.name AS name");
                assert.equal(count.status, 200, JSON.stringify(count.body));
                assert.ok(!count.body.error, JSON.stringify(count.body));
                assert.equal(count.body.records.length, cycle, JSON.stringify(count.body));

                const stop = await ask(current.port, "POST", "/shutdown", 60000);
                assert.equal(stop.status, 200, stop.body);
                await waitForExit(current);
                assert.deepEqual(
                    fs.readdirSync(dir).filter((name) => name.includes(".wal.corrupt")),
                    [],
                    `cycle ${cycle} quarantined a WAL after a clean shutdown`,
                );
                current = null;
            }
        });
    });

    describe("POST /shutdown", () => {
        let d;
        before(async () => { d = await startDaemon(); });
        after(() => d && cleanup(d));

        it("answers before it goes, so a clean stop is distinguishable from a crash", async () => {
            const res = await ask(d.port, "POST", "/shutdown");
            assert.equal(res.status, 200, `expected 200, got ${res.status}`);
            const body = JSON.parse(res.body);
            assert.equal(body.ok, true);
            assert.equal(body.stopping, true);
            assert.equal(typeof body.pid, "number");
        });

        it("exits while a client keeps polling — the poll must not hold it open", async () => {
            // THE regression. server.close() only stops new connections and then
            // waits for the open ones to end; a caller polling /health to see
            // whether the stop worked kept a connection alive, which kept close()
            // pending, which kept the daemon answering, which made the caller
            // poll again. The stop timed out after 20s on a daemon that was
            // trying to exit the whole time.
            const deadline = Date.now() + 15000;
            while (Date.now() < deadline) {
                if (d.hasExited()) break;
                await ask(d.port, "GET", "/health", 1000);
                await sleep(100);
            }
            assert.ok(d.hasExited(), "daemon was still running 15s after /shutdown while being polled");
        });

        it("stops answering once it is gone", async () => {
            const h = await ask(d.port, "GET", "/health", 1000);
            assert.notEqual(h.status, 200, "something is still serving on the daemon's port");
        });
    });

    describe("POST /schema/reconcile", () => {
        let d;
        before(async () => { d = await startDaemon(); });
        after(() => d && cleanup(d));

        it("reports success on an already-open database", async () => {
            const res = await ask(d.port, "POST", "/schema/reconcile", 60000);
            assert.equal(res.status, 200);
            const body = JSON.parse(res.body);
            assert.ok(!body.error, `reconcile reported: ${body.error}`);
            assert.equal(body.ok, true);
            assert.equal(body.db, "target");
        });

        it("is idempotent — running it again is still a success", async () => {
            const res = await ask(d.port, "POST", "/schema/reconcile", 60000);
            assert.equal(JSON.parse(res.body).ok, true);
        });

        it("leaves the node table carrying every column the schema declares", async () => {
            // The point of the route: after it runs, nothing the builder writes
            // can hit "Cannot find property X". Compare the live catalog against
            // the schema's own DDL rather than a hand-kept list, so a column
            // added to the schema is covered here without editing this test.
            const schema = require("../scripts/ladybug_schema.cjs");
            const ddl = schema.stripComments(schema.NODE_TABLES[0]);
            const body = ddl.slice(ddl.indexOf("(") + 1, ddl.lastIndexOf(")"));
            const wanted = body
                .split(",")
                .map((c) => c.trim())
                .filter((c) => c && !/^PRIMARY\s+KEY/i.test(c))
                .map((c) => (/^(`[^`]+`|[A-Za-z_][A-Za-z0-9_]*)\s+(.+)$/.exec(c) || [])[1])
                .filter(Boolean)
                .map((n) => n.replace(/`/g, ""))
                .filter((n) => !/^PRIMARY$/i.test(n));

            const res = await ask(d.port, "POST", "/cypher", 60000);
            assert.equal(res.status, 400, "sanity: /cypher needs a query and should say so");

            const q = await new Promise((resolve) => {
                const payload = JSON.stringify({ db: "target", cypher: "CALL table_info('CodeNode') RETURN name" });
                const req = http.request(
                    { host: "127.0.0.1", port: d.port, path: "/cypher", method: "POST", timeout: 60000,
                      agent: false, headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload), Connection: "close" } },
                    (r) => { const c = []; r.on("data", (x) => c.push(x)); r.on("end", () => resolve(JSON.parse(Buffer.concat(c).toString("utf8")))); },
                );
                req.on("error", () => resolve({ records: [] }));
                req.end(payload);
            });

            const have = new Set((q.records || []).map((r) => r.name));
            const missing = wanted.filter((n) => !have.has(n));
            assert.deepEqual(missing, [], `columns declared in the schema but absent from CodeNode: ${missing.join(", ")}`);
        });
    });

    describe("routing", () => {
        it("publishes a schema fingerprint so upgraded clients can restart stale daemons", async () => {
            const h = await ask(d.port, "GET", "/health");
            assert.equal(h.status, 200);
            assert.match(JSON.parse(h.body).schemaFingerprint, /^[0-9a-f]{16}$/);
        });
        let d;
        before(async () => { d = await startDaemon(); });
        after(() => d && cleanup(d));

        it("still 404s an unknown path", async () => {
            const res = await ask(d.port, "POST", "/nope");
            assert.equal(res.status, 404);
        });

        it("does not stop on a GET to /shutdown", async () => {
            // Only POST stops it. A stray GET — a browser, a health checker
            // walking routes — must not take the database down.
            await ask(d.port, "GET", "/shutdown");
            await sleep(500);
            const h = await ask(d.port, "GET", "/health");
            assert.equal(h.status, 200, "a GET /shutdown stopped the daemon");
        });
    });
});

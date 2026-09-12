const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
const cli = path.resolve(__dirname, '../bin/codevis.mjs');

test('info CLI reports all recovery artifacts, honors explicit storage, and fails JSON health gates', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codevis-info-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const dataDir = path.join(root, 'data');
    fs.mkdirSync(dataDir);
    fs.writeFileSync(path.join(root, 'codevis.config.cjs'), 'module.exports = {};');
    fs.writeFileSync(path.join(dataDir, 'ladybug-meta'), 'fixture: never opened by a database');
    const artifacts = ['ladybug-meta.wal.corrupt-123', 'ladybug-meta.wal.checkpoint.corrupt-123', 'ladybug-meta.shadow.corrupt-123'];
    for (const name of [...artifacts, 'ladybug-meta.wal', 'unrelated.txt']) fs.writeFileSync(path.join(dataDir, name), 'preserve');
    let queryStatus = 200;
    let queryBody = { records: [{ c: 1 }] };
    let bridgeRoot = root;
    const server = http.createServer((req, res) => {
        res.setHeader('Content-Type', 'application/json');
        if (req.url === '/health') res.end(JSON.stringify({ ok: true, pid: process.pid, dataDir }));
        else if (req.url === '/api/status') res.end(JSON.stringify({ projectRoot: bridgeRoot, dataDir, pid: process.pid }));
        else if (req.url === '/cypher') { res.statusCode = queryStatus; res.end(JSON.stringify(queryBody)); }
        else { res.statusCode = 404; res.end('{}'); }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const port = server.address().port;
    fs.writeFileSync(path.join(dataDir, '.ladybug-daemon.pid'), JSON.stringify({ pid: process.pid, port, dataDir }));
    const env = { ...process.env, CODEVIS_PROJECT_DIR: root, CODEVIS_DATA_DIR: dataDir,
        LADYBUG_DAEMON_PORT: String(port), CODEVIS_BRIDGE_PORT: String(port),
        LADYBUG_PIDFILE: path.join(dataDir, '.ladybug-daemon.pid'),
        LADYBUG_META_PATH: path.join(dataDir, 'ladybug-meta'), LADYBUG_TARGET_PATH: path.join(dataDir, 'ladybug-target'),
    };
    async function info(json = true) {
        try { return { ...(await run(process.execPath, [cli, 'info', ...(json ? ['--json'] : [])], { cwd: root, env, timeout: 25000 })), code: 0 }; }
        catch (error) { if (typeof error.code !== 'number') throw error; return error; }
    }
    const healthy = await info();
    assert.equal(healthy.code, 0, healthy.stderr);
    const report = JSON.parse(healthy.stdout);
    assert.deepEqual(report.facts.quarantinedRecoveryFiles.sort(), artifacts.sort());
    assert.deepEqual(report.facts.quarantinedWals, ['ladybug-meta.wal.corrupt-123']);
    assert.equal(report.facts.usingLegacyDataDir, true);
    assert.equal(report.facts.explicitDataDir, true);
    assert.ok(!report.findings.some((f) => f.title === 'Legacy data directory in use'));
    assert.equal(report.facts.daemons.find((d) => d.port === port).canQuery, true);

    bridgeRoot = path.join(root, 'different-project');
    for (const json of [true, false]) {
        const mismatch = await info(json);
        assert.equal(mismatch.code, 1);
        assert.match(mismatch.stdout, /Bridge belongs to another project/);
    }
    bridgeRoot = root;
    for (const [status, body] of [[503, { records: [] }], [200, {}]]) {
        queryStatus = status;
        queryBody = body;
        const failed = await info();
        assert.equal(failed.code, 1);
        assert.equal(JSON.parse(failed.stdout).facts.daemons.find((d) => d.port === port).canQuery, false);
    }
    for (const name of artifacts) assert.equal(fs.readFileSync(path.join(dataDir, name), 'utf8'), 'preserve');

    queryStatus = 200;
    queryBody = { records: [] };
    env.LADYBUG_DAEMON_PORT = '65535';
    const upperPort = await info();
    assert.equal(upperPort.code, 0, upperPort.stderr);
    assert.equal(JSON.parse(upperPort.stdout).facts.daemons.find((d) => d.port === port).canQuery, true);
});

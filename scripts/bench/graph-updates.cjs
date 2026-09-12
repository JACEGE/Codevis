#!/usr/bin/env node
// Opt-in benchmark. Uses production update paths, a generated project and a
// private daemon. No changes to the host project's graph or update behavior.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
const { performance } = require('node:perf_hooks');

const repo = path.resolve(__dirname, '../..');
const argv = process.argv.slice(2);
function option(name, fallback) {
    const i = argv.indexOf(`--${name}`);
    return i < 0 ? fallback : argv[i + 1];
}
function positive(name, fallback) {
    const n = Number(option(name, fallback));
    assert.ok(Number.isInteger(n) && n > 0 && n <= 1000, `Invalid --${name}`);
    return n;
}
const settings = {
    callers: positive('callers', 12), helpers: positive('helpers', 20),
    unrelated: positive('unrelated', 20), edits: positive('edits', 6), repeats: positive('repeats', 3),
};
assert.ok(settings.helpers >= 2, '--helpers must be at least 2');
const output = path.resolve(option('output', path.join(repo, '.codevis/graph-update-benchmark.json')));
const compareBatching = argv.includes('--compare-batching');
const baselineRef = option('baseline', '2d59efb');
function loadBaselineSync() {
    const ts = require('typescript');
    const vm = require('node:vm');
    const source = execFileSync('git', ['show', `${baselineRef}:tools/lib/graph-sync.ts`], { cwd:repo, encoding:'utf8' });
    const tree = ts.createSourceFile('baseline.ts',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
    const functions = ['extractSyncFunctions','syncFileToGraph'].map(name => {
        const fn = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
        assert.ok(fn, `Baseline function missing: ${name}`);
        return fn.getText(tree).replace(/^export\s+/, '');
    }).join('\n');
    const code = ts.transpileModule(functions, { compilerOptions:{target:ts.ScriptTarget.ES2022} }).outputText;
    return vm.runInNewContext(`${code}\nsyncFileToGraph`, { ...fs,
        createHash:require('node:crypto').createHash,
        ...require(path.join(repo,'tools/lib/treesitter.ts')) });
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function freePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const port = server.address().port;
            server.close(() => resolve(port));
        });
    });
}
function stats(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return { median: sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2,
        min: sorted[0], max: sorted.at(-1) };
}
function source(revision, scenario) {
    const parameter = scenario === 'interface' ? `value, offset = ${revision}` : 'value';
    const target = scenario === 'calls' && revision > 0 ? 'helper1' : 'helper0';
    const functions = [`export function targetD(${parameter}) { return ${target}(value) + ${revision}; }`];
    for (let i = 0; i < settings.helpers; i++) {
        functions.push(`function helper${i}(value) { return ${i + 1 < settings.helpers ? `helper${i + 1}(value)` : 'value'}; }`);
    }
    return functions.join('\n') + '\n';
}

async function main() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codevis-update-benchmark-'));
    const dataDir = path.join(root, '.codevis');
    const port = await freePort();
    const env = { ...process.env, CODEVIS_PROJECT_DIR: root, CODEVIS_DATA_DIR: dataDir,
        LADYBUG_DAEMON_PORT: String(port), LADYBUG_PIDFILE: path.join(dataDir, 'daemon.pid'),
        LADYBUG_CHECKPOINT_MS: '0', CODEVIS_LOCK_SWEEP_MS: '0', LOG_TO_GRAPH: 'false' };
    // Inherited database-path overrides must never redirect this benchmark.
    for (const key of ['LADYBUG_TARGET_PATH', 'LADYBUG_META_PATH', 'CODEVIS_TARGET_SRC', 'CODEVIS_META_SRC']) {
        delete env[key]; delete process.env[key];
    }
    Object.assign(process.env, env);
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.mkdirSync(dataDir);
    fs.writeFileSync(path.join(root, 'codevis.config.cjs'), `module.exports = ${JSON.stringify({
        workspaces: { project_db: { sourceDir: ['src'], dbUri: 'bolt://localhost:7687', auth: { user: '', pass: '' } } },
        locking: { enabled: false }, autoUpdate: { enabled: false }, extractors: { ros: false },
    })};\n`);
    const changedFile = path.join(root, 'src/c.js');
    fs.writeFileSync(changedFile, source(0, 'body'));
    for (let i = 0; i < settings.callers; i++) {
        fs.writeFileSync(path.join(root, `src/a${i}.js`),
            `import { targetD } from './c.js';\nexport function caller${i}(value) { return targetD(value); }\n`);
    }
    for (let i = 0; i < settings.unrelated; i++) {
        fs.writeFileSync(path.join(root, `src/u${i}.js`), `export function unrelated${i}(value) { return value + ${i}; }\n`);
    }
    const daemonLog = fs.openSync(path.join(root, 'daemon.log'), 'w');
    const child = spawn(process.execPath, [path.join(repo, 'server/ladybug-daemon.cjs')],
        { env, cwd: root, stdio: ['ignore', daemonLog, daemonLog], windowsHide: true });
    fs.closeSync(daemonLog);
    let exited = false;
    child.once('exit', () => { exited = true; });
    let driver, ladybug;
    const report = { timestamp: new Date().toISOString(), settings,
        environment: { platform: process.platform, arch: process.arch, node: process.version,
            cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length,
            commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
            dirtyFiles: execFileSync('git', ['diff', '--name-only'], { cwd: repo, encoding: 'utf8' }).trim().split('\n').filter(Boolean) },
        scope: compareBatching
            ? 'Synthetic JavaScript; real daemon/driver; legacy versus atomic batched file sync, immediate and checkpoint schedules; no parser cache or concurrent agent workload.'
            : 'Synthetic JavaScript; real daemon/driver; same production algorithms across schedules; no parser cache or concurrent agent workload.',
        rows: [], correctness: [], setupMs: 0 };
    fs.mkdirSync(path.dirname(output), { recursive: true });
    const save = () => fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
    try {
        const deadline = Date.now() + 30000;
        let healthy = false;
        while (Date.now() < deadline && !exited) {
            try {
                const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
                const health = await response.json();
                if (response.ok && Number(health.pid) === child.pid) { healthy = true; break; }
            } catch { /* startup */ }
            await delay(100);
        }
        assert.ok(healthy, 'Private daemon failed to start');
        require(path.join(repo, 'lib/tsx-userinfo-preload.cjs'));
        require('tsx/cjs/api').register();
        ladybug = require(path.join(repo, 'server/ladybug-driver.cjs'));
        driver = ladybug.driver('bolt://localhost:7687');
        const { syncFileToGraph } = require(path.join(repo, 'tools/lib/graph-sync.ts'));
        const baselineSync = compareBatching ? loadBaselineSync() : null;
        report.baselineRef = compareBatching ? baselineRef : null;
        let requests = 0, requestMs = 0;
        const countedDriver = { session() {
            const session = driver.session();
            return { async run(query, params) {
                requests++;
                const start = performance.now();
                try { return await session.run(query, params); }
                finally { requestMs += performance.now() - start; }
            }, async syncGraphFileAtomic(snapshot) {
                requests++;
                const start = performance.now();
                try { return await session.syncGraphFileAtomic(snapshot); }
                finally { requestMs += performance.now() - start; }
            }, close: () => session.close() };
        } };
        async function query(cypher) {
            const session = driver.session();
            try {
                const result = await session.run(cypher);
                return result.records.map(r => Object.fromEntries(r.keys.map(k => {
                    const value = r.get(k);
                    return [k, value?.toNumber ? value.toNumber() : value];
                })));
            } finally { await session.close(); }
        }
        async function build(mode = 'diff') {
            const start = performance.now();
            const { stdout } = await execFile(process.execPath, [path.join(repo, 'scripts/graph_builder.js'), 'project_db', mode],
                { cwd: root, env, timeout: 180000, maxBuffer: 10 * 1024 * 1024, windowsHide: true });
            return { ms: performance.now() - start,
                dependentFiles: Number(stdout.match(/Smart mode: (\d+) additional direct dependent/)?.[1] || 0),
                changedFiles: Number(stdout.match(/Smart mode: (\d+) changed/)?.[1] || 0) };
        }
        const setupStart = performance.now();
        await build('full');
        await query(`MATCH (d:Function {name:'targetD', file:'src/c.js'})
            CREATE (t:Task {taskId:'benchmark-task', title:'Benchmark'})
            CREATE (k:Knowledge {name:'Benchmark invariant'})
            CREATE (t)-[:AFFECTS]->(d) CREATE (k)-[:APPLIES_TO]->(d)`);
        report.setupMs = performance.now() - setupStart;
        console.log(`Fixture ready: ${settings.callers + settings.unrelated + 1} files, ${settings.callers} incoming callers; setup ${Math.round(report.setupMs)}ms`);

        async function snapshot(scenario, revision) {
            const calls = await query(`MATCH (a:Function)-[:CALLS]->(b:Function)
                RETURN a.file AS file,a.name AS caller,b.file AS targetFile,b.name AS callee ORDER BY file,caller,targetFile,callee`);
            const expected = [];
            for (let i = 0; i < settings.callers; i++) expected.push({ file:`src/a${i}.js`, caller:`caller${i}`, targetFile:'src/c.js', callee:'targetD' });
            expected.push({ file:'src/c.js', caller:'targetD', targetFile:'src/c.js', callee:scenario === 'calls' && revision > 0 ? 'helper1' : 'helper0' });
            for (let i = 0; i < settings.helpers - 1; i++) expected.push({ file:'src/c.js', caller:`helper${i}`, targetFile:'src/c.js', callee:`helper${i + 1}` });
            const canonical = rows => rows.map(row => JSON.stringify(row)).sort();
            assert.deepEqual(canonical(calls), canonical(expected), 'Exact incoming/outgoing CALLS set changed unexpectedly');
            const authored = await query(`MATCH (:Task {taskId:'benchmark-task'})-[:AFFECTS]->(d:Function {name:'targetD'})
                MATCH (:Knowledge {name:'Benchmark invariant'})-[:APPLIES_TO]->(d) RETURN count(d) AS count`);
            assert.equal(authored[0].count, 1, 'Authored relationships must survive');
            const functions = await query(`MATCH (f:Function) RETURN f.file AS file,f.name AS name,f.params AS params,
                f.startLine AS startLine,f.endLine AS endLine,f.bodySnippet AS bodySnippet ORDER BY file,name`);
            assert.equal(functions.length, settings.callers + settings.unrelated + settings.helpers + 1);
            const target = functions.find(f => f.name === 'targetD');
            assert.ok(target.bodySnippet.includes(`+ ${revision}`), 'Graph must contain the final body');
            if (scenario === 'interface') assert.ok(target.params.includes(`offset = ${revision}`), 'Final signature must be current');
            return { calls, functions };
        }
        await snapshot('body', 0);
        // Unmeasured warm-up loads the MCP parser and verifies the same fixture.
        assert.ok(await syncFileToGraph(changedFile, 'src/c.js', '.js', countedDriver));
        const pipelines = compareBatching
            ? [['legacy-file-sync','body'],['mcp-file-sync','body'],['legacy-file-sync','calls'],['mcp-file-sync','calls']]
            : [['mcp-file-sync','body'], ['mcp-file-sync','calls'], ['smart-builder','body'], ['smart-builder','interface']];
        const comparisonSnapshots = new Map();
        for (const [pipeline, scenario] of pipelines) {
            const sync = pipeline === 'legacy-file-sync' ? baselineSync : syncFileToGraph;
            let reference;
            for (let trial = 0; trial < settings.repeats; trial++) {
                // Alternate order to reduce warm-cache/order bias.
                const order = trial % 2 ? ['checkpoint','per-edit'] : ['per-edit','checkpoint'];
                for (const schedule of order) {
                    fs.writeFileSync(changedFile, source(0, scenario));
                    if (pipeline === 'smart-builder') await build();
                    else assert.ok(await sync(changedFile, 'src/c.js', '.js', countedDriver));
                    await snapshot(scenario, 0);
                    requests = 0; requestMs = 0;
                    const row = { pipeline, scenario, schedule, trial:trial + 1, totalMs:0, syncMs:0,
                        finalUpdateMs:0, updates:0, dependentFiles:0, changedFiles:0 };
                    const start = performance.now();
                    for (let revision = 1; revision <= settings.edits; revision++) {
                        fs.writeFileSync(changedFile, source(revision, scenario));
                        if (schedule === 'checkpoint' && revision < settings.edits) continue;
                        const syncStart = performance.now();
                        if (pipeline === 'smart-builder') {
                            const result = await build();
                            assert.equal(result.changedFiles, 1, 'Expected precisely one changed source file');
                            assert.equal(result.dependentFiles, settings.callers, 'Unchanged callers must be included');
                            row.dependentFiles += result.dependentFiles; row.changedFiles += result.changedFiles;
                        } else assert.ok(await sync(changedFile, 'src/c.js', '.js', countedDriver));
                        const duration = performance.now() - syncStart;
                        row.syncMs += duration; row.finalUpdateMs = duration; row.updates++;
                    }
                    row.totalMs = performance.now() - start;
                    row.requests = pipeline !== 'smart-builder' ? requests : null;
                    row.requestMs = pipeline !== 'smart-builder' ? requestMs : null;
                    const actual = await snapshot(scenario, settings.edits);
                    if (compareBatching) {
                        if (comparisonSnapshots.has(scenario)) assert.deepEqual(actual, comparisonSnapshots.get(scenario), 'Batched sync must match the legacy function/call snapshot');
                        else comparisonSnapshots.set(scenario,actual);
                    }
                    if (reference) assert.deepEqual(actual, reference, 'Schedules must produce identical final function metadata and calls');
                    else reference = actual;
                    report.rows.push(row); save();
                    console.log(`${pipeline}/${scenario} ${schedule} trial ${trial + 1}: ${Math.round(row.totalMs)}ms, ${row.updates} updates, incoming ${settings.callers}/${settings.callers} intact`);
                }
            }
            report.correctness.push({ pipeline, scenario, identicalFinalGraph:true, incomingCalls:settings.callers,
                exactCallSet:true, authoredLinksPreserved:true });
        }
        report.summary = [];
        for (const { pipeline, scenario } of report.correctness) {
            const rows = report.rows.filter(r => r.pipeline === pipeline && r.scenario === scenario);
            const perEdit = stats(rows.filter(r => r.schedule === 'per-edit').map(r => r.totalMs));
            const checkpoint = stats(rows.filter(r => r.schedule === 'checkpoint').map(r => r.totalMs));
            report.summary.push({ pipeline, scenario, perEditMs:perEdit, checkpointMs:checkpoint,
                speedup:perEdit.median / checkpoint.median,
                checkpointFinalUpdateMs:stats(rows.filter(r => r.schedule === 'checkpoint').map(r => r.finalUpdateMs)) });
        }
        report.success = true;
        save();
        console.log(JSON.stringify(report.summary, null, 2));
        console.log(`Report: ${output}`);
    } catch (error) {
        report.success = false; report.error = error.stack; save(); throw error;
    } finally {
        await driver?.close();
        if (ladybug) await ladybug.stopDaemon({ timeoutMs:15000 });
        else if (!exited) {
            await fetch(`http://127.0.0.1:${port}/shutdown`, { method:'POST', signal:AbortSignal.timeout(5000) }).catch(() => {});
        }
        const deadline = Date.now() + 15000;
        while (!exited && Date.now() < deadline) await delay(100);
        if (!exited) { child.kill(); await delay(250); }
        // root is the exact directory returned by mkdtemp; no project paths are deleted.
        await fs.promises.rm(root, { recursive:true, force:true, maxRetries:20, retryDelay:250 });
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

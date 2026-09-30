const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const cli = path.resolve(__dirname, '../bin/codevis.mjs');
const driverPath = require.resolve('../server/ladybug-driver.cjs');

// c.js calls b.js, b.js calls a.js. Changing a.js reparses a and its direct
// dependent b; c is not reparsed. c's call into b used to vanish with b's
// deleted nodes, because only reparsed files re-emit their edges.
test('an incremental build keeps calls into a reparsed dependent from files it did not reparse', { timeout: 180000 }, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codevis-chain-'));
    const env = { ...process.env, CODEVIS_PROJECT_DIR: root };
    for (const key of ['CODEVIS_DATA_DIR', 'LADYBUG_TARGET_PATH', 'LADYBUG_META_PATH', 'LADYBUG_DAEMON_PORT']) delete env[key];
    const run = (...args) => spawnSync(process.execPath, [cli, ...args], { cwd: root, env, encoding: 'utf8', timeout: 120000 });
    const calls = () => {
        const script = `const l=require(${JSON.stringify(driverPath)});(async()=>{const d=l.workspace('project_db');const s=d.session();
            const r=await s.run("MATCH (x:Function)-[:CALLS]->(y:Function) RETURN x.name+'->'+y.name AS v ORDER BY v");
            console.log(JSON.stringify(r.records.map(x=>x.get('v'))));await s.close();await d.close();})().catch(e=>{console.error(e.message);process.exit(1);});`;
        const result = spawnSync(process.execPath, ['-e', script], { cwd: root, env, encoding: 'utf8', timeout: 60000 });
        assert.equal(result.status, 0, result.stderr);
        return JSON.parse(result.stdout.trim().split('\n').pop());
    };
    t.after(() => {
        run('stop');
        try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 }); } catch { /* temp dir */ }
    });

    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'codevis.config.cjs'), "module.exports = { workspaces: { project_db: { sourceDir: ['src'] } } };\n");
    fs.writeFileSync(path.join(root, 'src/a.js'), 'export function base() { return 1; }\n');
    fs.writeFileSync(path.join(root, 'src/b.js'), "import { base } from './a.js';\nexport function middle() { return base() + 1; }\n");
    fs.writeFileSync(path.join(root, 'src/c.js'), "import { middle } from './b.js';\nexport function top() { return middle() + 1; }\n");
    let build = run('build', 'full');
    assert.equal(build.status, 0, build.stderr);
    const before = calls();
    assert.deepEqual(before, ['middle->base', 'top->middle']);

    // Change only a.js; keep mtimes moving forward on coarse file systems.
    const later = new Date(Date.now() + 5000);
    fs.writeFileSync(path.join(root, 'src/a.js'), 'export function base() { return 2; }\n');
    fs.utimesSync(path.join(root, 'src/a.js'), later, later);
    build = run('build');
    assert.equal(build.status, 0, build.stderr);
    assert.deepEqual(calls(), before, 'top->middle survives although c.js was not reparsed');
});

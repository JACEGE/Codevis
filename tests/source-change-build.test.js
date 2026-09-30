const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const cli = path.resolve(__dirname, '../bin/codevis.mjs');
const driverPath = require.resolve('../server/ladybug-driver.cjs');

// A folder added to sourceDir after the first build used to stop every later
// build ("move the database aside"), which would have thrown away the Tasks,
// Flows and Knowledge that live in the same database.
test('adding a source folder later rebuilds the code graph and keeps Tasks and Knowledge', { timeout: 180000 }, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codevis-source-change-'));
    const env = { ...process.env, CODEVIS_PROJECT_DIR: root };
    delete env.CODEVIS_DATA_DIR; delete env.LADYBUG_TARGET_PATH; delete env.LADYBUG_META_PATH; delete env.LADYBUG_DAEMON_PORT;
    const run = (...args) => spawnSync(process.execPath, [cli, ...args], { cwd: root, env, encoding: 'utf8', timeout: 120000 });
    const query = (cypher) => {
        const script = `const l=require(${JSON.stringify(driverPath)});(async()=>{const d=l.workspace('project_db');const s=d.session();
            const r=await s.run(${JSON.stringify(cypher)});console.log(JSON.stringify(r.records.map(x=>x.get('v'))));await s.close();await d.close();})()
            .catch(e=>{console.error(e.message);process.exit(1);});`;
        const result = spawnSync(process.execPath, ['-e', script], { cwd: root, env, encoding: 'utf8', timeout: 60000 });
        assert.equal(result.status, 0, result.stderr);
        return JSON.parse(result.stdout.trim().split('\n').pop());
    };
    const config = (dirs) => fs.writeFileSync(path.join(root, 'codevis.config.cjs'),
        `module.exports = { workspaces: { project_db: { sourceDir: ${JSON.stringify(dirs)} } } };\n`);
    t.after(() => {
        run('stop');
        // Windows keeps the database files locked for a moment after the daemon exits.
        try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 }); } catch { /* temp dir; the OS cleans it up */ }
    });

    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src/core.js'), 'export function core() { return 1; }\n');
    config(['src']);
    let build = run('build');
    assert.equal(build.status, 0, build.stderr);
    query("CREATE (:Task {taskId:'task-keep', title:'Keep me'}), (:Knowledge {name:'Rule', content:'kept'}) RETURN 1 AS v");

    fs.mkdirSync(path.join(root, 'frontend'));
    fs.writeFileSync(path.join(root, 'frontend/view.js'), 'export function render() { return 2; }\n');
    config(['src', 'frontend']);
    build = run('build');
    assert.equal(build.status, 0, build.stdout + build.stderr);
    assert.match(build.stdout + build.stderr, /Source folders changed/);

    assert.deepEqual(query("MATCH (t:Task {taskId:'task-keep'}) RETURN t.title AS v"), ['Keep me']);
    assert.deepEqual(query("MATCH (k:Knowledge {name:'Rule'}) RETURN k.content AS v"), ['kept']);
    assert.deepEqual(query("MATCH (f:Function) RETURN f.name AS v ORDER BY v"), ['core', 'render']);

    // The new identity is recorded: the next build is an ordinary diff build again.
    build = run('build');
    assert.equal(build.status, 0, build.stderr);
    assert.doesNotMatch(build.stdout + build.stderr, /Source folders changed/);
});

test('identity changes are classified: sources, moved project, foreign database', () => {
    const paths = require('../server/codevis-paths.cjs');
    const config = { workspaces: { project_db: { sourceDir: ['src'] } } };
    const expected = paths.workspaceIdentityStatus(config, 'project_db').expected;
    const classify = (recorded) => paths.identityChange(expected, { ...expected, fingerprint: 'old', ...recorded });
    assert.equal(paths.identityChange(expected, expected), null);
    assert.equal(paths.identityChange(expected, null), null);
    assert.equal(classify({ sourceDirs: ['/elsewhere'] }), 'sources');
    assert.equal(classify({ workspace: 'codevis_db' }), 'foreign');
    // Default data dir inside the project: the project moved and took its database along.
    const moved = classify({ projectRoot: '/somewhere/else' });
    assert.equal(moved, process.env.CODEVIS_DATA_DIR ? 'foreign' : 'relocated');
});

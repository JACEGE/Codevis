const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('full and incremental builds reject incomplete scans before graph queries or identity adoption', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codevis-build-scan-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const dataDir = path.join(root, '.codevis');
    fs.mkdirSync(dataDir);
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src/app.js'), 'export function app() {}');
    const db = path.join(dataDir, 'ladybug-target');
    fs.writeFileSync(db, 'existing graph');
    fs.writeFileSync(path.join(root, 'codevis.config.cjs'), `module.exports = {
        workspaces: { project_db: { sourceDir: ['src', 'unavailable'], auth: { user: '', pass: '' } } },
        knowledge: { paths: ['./notes'] },
    };`);
    const preload = path.join(root, 'guard.cjs');
    fs.writeFileSync(preload, `
        const fs = require('node:fs');
        const driver = require(${JSON.stringify(require.resolve('../server/ladybug-driver.cjs'))});
        driver.reconcileDaemonSchema = async () => false;
        driver.driver = () => ({
            session: () => ({ run: async () => { throw new Error('GRAPH_QUERY_BEFORE_SOURCE_VALIDATION'); }, close: async () => {} }),
            close: async () => {},
        });
        if (process.env.TEST_UNREADABLE_DIR) {
            const readdir = fs.readdirSync;
            fs.readdirSync = (dir, ...args) => {
                if (dir === process.env.TEST_UNREADABLE_DIR) throw Object.assign(new Error('denied'), { code: 'EACCES' });
                return readdir(dir, ...args);
            };
        }
    `);
    for (const unavailable of ['missing', 'unreadable']) {
        if (unavailable === 'unreadable') fs.mkdirSync(path.join(root, 'unavailable'));
        for (const mode of [[], ['diff']]) {
            const result = spawnSync(process.execPath, ['--require', preload,
                require.resolve('../scripts/graph_builder.js'), 'project_db', ...mode], {
                cwd: root, encoding: 'utf8', timeout: 15000,
                env: { ...process.env, CODEVIS_PROJECT_DIR: root, CODEVIS_DATA_DIR: dataDir,
                    LADYBUG_TARGET_PATH: db,
                    TEST_UNREADABLE_DIR: unavailable === 'unreadable' ? path.join(root, 'unavailable') : '',
                },
            });
            assert.equal(result.status, 1, result.stderr);
            assert.match(result.stderr, /Source scan incomplete/);
            assert.doesNotMatch(result.stderr, /GRAPH_QUERY_BEFORE_SOURCE_VALIDATION/);
            assert.equal(fs.readFileSync(db, 'utf8'), 'existing graph');
            assert.ok(!fs.existsSync(path.join(dataDir, '.build-in-progress')));
            assert.ok(!fs.readdirSync(dataDir).some(name => name.startsWith('.workspace-')));
        }
    }
});

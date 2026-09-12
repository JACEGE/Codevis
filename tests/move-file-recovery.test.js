const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const crypto = require('node:crypto');
require('../lib/tsx-userinfo-preload.cjs');
require('tsx/cjs/api').register();
const parser = require('../tools/lib/treesitter.ts');
const { rewriteMovedImports, assertMoveDestination } = require('../tools/lib/move-imports.ts');

const filename = path.resolve(__dirname, '../tools/handlers/edit-tools.ts');
const tree = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true);
let handler;
function visit(n) {
    if (ts.isPropertyAssignment(n) && n.name.getText(tree) === 'move_function') handler = n.initializer;
    ts.forEachChild(n, visit);
}
visit(tree);

function harness(t, fault, targetExists = true, options = {}) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codevis-move-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const src = path.join(root, 'source.js'), dst = path.join(root, 'target.js');
    const original = options.source || 'function work() { return 42; }\n';
    fs.writeFileSync(src, original);
    if (targetExists) fs.writeFileSync(dst, options.target || '// target\n');
    const importer = path.join(root, 'app.js');
    if (options.importer) fs.writeFileSync(importer, options.importer);
    let locks = [], targetRenames = 0, graphWrites = 0, holdingLocks = false;
    const session = {
        run: async q => {
            if (q.includes('RETURN importer.path')) return { records: options.importer ? [{ get: () => 'app.js' }] : [] };
            if (q.includes('RETURN n.locked')) return { records: [{ get: k => k === 'startLine' ? 1 : null }] };
            if (q.includes('count(n) AS c')) return { records: [{ get: () => ({ toNumber: () => 0 }) }] };
            if (/MERGE|SET n.file/.test(q)) {
                graphWrites++;
                if (fault === 'graph') throw new Error('database unavailable');
            }
            return { records: [] };
        }, close: async () => {},
    };
    const mod = { exports: {} };
    vm.runInNewContext(ts.transpile(`module.exports = ${handler.getText(tree)}`, { target: ts.ScriptTarget.ES2022 }), require('./helpers/file-publication.cjs')({
        module: mod, process, ...path, ...fs, ...crypto, ...parser, rewriteMovedImports, assertMoveDestination, PROJECT_ROOT: root,
        pickDbDriver: () => ({ session: () => session }), isPathAllowed: () => true, graphInt: Number,
        assertFileScope: async file => {
            if (fault === 'scope-race' && file === src && holdingLocks
                && fs.readdirSync(root).some(name => name.includes('.move_tmp.'))) {
                await Promise.resolve();
                fs.writeFileSync(options.changeTarget ? dst : src, '// newer edit\n');
            }
        },
        withFileLock: async (_, fn) => fn(),
        withFileLocks: async (paths, fn) => {
            locks = paths; holdingLocks = true;
            try { return await fn(); } finally { holdingLocks = false; }
        },
        createEditBackup: (file, _, content) => {
            const backupToken = crypto.randomUUID();
            const backupPath = path.join(root, backupToken + '.bak');
            fs.writeFileSync(backupPath, content);
            return { backupToken, backupPath, backupDir: root };
        },
        writeFileSync: (file, ...args) => {
            if (fault === 'target-stage' && file.startsWith(dst + '.')) throw new Error('EACCES target staging');
            if (fault === 'source-stage' && file.startsWith(src + '.')) throw new Error('ENOSPC source staging');
            if (fault === 'importer-stage' && file.startsWith(importer + '.')) throw new Error('EACCES importer staging');
            fs.writeFileSync(file, ...args);
            if (fault === 'external-edit' && file.startsWith(src + '.')) fs.writeFileSync(src, original + '// newer edit\n');
        },
        renameSync: (a, b) => {
            assert.equal(holdingLocks, true, 'commit and rollback must hold the complete file set');
            if (b === dst) targetRenames++;
            if (fault === 'target-rename' && b === dst) throw new Error('EACCES target rename');
            if (fault === 'importer-rename' && b === importer) throw new Error('EACCES importer commit');
            if (['source-rename', 'rollback'].includes(fault) && b === src) throw new Error('EACCES source rename');
            if (fault === 'rollback' && b === dst && targetRenames > 1) throw new Error('EACCES rollback');
            return fs.renameSync(a, b);
        },
        syncFileToGraph: async () => {}, recordEditTouch: async () => {}, logger: { info: () => {} },
    }));
    return { root, src, dst, original, get locks() { return locks; }, get graphWrites() { return graphWrites; },
        run: async (args = {}) => {
            const result = await mod.exports({ agentId: 'audit', functionName: 'work', sourceFile: 'source.js',
                targetFile: 'target.js', updateImports: false, ...args }, { lockingEnabled: false });
            let body; try { body = JSON.parse(result.content[0].text); } catch { body = {}; }
            return { ...result, body };
        } };
}

test('moving a function preserves symbolic links for its source, target and importer', async t => {
    const h = harness(t, null, true, { source: 'export function work() { return 42; }\n', importer: "import { work } from './source.js';\nwork();\n" });
    const targets = new Map();
    for (const file of ['source.js', 'target.js', 'app.js']) {
        const alias = path.join(h.root, file), target = path.join(h.root, 'physical-' + file);
        fs.renameSync(alias, target); fs.symlinkSync(target, alias, 'file');
        targets.set(alias, target);
    }
    const result = await h.run({ updateImports: true });
    assert.equal(result.body.status, 'OK', JSON.stringify(result));
    for (const alias of targets.keys()) assert.equal(fs.lstatSync(alias).isSymbolicLink(), true);
    assert.match(fs.readFileSync(targets.get(path.join(h.root, 'target.js')), 'utf8'), /function work/);
    assert.doesNotMatch(fs.readFileSync(targets.get(path.join(h.root, 'source.js')), 'utf8'), /function work/);
    const importer = fs.readFileSync(targets.get(path.join(h.root, 'app.js')), 'utf8');
    assert.match(importer, /physical-target\.js/);
    fs.writeFileSync(path.join(h.root, 'package.json'), '{"type":"module"}');
    require('node:child_process').execFileSync(process.execPath, [path.join(h.root, 'app.js')], { timeout: 10000 });
});

for (const fault of ['target-stage', 'source-stage', 'target-rename', 'source-rename']) {
    test(`move_function preserves both files after ${fault} failure`, async t => {
        const h = harness(t, fault);
        const result = await h.run();
        assert.equal(result.isError, true);
        assert.equal(fs.readFileSync(h.src, 'utf8'), h.original);
        assert.equal(fs.readFileSync(h.dst, 'utf8'), '// target\n');
        assert.equal(h.graphWrites, 0);
        assert.ok(result.body.backupToken);
        assert.equal(fs.readFileSync(path.join(h.root, result.body.backupToken + '.bak'), 'utf8'), h.original);
        assert.ok(!fs.readdirSync(h.root).some(f => f.includes('_tmp')));
    });
}

test('move_function succeeds while holding source and target together', async t => {
    const h = harness(t);
    const result = await h.run();
    assert.equal(result.body.status, 'OK');
    assert.deepEqual([...h.locks].sort(), [h.src, h.dst].sort());
    assert.doesNotMatch(fs.readFileSync(h.src, 'utf8'), /function work/);
    assert.match(fs.readFileSync(h.dst, 'utf8'), /function work/);
});

test('move_function removes a newly created target on source commit failure', async t => {
    const h = harness(t, 'source-rename', false);
    assert.equal((await h.run()).isError, true);
    assert.equal(fs.readFileSync(h.src, 'utf8'), h.original);
    assert.equal(fs.existsSync(h.dst), false);
});

test('move_function reports failed rollback and keeps both recovery backups', async t => {
    const h = harness(t, 'rollback');
    const result = await h.run();
    assert.equal(result.isError, true);
    assert.equal(result.body.rolledBack, false);
    assert.ok(result.body.rollbackErrors.length);
    assert.equal(fs.readFileSync(h.src, 'utf8'), h.original);
    assert.equal(result.body.backups.length, 2);
    for (const backup of result.body.backups) assert.ok(fs.existsSync(path.join(h.root, backup.backupToken + '.bak')));
});

test('move_function reports committed files and backup tokens on graph failure', async t => {
    const h = harness(t, 'graph');
    const result = await h.run();
    assert.equal(result.isError, true);
    assert.equal(result.body.filesCommitted, true);
    assert.ok(result.body.backupToken);
    assert.match(fs.readFileSync(h.dst, 'utf8'), /function work/);
});

test('move_function rejects identical source and destination before writing', async t => {
    const h = harness(t);
    assert.equal((await h.run({ targetFile: './source.js' })).isError, true);
    assert.equal(fs.readFileSync(h.src, 'utf8'), h.original);
    assert.equal(h.graphWrites, 0);
});

test('move_function preserves an external edit detected during preparation', async t => {
    const h = harness(t, 'external-edit');
    const result = await h.run();
    assert.equal(result.isError, true);
    assert.match(result.body.error, /CONFLICT/);
    assert.equal(fs.readFileSync(h.src, 'utf8'), h.original + '// newer edit\n');
    assert.equal(fs.readFileSync(h.dst, 'utf8'), '// target\n');
    assert.equal(h.graphWrites, 0);
});

for (const changeTarget of [false, true]) {
    test(`move scope wait preserves a newer ${changeTarget ? 'destination' : 'source'} edit`, async t => {
        const h = harness(t, 'scope-race', true, { changeTarget });
        const result = await h.run();
        assert.equal(result.isError, true);
        assert.match(result.body.error, /CONFLICT/);
        assert.equal(fs.readFileSync(h.src, 'utf8'), changeTarget ? h.original : '// newer edit\n');
        assert.equal(fs.readFileSync(h.dst, 'utf8'), changeTarget ? '// newer edit\n' : '// target\n');
        assert.equal(h.graphWrites, 0);
    });
}

test('move_function successfully creates a previously absent target', async t => {
    const h = harness(t, undefined, false);
    const result = await h.run();
    assert.equal(result.body.status, 'OK');
    assert.doesNotMatch(fs.readFileSync(h.src, 'utf8'), /function work/);
    assert.match(fs.readFileSync(h.dst, 'utf8'), /function work/);
    assert.equal(result.body.backups.find(b => b.file === 'target.js').existed, false);
});

for (const fault of ['importer-stage', 'importer-rename']) {
    test(`move_function rolls back the complete move after ${fault}`, async t => {
        const importer = "import { work, helper } from './source.js';\n";
        const h = harness(t, fault, true, { source: 'export function work() {}\nexport function helper() {}\n', importer });
        const result = await h.run({ updateImports: true });
        assert.equal(result.isError, true);
        assert.equal(fs.readFileSync(h.src, 'utf8'), h.original);
        assert.equal(fs.readFileSync(h.dst, 'utf8'), '// target\n');
        assert.equal(fs.readFileSync(path.join(h.root, 'app.js'), 'utf8'), importer);
    });
}

test('moved exported function and mixed .js imports execute successfully in Node', async t => {
    const h = harness(t, undefined, true, {
        source: 'export function work() { return 40; }\nexport function helper() { return 2; }\n',
        importer: "import { work as calculate, helper } from './source.js';\nconsole.log(calculate() + helper());\n",
    });
    fs.writeFileSync(path.join(h.root, 'package.json'), '{"type":"module"}');
    const result = await h.run({ updateImports: true });
    assert.equal(result.body.status, 'OK', JSON.stringify(result));
    assert.equal(result.body.importsUpdated, 1);
    const run = require('node:child_process').spawnSync(process.execPath, [path.join(h.root, 'app.js')], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.trim(), '42');
});

for (const importer of [
    "import local from './source.js'; console.log(local());",
    "import local, { helper } from './source.js'; console.log(local() + helper());",
    "import { default as local, helper } from './source.js'; console.log(local() + helper());",
]) {
    test(`default move executes with ${importer}`, async t => {
        const mixed = importer.includes('helper');
        const h = harness(t, undefined, true, {
            source: `export default function work() { return ${mixed ? 40 : 42}; }\nexport function helper() { return 2; }\n`, importer,
        });
        fs.writeFileSync(path.join(h.root, 'package.json'), '{"type":"module"}');
        const result = await h.run({ updateImports: true });
        assert.equal(result.body.status, 'OK', JSON.stringify(result));
        const run = require('node:child_process').spawnSync(process.execPath, [path.join(h.root, 'app.js')], { encoding: 'utf8' });
        assert.equal(run.status, 0, run.stderr);
        assert.equal(run.stdout.trim(), '42');
    });
}
test('move rejects a grouped declaration without changing any file', async t => {
    const importer = "import { work, helper } from './source.js'; console.log(work() + helper());";
    const h = harness(t, undefined, true, { source: 'export const work = () => 40, helper = () => 2;', importer });
    const result = await h.run({ updateImports: true });
    assert.equal(result.isError, true);
    assert.match(result.body.error, /multi-declarator/);
    assert.equal(fs.readFileSync(h.src, 'utf8'), h.original);
    assert.equal(fs.readFileSync(h.dst, 'utf8'), '// target\n');
    assert.equal(fs.readFileSync(path.join(h.root, 'app.js'), 'utf8'), importer);
    assert.equal(h.graphWrites, 0);
});

test('move rejects a conflicting default export without touching source or target', async t => {
    const target = 'export default function existing() {}';
    const h = harness(t, undefined, true, { source: 'export default function work() {}', target });
    const result = await h.run();
    assert.equal(result.isError, true);
    assert.match(result.body.error, /already has a default/);
    assert.equal(fs.readFileSync(h.src, 'utf8'), h.original);
    assert.equal(fs.readFileSync(h.dst, 'utf8'), target);
    assert.equal(h.graphWrites, 0);
});

test('move rejects discovered re-exports before changing any file', async t => {
    const importer = 'export { work } from "./source.js";';
    const h = harness(t, undefined, true, { source: 'export function work() {}', importer });
    const result = await h.run({ updateImports: true });
    assert.equal(result.isError, true);
    assert.match(result.body.error, /Re-export/);
    assert.equal(fs.readFileSync(h.src, 'utf8'), h.original);
    assert.equal(fs.readFileSync(h.dst, 'utf8'), '// target\n');
    assert.equal(fs.readFileSync(path.join(h.root, 'app.js'), 'utf8'), importer);
});

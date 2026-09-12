const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const path = require('node:path');
require('../lib/tsx-userinfo-preload.cjs');
require('tsx/cjs/api').register();
const parser = require('../tools/lib/treesitter.ts');

function harness(intervene, options = {}) {
    const filename = path.resolve(__dirname, '../tools/handlers/edit-tools.ts');
    const tree = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true);
    let handler;
    const visit = n => {
        if (ts.isPropertyAssignment(n) && n.name.getText(tree) === 'multi_file_edit') handler = n.initializer;
        ts.forEachChild(n, visit);
    };
    visit(tree);
    const root = options.root || path.resolve(__dirname, '..');
    const files = new Map(['a.js', 'b.js'].map(f => [path.resolve(root, f), 'function work() { return 1; }\n// original\n']));
    const session = { run: async () => {
        await options.duringQuery?.();
        return { records: [{ get: k => k === 'startLine' ? 1 : null }] };
    }, close: async () => {} };
    const mod = { exports: {} };
    vm.runInNewContext(ts.transpile(`module.exports = ${handler.getText(tree)}`, { target: ts.ScriptTarget.ES2022 }), require('./helpers/file-publication.cjs')({
        module: mod, PROJECT_ROOT: root, process, console, Date, Map, Set, ...path, ...parser,
        ...require('../tools/lib/edit-backups.cjs'),
        randomUUID: require('node:crypto').randomUUID, pickDbDriver: () => ({ session: () => session }),
        isPathAllowed: () => true, graphInt: Number,
        assertFileScope: async file => { await options.duringScope?.(files, root, file); },
        readFileSync: p => files.get(p), writeFileSync: (p, v) => files.set(p, v), mkdirSync: () => {},
        existsSync: p => files.has(p), rmSync: p => files.delete(p),
        renameSync: (a, b) => { options.beforeRename?.(files, root, a, b); files.set(b, files.get(a)); files.delete(a); },
        getFileLockPath: options.filesystem ? require('../tools/lib/file-ops.ts').getFileLockPath : p => p,
        ...options.filesystem,
        withFileLocks: async (paths, fn) => { intervene?.(files, root, paths); return fn(); },
        liveSyncFile: async () => null, recordEditTouch: async () => {}, logger: { info: () => {} },
    }));
    const raw = (edits, extra = {}) => mod.exports({ agentId: 'audit', edits, ...extra }, { lockingEnabled: false });
    return { files, root, raw, run: async (edits, extra = {}) => JSON.parse((await raw(edits, extra)).content[0].text) };
}
const edits = ['a.js', 'b.js'].map(file => ({ file, functionName: 'work', oldString: 'return 1', newString: 'return 2' }));

test('multi-file edits merge two symlink aliases without replacing either link', async t => {
    const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'codevis-multi-links-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const actual = path.join(root, 'actual.js');
    fs.writeFileSync(actual, 'function work() { return 1; }\n');
    for (const name of ['a.js', 'b.js']) fs.symlinkSync(actual, path.join(root, name), 'file');
    const h = harness(null, { root, filesystem: fs });
    const result = await h.run([edits[0], { ...edits[1], oldString: 'return 2', newString: 'return 3' }]);
    assert.equal(result.status, 'OK', JSON.stringify(result));
    assert.match(fs.readFileSync(actual, 'utf8'), /return 3/);
    for (const name of ['a.js', 'b.js']) assert.equal(fs.lstatSync(path.join(root, name)).isSymbolicLink(), true);
});
test('multi-file staging conflict preserves both user edit and all uncommitted files', async () => {
    const h = harness((files, root, paths) => {
        assert.equal(paths.length, 2);
        files.set(path.resolve(root, 'b.js'), 'function work() { return 1; }\n// NEW USER EDIT\n');
    });
    assert.equal((await h.run(edits)).status, 'CONFLICT');
    assert.match(h.files.get(path.resolve(h.root, 'a.js')), /return 1/);
    assert.match(h.files.get(path.resolve(h.root, 'b.js')), /NEW USER EDIT/);
    assert.ok(![...h.files.keys()].some(f => f.includes('.multi_tmp.')));
});
test('multi-file unchanged snapshot commits every staged edit', async () => {
    const h = harness();
    assert.equal((await h.run(edits)).status, 'OK');
    for (const file of ['a.js', 'b.js']) assert.match(h.files.get(path.resolve(h.root, file)), /return 2/);
});

for (const changedFile of ['a.js', 'b.js']) {
    test(`multi-file scope wait preserves a newer edit to ${changedFile}`, async () => {
        const h = harness(null, { duringScope: async (files, root, file) => {
            if (file === path.resolve(root, 'b.js')) {
                await Promise.resolve();
                files.set(path.resolve(root, changedFile), 'function work() { return 99; }\n');
            }
        } });
        const response = await h.raw(edits);
        assert.equal(response.isError, true);
        assert.equal(JSON.parse(response.content[0].text).status, 'CONFLICT');
        for (const file of ['a.js', 'b.js']) {
            assert.match(h.files.get(path.resolve(h.root, file)), file === changedFile ? /return 99/ : /return 1/);
        }
        assert.ok(![...h.files.keys()].some(file => file.includes('.multi_tmp.')));
    });
}

test('multi-file staging failures expose the MCP error flag', async () => {
    const h = harness();
    const response = await h.raw([{ ...edits[0], oldString: 'missing text' }]);
    assert.equal(response.isError, true);
    assert.equal(JSON.parse(response.content[0].text).status, 'STAGING_FAIL');
});

test('multi-file commit failures expose the MCP error flag and restore earlier files', async () => {
    const h = harness(null, { beforeRename: (_files, root, _from, to) => {
        if (to === path.resolve(root, 'b.js')) throw new Error('simulated rename failure');
    } });
    const response = await h.raw(edits);
    assert.equal(response.isError, true);
    const result = JSON.parse(response.content[0].text);
    assert.equal(result.status, 'PARTIAL_FAIL');
    assert.deepEqual(result.rollbackErrors, []);
    for (const file of ['a.js', 'b.js']) assert.match(h.files.get(path.resolve(h.root, file)), /return 1/);
});

test('multi-file rollback preserves a newer external edit and its recovery backup', async () => {
    const h = harness(null, { beforeRename: (files, root, _from, to) => {
        if (to === path.resolve(root, 'b.js')) {
            files.set(path.resolve(root, 'a.js'), 'function work() { return 99; }\n');
            throw new Error('simulated rename failure');
        }
    } });
    const result = await h.run(edits);
    assert.equal(result.status, 'PARTIAL_FAIL');
    assert.match(h.files.get(path.resolve(h.root, 'a.js')), /return 99/);
    assert.equal(result.rollbackErrors.length, 1);
    assert.ok(result.backupPaths.some(file => /return 1/.test(h.files.get(file))));
});

test('another language parsed during a graph query cannot change multi-file parsing', async () => {
    const h = harness(null, { duringQuery: async () => {
        const { lang } = await parser.getLanguageAndQuery('.py');
        parser.getParserInstance().setLanguage(lang);
        const tree = parser.getParserInstance().parse('def other():\n    return 1\n');
        tree.delete();
    } });
    assert.equal((await h.run(edits)).status, 'OK');
    for (const file of ['a.js', 'b.js']) assert.match(h.files.get(path.resolve(h.root, file)), /return 2/);
});

test('multi-file backups cannot escape their directory through the agent ID', async () => {
    const h = harness();
    assert.equal((await h.run(edits, { agentId: '../../../../elsewhere' })).status, 'OK');
    const backups = [...h.files.keys()].filter(file => file.endsWith('.bak'));
    assert.equal(backups.length, 2);
    for (const file of backups) assert.equal(path.dirname(file), path.join(h.root, '.claude', 'backups'));
});

test('multi-file edits through directory aliases share one staged buffer', async t => {
    const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'codevis-edit-alias-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, 'src'));
    fs.symlinkSync(path.join(root, 'src'), path.join(root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
    const file = path.join(root, 'src/app.js');
    fs.writeFileSync(file, 'function work() { const x = 1; return 2; }');
    const h = harness(null, { root, filesystem: fs });
    const result = await h.run([
        { file: 'src/app.js', functionName: 'work', oldString: 'const x = 1', newString: 'const x = 3' },
        { file: 'alias/app.js', functionName: 'work', oldString: 'return 2', newString: 'return 4' },
    ]);
    assert.equal(result.status, 'OK');
    assert.equal(fs.readFileSync(file, 'utf8'), 'function work() { const x = 3; return 4; }');
    assert.equal(result.backupTokens.length, 1);
});

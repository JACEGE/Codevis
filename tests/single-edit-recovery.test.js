const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
require('../lib/tsx-userinfo-preload.cjs');
require('tsx/cjs/api').register();
const parser = require('../tools/lib/treesitter.ts');
const { replaceFileSnapshot } = require('../tools/lib/edit-transaction.ts');

function harness(t, name, fault, options = {}) {
    const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'codevis-single-edit-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const file = path.join(root, 'source.js');
    const original = options.original || 'function work() { return 1; }\n';
    fs.writeFileSync(file, original);
    const source = ts.createSourceFile('edit-tools.ts', fs.readFileSync('tools/handlers/edit-tools.ts', 'utf8'), ts.ScriptTarget.Latest, true);
    let handler, detect;
    function visit(node) {
        if (ts.isPropertyAssignment(node) && node.name.getText(source) === name) handler = node.initializer;
        if (ts.isFunctionDeclaration(node) && node.name?.text === 'detectFunctionChanges') detect = node;
        ts.forEachChild(node, visit);
    }
    visit(source);
    const session = { run: async query => {
        if (query.includes('RETURN f.locked')) return { records: [{ get: key => ({ locked: true, lockedBy: 'audit', startLine: 1 })[key] }] };
        if (query.includes('RETURN f.name AS name') && fault === 'language') {
            const { lang } = await parser.getLanguageAndQuery('.py');
            parser.getParserInstance().setLanguage(lang);
        }
        if (query.includes('UNWIND $funcs') && fault?.startsWith('graph')) {
            if (fault === 'graph-newer') fs.writeFileSync(file, 'function work() { return 99; }\n');
            throw new Error('database unavailable');
        }
        return { records: [] };
    }, close: async () => {} };
    const mod = { exports: {} };
    const allocated = new Set(), deleted = new Set();
    t.after(() => assert.equal(deleted.size, allocated.size, 'every allocated syntax tree must be released'));
    vm.runInNewContext(ts.transpile(`${detect.getText(source)}\nmodule.exports = ${handler.getText(source)}`, { target: ts.ScriptTarget.ES2022 }), require('./helpers/file-publication.cjs')({
        module: mod, process, ...fs, ...path, ...parser, ...require('node:crypto'),
        getParserInstance: () => ({
            setLanguage: lang => parser.getParserInstance().setLanguage(lang),
            parse: content => {
                const tree = parser.getParserInstance().parse(content);
                allocated.add(tree);
                const dispose = tree.delete.bind(tree);
                tree.delete = () => { assert.ok(!deleted.has(tree), 'tree must not be released twice'); deleted.add(tree); dispose(); };
                return tree;
            },
        }),
        PROJECT_ROOT: root, pickDbDriver: () => ({ session: () => session }), isPathAllowed: () => true,
        graphInt: Number, checkAndResyncIfChanged: async () => ({ changed: false }),
        withFileLock: async (_, fn) => fn(), replaceFileSnapshot,
        assertFileScope: async () => {
            await Promise.resolve();
            if (fault === 'scope-race') fs.writeFileSync(file, 'function work() { return 99; }\n');
        },
        createEditBackup: (_file, _agent, content) => {
            const backupPath = path.join(root, 'backup.bak');
            fs.writeFileSync(backupPath, content);
            return { backupPath, backupDir: root, backupToken: 'backup' };
        },
        syncFileToGraph: async () => ({}), recordEditTouch: async () => {},
        logger: { info() {}, warn() {} },
    }));
    return { file, root, original, run: (args = {}) => mod.exports({
        file: 'source.js', functionName: 'work', agentId: 'audit',
        newBody: 'function work() { return 2; }', oldString: 'return 1', newString: 'return 2',
        ...args,
    }, { lockingEnabled: fault === 'language' }) };
}

for (const name of ['rewrite_function', 'edit_code_patch']) {
    test(`${name} edits the physical file and preserves its symlink`, async t => {
        const h = harness(t, name);
        const target = path.join(h.root, 'real.js');
        fs.renameSync(h.file, target); fs.symlinkSync(target, h.file, 'file');
        assert.equal((await h.run()).isError, false);
        assert.equal(fs.lstatSync(h.file).isSymbolicLink(), true);
        assert.match(fs.readFileSync(target, 'utf8'), /return 2/);
    });
    test(`${name} preserves an edit arriving during its scope check`, async t => {
        const h = harness(t, name, 'scope-race');
        const response = await h.run();
        assert.equal(response.isError, true);
        assert.match(fs.readFileSync(h.file, 'utf8'), /return 99/);
        assert.ok(!fs.readdirSync(h.root).some(file => file.includes('_tmp')));
    });
    for (const fault of ['graph-failed', 'graph-newer']) {
        test(`${name} handles ${fault} without losing newer work or recovery data`, async t => {
            const h = harness(t, name, fault);
            const response = await h.run();
            assert.equal(response.isError, true);
            const body = JSON.parse(response.content[0].text);
            assert.equal(body.status, 'GRAPH_ERROR');
            if (fault === 'graph-newer') {
                assert.equal(body.rolledBack, false);
                assert.equal(body.backupToken, 'backup');
                assert.match(fs.readFileSync(h.file, 'utf8'), /return 99/);
                assert.equal(fs.readFileSync(path.join(h.root, 'backup.bak'), 'utf8'), h.original);
            } else {
                assert.equal(fs.readFileSync(h.file, 'utf8'), h.original);
            }
            assert.ok(!fs.readdirSync(h.root).some(file => file.includes('_tmp')));
        });
    }
    test(`${name} still applies valid edits`, async t => {
        const h = harness(t, name);
        assert.equal((await h.run()).isError, false);
        assert.match(fs.readFileSync(h.file, 'utf8'), /return 2/);
    });
}

test('patch validation restores its language after an asynchronous lock query', async t => {
    const h = harness(t, 'edit_code_patch', 'language');
    const response = await h.run();
    assert.equal(response.isError, false, JSON.stringify(response));
    assert.match(fs.readFileSync(h.file, 'utf8'), /return 2/);
});

test('rewriting one grouped arrow function cannot delete its sibling', async t => {
    const h = harness(t, 'rewrite_function', null, { original: 'const work = () => 1, sibling = () => 99;\n' });
    const response = await h.run({ newBody: 'const work = () => 2;' });
    assert.equal(response.isError, true);
    assert.equal(fs.readFileSync(h.file, 'utf8'), h.original);
});

test('patching one grouped arrow function cannot match code in its sibling', async t => {
    const h = harness(t, 'edit_code_patch', null, { original: 'const work = () => 1, sibling = () => 99;\n' });
    const response = await h.run({ oldString: '99', newString: '100' });
    assert.equal(response.isError, true);
    assert.equal(fs.readFileSync(h.file, 'utf8'), h.original);
});

test('a patch inside a grouped arrow function preserves the other declaration', async t => {
    const h = harness(t, 'edit_code_patch', null, { original: 'const work = () => 1, sibling = () => 99;\n' });
    const response = await h.run({ oldString: '1', newString: '2' });
    assert.equal(response.isError, false);
    assert.equal(fs.readFileSync(h.file, 'utf8'), 'const work = () => 2, sibling = () => 99;\n');
});

for (const original of ['work();\nfunction real() { return 1; }\n', '// function work() { return 1; }\nfunction real() { return 1; }\n']) {
    for (const name of ['rewrite_function', 'edit_code_patch']) {
        test(`${name} cannot edit a call or commented declaration: ${original.split('\n')[0]}`, async t => {
            const h = harness(t, name, null, { original });
            assert.equal((await h.run()).isError, true);
            assert.equal(fs.readFileSync(h.file, 'utf8'), original);
        });
    }
}

for (const original of ['const work = x => x + 1;\n', 'const work = () => 1;\n', 'const obj = { work: function() { return 1; } };\n', 'class C { work = () => 1; }\n']) {
    test(`patch AST fallback supports ${original.trim()}`, async t => {
        const h = harness(t, 'edit_code_patch', null, { original });
        const response = await h.run({ oldString: '1', newString: '2' });
        assert.equal(response.isError, false, JSON.stringify(response));
        assert.equal(fs.readFileSync(h.file, 'utf8'), original.replace('1', '2'));
    });
}

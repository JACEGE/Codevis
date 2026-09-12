const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
require('../lib/tsx-userinfo-preload.cjs');
require('tsx/cjs/api').register();
const parser = require('../tools/lib/treesitter.ts');

function harness(t, fault, options = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codevis-insert-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const filename = 'source' + (options.ext || '.js');
    const file = path.join(root, filename);
    const original = options.original || 'const original = 1;\n';
    fs.writeFileSync(file, original);
    const source = ts.createSourceFile('edit-tools.ts', fs.readFileSync('tools/handlers/edit-tools.ts', 'utf8'), ts.ScriptTarget.Latest, true);
    let handler;
    const visit = node => {
        if (ts.isPropertyAssignment(node) && node.name.getText(source) === 'insert_code') handler = node.initializer;
        ts.forEachChild(node, visit);
    };
    visit(source);
    const guard = options.checkPaths ? source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'isPathAllowed').getText(source) : '';
    const mod = { exports: {} };
    vm.runInNewContext(ts.transpile(`${guard}\nmodule.exports = ${handler.getText(source)}`, { target: ts.ScriptTarget.ES2022 }), require('./helpers/file-publication.cjs')({
        module: mod, process, ...fs, ...path, ...require('node:crypto'), ...parser,
        ...require('../tools/lib/insertion-position.ts'),
        PROJECT_ROOT: root, ALLOWED_EXTRA_DIRS: [], isPathAllowed: () => true, withFileLock: async (_, fn) => fn(),
        assertFileScope: async () => { if (fault === 'conflict') fs.writeFileSync(file, 'new user edit'); },
        getLanguageAndQuery: async ext => {
            if (fault === 'parser') throw new Error('Grammar failed to load');
            return parser.getLanguageAndQuery(ext);
        },
        renameSync: (a, b) => {
            if (fault === 'rename') throw new Error('EACCES');
            fs.renameSync(a, b);
        },
        createEditBackup: (_, __, content) => {
            fs.writeFileSync(path.join(root, 'backup.bak'), content);
            return { backupToken: 'backup' };
        },
        pickDbDriver: () => ({}), syncFileToGraph: async () => ({}), recordEditTouch: async () => {},
    }));
    return { file, root, original, run: (code, args = {}) => mod.exports({ file: filename, position: options.position || 'end_of_file', code, ...args }, { lockingEnabled: false }) };
}

for (const fault of ['syntax', 'parser', 'rename', 'conflict']) {
    test(`insert ${fault} failure preserves the existing file`, async t => {
        const h = harness(t, fault);
        const result = await h.run(fault === 'syntax' ? 'function broken( {' : 'function valid() { return 2; }');
        assert.equal(result.isError, true, JSON.stringify(result));
        assert.equal(fs.readFileSync(h.file, 'utf8'), fault === 'conflict' ? 'new user edit' : h.original);
        assert.ok(!fs.readdirSync(h.root).some(name => name.includes('_tmp')));
    });
}

test('valid insertion writes the code and keeps a recovery backup', async t => {
    const h = harness(t);
    const result = await h.run('function added() { return 2; }');
    assert.equal(result.isError, false);
    assert.match(fs.readFileSync(h.file, 'utf8'), /function added/);
    assert.equal(fs.readFileSync(path.join(h.root, 'backup.bak'), 'utf8'), h.original);
});

test('inserting through a symbolic link updates the target without replacing the link', async t => {
    const h = harness(t);
    const target = path.join(h.root, 'real.js');
    fs.renameSync(h.file, target); fs.symlinkSync(target, h.file, 'file');
    assert.equal((await h.run('const added = 2;')).isError, false);
    assert.equal(fs.lstatSync(h.file).isSymbolicLink(), true);
    assert.match(fs.readFileSync(target, 'utf8'), /const added = 2/);
});

for (const kind of ['outside-project', 'installed-package']) {
    test(`insert rejects ${kind} aliases using the real path guard`, async t => {
        const h = harness(t, null, { checkPaths: true });
        const target = kind === 'outside-project'
            ? fs.mkdtempSync(path.join(os.tmpdir(), 'codevis-outside-source-')) : path.join(h.root, 'external');
        if (kind === 'outside-project') t.after(() => fs.rmSync(target, { recursive: true, force: true }));
        else fs.mkdirSync(target);
        const requested = kind === 'outside-project' ? 'linked' : 'node_modules/codevis';
        fs.mkdirSync(path.dirname(path.join(h.root, requested)), { recursive: true });
        fs.writeFileSync(path.join(target, 'source.js'), h.original);
        fs.symlinkSync(target, path.join(h.root, requested), process.platform === 'win32' ? 'junction' : 'dir');
        const result = await h.run('const added = 2;', { file: requested + '/source.js' });
        assert.equal(result.isError, true, JSON.stringify(result));
        assert.equal(fs.readFileSync(path.join(target, 'source.js'), 'utf8'), h.original);
    });
}

for (const [name, ext, prefix, suffix, code] of [
    ['multiline import', '.js', "import {\n  readFileSync\n} from 'node:fs';\n", 'const end = 2;\n', 'const added = 1;'],
    ['multiline require', '.cjs', "const {\n  readFileSync\n} = require('node:fs');\n", 'const end = 2;\n', 'const added = 1;'],
    ['trailing multiline comment', '.js', "import fs from 'node:fs'; /* details\ncontinued */\n", 'const end = 2;\n', 'const added = 1;'],
    ['Python from import', '.py', 'from os import (\n    path,\n    getcwd,\n)\n', 'end = 2\n', 'added = 1'],
    ['directives after comments', '.js', "#!/usr/bin/env node\n// license\n'use strict';\n", 'const end = 2;\n', 'const added = 1;'],
    ['nested require', '.js', '', "function later() {\n  const x = require('node:fs');\n}\n", 'const added = 1;'],
    ['Python module docstring', '.py', '"""module\ndocumentation"""\n', 'end = 2\n', 'added = 1'],
]) {
    test(`insert after imports respects ${name}`, async t => {
        const h = harness(t, null, { ext, original: prefix + suffix, position: 'after_imports' });
        const response = await h.run(code);
        assert.equal(response.isError, false, JSON.stringify(response));
        assert.equal(fs.readFileSync(h.file, 'utf8'), prefix + code + '\n' + suffix);
    });
}

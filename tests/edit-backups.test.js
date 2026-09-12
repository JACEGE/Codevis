const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

function harness() {
    const file = path.resolve(__dirname, '../tools/handlers/edit-tools.ts');
    const tree = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const helper = tree.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'createEditBackup');
    const mod = { exports: {} }, files = new Map();
    const root = path.resolve(__dirname, '..');
    vm.runInNewContext(ts.transpile(`module.exports = ${helper.getText(tree)}`, { target: ts.ScriptTarget.ES2022 }), {
        module: mod, ...path, ...require('node:crypto'), Date, PROJECT_ROOT: root,
        ...require('../tools/lib/edit-backups.cjs'),
        mkdirSync: () => {}, writeFileSync: (file, content) => files.set(file, content),
    });
    return { create: mod.exports, files, directory: path.join(root, '.claude', 'backups') };
}

test('same-millisecond backups never overwrite earlier snapshots', t => {
    t.mock.method(Date, 'now', () => 1700000000000);
    const h = harness();
    const a = h.create('src/a.js', 'agent', 'first');
    const b = h.create('src/a.js', 'agent', 'second');
    assert.notEqual(a.backupToken, b.backupToken);
    assert.equal(h.files.get(a.backupPath), 'first');
    assert.equal(h.files.get(b.backupPath), 'second');
});

test('backup filenames remain bounded and inside the backup directory for arbitrary agent IDs', () => {
    const h = harness();
    for (const agent of ['../../../../elsewhere', 'agent/with/slashes', 'x'.repeat(500)]) {
        const backup = h.create('long-directory/'.repeat(30) + 'file.js', agent, 'snapshot');
        assert.equal(path.dirname(backup.backupPath), h.directory);
        assert.ok(path.basename(backup.backupPath).length < 200);
    }
});

test('backup file binding uses the project root and normalizes equivalent paths', () => {
    const { createBackupToken, backupFileMatches } = require('../tools/lib/edit-backups.cjs');
    const root = path.resolve(__dirname, '..');
    const token = createBackupToken('src/app.js', 'agent', root);
    assert.equal(backupFileMatches(token, 'src/../src/app.js', root), true);
    assert.equal(backupFileMatches(token, path.join(root, 'src/app.js'), root), true);
    assert.equal(backupFileMatches(token, 'other/app.js', root), false);
    assert.equal(backupFileMatches(token, 'src/app.js', path.join(root, 'other-project')), false);
    assert.equal(backupFileMatches('old-token', 'src/app.js', root), null);
});

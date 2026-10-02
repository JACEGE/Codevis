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

test('stale-edit recovery finds only the crashed agent\'s backups of that file, newest first', () => {
    const { createBackupToken, latestBackupsFor } = require('../tools/lib/edit-backups.cjs');
    const root = path.resolve(__dirname, '..');
    const older = createBackupToken('src/app.js', 'worker-1', root).replace(/^\d+/, '1000');
    const newer = createBackupToken('src/app.js', 'worker-1', root).replace(/^\d+/, '2000');
    const otherAgent = createBackupToken('src/app.js', 'worker-2', root);
    const otherFile = createBackupToken('src/webapp.js', 'worker-1', root);
    const entries = [older, otherAgent, newer, otherFile, 'legacy_worker-1_src_app.js'].map(t => `${t}.bak`);
    assert.deepEqual(latestBackupsFor(entries, 'src/app.js', 'worker-1', root), [`${newer}.bak`, `${older}.bak`]);
    assert.deepEqual(latestBackupsFor(entries, 'src/app.js', '', root), []);
});

test('Windows backups match canonical roots and retain legacy short-path tokens', { skip: process.platform !== 'win32' }, t => {
    const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'codevis-backup-alias-'));
    const canonical = fs.realpathSync.native(root);
    const previous = process.env.CODEVIS_PROJECT_DIR;
    process.env.CODEVIS_PROJECT_DIR = root;
    t.after(() => {
        if (previous === undefined) delete process.env.CODEVIS_PROJECT_DIR;
        else process.env.CODEVIS_PROJECT_DIR = previous;
        fs.rmSync(root, { recursive: true, force: true });
    });
    fs.writeFileSync(path.join(root, 'app.js'), 'function app() {}');
    const { createBackupToken, backupFileMatches } = require('../tools/lib/edit-backups.cjs');
    const token = createBackupToken('app.js', 'agent', root);
    assert.equal(backupFileMatches(token, 'app.js', canonical), true);
    const { resolvePhysicalPath } = require('../lib/file-publication.cjs');
    const oldHash = require('node:crypto').createHash('sha256')
        .update(resolvePhysicalPath(path.join(root, 'app.js')).toLowerCase()).digest('hex');
    const legacy = token.replace(/_f-[a-f0-9]{64}_/, `_f-${oldHash}_`);
    assert.equal(backupFileMatches(legacy, 'app.js', canonical), true);
    assert.equal(backupFileMatches(legacy, path.join(canonical, 'app.js'), canonical), true);
    assert.equal(backupFileMatches(legacy, 'app.js', path.join(canonical, 'other-project')), false);
});

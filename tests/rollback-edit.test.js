const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');
const backups = require('../tools/lib/edit-backups.cjs');

function harness(t, fault) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codevis-rollback-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const token = backups.createBackupToken('app.js', 'audit', root);
    const file = path.join(root, 'app.js'), backup = path.join(root, `.claude/backups/${token}.bak`);
    fs.mkdirSync(path.dirname(backup), { recursive: true });
    fs.writeFileSync(file, 'current content'); fs.writeFileSync(backup, 'original content');
    const source = ts.createSourceFile('edit-tools.ts', fs.readFileSync(path.resolve(__dirname, '../tools/handlers/edit-tools.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
    let handler;
    const visit = n => {
        if (ts.isPropertyAssignment(n) && n.name.getText(source) === 'rollback_edit') handler = n.initializer;
        ts.forEachChild(n, visit);
    };
    visit(source);
    let holding = false, syncHeld = false;
    const mod = { exports: {} };
    vm.runInNewContext(ts.transpile(`module.exports = ${handler.getText(source)}`, { target: ts.ScriptTarget.ES2022 }), require('./helpers/file-publication.cjs')({
        module: mod, ...path, ...fs, ...require('node:crypto'), ...backups, PROJECT_ROOT: root,
        isPathAllowed: () => true, pickDbDriver: () => ({}),
        withFileLock: async (_, fn) => {
            holding = true;
            if (fault === 'consumed') fs.rmSync(backup);
            try { return await fn(); } finally { holding = false; }
        },
        writeFileSync: (p, content, options) => {
            if (fault === 'write') { fs.writeFileSync(p, 'partial'); throw new Error('ENOSPC'); }
            fs.writeFileSync(p, content, options);
        },
        renameSync: (a, b) => { if (fault === 'rename') throw new Error('EACCES'); fs.renameSync(a, b); },
        syncFileToGraph: async () => { syncHeld = holding; return fault === 'sync' ? null : {}; },
        recordEditTouch: async () => {},
    }));
    return { root, file, backup, get syncHeld() { return syncHeld; },
        run: (args = {}) => mod.exports({ file: 'app.js', backupToken: token, agentId: 'audit', ...args }, { lockingEnabled: false }) };
}

test('rollback rejects a backup for another file, including the same basename in another directory', async t => {
    const h = harness(t);
    fs.mkdirSync(path.join(h.root, 'other'));
    const other = path.join(h.root, 'other/app.js');
    fs.writeFileSync(other, 'unrelated content');
    const result = await h.run({ file: 'other/app.js' });
    assert.equal(result.isError, true);
    assert.equal(JSON.parse(result.content[0].text).status, 'BACKUP_FILE_MISMATCH');
    assert.equal(fs.readFileSync(other, 'utf8'), 'unrelated content');
    assert.equal(fs.readFileSync(h.backup, 'utf8'), 'original content');
});

test('legacy backups without file identity are retained instead of guessed', async t => {
    const h = harness(t);
    const legacy = path.join(path.dirname(h.backup), 'legacy.bak');
    fs.writeFileSync(legacy, 'unknown source');
    const result = await h.run({ backupToken: 'legacy' });
    assert.equal(result.isError, true);
    assert.equal(JSON.parse(result.content[0].text).status, 'UNBOUND_BACKUP');
    assert.equal(fs.readFileSync(h.file, 'utf8'), 'current content');
    assert.ok(fs.existsSync(legacy));
});

test('rollback accepts physical aliases and preserves a matching symbolic link', async t => {
    const h = harness(t);
    const target = path.join(h.root, 'real.js');
    fs.renameSync(h.file, target); fs.symlinkSync(target, h.file, 'file');
    const token = backups.createBackupToken('app.js', 'audit', h.root);
    fs.renameSync(h.backup, path.join(path.dirname(h.backup), token + '.bak'));
    assert.equal((await h.run({ backupToken: token })).isError, undefined);
    assert.equal(fs.lstatSync(h.file).isSymbolicLink(), true);
    assert.equal(fs.readFileSync(target, 'utf8'), 'original content');
});

test('rollback rejects a symbolic link redirected after its backup was created', async t => {
    const h = harness(t);
    const other = path.join(h.root, 'other.js');
    fs.writeFileSync(other, 'other original');
    fs.unlinkSync(h.file); fs.symlinkSync(other, h.file, 'file');
    const result = await h.run();
    assert.equal(JSON.parse(result.content[0].text).status, 'BACKUP_FILE_MISMATCH');
    assert.equal(fs.readFileSync(other, 'utf8'), 'other original');
    assert.ok(fs.existsSync(h.backup));
});

for (const fault of ['write', 'rename']) {
    test(`rollback ${fault} failure preserves current content and the recovery backup`, async t => {
        const h = harness(t, fault);
        assert.equal((await h.run()).isError, true);
        assert.equal(fs.readFileSync(h.file, 'utf8'), 'current content');
        assert.equal(fs.readFileSync(h.backup, 'utf8'), 'original content');
        assert.deepEqual(fs.readdirSync(h.root).sort(), ['.claude', 'app.js']);
    });
}

test('rollback keeps recovery data and reports failure when graph sync returns null', async t => {
    const h = harness(t, 'sync');
    const result = await h.run();
    assert.equal(result.isError, true);
    assert.equal(JSON.parse(result.content[0].text).fileRestored, true);
    assert.equal(fs.readFileSync(h.file, 'utf8'), 'original content');
    assert.ok(fs.existsSync(h.backup));
});

test('rollback holds its file lock through graph sync and consumes backup only on success', async t => {
    const h = harness(t);
    assert.equal(JSON.parse((await h.run()).content[0].text).status, 'OK');
    assert.equal(h.syncHeld, true);
    assert.equal(fs.readFileSync(h.file, 'utf8'), 'original content');
    assert.equal(fs.existsSync(h.backup), false);
});

test('a queued rollback cannot reuse a backup consumed while it waited for the lock', async t => {
    const h = harness(t, 'consumed');
    assert.equal((await h.run()).isError, true);
    assert.equal(fs.readFileSync(h.file, 'utf8'), 'current content');
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
require('../lib/tsx-userinfo-preload.cjs');
require('tsx/cjs/api').register();
const { commitFileSnapshots, replaceFileSnapshot } = require('../tools/lib/edit-transaction.ts');

for (const kind of ['single', 'batch']) {
    test(`${kind} replacement preserves a file symlink and edits its target`, async t => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codevis-snapshot-link-'));
        t.after(() => fs.rmSync(root, { recursive: true, force: true }));
        const target = path.join(root, 'actual.js'), alias = path.join(root, 'alias.js');
        fs.writeFileSync(target, 'original'); fs.symlinkSync(target, alias, 'file');
        const snapshot = { file: 'alias.js', path: alias, original: 'original', content: 'edited' };
        if (kind === 'single') replaceFileSnapshot(snapshot);
        else await commitFileSnapshots([snapshot], () => ({ backupToken: 'backup' }));
        assert.equal(fs.lstatSync(alias).isSymbolicLink(), true);
        assert.equal(fs.readFileSync(target, 'utf8'), 'edited');
    });
    test(`${kind} replacement preserves executable and private permissions`, { skip: process.platform === 'win32' }, async t => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codevis-snapshot-mode-'));
        t.after(() => fs.rmSync(root, { recursive: true, force: true }));
        for (const mode of [0o755, 0o700, 0o600]) {
            const target = path.join(root, 'script.js');
            fs.writeFileSync(target, 'original'); fs.chmodSync(target, mode);
            const snapshot = { file: 'script.js', path: target, original: 'original', content: 'edited' };
            if (kind === 'single') replaceFileSnapshot(snapshot);
            else await commitFileSnapshots([snapshot], () => ({ backupToken: 'backup' }));
            assert.equal(fs.statSync(target).mode & 0o777, mode);
        }
    });
}

for (const changedFile of ['first', 'second']) {
    test(`a scope-check wait cannot overwrite a new edit to the ${changedFile} file`, async t => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codevis-snapshot-'));
        t.after(() => fs.rmSync(root, { recursive: true, force: true }));
        const snapshots = ['first', 'second'].map(file => {
            const target = path.join(root, file + '.js');
            fs.writeFileSync(target, 'original');
            return { file, path: target, original: 'original', content: 'agent edit' };
        });
        await assert.rejects(commitFileSnapshots(snapshots, () => ({ backupToken: 'backup' }), async snapshot => {
            if (snapshot.file === 'second') {
                await Promise.resolve();
                fs.writeFileSync(snapshots.find(s => s.file === changedFile).path, 'new user edit');
            }
        }), error => error.status === 'CONFLICT' && error.rolledBack);
        for (const snapshot of snapshots) assert.equal(fs.readFileSync(snapshot.path, 'utf8'), snapshot.file === changedFile ? 'new user edit' : 'original');
        assert.equal(fs.readdirSync(root).length, 2);
    });
}

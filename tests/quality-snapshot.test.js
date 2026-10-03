const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { sourceSnapshot } = require('../lib/workflow/quality-snapshot.cjs');
const { createChange } = require('../lib/workflow/model.cjs');
const { saveState, writeArtifact } = require('../lib/workflow/artifacts.cjs');
const { SKIP_WITHOUT_FILE_SYMLINKS } = require('./helpers/symlinks.cjs');

test('source snapshot skips database and dependency folders without a .gitignore', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codevis-snapshot-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    execFileSync('git', ['init', '-q'], { cwd: root });
    const write = (file, content) => {
        fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        fs.writeFileSync(path.join(root, file), content);
    };
    write('src/app.js', 'export const answer = 42;\n');
    write('.codevis/ladybug-target/data.kz', 'live database pages');
    write('node_modules/left-pad/index.js', 'module.exports = () => {};\n');
    write('docs/codevis/changes/state.json', '{}');

    const snapshot = sourceSnapshot({ projectRoot: root, config: {} });

    assert.deepEqual(Object.keys(snapshot.hashes), ['src/app.js']);
});

for (const artifactDir of ['docs/./codevis', 'docs/temp/../codevis', '.']) {
    test(`workflow writes do not change the source fingerprint with artifactDir=${artifactDir}`, (t) => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codevis-snapshot-path-'));
        t.after(() => fs.rmSync(root, { recursive: true, force: true }));
        execFileSync('git', ['init', '-q'], { cwd: root });
        fs.writeFileSync(path.join(root, 'app.js'), 'module.exports = 42;\n');
        const context = { projectRoot: root, workspace: 'project_db', config: { workflow: { artifactDir } } };
        const before = sourceSnapshot(context);
        for (const workspace of ['project_db', 'codevis_db']) {
            const state = createChange({ workspace, title: 'Verify source evidence', description: 'Keep workflow artifacts separate from source evidence.' });
            const storage = { ...context, workspace };
            saveState(storage, state);
            writeArtifact(storage, state, 'checks', '# Checks\nThe executable check passed.');
        }
        const after = sourceSnapshot(context);

        assert.deepEqual(Object.keys(after.hashes), ['app.js']);
        assert.equal(after.fingerprint, before.fingerprint);
    });
}

test('source files beside the workflow changes directory still invalidate evidence', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codevis-snapshot-source-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    execFileSync('git', ['init', '-q'], { cwd: root });
    const context = { projectRoot: root, config: { workflow: { artifactDir: 'src' } } };
    fs.mkdirSync(path.join(root, 'src'));
    const source = path.join(root, 'src', 'app.js');
    fs.writeFileSync(source, 'module.exports = 42;\n');
    const before = sourceSnapshot(context);
    fs.writeFileSync(source, 'module.exports = 43;\n');
    const after = sourceSnapshot(context);

    assert.ok(before.hashes['src/app.js']);
    assert.notEqual(after.fingerprint, before.fingerprint);
});

test('redirecting a source symlink invalidates evidence even when its content is identical', { skip: SKIP_WITHOUT_FILE_SYMLINKS }, (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codevis-snapshot-redirect-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    execFileSync('git', ['init', '-q'], { cwd: root });
    fs.writeFileSync(path.join(root, '.gitignore'), 'physical/\n');
    fs.mkdirSync(path.join(root, 'physical'));
    const first = path.join(root, 'physical', 'first.js');
    const second = path.join(root, 'physical', 'second.js');
    for (const target of [first, second]) fs.writeFileSync(target, 'module.exports = 42;\n');
    const link = path.join(root, 'app.js');
    fs.symlinkSync(first, link, 'file');
    const context = { projectRoot: root, config: {} };
    const before = sourceSnapshot(context);
    fs.unlinkSync(link);
    fs.symlinkSync(second, link, 'file');
    const after = sourceSnapshot(context);

    assert.equal(after.contents.get('app.js'), before.contents.get('app.js'));
    assert.notEqual(after.fingerprint, before.fingerprint);
});

test('linked source changes invalidate evidence even when the physical target is gitignored', { skip: SKIP_WITHOUT_FILE_SYMLINKS }, (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codevis-snapshot-link-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    execFileSync('git', ['init', '-q'], { cwd: root });
    fs.writeFileSync(path.join(root, '.gitignore'), 'physical/\n');
    fs.mkdirSync(path.join(root, 'physical'));
    const target = path.join(root, 'physical', 'app.js');
    fs.writeFileSync(target, 'module.exports = 42;\n');
    fs.symlinkSync(target, path.join(root, 'app.js'), 'file');
    const context = { projectRoot: root, config: {} };
    const before = sourceSnapshot(context);
    fs.writeFileSync(target, 'module.exports = 43;\n');
    const after = sourceSnapshot(context);

    assert.equal(before.contents.get('app.js'), 'module.exports = 42;\n');
    assert.notEqual(after.fingerprint, before.fingerprint);
});

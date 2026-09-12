const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const ts = require('typescript');
const { resolvePhysicalPath, publishStagedFile } = require('../lib/file-publication.cjs');

function fixture(t) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codevis-publication-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const target = path.join(root, 'target.js'), staged = path.join(root, 'staged.js');
    fs.writeFileSync(target, 'original'); fs.writeFileSync(staged, 'edited');
    return { root, target, staged };
}

for (const mode of [0o600, 0o640, 0o644, 0o700, 0o750, 0o755]) {
    for (const failure of ['none', 'stat', 'chmod', 'rename']) {
        test(`publication with mode ${mode.toString(8)} and ${failure} failure preserves the original or its permissions`, t => {
            const h = fixture(t);
            let appliedMode;
            const filesystem = {
                ...fs,
                statSync(file) {
                    if (failure === 'stat') throw Object.assign(new Error('stat denied'), { code: 'EACCES' });
                    return { ...fs.statSync(file), mode };
                },
                chmodSync(file, value) {
                    if (failure === 'chmod') throw new Error('chmod denied');
                    assert.equal(file, h.staged);
                    appliedMode = value;
                },
                renameSync(from, to) {
                    assert.equal(appliedMode, mode, 'permissions must be copied before publication');
                    if (failure === 'rename') throw new Error('rename denied');
                    fs.renameSync(from, to);
                },
            };
            if (failure === 'none') {
                publishStagedFile(h.staged, h.target, filesystem);
                assert.equal(fs.readFileSync(h.target, 'utf8'), 'edited');
            } else {
                assert.throws(() => publishStagedFile(h.staged, h.target, filesystem), /denied/);
                assert.equal(fs.readFileSync(h.target, 'utf8'), 'original');
                assert.equal(fs.readFileSync(h.staged, 'utf8'), 'edited');
            }
        });
    }
}

test('publication supports a genuinely new destination', t => {
    const h = fixture(t);
    fs.unlinkSync(h.target);
    publishStagedFile(h.staged, h.target);
    assert.equal(fs.readFileSync(h.target, 'utf8'), 'edited');
});

test('publication refuses a destination changed into a symbolic link', t => {
    const h = fixture(t);
    const other = path.join(h.root, 'other.js');
    fs.renameSync(h.target, other); fs.symlinkSync(other, h.target, 'file');
    assert.throws(() => publishStagedFile(h.staged, h.target), error => error.status === 'CONFLICT');
    assert.equal(fs.lstatSync(h.target).isSymbolicLink(), true);
    assert.equal(fs.readFileSync(other, 'utf8'), 'original');
});

test('publication refuses a parent directory redirected after staging', t => {
    const h = fixture(t);
    const directory = path.join(h.root, 'directory'), other = path.join(h.root, 'other');
    fs.mkdirSync(directory); fs.mkdirSync(other);
    const target = path.join(directory, 'file.js');
    fs.writeFileSync(target, 'original'); fs.writeFileSync(path.join(other, 'file.js'), 'other original');
    const captured = resolvePhysicalPath(target);
    fs.renameSync(directory, path.join(h.root, 'old-directory'));
    fs.symlinkSync(other, directory, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => publishStagedFile(h.staged, captured), error => error.status === 'CONFLICT');
    assert.equal(fs.readFileSync(path.join(other, 'file.js'), 'utf8'), 'other original');
});

test('a dangling symbolic link cannot be mistaken for a new destination', t => {
    const h = fixture(t);
    const link = path.join(h.root, 'dangling.js');
    fs.symlinkSync(path.join(h.root, 'missing.js'), link, 'file');
    assert.throws(() => resolvePhysicalPath(link), error => error.code === 'DANGLING_SYMLINK');
    assert.throws(() => publishStagedFile(h.staged, link), error => error.code === 'DANGLING_SYMLINK');
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
});

test('edit path containment follows links and permits only configured physical roots', t => {
    const h = fixture(t);
    const project = path.join(h.root, 'project'), external = path.join(h.root, 'external');
    fs.mkdirSync(project); fs.mkdirSync(external);
    const alias = path.join(project, 'linked');
    fs.symlinkSync(external, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const source = ts.createSourceFile('edit-tools.ts', fs.readFileSync(path.join(__dirname, '../tools/handlers/edit-tools.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
    const helper = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'isPathAllowed');
    const mod = { exports: {} }, extra = [];
    vm.runInNewContext(ts.transpile('module.exports = ' + helper.getText(source), { target: ts.ScriptTarget.ES2022 }), {
        module: mod, process, resolvePhysicalPath, PROJECT_ROOT: project, ALLOWED_EXTRA_DIRS: extra,
    });
    assert.equal(mod.exports(path.join(project, 'new/file.js')), true);
    assert.equal(mod.exports(path.join(alias, 'new/file.js')), false);
    extra.push(external);
    assert.equal(mod.exports(path.join(alias, 'new/file.js')), true);
    fs.mkdirSync(path.join(project, 'node_modules'));
    fs.symlinkSync(external, path.join(project, 'node_modules/codevis'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal(mod.exports(path.join(project, 'node_modules/codevis/new.js')), false);
    assert.equal(mod.exports(path.join(project, 'node_modules/codevis/new.js'), true), true);
});

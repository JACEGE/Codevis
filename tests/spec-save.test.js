const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { saveSpecSource } = require('../server/spec-save.cjs');

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codevis-spec-save-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const filePath = path.join(root, 'diagram.puml');
    fs.writeFileSync(filePath, 'original');
    return { filePath, text: 'updated', lockDirectory: path.join(root, 'locks') };
}

for (const fault of ['write', 'rename']) {
    test(`spec file ${fault} failure never starts the graph import`, async t => {
        const options = fixture(t);
        let imports = 0;
        const filesystem = { ...fs, [fault === 'write' ? 'writeFileSync' : 'renameSync']: () => { throw new Error('EACCES'); } };
        await assert.rejects(saveSpecSource({ ...options, importSpec: async () => imports++ }, filesystem), /EACCES/);
        assert.equal(imports, 0);
        assert.equal(fs.readFileSync(options.filePath, 'utf8'), 'original');
    });
}

test('a rejected atomic graph import restores the original diagram file', async t => {
    const options = fixture(t);
    await assert.rejects(saveSpecSource({ ...options, importSpec: async () => {
        assert.equal(fs.readFileSync(options.filePath, 'utf8'), 'updated');
        throw new Error('Invalid diagram');
    } }), error => error.fileRestored && /Invalid diagram/.test(error.message));
    assert.equal(fs.readFileSync(options.filePath, 'utf8'), 'original');
});

test('failed compensation keeps newer edits and an original-content recovery backup', async t => {
    const options = fixture(t);
    await assert.rejects(saveSpecSource({ ...options, importSpec: async () => {
        fs.writeFileSync(options.filePath, 'new user edit');
        throw new Error('Database rejected import');
    } }), error => {
        assert.equal(fs.readFileSync(error.recoveryPath, 'utf8'), 'original');
        return true;
    });
    assert.equal(fs.readFileSync(options.filePath, 'utf8'), 'new user edit');
});

test('successful spec save publishes matching file content and removes temporary backups', async t => {
    const options = fixture(t);
    const result = await saveSpecSource({ ...options, importSpec: async () => ({ saved: true }) });
    assert.equal(result.saved, true);
    assert.equal(fs.readFileSync(options.filePath, 'utf8'), 'updated');
    assert.deepEqual(fs.readdirSync(path.dirname(options.filePath)).sort(), ['diagram.puml', 'locks']);
});

test('spec source files never resolve outside their root', () => {
    const { firstContainedSpecFile } = require('../server/spec-save.cjs');
    const root = path.resolve('/project');
    const sibling = path.resolve('/sample-project');
    const exists = { existsSync: () => true };
    assert.equal(firstContainedSpecFile([root], 'docs/a.puml', exists), path.join(root, 'docs', 'a.puml'));
    assert.equal(firstContainedSpecFile([root], '../other/x.puml', exists), null);
    assert.equal(firstContainedSpecFile([root], path.resolve('/etc/x.puml'), exists), null);
    assert.equal(firstContainedSpecFile([root], 'docs/../../x.puml', exists), null);
    // Ein Geschwisterprojekt bleibt erreichbar, sobald es selbst eine Wurzel ist.
    assert.equal(firstContainedSpecFile([root, sibling], '../sample-project/a.puml', exists),
        path.join(sibling, 'a.puml'));
});

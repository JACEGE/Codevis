const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { collectSourceFiles } = require('../lib/source-files.cjs');

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codevis-source-scan-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src/app.js'), 'export {};');
    return root;
}

test('source discovery excludes CodeVis internal storage', t => {
    const root = fixture(t);
    fs.mkdirSync(path.join(root, '.codevis'));
    fs.writeFileSync(path.join(root, '.codevis/generated.js'), 'export {};');
    assert.deepEqual(collectSourceFiles(root, ['.']).files, [path.join(root, 'src/app.js')]);
});

test('source discovery terminates on directory-link cycles while retaining linked sources', t => {
    const root = fixture(t);
    const linked = path.join(root, 'linked');
    fs.mkdirSync(linked);
    fs.writeFileSync(path.join(linked, 'extra.js'), 'export {};');
    fs.symlinkSync(path.join(root, 'src'), path.join(root, 'src/back'), 'junction');
    fs.symlinkSync(linked, path.join(root, 'src/linked'), 'junction');
    const script = `const { collectSourceFiles } = require(${JSON.stringify(require.resolve('../lib/source-files.cjs'))});
        console.log(JSON.stringify(collectSourceFiles(process.argv[1], ['src']).files));`;
    const files = JSON.parse(execFileSync(process.execPath, ['-e', script, root], { encoding: 'utf8', timeout: 5000 }));
    assert.deepEqual(files.sort(), [path.join(root, 'src/app.js'), path.join(root, 'src/linked/extra.js')].sort());
});

test('intentionally excluded missing roots do not make a scan incomplete', t => {
    const root = fixture(t);
    const scan = collectSourceFiles(root, ['src', 'generated'], { exclude: ['generated/**'] });
    assert.deepEqual(scan.missingDirs, []);
    assert.deepEqual(scan.files, [path.join(root, 'src/app.js')]);
});

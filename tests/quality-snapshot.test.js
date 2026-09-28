const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { sourceSnapshot } = require('../lib/workflow/quality-snapshot.cjs');

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

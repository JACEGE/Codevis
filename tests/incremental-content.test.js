const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { __testing__: { getMtimeChangedFiles } } = require('../scripts/graph_builder.js');

test('incremental selection detects changed contents with equal or older timestamps', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codevis-incremental-content-'));
    const file = path.join(root, 'example.js');
    try {
        fs.writeFileSync(file, 'export const value = 1;');
        const sourceTime = new Date(Date.now() - 60000);
        fs.utimesSync(file, sourceTime, sourceTime);
        const state = { path: 'example.js', lastParsed: Math.ceil(fs.statSync(file).mtimeMs),
            parseStatus: 'current', contentHash: createHash('sha256').update(fs.readFileSync(file)).digest('hex') };
        const session = { run: async () => ({ records: [{ get: key => state[key] }] }) };
        assert.deepEqual(await getMtimeChangedFiles(session, [file], root), []);
        fs.writeFileSync(file, 'export const value = 2;');
        for (const time of [sourceTime, new Date(sourceTime.getTime() - 60000)]) {
            fs.utimesSync(file, time, time);
            assert.deepEqual(await getMtimeChangedFiles(session, [file], root), [file]);
        }
        state.contentHash = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
        assert.deepEqual(await getMtimeChangedFiles(session, [file], root), []);
        state.contentHash = null; // Old graphs acquire hashes on their next build.
        assert.deepEqual(await getMtimeChangedFiles(session, [file], root), [file]);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

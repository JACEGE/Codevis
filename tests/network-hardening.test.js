const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const { parsePort, LOOPBACK_HOST } = require('../lib/network-options.cjs');
const { openBrowser } = require('../lib/open-browser.cjs');

test('network ports reject malformed and out-of-range values', () => {
    assert.equal(parsePort('4200', 'TEST_PORT'), 4200);
    for (const value of ['', '12x', '1;calc', '0', '-1', '65536']) {
        assert.throws(() => parsePort(value, 'TEST_PORT'), /TEST_PORT must be an integer/);
    }
});

test('browser opener uses argument arrays instead of a shell command string', () => {
    const calls = [];
    const spawnImpl = (...args) => { calls.push(args); return { unref() {} }; };
    assert.equal(openBrowser('http://localhost:4200', { platform: 'win32', spawnImpl }), true);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0][1].slice(-2), ['', 'http://localhost:4200']);
    assert.equal(calls[0][2].windowsHide, true);
});

test('web Kanban is loopback-only and accepts public database names', () => {
    const source = fs.readFileSync(path.join(root, 'lib/kanban-server.mjs'), 'utf8');
    assert.equal(LOOPBACK_HOST, '127.0.0.1');
    assert.match(source, /app\.listen\(PORT, LOOPBACK_HOST\)/);
    assert.match(source, /normalizeWorkspaceName\(process\.env\.CODEVIS_DB \|\| "project_db"\)/);
});

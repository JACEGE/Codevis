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

test('a missing browser opener is reported, never crashes the dashboard, and WSL uses the Windows browser', () => {
    const { EventEmitter } = require('node:events');
    const calls = [], logs = [];
    const spawnImpl = (...args) => { calls.push(args); const child = new EventEmitter(); child.unref = () => {}; setImmediate(() => child.emit('error', new Error('spawn ENOENT'))); return child; };
    assert.equal(openBrowser('http://localhost:4042', { platform: 'linux', wsl: false, spawnImpl, log: m => logs.push(m) }), true);
    assert.equal(calls[0][0], 'xdg-open');
    assert.equal(openBrowser('http://localhost:4042', { platform: 'linux', wsl: true, spawnImpl, log: m => logs.push(m) }), true);
    assert.deepEqual([calls[1][0], calls[1][1], calls[1][2].cwd], ['cmd.exe', ['/d', '/c', 'start', '', 'http://localhost:4042'], '/mnt/c']);
    return new Promise(resolve => setImmediate(() => { assert.equal(logs.length, 2); assert.match(logs[0], /Open http:\/\/localhost:4042 yourself/); resolve(); }));
});

test('web Kanban is loopback-only and accepts public database names', () => {
    const source = fs.readFileSync(path.join(root, 'lib/kanban-server.mjs'), 'utf8');
    assert.equal(LOOPBACK_HOST, '127.0.0.1');
    assert.match(source, /app\.listen\(PORT, LOOPBACK_HOST\)/);
    assert.match(source, /normalizeWorkspaceName\(process\.env\.CODEVIS_DB \|\| "project_db"\)/);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const filename = path.resolve(__dirname, '../server/codevis-paths.cjs');
const source = fs.readFileSync(filename, 'utf8');
const localRequire = createRequire(filename);
const longRoot = 'C:\\Users\\Example User\\project';
const shortRoot = 'c:\\Users\\EXAMPL~1\\project';

// Exercise Windows resolution on every CI platform, without changing global
// process.platform or requiring an NTFS volume with 8.3 names enabled.
function windowsPaths(root, realpath = value => {
    if ([shortRoot, longRoot].includes(value)) return longRoot;
    throw Object.assign(new Error('not found'), { code: 'ENOENT' });
}) {
    const module = { exports: {} };
    vm.runInNewContext(source, {
        module, __dirname: path.dirname(filename),
        process: { platform: 'win32', cwd: () => root, env: {
            CODEVIS_PROJECT_DIR: root, CODEVIS_DATA_DIR: path.win32.join(root, '.codevis'),
        } },
        require: name => name === 'path' ? path.win32 : name === 'fs'
            ? { ...fs, realpathSync: { native: realpath }, existsSync: () => false }
            : localRequire(name),
    }, { filename });
    return module.exports;
}

test('Windows short and long roots share project, data, fingerprint and ports', () => {
    const short = windowsPaths(shortRoot);
    const long = windowsPaths(longRoot);
    assert.equal(short.PROJECT_ROOT, longRoot);
    for (const key of ['PROJECT_ROOT', 'DATA_DIR', 'PIDFILE', 'DAEMON_PORT', 'BRIDGE_PORT']) {
        assert.equal(short[key], long[key], key);
    }
    assert.equal(short.DB_PATHS.target, long.DB_PATHS.target);
    const config = { workspaces: { target: { sourceDir: ['src'] } } };
    assert.equal(short.workspaceIdentity(config, 'project_db').fingerprint,
        long.workspaceIdentity(config, 'project_db').fingerprint);
});

test('Windows canonicalization keeps missing suffixes below a real ancestor', () => {
    const paths = windowsPaths(shortRoot);
    assert.equal(paths.canonicalize(path.win32.join(shortRoot, '.codevis', 'new', 'db')),
        path.win32.join(longRoot, '.codevis', 'new', 'db'));
});

test('older short-path workspace markers retain their ownership and detect source changes', () => {
    const paths = windowsPaths(longRoot);
    const expected = paths.workspaceIdentity({ workspaces: { target: { sourceDir: ['src'] } } }, 'project_db');
    const recorded = { ...expected, projectRoot: shortRoot, fingerprint: 'legacy-short-path-hash',
        sourceDirs: [path.win32.join(shortRoot, 'src')] };
    assert.equal(paths.identityChange(expected, recorded), null);
    assert.equal(paths.identityChange(expected, { ...recorded, sourceDirs: [path.win32.join(shortRoot, 'other')] }), 'sources');
    assert.equal(paths.identityChange(expected, { ...recorded, workspace: 'codevis_db' }), 'foreign');
});

test('inaccessible or unavailable Windows paths retain their absolute spelling', () => {
    for (const code of ['EACCES', 'ENOENT']) {
        const paths = windowsPaths(shortRoot, () => { throw Object.assign(new Error(code), { code }); });
        assert.equal(paths.canonicalize(shortRoot), shortRoot.replace(/^c:/, 'C:'));
    }
});

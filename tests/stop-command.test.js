const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const sourceCallback = require('./helpers/source-callback.cjs');
const ui = { title: () => '', section: () => '', badge: () => '' };
const quiet = { log() {}, error() {} };
const expected = { projectRoot: path.resolve('project'), dataDir: path.resolve('project', '.codevis') };

test('stop refuses a dashboard from another project or data directory on the same port', async () => {
    const { dashboardMatches } = await import('../lib/dashboard-session.mjs');
    for (const changed of ['projectRoot', 'dataDir']) {
        const calls = [];
        let stopped = false;
        const stopDashboard = sourceCallback('lib/commands/stop.mjs', 'stopDashboard', {
            ui, console: quiet, AbortSignal, Date, setTimeout, dashboardMatches,
            fetch: async (url, options) => {
                calls.push(options?.method || 'GET');
                if (stopped) throw new Error('closed');
                if (options?.method === 'POST') stopped = true;
                return { ok: true, status: 200, json: async () => ({ ...expected, [changed]: path.resolve('other'), activeDb: 'project_db', pid: 123 }) };
            },
        });
        await stopDashboard(4321, expected);
        assert.deepEqual(calls, ['GET']);
    }
});

test('forced shutdown uses the verified daemon PID, never a stale pidfile', async () => {
    const killed = [];
    const stop = sourceCallback('lib/commands/stop.mjs', 'stop', {
        ui, console: quiet, join: path.join, packageRoot: path.resolve('.'),
        require: file => file.endsWith('ladybug-driver.cjs')
            ? { stopDaemon: async () => ({ stopped: false, reason: 'timed out', targetPid: 54321 }) }
            : { BRIDGE_PORT: 4321, PIDFILE: 'unused', PROJECT_ROOT: expected.projectRoot, DATA_DIR: expected.dataDir },
        readFileSync: () => JSON.stringify({ pid: 12345 }), stopDashboard: async () => {},
        process: { exit: code => { throw new Error(`exit ${code}`); }, kill: pid => killed.push(pid) },
    });
    await stop(['--force']);
    assert.deepEqual(killed, [54321]);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

test('demo subprocesses use only demo storage and do not inherit workspace ports', async () => {
    const { demoEnvironment } = await import('../scripts/demo/project-environment.mjs');
    const project = path.resolve('temporary-demo', 'harbor-library');
    const inherited = {
        PATH: '/tools', TEMP: '/temporary', CODEVIS_PROJECT_DIR: '/real-project',
        CODEVIS_DATA_DIR: '/real-project/data', CODEVIS_BRIDGE_PORT: '4362', CODEVIS_DEFAULT_DB: 'codevis_db',
        LADYBUG_DAEMON_PORT: '7829', LADYBUG_TARGET_PATH: '/real-project/target',
        LADYBUG_META_PATH: '/real-project/meta', LADYBUG_PIDFILE: '/real-project/pid',
        LADYBUG_DAEMON_LOG: '/real-project/log', ladybug_target_path: '/other-real-project',
        codevis_data_dir: '/other-real-project/data',
    };
    const env = demoEnvironment(project, inherited);
    assert.equal(env.PATH, inherited.PATH);
    assert.equal(env.TEMP, inherited.TEMP);
    assert.equal(env.CODEVIS_PROJECT_DIR, project);
    const data = path.join(project, '.codevis');
    assert.equal(env.CODEVIS_DATA_DIR, data);
    assert.equal(env.CODEVIS_DEFAULT_DB, 'project_db');
    for (const key of ['LADYBUG_TARGET_PATH', 'LADYBUG_META_PATH', 'LADYBUG_PIDFILE', 'LADYBUG_DAEMON_LOG']) {
        assert.equal(path.dirname(env[key]), data, key);
    }
    for (const key of ['CODEVIS_BRIDGE_PORT', 'LADYBUG_DAEMON_PORT', 'ladybug_target_path', 'codevis_data_dir']) {
        assert.equal(env[key], undefined, key);
    }
    assert.equal(inherited.LADYBUG_TARGET_PATH, '/real-project/target');
});

test('demo recording waits past the banner until its own dashboard answers', async () => {
    const { waitForDemoDashboard } = await import('../scripts/demo/dashboard-ready.mjs');
    const identity = { projectRoot: path.resolve('demo'), dataDir: path.resolve('demo/.codevis') };
    let attempts = 0;
    const status = await waitForDemoDashboard('http://127.0.0.1:4123', identity, {
        pollMs: 1, fetchImpl: async url => {
            assert.equal(url.pathname, '/api/status');
            if (++attempts === 1) throw new Error('ECONNREFUSED');
            return { ok: true, json: async () => ({ ...identity, activeDb: 'project_db' }) };
        },
    });
    assert.equal(attempts, 2);
    assert.equal(status.projectRoot, identity.projectRoot);
});

test('demo recording rejects foreign dashboards and times out on failed startup', async () => {
    const { waitForDemoDashboard } = await import('../scripts/demo/dashboard-ready.mjs');
    const identity = { projectRoot: path.resolve('demo'), dataDir: path.resolve('demo/.codevis') };
    await assert.rejects(waitForDemoDashboard('http://127.0.0.1:4123', identity, {
        fetchImpl: async () => ({ ok: true, json: async () => ({ ...identity, activeDb: 'codevis_db' }) }),
    }), /different project, data directory or database/);
    await assert.rejects(waitForDemoDashboard('http://127.0.0.1:4123', identity, {
        timeoutMs: 0, fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
    }), /did not become ready: ECONNREFUSED/);
    await assert.rejects(waitForDemoDashboard('http://127.0.0.1:4123', identity, {
        startupError: () => new Error('bridge exited'), fetchImpl: () => assert.fail('must not fetch after exit'),
    }), /bridge exited/);
});

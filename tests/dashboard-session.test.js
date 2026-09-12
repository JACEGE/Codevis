const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const base = { port: 4234, projectRoot: root, dataDir: path.join(root, '.codevis') };
const response = (value, ok = true) => ({ ok, json: async () => value });

test('repeated dashboard command switches the matching existing bridge', async () => {
    const { reuseDashboard } = await import('../lib/dashboard-session.mjs');
    const calls = [];
    const result = await reuseDashboard({ ...base, db: 'meta', fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return response(calls.length === 1 ? { ...base, activeDb: 'project_db' } : { activeDb: 'codevis_db' });
    }});
    assert.equal(result.activeDb, 'codevis_db');
    assert.match(calls[1].url, /\/api\/switch-db$/);
    assert.deepEqual(JSON.parse(calls[1].options.body), { db: 'codevis_db' });
});

test('no explicit workspace preserves the running selection', async () => {
    const { reuseDashboard } = await import('../lib/dashboard-session.mjs');
    let count = 0;
    const result = await reuseDashboard({ ...base, fetchImpl: async () => { count++; return response({ ...base, activeDb: 'codevis_db' }); } });
    assert.equal(result.activeDb, 'codevis_db'); assert.equal(count, 1);
});

test('a foreign project or data directory cannot be switched', async () => {
    const { reuseDashboard } = await import('../lib/dashboard-session.mjs');
    for (const key of ['projectRoot', 'dataDir']) {
        let count = 0;
        await assert.rejects(reuseDashboard({ ...base, db: 'codevis_db', fetchImpl: async () => {
            count++; return response({ ...base, [key]: path.join(root, 'other'), activeDb: 'project_db' });
        }}), /another service or project/);
        assert.equal(count, 1);
    }
});

test('absent bridges start normally; protected switches fail visibly', async () => {
    const { reuseDashboard } = await import('../lib/dashboard-session.mjs');
    assert.equal(await reuseDashboard({ ...base, fetchImpl: async () => { throw Object.assign(new Error('refused'), { cause: { code: 'ECONNREFUSED' } }); } }), null);
    await assert.rejects(reuseDashboard({ ...base, db: 'codevis_db', fetchImpl: async url =>
        url.endsWith('/status') ? response({ ...base, activeDb: 'project_db' }) : response({ error: 'Meta database is locked.' }, false)
    }), /Could not switch/);
});

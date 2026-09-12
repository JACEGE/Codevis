const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const callback = require('./helpers/source-callback.cjs');
const file = path.resolve(__dirname, '../frontend/src/components/BrainTab.jsx');
const bridge = path.resolve(__dirname, '../server/bridge.js');
const workspace = require('../lib/workspace-names.cjs');

function editor() {
    const state = {};
    let resolve;
    const globals = { lifetime: { current: {} }, draftRevision: { current: 0 }, writeRequest: { current: 0 }, activeRun: { current: null },
        db: 'project_db', text: 'draft A', savedSessionId: null, BRIDGE_URL: '', crypto: { randomUUID: () => 'run-a' },
        matchesWorkspace: (data, db) => data.db === db,
        fetch: async (_url, options) => { state.sent = JSON.parse(options.body); return new Promise(yes => { resolve = yes; }); } };
    for (const name of ['Status', 'ErrorMsg', 'SavedSessionId', 'BrainResult', 'SelectedNodeId', 'DraftText']) {
        globals[`set${name}`] = value => { state[name] = typeof value === 'function' ? value(state[name]) : value; };
    }
    return { globals, state, finish: () => resolve({ ok: true, json: async () => ({ sessionId: 'session-a' }) }) };
}

for (const action of ['saveOnly', 'sendToClaude']) {
    test(`Brain ${action} binds the request to the editor workspace`, async () => {
        const { globals, state, finish } = editor();
        const pending = callback(file, action, globals)();
        assert.equal(state.sent.db, 'project_db');
        if (action === 'sendToClaude') assert.equal(state.sent.runId, 'run-a');
        finish(); await pending;
        assert.equal(state.Status, action === 'saveOnly' ? 'saved' : 'waiting');
    });
    test(`Brain ${action} ignores responses after workspace change`, async () => {
        const { globals, state, finish } = editor();
        const pending = callback(file, action, globals)();
        globals.lifetime.current = {};
        const before = { ...state };
        finish(); await pending;
        assert.deepEqual(state, before);
    });
}

test('Brain save does not acknowledge edits made while saving, including ABA edits', async () => {
    const { globals, state, finish } = editor();
    const pending = callback(file, 'saveOnly', globals)();
    const setText = callback(file, 'setText', globals);
    setText('draft B'); setText('draft A');
    finish(); await pending;
    assert.equal(state.Status, 'idle');
    assert.equal(state.DraftText, 'draft A');
});

for (const error of [false, true]) test(`Brain matching ${error ? 'error' : 'success'} before HTTP acknowledgement stays terminal`, async () => {
    const { globals, state, finish } = editor();
    const pending = callback(file, 'sendToClaude', globals)();
    const handler = callback(file, 'handler', globals);
    handler({ db: 'codevis_db', runId: 'run-a', error });
    handler({ db: 'project_db', runId: 'other', error });
    assert.equal(state.Status, 'sending');
    handler({ db: 'project_db', runId: 'run-a', error, summary: 'result' });
    assert.equal(state.Status, error ? 'error' : 'done');
    finish(); await pending;
    assert.equal(state.Status, error ? 'error' : 'done');
    handler({ db: 'project_db', runId: 'run-a', error: !error });
    assert.equal(state.Status, error ? 'error' : 'done');
});

for (const push of [false, true]) for (const db of ['project_db', 'codevis_db', 'invalid']) {
    test(`Brain route ${push ? 'generates' : 'saves'} in explicit ${db}`, async () => {
        const writes = [], runs = [];
        const res = { status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
        const route = callback(bridge, '/api/brain/save', { ...workspace, crypto: { randomUUID: () => 'unique' }, activeDb: db === 'project_db' ? 'meta' : 'target',
            getTaskDriver: selected => { writes.push(selected); return { session: () => ({ run: async () => {}, close: async () => {} }) }; },
            runHeadlessBraindump: args => runs.push(args) }, 'post');
        await route({ body: { text: 'note', db, push, runId: 'run-a' } }, res);
        if (db === 'invalid') { assert.equal(res.code, 400); assert.equal(writes.length, 0); }
        else {
            assert.deepEqual(writes, [workspace.normalizeWorkspaceName(db)]);
            assert.equal(res.code, push ? 202 : 200);
            if (push) { assert.equal(runs[0].db, writes[0]); assert.equal(runs[0].runId, 'run-a'); }
        }
    });
}

for (const outcome of ['success', 'spawn', 'exit', 'invalid', 'model-error', 'publish']) {
    test(`Brain worker ${outcome} emits one correctly identified outcome`, async () => {
        const { EventEmitter } = require('node:events');
        const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
        const events = [], published = [];
        const run = callback(bridge, 'runHeadlessBraindump', { ...workspace, BRAIN_MODEL: 'test', BRAIN_MCP_CONFIG: '', BRAIN_CWD: '', process: { env: {} },
            brainSystemPrompt: () => '', spawnHeadlessWorker: () => child, extractJsonObject: JSON.parse,
            io: { emit: (_name, data) => events.push(data) }, console: { log() {}, error() {} },
            getTaskDriver: () => ({ session: () => ({ run: async () => {}, close: async () => {} }) }),
            publishBrainResult: async data => { if (outcome === 'publish') throw new Error('query failed'); published.push(data); return 0; } });
        run({ text: 'note', sessionId: 'session', chat_id: 'session', runId: 'run-a', db: 'target' });
        child.stdout.emit('data', outcome === 'invalid' ? 'broken' : JSON.stringify({ is_error: outcome === 'model-error', result: JSON.stringify({ summary: 'ok', nodeIds: [] }) }));
        if (outcome === 'spawn') child.emit('error', new Error('cannot start'));
        await child.listeners('close')[0](outcome === 'exit' ? 1 : 0);
        if (outcome === 'success') { assert.equal(events.length, 0); assert.equal(published[0].runId, 'run-a'); assert.equal(published[0].db, 'target'); }
        else { assert.equal(published.length, 0); assert.equal(events.length, 1); assert.equal(events[0].error, true); assert.equal(events[0].db, 'project_db'); assert.equal(events[0].runId, 'run-a'); }
    });
}

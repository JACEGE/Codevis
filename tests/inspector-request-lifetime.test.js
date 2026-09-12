const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const callback = require('./helpers/source-callback.cjs');
const inspector = path.resolve(__dirname, '../frontend/src/components/InspectorSidebar.jsx');

for (const action of ['loadFullSource', 'reviewAnnotation']) for (const outcome of ['success', 'error']) {
    test(`${action}: late ${outcome} cannot change another node's inspector`, async () => {
        const writes = [];
        let resolve, reject;
        const lifetime = { current: {} };
        const globals = { BRIDGE_URL: '', debugNode: 'A', db: 'project_db', nodeLifetime: lifetime,
            fetch: () => new Promise((yes, no) => { resolve = yes; reject = no; }) };
        for (const name of ['setSource', 'setLoadingFullSource', 'setSourceError', 'setAnnotationSaving', 'setAnnotationError', 'setAnnotations']) {
            globals[name] = value => writes.push([name, value]);
        }
        const request = callback(inspector, action, globals)('tag-A', 'accepted');
        lifetime.current = {}; writes.length = 0;
        if (outcome === 'success') resolve({ ok: true, json: async () => ({ source: 'A', annotation: {} }) });
        else reject(new Error('Old failure'));
        await request; assert.equal(writes.length, 0);
    });
}
test('full source failure is handled and shown instead of becoming an unhandled rejection', async () => {
    const state = {}; const globals = { BRIDGE_URL: '', debugNode: 'A', db: 'project_db', nodeLifetime: { current: {} },
        fetch: async () => ({ ok: false, status: 500 }),
        setLoadingFullSource: value => { state.loading = value; }, setSourceError: value => { state.error = value; } };
    await callback(inspector, 'loadFullSource', globals)();
    assert.equal(state.loading, false); assert.equal(state.error, 'HTTP 500');
});

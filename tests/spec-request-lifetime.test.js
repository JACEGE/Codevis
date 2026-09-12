const test = require('node:test');
const assert = require('node:assert/strict');
const callback = require('./helpers/source-callback.cjs');
const file = require('node:path').resolve(__dirname, '../frontend/src/components/SpecTab.jsx');

for (const action of ['openSpec', 'syncSpec', 'deleteSpec', 'submit', 'loadLibrary']) {
    for (const outcome of ['success', 'error']) test(`Spec ${action} ignores late ${outcome} after workspace change/unmount`, async () => {
        let resolve, reject;
        const writes = [];
        const lifetime = { current: {} };
        const globals = { lifetime, draftRevision: { current: 0 }, editorRequest: { current: 0 }, libraryRequest: { current: 0 }, workerId: { current: null },
            db: 'project_db', dbQuery: '?db=project_db', diagram: 'A -> B: run()', openedSpec: { db: 'project_db', specId: 'a' },
            instructions: '', kind: 'auto', emitTasks: false, BRIDGE_URL: '', loadLibrary: () => writes.push('library'),
            fetch: () => new Promise((yes, no) => { resolve = yes; reject = no; }) };
        for (const name of ['OpeningId','ErrorMsg','Diagram','Result','Status','OpenedSpec','ConfirmDelete','SyncNote','Specs']) {
            globals[`set${name}`] = value => writes.push([name, value]);
        }
        const pending = callback(file, action, globals)('a');
        lifetime.current = {}; writes.length = 0;
        if (outcome === 'success') resolve({ ok: true, json: async () => ({ source: 'old', specs: [], removed: 1 }) });
        else reject(new Error('old failure'));
        await pending;
        assert.deepEqual(writes, []);
    });
}
for (const action of ['syncSpec', 'deleteSpec']) test(`Spec ${action} rejects an editor owned by another workspace`, async () => {
    await callback(file, action, { openedSpec: { db: 'project_db', specId: 'shared' }, db: 'codevis_db', diagram: 'A -> B: run()',
        fetch: () => assert.fail('foreign workspace write') })();
});

for (const action of ['openSpec', 'deleteSpec']) {
    for (const edit of [false, true]) test(`Spec ${action} ${edit ? 'preserves a newer draft' : 'applies unchanged editor response'}`, async () => {
        let resolve;
        let diagram = 'original';
        const globals = { lifetime: { current: {} }, draftRevision: { current: 0 }, editorRequest: { current: 0 }, workerId: { current: null },
            db: 'project_db', openedSpec: { db: 'project_db', specId: 'a', title: 'A' }, BRIDGE_URL: '', loadLibrary() {},
            setDraftDiagram: value => { diagram = value; }, fetch: () => new Promise(yes => { resolve = yes; }) };
        for (const name of ['OpeningId','ErrorMsg','Result','Status','OpenedSpec','ConfirmDelete','SyncNote']) globals[`set${name}`] = () => {};
        globals.setDiagram = callback(file, 'setDiagram', globals);
        const pending = callback(file, action, globals)('a');
        if (edit) { globals.setDiagram('newer'); globals.setDiagram('original'); } // ABA edits still count.
        resolve({ ok: true, json: async () => ({ source: 'stored', removed: 1 }) });
        await pending;
        assert.equal(diagram, edit ? 'original' : action === 'openSpec' ? 'stored' : '');
    });
}

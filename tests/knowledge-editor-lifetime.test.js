const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const hookRunner = require('./helpers/hook-runner.cjs');

function setup() {
    const requests = [], saved = [];
    const props = { nodeId: 'A', db: 'project_db', node: { content: 'Original A' }, onSaved: (...args) => saved.push(args) };
    const run = hookRunner(path.resolve(__dirname, '../frontend/src/hooks/useKnowledgeEditor.js'), {
        '../bridgeUrl': '', '../api/http': { requestJson: (url, options) => new Promise((resolve, reject) => requests.push({ url, options, resolve, reject })) },
    });
    const render = () => run(props);
    render();
    return { render, props, requests, saved, run };
}

for (const change of ['node', 'workspace', 'A-B-A', 'unmount']) {
    for (const outcome of ['success', 'error']) test(`Knowledge late ${outcome} is ignored after ${change}`, async () => {
        const { render, props, requests, saved, run } = setup();
        let hook = render(); hook.setEditing(true); hook.setDraft('Submitted A');
        const saving = render().saveKnowledge();
        if (change === 'node') { props.nodeId = 'B'; props.node = { content: 'Original B' }; }
        if (change === 'workspace' || change === 'A-B-A') props.db = 'codevis_db';
        render();
        if (change === 'A-B-A') { props.db = 'project_db'; render(); }
        hook = render(); hook.setEditing(true); hook.setDraft('New draft');
        if (change === 'unmount') run.unmount();
        if (outcome === 'success') requests[0].resolve({ content: 'Submitted A' });
        else requests[0].reject(new Error('Old error'));
        await saving;
        hook = render(); assert.equal(hook.draft, 'New draft'); assert.equal(hook.editing, true);
        assert.equal(hook.knowledgeContent, props.node.content); assert.equal(hook.saveError, null); assert.equal(saved.length, 0);
    });
}
test('Knowledge exact-ID save preserves text typed while saving', async () => {
    const { render, requests, saved } = setup();
    let hook = render(); hook.setEditing(true); hook.setDraft('Submitted');
    const saving = render().saveKnowledge();
    assert.deepEqual(JSON.parse(requests[0].options.body), { nodeId: 'A', content: 'Submitted', db: 'project_db' });
    render().setDraft('Newer typing');
    requests[0].resolve({ content: 'Submitted' }); await saving;
    hook = render(); assert.equal(hook.draft, 'Newer typing'); assert.equal(hook.editing, true);
    assert.equal(hook.knowledgeContent, 'Submitted'); assert.equal(hook.saving, false); assert.equal(saved.length, 1);
});
test('unchanged Knowledge editor closes after saving; Markdown never submits', async () => {
    const { render, requests, props } = setup();
    render().setEditing(true); render().setDraft('Saved');
    const saving = render().saveKnowledge(); requests[0].resolve({ content: 'Saved' }); await saving;
    assert.equal(render().editing, false);
    props.node = { kind: 'markdown' }; await render().saveKnowledge(); assert.equal(requests.length, 1);
});

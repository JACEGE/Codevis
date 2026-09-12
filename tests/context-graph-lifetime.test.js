const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const hookRunner = require('./helpers/hook-runner.cjs');
const callback = require('./helpers/source-callback.cjs');
const app = path.resolve(__dirname, '../frontend/src/App.jsx');

function setup() {
    const run = hookRunner(path.resolve(__dirname, '../frontend/src/hooks/useGraphRequestGate.js'), {});
    run('project_db'); const gate = run('project_db');
    const state = { explore: { nodes: [{ id: 'Old' }], links: [] }, selected: 'Old', focus: 'Old', menu: {} };
    const requests = [], noop = () => {};
    const globals = {
        AbortSignal: { timeout: () => undefined },
        setContextRequest: value => { state.contextRequest = value; },
        beginGraphRequest: gate.begin, captureGraphRequest: gate.capture, invalidateGraphRequests: gate.invalidate,
        setExploreGraphData: value => { state.explore = value; }, setSelectedNode: value => { state.selected = value; },
        setFocusNodeId: value => { state.focus = value; }, setNodeActionMenu: value => { state.menu = value; },
        setCallStack: noop, setRouteResult: noop, setDebugPath: noop, setDebugBranches: noop, clearActiveLinks: noop,
        setDfsTree: noop, dfsTreeRef: { current: null }, fullGraphRef: { current: { nodes: [] } }, routeResult: null,
        activeDb: 'project_db', BRIDGE_URL: '', getNodeInfo: id => ({ id }), console: { error: noop, log: noop },
        fetch: (url, options) => new Promise(resolve => requests.push({ url, options, resolve })),
    };
    globals.clearTrace = callback(app, 'clearTrace', globals);
    globals.resetSelection = callback(app, 'resetSelection', globals);
    return { run, gate, state, requests, globals, show: callback(app, 'showContextSubgraph', globals) };
}
test('graph:init clears an ordinary context graph, selection, focus and menu even for an empty replacement', () => {
    const { state, globals } = setup(); const noop = () => {};
    callback(app, 'graph:init', { ...globals, setReceivedGraphNodeCount: noop, setCapped: noop, replaceCachedGraph: noop, applyGraph: noop }, 'on')({ nodes: [], links: [] });
    assert.equal(state.explore, null); assert.equal(state.selected, null); assert.equal(state.focus, null); assert.equal(state.menu, null);
});

test('context actions show pending, then preserve the loaded graph and show a failed request', async () => {
    const { show, state, requests } = setup();
    const graph = state.explore;
    const pending = show('A', 2);
    assert.equal(state.contextRequest.pending, true);
    assert.equal(state.contextRequest.hops, 2);
    requests[0].resolve({ ok: false, status: 500, json: async () => ({ error: 'database unavailable' }) });
    await pending;
    assert.equal(state.explore, graph);
    assert.equal(state.contextRequest.pending, false);
    assert.match(state.contextRequest.error, /database unavailable/);
});

test('an empty context result reports a missing node instead of replacing the graph', async () => {
    const { show, state, requests } = setup(); const graph = state.explore;
    const pending = show('missing');
    requests[0].resolve({ ok: true, json: async () => ({ nodes: [], links: [] }) }); await pending;
    assert.equal(state.explore, graph);
    assert.match(state.contextRequest.error, /no longer in the graph/);
});

test('an old failed context request cannot overwrite a newer loading state', async () => {
    const { show, state, requests } = setup();
    const first = show('A'); const second = show('B');
    requests[0].resolve({ ok: false, status: 500, json: async () => ({ error: 'old failure' }) }); await first;
    assert.equal(state.contextRequest.nodeId, 'B');
    assert.equal(state.contextRequest.pending, true);
    requests[1].resolve({ ok: true, json: async () => ({ nodes: [{ id: 'B' }], links: [] }) }); await second;
    assert.equal(state.contextRequest, null);
});
test('new graph navigation invalidates pending context feedback', async () => {
    const { show, state, requests, gate } = setup();
    const pending = show('A');
    assert.equal(state.contextRequest.isCurrent(), true);
    gate.begin();
    assert.equal(state.contextRequest.isCurrent(), false);
    requests[0].resolve({ ok: false, status: 500, json: async () => ({ error: 'old failure' }) });
    await pending;
    assert.equal(state.contextRequest.error, undefined);
});
for (const change of ['workspace', 'A-B-A', 'reset', 'unmount', 'newer context']) test(`late context cannot replace graph after ${change}`, async () => {
    const { show, run, state, requests, globals } = setup();
    const first = show('A');
    if (change === 'workspace' || change === 'A-B-A') run('codevis_db');
    if (change === 'A-B-A') run('project_db');
    if (change === 'reset') globals.resetSelection();
    if (change === 'unmount') run.unmount();
    if (change === 'newer context') {
        const second = show('B'); requests[1].resolve({ ok: true, json: async () => ({ nodes: [{ id: 'B' }], links: [] }) }); await second;
    }
    const before = state.explore;
    requests[0].resolve({ ok: true, json: async () => ({ nodes: [{ id: 'A' }], links: [] }) }); await first;
    assert.equal(state.explore, before);
});

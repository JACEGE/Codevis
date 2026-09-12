const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const hookRunner = require('./helpers/hook-runner.cjs');

const scope = (budget = null) => ({budget, loadable: 24, hiddenTypes: [], includeIsolated: false});
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function harness() {
    const requests = [], updates = [], timers = new Set();
    const props = {activeDb: 'project_db', detailLevel: 1,
        setActiveDb: db => updates.push(['db', db]), setDetailLevel: level => updates.push(['level', level])};
    const renderHook = hookRunner(path.resolve(__dirname, '../frontend/src/hooks/useGraphScope.js'), {
        '../bridgeUrl': '', '../components/GraphFilter': {DEFAULT_TYPE_VISIBILITY: {}},
    }, {
        AbortController, console: {error() {}},
        localStorage: {getItem: () => null, setItem() {}},
        setTimeout: (fn, delay) => { const timer = {fn, delay}; timers.add(timer); return timer; },
        clearTimeout: timer => timers.delete(timer),
        fetch: (url, options) => new Promise((resolve, reject) => {
            requests.push({url, options, resolve, reject});
            options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {once: true});
        }),
    });
    const render = () => renderHook(props);
    const flush = delay => {
        const timer = [...timers].find(t => t.delay === delay);
        assert.ok(timer, `expected ${delay}ms timer`); timers.delete(timer); timer.fn();
    };
    const changeBudget = budget => { const h = render(); h.setGraphScope(scope()); h.setNodeBudget(budget); render(); flush(350); return requests.at(-1); };
    return {render, props, requests, updates, timers, flush, changeBudget, unmount: renderHook.unmount};
}
const ok = data => ({ok: true, json: async () => data});

test('HTTP scope errors stop pending, preserve loaded scope and allow explicit retry', async () => {
    const h = harness(); const req = h.changeBudget(7);
    req.resolve({ok: false, status: 500, json: async () => ({error: 'database unavailable'})}); await tick();
    let state = h.render();
    assert.equal(state.scopePending, false);
    assert.match(state.scopeError, /database unavailable/);
    assert.equal(state.graphScope.budget, null);
    state.retryScope(); h.render(); h.flush(350);
    h.requests.at(-1).resolve(ok({ok: true, scope: scope(7)})); await tick();
    state = h.render();
    assert.equal(state.scopePending, false);
    assert.equal(state.scopeError, null);
    assert.equal(state.graphScope.budget, 7);
});

test('network rejection is visible and recoverable', async () => {
    const h = harness(); h.changeBudget(7).reject(new Error('offline')); await tick();
    assert.equal(h.render().scopePending, false);
    assert.match(h.render().scopeError, /offline/);
});

test('another window changing scope does not reassert this window budget', async () => {
    const h = harness(); const req = h.changeBudget(7);
    req.resolve(ok({ok: true, scope: scope(7)})); await tick(); h.render();
    for (const budget of [9, 12, 9]) {
        h.render().setGraphScope(scope(budget)); h.render();
        assert.equal([...h.timers].some(timer => timer.delay === 350), false);
    }
    assert.equal(h.requests.length, 1);
    h.render().setNodeBudget(11); h.render(); h.flush(350);
    assert.equal(JSON.parse(h.requests.at(-1).options.body).budget, 11);
    h.unmount();
});

test('graph broadcasts do not abort or repeat a pending user scope request', async () => {
    const h = harness(); const req = h.changeBudget(7);
    h.render().setGraphScope(scope(9)); h.render();
    assert.equal(req.options.signal.aborted, false);
    assert.equal([...h.timers].some(timer => timer.delay === 350), false);
    req.resolve(ok({ok: true, scope: scope(7)})); await tick();
    assert.equal(h.render().graphScope.budget, 7);
    assert.equal(h.render().scopePending, false);
    h.unmount();
});

test('a delayed bootstrap never turns an unknown budget into an unlimited request', () => {
    const h = harness(); h.render().setGraphScope({...scope(500), loadable: 100000});
    h.render();
    assert.equal([...h.timers].some(timer => timer.delay === 350), false);
    assert.equal(h.render().nodeBudget, 500);
});

test('a scope timeout stops pending and offers retry', async () => {
    const h = harness(); h.changeBudget(7); h.flush(60000); await tick();
    assert.equal(h.render().scopePending, false);
    assert.match(h.render().scopeError, /timed out/);
});

test('automatic status refresh cannot acknowledge an unfinished scope update', async () => {
    const h = harness(); h.changeBudget(7); h.flush(600); await tick();
    assert.equal(h.requests.length, 1);
    assert.equal(h.render().scopePending, true);
});

for (const changed of ['activeDb', 'detailLevel']) {
    test(`late status cannot roll back changed ${changed}, even after switching back`, async () => {
        const h = harness(); const pending = h.render().refreshFromBridge();
        const old = h.props[changed]; h.props[changed] = changed === 'activeDb' ? 'codevis_db' : 3; h.render();
        h.props[changed] = old; h.render();
        h.requests[0].resolve(ok({activeDb: 'project_db', detailLevel: 1, scope: scope()})); await pending;
        assert.deepEqual(h.updates, []);
        assert.equal(h.render().graphScope, null);
    });
}

test('only the newest status response applies', async () => {
    const h = harness(); const a = h.render().refreshFromBridge(); const b = h.render().refreshFromBridge();
    h.requests[1].resolve(ok({scope: scope(9)})); await b;
    h.requests[0].resolve(ok({scope: scope(3)})); await a;
    assert.equal(h.render().graphScope.budget, 9);
});

test('a graph event supersedes a pending status response', async () => {
    const h = harness(); const pending = h.render().refreshFromBridge();
    h.render().setGraphScope(scope(9)); h.render();
    h.requests[0].resolve(ok({scope: scope(3)})); await pending;
    assert.equal(h.render().graphScope.budget, 9);
});

test('old scope failures cannot clear a newer request pending flag', async () => {
    const h = harness(); const old = h.changeBudget(7);
    h.render().setNodeBudget(9); h.render(); h.flush(350);
    old.reject(new Error('old failure')); await tick();
    assert.equal(h.render().scopePending, true);
    assert.equal(h.render().scopeError, null);
    h.requests.at(-1).resolve(ok({ok: true, scope: scope(9)})); await tick();
    assert.equal(h.render().graphScope.budget, 9);
});

test('scope replies from a previous workspace are ignored', async () => {
    const h = harness(); const req = h.changeBudget(7);
    h.props.activeDb = 'codevis_db'; h.render();
    req.resolve(ok({ok: true, scope: scope(7)})); await tick();
    assert.notEqual(h.render().graphScope?.budget, 7);
});

test('unmount invalidates outstanding status callbacks', async () => {
    const h = harness(); const pending = h.render().refreshFromBridge(); h.unmount();
    h.requests[0].resolve(ok({activeDb: 'codevis_db', scope: scope()})); await pending;
    assert.deepEqual(h.updates, []);
});

test('a level change keeps loading until a fresh graph arrives', () => {
    const h = harness(); let state = h.render(); state.setGraphScope(scope()); state.setNodeBudget(0);
    h.render(); state = h.render(); state.setScopePending(true);
    h.props.detailLevel = 3; h.render();
    assert.equal(h.render().scopePending, true);
});

test('bootstrap config does not overwrite live workspace, and refreshes extractor config on switch', async () => {
    const requests = [], updates = [];
    const render = hookRunner(path.resolve(__dirname, '../frontend/src/hooks/useProjectConfig.js'), {
        '../bridgeUrl': '', '../api/http': {requestJson: () => new Promise(resolve => requests.push(resolve))},
    });
    const props = {activeDb: 'project_db', setActiveDb: db => updates.push(db)};
    render(props); props.activeDb = 'codevis_db'; render(props);
    assert.equal(requests.length, 2);
    requests[1]({activeDb: 'codevis_db', extractors: {ros: true}}); await tick();
    requests[0]({activeDb: 'project_db', extractors: {ros: false}}); await tick();
    assert.deepEqual(updates, []);
    assert.equal(render(props).extractors.ros, true);
});

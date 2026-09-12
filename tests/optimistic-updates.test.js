const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const frontendRequire = createRequire(path.resolve(__dirname, '../frontend/package.json'));
const React = frontendRequire('react');
const { createRoot } = frontendRequire('react-dom/client');
const { JSDOM } = frontendRequire('jsdom');

test('optimistic rollback handles every completion order and success combination', async () => {
    const { applyOptimisticUpdate, reconcileOptimisticUpdate } = await import('../frontend/src/kanban/optimisticUpdates.js');
    const orders = [[0,1,2], [0,2,1], [1,0,2], [1,2,0], [2,0,1], [2,1,0]];
    const patches = [{ priority: 'high' }, { content: 'Edited' }, { priority: 'medium' }];
    for (const order of orders) for (let mask = 0; mask < 8; mask++) {
        const updates = new WeakMap();
        const original = { content: 'Original', priority: 'low' };
        const operations = patches.map(() => ({ state: 'pending' }));
        let item = original;
        patches.forEach((patch, index) => { item = applyOptimisticUpdate(updates, item, patch, operations[index]); });
        for (const index of order) {
            operations[index].state = mask & (1 << index) ? 'succeeded' : 'failed';
            item = reconcileOptimisticUpdate(updates, item);
        }
        const expected = Object.assign({}, original, ...patches.filter((_, index) => mask & (1 << index)));
        assert.deepEqual(item, expected, `order ${order}, success mask ${mask}`);
        assert.equal(updates.has(item), false, 'settled history should be released');
    }
});

test('overlapping idea failures reconcile correctly in React StrictMode', async () => {
    const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
    global.window = dom.window;
    global.document = dom.window.document;
    global.IS_REACT_ACT_ENVIRONMENT = true;
    const requests = [];
    const bundle = require('esbuild').buildSync({
        entryPoints: [path.resolve(__dirname, '../frontend/src/hooks/useIdeas.js')],
        bundle: true, write: false, format: 'cjs', platform: 'node', external: ['react'],
        define: { 'import.meta.env.VITE_BRIDGE_URL': '"http://localhost"' },
    }).outputFiles[0].text;
    const mod = { exports: {} };
    vm.runInNewContext(bundle, {
        module: mod, exports: mod.exports, require: name => { assert.equal(name, 'react'); return React; },
        fetch: (url, options) => new Promise((resolve, reject) => requests.push({ url, options, resolve, reject })),
    });
    let ideas;
    function Editor() {
        ideas = mod.exports.default({ db: 'project_db', onError() {} });
        return React.createElement('output', null, JSON.stringify(ideas.ideas));
    }
    const root = createRoot(document.getElementById('root'));
    try {
        await React.act(() => root.render(React.createElement(React.StrictMode, null, React.createElement(Editor))));
        await React.act(() => ideas.setIdeas([{ ideaId: 'A', content: 'Original', priority: 'low' }]));
        let first, second;
        await React.act(() => { first = ideas.patchIdea('A', { priority: 'high' }); });
        await React.act(() => { second = ideas.patchIdea('A', { content: 'Edited' }); });
        await React.act(async () => { requests[0].reject(new Error('offline')); await first; });
        assert.equal(ideas.ideas[0].content, 'Edited');
        assert.equal(ideas.ideas[0].priority, 'low');
        await React.act(async () => { requests[1].reject(new Error('offline')); await second; });
        assert.equal(ideas.ideas[0].content, 'Original');
        assert.equal(ideas.ideas[0].priority, 'low');
    } finally {
        await React.act(() => root.unmount());
        dom.window.close();
        delete global.window; delete global.document; delete global.IS_REACT_ACT_ENVIRONMENT;
    }
});

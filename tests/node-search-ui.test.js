const test = require('node:test');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { resolve } = require('node:path');
const { readFileSync } = require('node:fs');
const { runInNewContext } = require('node:vm');
const { transformSync } = require('esbuild');
const frontendRequire = createRequire(resolve(__dirname, '../frontend/package.json'));
const React = frontendRequire('react');
const { JSDOM } = frontendRequire('jsdom');

test('search ignores obsolete responses, resets on workspace changes, retries errors and navigates by exact ID', async t => {
    const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
    const oldWindow = global.window, oldDocument = global.document, oldAct = global.IS_REACT_ACT_ENVIRONMENT;
    global.window = dom.window;
    global.document = dom.window.document;
    global.IS_REACT_ACT_ENVIRONMENT = true;
    const { createRoot } = frontendRequire('react-dom/client');
    const { Simulate } = frontendRequire('react-dom/test-utils');
    dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
    dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
    const pending = [], selected = [];
    const requestJson = (url, options) => new Promise((resolve, reject) => pending.push({ url, options, resolve, reject }));
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const mod = { exports: {} };
    runInNewContext(transformSync(readFileSync(resolve(__dirname, '../frontend/src/components/NodeSearchDialog.jsx'), 'utf8'), {
        loader: 'jsx', format: 'cjs', jsx: 'automatic',
    }).code, { module: mod, exports: mod.exports, AbortController, AbortSignal, setTimeout, clearTimeout,
        require: name => name === '../bridgeUrl' ? { default: '' } : name === '../api/http' ? { requestJson } : frontendRequire(name) });
    const Search = mod.exports.default;
    const root = createRoot(document.getElementById('root'));
    const render = db => React.act(() => root.render(React.createElement(Search, { key: db, db, onClose() {}, onSelect: id => selected.push(id) })));
    const change = async text => {
        await React.act(() => Simulate.change(document.querySelector('input'), { target: { value: text } }));
        await React.act(() => t.mock.timers.tick(251));
    };
    try {
        await render('codevis_db');
        assert.equal(document.activeElement.tagName, 'INPUT');
        await change('old');
        await change('new');
        assert.equal(pending[0].options.signal.aborted, true);
        await React.act(() => pending[1].resolve({ items: [{ id: 'Function||file=a & #1.js', name: 'new', labels: ['Function'] }] }));
        await React.act(() => pending[0].resolve({ items: [{ id: 'old', name: 'obsolete', labels: ['Function'] }] }));
        assert.equal(document.querySelector('.node-search-result strong').textContent, 'new');
        await React.act(() => document.querySelector('.node-search-result').click());
        assert.deepEqual(selected, ['Function||file=a & #1.js']);
        await change('in flight');
        await render('project_db');
        await React.act(() => pending[2].resolve({ items: [{ id: 'wrong-workspace', name: 'obsolete', labels: [] }] }));
        assert.equal(document.querySelectorAll('.node-search-result').length, 0);
        await change('missing');
        assert.match(pending[3].url, /db=project_db/);
        await React.act(() => pending[3].reject(new Error('Offline')));
        assert.match(document.querySelector('[role=status]').textContent, /Offline/);
        await React.act(() => [...document.querySelectorAll('button')].find(button => button.textContent === 'Retry search').click());
        await React.act(() => t.mock.timers.tick(251));
        await React.act(() => pending[4].resolve({ items: [] }));
        assert.match(document.querySelector('[role=status]').textContent, /No matches/);
        await change('   ');
        assert.equal(pending.length, 5);
        assert.equal(document.querySelectorAll('.node-search-result').length, 0);
        await change('frontend/src');
        await React.act(() => pending[5].reject(Object.assign(new Error('HTTP 404'), { status: 404 })));
        assert.match(document.querySelector('[role=status]').textContent, /stop and restart its dashboard server/);
        assert.equal(document.querySelectorAll('.node-search-result').length, 0);
        await React.act(() => [...document.querySelectorAll('button')].find(button => button.textContent === 'Retry search').click());
        await React.act(() => t.mock.timers.tick(251));
        assert.equal(pending[6].url, pending[5].url);
        await React.act(() => pending[6].resolve({ items: [{ id: 'File||frontend/src/App.jsx', name: 'App.jsx', labels: ['File'] }] }));
        assert.equal(document.querySelector('.node-search-result strong').textContent, 'App.jsx');
        assert.doesNotMatch(document.querySelector('[role=status]').textContent, /HTTP 404/);
    } finally {
        await React.act(() => root.unmount());
        dom.window.close();
        global.window = oldWindow;
        global.document = oldDocument;
        global.IS_REACT_ACT_ENVIRONMENT = oldAct;
    }
});

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const path = require('node:path');
const frontendRequire = createRequire(path.resolve(__dirname, '../frontend/package.json'));
const React = frontendRequire('react');
const { createRoot } = frontendRequire('react-dom/client');
const { JSDOM } = frontendRequire('jsdom');

test('drafts survive unmounts, remain workspace-scoped, and support explicit discard', async () => {
    const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
    global.window = dom.window;
    global.document = dom.window.document;
    global.sessionStorage = dom.window.sessionStorage;
    global.IS_REACT_ACT_ENVIRONMENT = true;
    const { default: useSessionDraft } = await import('../frontend/src/hooks/useSessionDraft.js');
    let update;
    function Editor({ workspace }) {
        const [value, setValue] = useSessionDraft(`test.${workspace}`, '');
        update = setValue;
        return React.createElement('output', null, value);
    }
    let root = createRoot(document.getElementById('root'));
    const render = workspace => React.act(() => root.render(React.createElement(Editor, { workspace })));
    try {
        await render('project');
        await React.act(() => update('Project draft'));
        const staleUpdate = update;
        await render('self');
        assert.equal(document.querySelector('output').textContent, '');
        await React.act(() => staleUpdate('Late project response'));
        assert.equal(document.querySelector('output').textContent, '');
        await React.act(() => update('Self draft'));
        await render('project');
        assert.equal(document.querySelector('output').textContent, 'Project draft');
        await React.act(() => root.unmount());
        root = createRoot(document.getElementById('root'));
        await render('self');
        assert.equal(document.querySelector('output').textContent, 'Self draft');
        await React.act(() => update(''));
        await render('project');
        await render('self');
        assert.equal(document.querySelector('output').textContent, '');
        assert.equal(JSON.parse(sessionStorage.getItem('test.project')), 'Project draft');
    } finally {
        await React.act(() => root.unmount());
        dom.window.close();
        delete global.window;
        delete global.document;
        delete global.sessionStorage;
        delete global.IS_REACT_ACT_ENVIRONMENT;
    }
});

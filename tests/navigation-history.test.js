const test = require('node:test');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const path = require('node:path');
const frontendRequire = createRequire(path.resolve(__dirname, '../frontend/package.json'));
const React = frontendRequire('react');
const { createRoot } = frontendRequire('react-dom/client');
const { JSDOM } = frontendRequire('jsdom');

test('real React navigation batches destinations, replays them, branches and resets on database changes', async () => {
    const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
    global.window = dom.window;
    global.document = dom.window.document;
    global.IS_REACT_ACT_ENVIRONMENT = true;
    const { default: useNavigationHistory } = await import('../frontend/src/hooks/useNavigationHistory.js');
    let controls, select, selectTab, location;
    function Dashboard({ workspace }) {
        const [tab, setTab] = React.useState('kanban');
        const [nodeId, setNodeId] = React.useState(null);
        const [layout, setLayout] = React.useState('split');
        React.useEffect(() => { setNodeId(null); }, [workspace]);
        controls = useNavigationHistory({ workspace, tab, nodeId, layout, onRestore: previous => {
            setTab(previous.tab); setNodeId(previous.nodeId); setLayout(previous.layout);
        } });
        select = (node, nextTab = tab) => { setNodeId(node); setTab(nextTab); };
        selectTab = setTab;
        location = { tab, nodeId, layout };
        return React.createElement('output', null, JSON.stringify(location));
    }
    const root = createRoot(document.getElementById('root'));
    const render = workspace => React.act(() => root.render(React.createElement(React.StrictMode, null, React.createElement(Dashboard, { workspace }))));
    try {
        await render('project_db');
        assert.equal(controls.canGoBack, false);
        await React.act(() => select('Function||file=a.js', 'inspector'));
        await React.act(() => selectTab('documentation'));
        await React.act(() => controls.goBack());
        assert.deepEqual(location, { tab: 'inspector', nodeId: 'Function||file=a.js', layout: 'split' });
        assert.equal(controls.canGoForward, true);
        await React.act(() => controls.goBack());
        assert.equal(location.tab, 'kanban');
        assert.equal(location.nodeId, null);
        assert.equal(controls.canGoBack, false);
        await React.act(() => controls.goForward());
        assert.equal(location.nodeId, 'Function||file=a.js');
        await React.act(() => select('Function||file=a.js', 'inspector'));
        assert.equal(controls.canGoForward, true, 'duplicate destinations keep the forward branch');
        await React.act(() => select('node-b'));
        assert.equal(controls.canGoForward, false);
        await React.act(() => controls.goBack());
        assert.equal(location.nodeId, 'Function||file=a.js');
        await render('codevis_db');
        assert.equal(location.nodeId, null);
        assert.equal(controls.canGoBack, false);
        assert.equal(controls.canGoForward, false);
        await React.act(() => controls.goBack());
        assert.equal(location.nodeId, null);
    } finally {
        await React.act(() => root.unmount());
        dom.window.close();
        delete global.window;
        delete global.document;
        delete global.IS_REACT_ACT_ENVIRONMENT;
    }
});

test('navigation history stays bounded and restores layout without altering node IDs', async () => {
    const { createHistory, recordLocation, moveHistory } = await import('../frontend/src/navigation/historyModel.js');
    let history = createHistory('project_db', { tab: 'kanban', nodeId: null, layout: 'split' });
    for (let i = 0; i < 120; i++) history = recordLocation(history, { tab: 'inspector', nodeId: `node|/${i}`, layout: 'panel' });
    assert.equal(history.entries.length, 100);
    assert.equal(moveHistory(history, 1), history);
    history = recordLocation(history, { ...history.entries[history.index], layout: 'graph' });
    history = moveHistory(history, -1);
    assert.equal(history.entries[history.index].layout, 'panel');
    assert.equal(history.entries[history.index].nodeId, 'node|/119');
});

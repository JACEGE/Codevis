const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { resolve, dirname } = require('node:path');
const { readFileSync, existsSync } = require('node:fs');
const { createRequire } = require('node:module');
const { transformSync } = require('esbuild');
const frontendRequire = createRequire(resolve(__dirname, '../frontend/package.json'));
const React = frontendRequire('react');
const { renderToStaticMarkup } = frontendRequire('react-dom/server');

function loadModule(filename) {
    const compiled = transformSync(readFileSync(filename, 'utf8'), {
        loader: 'jsx', format: 'cjs', jsx: 'automatic',
        define: { 'import.meta.env.VITE_BRIDGE_URL': '"http://bridge.test"' },
    });
    const mod = { exports: {} };
    vm.runInNewContext(compiled.code, {
        module: mod, exports: mod.exports, require: name => {
            if (!name.startsWith('.')) return frontendRequire(name);
            const base = resolve(dirname(filename), name);
            const target = [base, `${base}.js`, `${base}.jsx`].find(existsSync);
            assert.ok(target, `Missing module: ${name}`);
            return loadModule(target);
        },
    });
    return mod.exports;
}
const GraphEmptyState = loadModule(resolve(__dirname, '../frontend/src/components/GraphEmptyState.jsx')).default;
const SettingsPanel = loadModule(resolve(__dirname, '../frontend/src/components/SettingsPanel.jsx')).default;
const render = (Component, props) => renderToStaticMarkup(React.createElement(Component, props));

test('Settings does not claim missing sources or an unverified database before status arrives', () => {
    const markup = render(SettingsPanel, {activeDb: 'project_db', totalNodes: 11, maxVisibleNodes: 500});
    assert.match(markup, /Loading workspace configuration/);
    assert.doesNotMatch(markup, /No source directories are configured|Unverified database/);
});

test('Settings shows failed scope as not applied, with an accessible retry action', () => {
    const markup = render(SettingsPanel, {activeDb: 'project_db', totalNodes: 11, maxVisibleNodes: 7,
        scopeError: 'Graph update failed: HTTP 500', onRetryScope() {}});
    assert.match(markup, /Not applied/);
    assert.match(markup, /role="alert"/);
    assert.match(markup, /Retry graph update/);
    assert.doesNotMatch(markup, />Applied</);
});

test('graph distinguishes connection, pending response and successfully loaded empty graph', () => {
    assert.match(render(GraphEmptyState, { connected: null }), /Connecting…/);
    assert.match(render(GraphEmptyState, { connected: true, loadedEmpty: false }), /Loading graph…/);
    const empty = render(GraphEmptyState, { connected: true, loadedEmpty: true });
    assert.match(empty, /No graph nodes to display/);
    assert.match(empty, /codevis build/);
    assert.doesNotMatch(empty, /Loading|waiting|⏳/);
});

test('filtered empty graph offers reset only after load; disconnect takes precedence', () => {
    const props = { connected: true, loadedEmpty: true, filteredEmpty: true };
    assert.match(render(GraphEmptyState, props), /Show all node types/);
    assert.doesNotMatch(render(GraphEmptyState, { ...props, loadedEmpty: false }), /Show all node types/);
    const disconnected = render(GraphEmptyState, { ...props, connected: false, bridgeUrl: 'http://bridge.test' });
    assert.match(disconnected, /connection error/);
    assert.doesNotMatch(disconnected, /Show all node types/);
});

for (const totalNodes of [0, 1, 9, 10, 2171]) {
    test(`Settings renders the actual loadable count ${totalNodes}, without a minimum of ten`, () => {
        const props = { activeDb: 'project_db', totalNodes, maxVisibleNodes: Infinity, typeCounts: {} };
        assert.match(render(SettingsPanel, props), new RegExp(`All ${totalNodes} nodes loadable at this level`));
        assert.match(render(SettingsPanel, { ...props, maxVisibleNodes: 5 }),
            new RegExp(`Budget ${Math.min(5, totalNodes)} of ${totalNodes} nodes loadable at this level`));
        const input = render(SettingsPanel, props).match(/<input[^>]*placeholder="All"[^>]*>/)?.[0];
        assert.ok(input);
        if (totalNodes) assert.match(input, new RegExp(`max="${totalNodes}"`));
        else assert.doesNotMatch(input, /max=/);
    });
}

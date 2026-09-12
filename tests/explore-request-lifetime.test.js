const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const callback = require('./helpers/source-callback.cjs');
const explore = path.resolve(__dirname, '../frontend/src/components/ExploreTab.jsx');

for (const phase of ['query', 'subgraph']) for (const change of ['workspace', 'new query']) {
    test(`Explore late ${phase} cannot publish after ${change}`, async () => {
        const writes = [], requests = [];
        const workspaceLifetime = { current: {} };
        const globals = { BRIDGE_URL: '', db: 'project_db', workspaceLifetime, abortRef: { current: null }, AbortController,
            parseDirectives: cypher => ({ cypher, expand: 0 }), rowKeys: () => ({ uids: ['A'], ipv6s: [] }), rowIpv6s: () => ['A'],
            fetch: () => new Promise(resolve => requests.push(resolve)) };
        for (const name of ['setQueryLoading', 'setQueryError', 'setGraphError', 'setGraphResult', 'setQueryResult', 'onResultGraph', 'setActiveQueryName']) {
            globals[name] = value => writes.push([name, value]);
        }
        const run = callback(explore, 'runQuery', globals);
        const pending = run('MATCH (n) RETURN n');
        if (phase === 'subgraph') {
            requests.shift()({ ok: true, json: async () => ({ rows: [{}] }) });
            for (let i = 0; i < 8; i++) await Promise.resolve();
            assert.equal(requests.length, 1);
        }
        if (change === 'workspace') workspaceLifetime.current = {};
        else run('MATCH (m) RETURN m');
        writes.length = 0;
        requests.shift()({ ok: true, json: async () => phase === 'query' ? { rows: [] } : { nodes: [{ id: 'A' }], links: [] } });
        await pending;
        assert.equal(writes.length, 0);
    });
}

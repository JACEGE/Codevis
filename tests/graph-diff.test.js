/**
 * Tests for the pure graph-diff layer (scripts/diff/graph_diff.cjs).
 *
 * These deliberately build snapshots by hand instead of going through a
 * database: the interesting decisions — what counts as "changed", what a pure
 * line shift means, who lands in the blast radius — are pure logic, and a test
 * that needs two built graphs would be too slow to run on every change.
 */

const test = require('node:test');
const assert = require('node:assert');
const { diffSnapshots, renderText, renderMermaid, impactChangedNodes } = require('../scripts/diff/graph_diff.cjs');
const { nodeKey } = require('../scripts/diff/graph_snapshot.cjs');

/** Build a snapshot from terse literals. */
function snap(nodes, edges = []) {
    return {
        nodes: new Map(nodes.map((n) => [n.key, n])),
        edges: new Map(edges.map((e) => [e.key, e])),
    };
}

const fn = (name, file, extra = {}) => ({
    key: `Function|${name}|${file}`,
    label: 'Function',
    name,
    file,
    startLine: 1,
    endLine: 10,
    signature: `${name}()`,
    bodySnippet: `body of ${name}`,
    ...extra,
});

const edge = (from, to, relType = 'CALLS') => ({
    key: `${from} -[${relType}]-> ${to}`,
    relType,
    from,
    to,
});

test('diffSnapshots — added, removed and unchanged nodes', () => {
    const base = snap([fn('a', 'src/a.js'), fn('gone', 'src/a.js')]);
    const head = snap([fn('a', 'src/a.js'), fn('fresh', 'src/b.js')]);

    const d = diffSnapshots(base, head);

    assert.deepStrictEqual(d.nodes.added.map((n) => n.name), ['fresh']);
    assert.deepStrictEqual(d.nodes.removed.map((n) => n.name), ['gone']);
    assert.strictEqual(d.nodes.changed.length, 0, 'identical node must not be reported');
    assert.strictEqual(d.stats.nodesAdded, 1);
    assert.strictEqual(d.stats.nodesRemoved, 1);
});

test('diffSnapshots — a pure line shift is not a change', () => {
    // Something was inserted above `a`: it moved 40 lines down but is identical.
    const base = snap([fn('a', 'src/a.js', { startLine: 1, endLine: 10 })]);
    const head = snap([fn('a', 'src/a.js', { startLine: 41, endLine: 50 })]);

    const d = diffSnapshots(base, head);

    assert.strictEqual(d.nodes.changed.length, 0);
    assert.strictEqual(d.stats.nodesChanged, 0);
});

test('diffSnapshots — body, signature and span changes are detected', () => {
    const base = snap([
        fn('body', 'src/a.js'),
        fn('sig', 'src/a.js'),
        fn('grew', 'src/a.js', { startLine: 1, endLine: 10 }),
    ]);
    const head = snap([
        fn('body', 'src/a.js', { bodySnippet: 'something else entirely' }),
        fn('sig', 'src/a.js', { signature: 'sig(extraArg)' }),
        // Same snippet (only the first 120 chars are stored) but 30 lines longer.
        fn('grew', 'src/a.js', { startLine: 1, endLine: 40 }),
    ]);

    const d = diffSnapshots(base, head);
    const byName = Object.fromEntries(d.nodes.changed.map((n) => [n.name, n.changedFields]));

    assert.deepStrictEqual(byName.body, ['bodySnippet']);
    assert.deepStrictEqual(byName.sig, ['signature']);
    assert.deepStrictEqual(byName.grew, ['span'], 'a body that only grew must still be flagged');
});

test('diffSnapshots — edges are compared independently of the nodes', () => {
    const a = fn('a', 'src/a.js');
    const b = fn('b', 'src/b.js');
    const base = snap([a, b], [edge(a.key, b.key)]);
    const head = snap([a, b], [edge(b.key, a.key)]);

    const d = diffSnapshots(base, head);

    assert.strictEqual(d.edges.added.length, 1);
    assert.strictEqual(d.edges.removed.length, 1);
    assert.strictEqual(d.edges.added[0].from, b.key, 'direction is part of the identity');
});

test('blastRadius — unchanged code with changed wiring is reported, changed code is not', () => {
    const caller = fn('untouchedCaller', 'src/caller.js');   // unchanged
    const helper = fn('newHelper', 'src/helper.js');         // added

    const base = snap([caller]);
    const head = snap([caller, helper], [edge(caller.key, helper.key)]);

    const d = diffSnapshots(base, head);
    const names = d.blastRadius.map((b) => b.name);

    assert.ok(names.includes('untouchedCaller'), 'the untouched caller is exactly the point of this');
    assert.ok(!names.includes('newHelper'), 'a node that changed itself is not collateral');

    const reason = d.blastRadius.find((b) => b.name === 'untouchedCaller').reasons[0];
    assert.strictEqual(reason.kind, 'gained-outgoing');
    assert.strictEqual(reason.relType, 'CALLS');
});

test('blastRadius — a lost caller is surfaced too', () => {
    const caller = fn('stillHere', 'src/caller.js');
    const dropped = fn('deleted', 'src/gone.js');

    const base = snap([caller, dropped], [edge(caller.key, dropped.key)]);
    const head = snap([caller]);

    const d = diffSnapshots(base, head);
    const entry = d.blastRadius.find((b) => b.name === 'stillHere');

    assert.ok(entry, 'losing an outgoing edge is as interesting as gaining one');
    assert.strictEqual(entry.reasons[0].kind, 'lost-outgoing');
});

test('diffFiles — new files are not also counted as touched', () => {
    const base = snap([]);
    const head = snap([
        { key: 'File|src/new.js|src/new.js', label: 'File', name: 'src/new.js', path: 'src/new.js', file: null },
        fn('inNewFile', 'src/new.js'),
    ]);

    const d = diffSnapshots(base, head);

    assert.deepStrictEqual(d.files.added, ['src/new.js']);
    assert.deepStrictEqual(d.files.touched, [], 'a brand-new file is added, not modified');
});

test('renderText — never lets a cap look like completeness', () => {
    const many = Array.from({ length: 40 }, (_, i) => fn(`f${i}`, 'src/a.js'));
    const d = diffSnapshots(snap([]), snap(many));

    const text = renderText(d, { limit: 5 });

    assert.match(text, /Added nodes \(40\)/);
    assert.match(text, /\.\.\. 35 more/);
});

test('nodeKey — an Effect keeps its identity across two builds', () => {
    // The builder names hooks `{hookType}_{uid[0..3]}`, and the uid comes from a
    // per-database sequence counter — so the SAME useEffect gets a different
    // name in every build. Without normalisation every hook in the codebase
    // showed up as removed-and-added in a diff that touched none of them.
    const inBuildA = { label: 'Effect', name: 'useEffect_676d', file: 'src/App.jsx' };
    const inBuildB = { label: 'Effect', name: 'useEffect_a91c', file: 'src/App.jsx' };

    assert.strictEqual(nodeKey(inBuildA), nodeKey(inBuildB));
    assert.match(nodeKey(inBuildA), /^Effect\|useEffect\|src\/App\.jsx$/);
});

test('nodeKey — an Effect with no name at all falls back to its hook type', () => {
    // The naming pass runs late in a build and may not have completed. Such a
    // node must still be comparable, otherwise the next diff reports every hook
    // in the file as deleted.
    const unnamed = { label: 'Effect', name: null, hookType: 'useMemo', file: 'src/App.jsx' };

    assert.strictEqual(nodeKey(unnamed), 'Effect|useMemo|src/App.jsx');
});

test('nodeKey — normalisation does not touch other labels', () => {
    const fn = { label: 'Function', name: 'useEffect_676d', file: 'src/a.js' };

    assert.strictEqual(nodeKey(fn), 'Function|useEffect_676d|src/a.js');
});

test('nodeKey — structural nodes without name use their stable semantic identity', () => {
    assert.strictEqual(
        nodeKey({ label: 'ImportedSymbol', name: null, localName: 'readFile', file: 'src/a.js' }),
        'ImportedSymbol|readFile|src/a.js',
    );
    assert.strictEqual(
        nodeKey({ label: 'ExportedSymbol', name: null, publicName: 'run', file: 'src/a.js' }),
        'ExportedSymbol|run|src/a.js',
    );
    assert.strictEqual(
        nodeKey({ label: 'Endpoint', name: null, url: '/health', file: '' }),
        'Endpoint|/health|',
    );
    assert.strictEqual(
        nodeKey({ label: 'ASTNode', name: null, elementId: 'StringLiteral:3:2', file: 'src/a.js' }),
        'ASTNode|StringLiteral:3:2|src/a.js',
    );
});

test('renderMermaid — draws isolated changes and marks node states', () => {
    const lonely = fn('rewritten', 'src/a.js');
    const base = snap([lonely]);
    const head = snap([fn('rewritten', 'src/a.js', { bodySnippet: 'new body' })]);

    const mermaid = renderMermaid(diffSnapshots(base, head));

    assert.match(mermaid, /^graph LR/);
    assert.match(mermaid, /rewritten/, 'a change with no edges must still appear');
    assert.match(mermaid, /classDef changed/);
});

test('changed symbols feed the shared explainable impact traversal', () => {
    const target = fn('save', 'src/save.js');
    const caller = fn('controller', 'src/api.js');
    const call = edge(caller.key, target.key);
    const base = snap([target, caller], [call]);
    const head = snap([fn('save', 'src/save.js', { bodySnippet: 'changed body' }), caller], [call]);

    const diff = diffSnapshots(base, head);
    assert.equal(diff.changeImpact.seeds.length, 1);
    assert.equal(diff.changeImpact.seeds[0].seed.name, 'save');
    assert.deepStrictEqual(diff.changeImpact.seeds[0].impacted.map((node) => node.name), ['controller']);
    assert.match(renderText(diff), /Dependency impact/);
    assert.match(renderText(diff), /controller/);
});

test('removed symbols use the base graph and seed caps are explicit', () => {
    const gone = fn('gone', 'src/gone.js');
    const caller = fn('caller', 'src/caller.js');
    const base = snap([gone, caller], [edge(caller.key, gone.key)]);
    const head = snap([caller]);
    const raw = { nodes: { added: [], changed: [], removed: [gone] } };

    const impact = impactChangedNodes(base, head, raw, { maxSeeds: 0 });
    assert.equal(impact.truncation.truncated, true);
    assert.equal(impact.truncation.omittedSeeds, 1);
});

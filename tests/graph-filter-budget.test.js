const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { transformSync } = require('esbuild');
const frontendRequire = createRequire(path.resolve(__dirname, '../frontend/package.json'));
const React = frontendRequire('react');
const { renderToStaticMarkup } = frontendRequire('react-dom/server');
const { JSDOM } = frontendRequire('jsdom');

// Exercise the real expanded component, its callbacks and native range stepping.
// Only local open/closed state is fixed; no budget/visibility logic is mocked.
function load(filename) {
    const mod = { exports: {} };
    vm.runInNewContext(transformSync(fs.readFileSync(filename, 'utf8'), {
        loader: 'jsx', format: 'cjs', jsx: 'automatic',
    }).code, { module: mod, exports: mod.exports, require: name => {
        if (name === 'react') return { ...React, useState: () => [true, () => {}], useMemo: fn => fn(), useRef: () => ({ current: null }), useEffect: () => {} };
        if (!name.startsWith('.')) return frontendRequire(name);
        const base = path.resolve(path.dirname(filename), name);
        return load([base, `${base}.js`, `${base}.jsx`].find(fs.existsSync));
    } });
    return mod.exports;
}
const GraphFilter = load(path.resolve(__dirname, '../frontend/src/components/GraphFilter.jsx')).default;
function elements(tree) {
    if (!tree || typeof tree !== 'object') return [];
    if (Array.isArray(tree)) return tree.flatMap(elements);
    return [tree, ...elements(tree.props?.children)];
}
function view(props) {
    const tree = GraphFilter(props);
    const dom = new JSDOM(renderToStaticMarkup(tree));
    return { dom, all: elements(tree), range: dom.window.document.querySelector('input[type=range]') };
}

for (const loadable of [0, 1, 9, 11, 499, 500, 501, 2171]) {
    test(`all-budget shows the actual ${loadable} nodes and its exact reachable endpoint`, () => {
        const {dom, range} = view({loadable, budget: 0});
        try {
            assert.equal(range.previousElementSibling.textContent, `Node Budgetall ${loadable}`);
            assert.equal(Number(range.max), loadable);
            assert.equal(range.disabled, loadable === 0);
            if (loadable > 0) {
                assert.equal(range.min, '1');
                range.value = '1'; range.stepUp(loadable + 1);
                assert.equal(Number(range.value), loadable);
            }
        } finally { dom.window.close(); }
    });
}
test('small budgets remain representable and selecting the endpoint clears the cap', () => {
    const changes = [];
    const {dom, all, range} = view({loadable: 2171, budget: 1, onBudgetChange: n => changes.push(n)});
    try {
        assert.equal(range.value, '1');
        const input = all.find(e => e.type === 'input' && e.props.type === 'range');
        input.props.onChange({target: {value: '9'}});
        input.props.onChange({target: {value: '2171'}});
        assert.deepEqual(changes, [9, 0]);
    } finally { dom.window.close(); }
});
test('explicit All clears a finite cap even when the current graph fits already', () => {
    const changes = [];
    const {dom, all} = view({loadable: 1, budget: 500, onBudgetChange: n => changes.push(n)});
    try {
        const button = all.find(e => e.type === 'button' && e.props['aria-label'] === 'Load all nodes');
        assert.ok(button);
        button.props.onClick();
        assert.deepEqual(changes, [0]);
    } finally { dom.window.close(); }
});
test('select all/none changes only the listed types, preserving hidden types at other levels', () => {
    let changed;
    const {dom, all} = view({loadable: 3, budget: 0, typeCounts: {File: 3}, levelLabels: ['File'],
        visible: {File: true, ASTNode: false}, onVisibleChange: value => { changed = value; }});
    try {
        const input = all.filter(e => e.type === 'input' && e.props.type === 'checkbox')[1];
        input.props.onChange();
        assert.equal(changed.File, false);
        assert.equal(changed.ASTNode, false);
    } finally { dom.window.close(); }
});

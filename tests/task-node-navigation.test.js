const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { createRequire } = require('node:module');
const { runInNewContext } = require('node:vm');
const { transformSync } = require('esbuild');
const frontendRequire = createRequire(resolve(__dirname, '../frontend/package.json'));
const mod = { exports: {} };
runInNewContext(transformSync(readFileSync(resolve(__dirname, '../frontend/src/components/TaskDetailDialog.jsx'), 'utf8'), {
    loader: 'jsx', format: 'cjs', jsx: 'automatic',
}).code, {module: mod, exports: mod.exports,
    require: name => name === './ScopeModeControl' ? (() => null) : frontendRequire(name)});

function buttons(element) {
    if (!element || typeof element !== 'object') return [];
    if (Array.isArray(element)) return element.flatMap(buttons);
    const found = element.type === 'button' && element.props['aria-label']?.startsWith('Show ') ? [element] : [];
    return [...found, ...buttons(element.props?.children)];
}
function setup(overrides = {}) {
    const calls = [];
    const props = {
        selectedTask: 'task-A', taskDetail: {taskId: 'task-A', comments: [], affectedNodes: [
            {id: 'Function||file=src/a.js||name=run', name: 'run', label: 'Function'},
            {id: 'File||path=src/run & #1.js', name: 'run', label: 'File'},
        ]}, styles: {}, PRIORITY_BADGE: {}, newComment: '', editingId: null,
        onShowNode: (id, hops) => calls.push(['show', id, hops]),
        closeDetail: () => calls.push(['close']), ...overrides,
    };
    return {calls, buttons: buttons(mod.exports.default(props))};
}

test('task target click uses exact string identity, not a shared name, and closes the dialog', () => {
    const view = setup();
    assert.equal(view.buttons.length, 2);
    assert.equal(view.buttons[1].props.disabled, false);
    view.buttons[1].props.onClick();
    assert.deepEqual(view.calls, [['show', 'File||path=src/run & #1.js', 1], ['close']]);
});
for (const draft of [{editingTask: true}, {newComment: 'Unsent note'}, {editingId: 'comment-A'}]) {
    test(`node navigation preserves drafts: ${JSON.stringify(draft)}`, () => {
        const view = setup(draft);
        assert.equal(view.buttons[0].props.disabled, true);
        view.buttons[0].props.onClick();
        assert.deepEqual(view.calls, []);
    });
}
test('node without an exact identity is not resolved using its name or ipv6', () => {
    const view = setup({taskDetail: {affectedNodes: [{name: 'run', ipv6: 'fd00::1'}], comments: []}});
    assert.equal(view.buttons[0].props.disabled, true);
    view.buttons[0].props.onClick();
    assert.deepEqual(view.calls, []);
});
test('standalone board without a graph handler does not offer a nonworking link', () => {
    assert.equal(setup({onShowNode: undefined}).buttons[0].props.disabled, true);
});

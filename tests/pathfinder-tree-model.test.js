const test = require('node:test');
const assert = require('node:assert/strict');

const tree = {
    id: 'root', name: 'Root', file: 'root.js', children: [{
        id: 'left', name: 'Left', file: 'left.js', children: [{
            id: 'leaf', name: 'Leaf', file: 'leaf.js', children: [],
        }],
    }, {
        id: 'right', name: 'Right', file: 'right.js', children: [],
    }],
};

test('findInTree locates nested nodes and handles missing input', async () => {
    const { findInTree } = await import('../frontend/src/pathfinder/treeModel.js');
    assert.equal(findInTree(tree, 'leaf')?.name, 'Leaf');
    assert.equal(findInTree(tree, 'missing'), null);
    assert.equal(findInTree(null, 'root'), null);
});

test('sequential debug sequence follows depth-first order', async () => {
    const { buildDebugSequence } = await import('../frontend/src/pathfinder/treeModel.js');
    const sequence = buildDebugSequence(tree, true);
    assert.deepEqual(sequence.map((step) => step.debugNode), ['root', 'left', 'leaf', 'right']);
    assert.deepEqual(sequence[2].debugPath, ['root', 'left', 'leaf']);
    assert.deepEqual(sequence[2].debugEdges, ['root->left', 'left->leaf']);
});

test('parallel debug sequence accumulates breadth-first levels', async () => {
    const { buildDebugSequence } = await import('../frontend/src/pathfinder/treeModel.js');
    const sequence = buildDebugSequence(tree, false);
    assert.equal(sequence.length, 3);
    assert.deepEqual(sequence[1].debugPath, ['root', 'left', 'right']);
    assert.deepEqual(sequence[1].debugBranches, ['leaf']);
    assert.deepEqual(sequence[2].debugEdges, ['root->left', 'root->right', 'left->leaf']);
});

test('incoming traversal highlights the real caller-to-callee edge direction', async () => {
    const { buildDebugSequence } = await import('../frontend/src/pathfinder/treeModel.js');
    const tree = { id: 'callee', children: [{ id: 'caller', children: [] }] };
    const sequence = buildDebugSequence(tree, true, 'in');
    assert.deepStrictEqual(sequence[1].debugEdges, ['caller->callee']);
});

test('debug sequence is empty without a tree', async () => {
    const { buildDebugSequence } = await import('../frontend/src/pathfinder/treeModel.js');
    assert.deepEqual(buildDebugSequence(null, true), []);
});

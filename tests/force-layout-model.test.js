const test = require('node:test');
const assert = require('node:assert/strict');

test('force parameters preserve the density and dimension heuristics', async () => {
  const { forceParameters } = await import('../frontend/src/graph/forceLayoutModel.js');
  assert.deepEqual(forceParameters(100, '2d', 6), {
    charge: -320,
    distance: 79,
    collideRadius: 14.399999999999999,
    dimensions: 2,
  });
  assert.equal(forceParameters(5000, '3d', 6).charge, -1420);
  assert.equal(forceParameters(5000, '3d', 6).distance, 230);
});

test('camera reset requires a significant node-count change', async () => {
  const { shouldResetCamera } = await import('../frontend/src/graph/forceLayoutModel.js');
  assert.equal(shouldResetCamera(-1, 10), true);
  assert.equal(shouldResetCamera(100, 125), false);
  assert.equal(shouldResetCamera(100, 126), true);
});

test('camera frame uses the centroid and mean distance with a minimum distance', async () => {
  const { cameraFrame } = await import('../frontend/src/graph/forceLayoutModel.js');
  const nodes = new Map([
    ['a', { x: -10, y: 0, z: 2 }],
    ['b', { x: 10, y: 0, z: 2 }],
  ]);
  assert.deepEqual(cameraFrame(nodes, new Set(['a', 'b'])), {
    x: 0, y: 0, z: 2, distance: 300,
  });
  assert.equal(cameraFrame(nodes, new Set(['missing'])), null);
});

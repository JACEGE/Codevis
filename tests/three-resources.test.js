const test = require('node:test');
const assert = require('node:assert/strict');

test('disposeResourceMap releases every disposable cached resource', async () => {
  const { disposeResourceMap } = await import('../frontend/src/graph/threeResources.js');
  const disposed = [];
  disposeResourceMap({
    geometry: { dispose: () => disposed.push('geometry') },
    material: { dispose: () => disposed.push('material') },
    absent: null,
  });
  assert.deepEqual(disposed, ['geometry', 'material']);
});

test('disposeResourceMap accepts an empty cache', async () => {
  const { disposeResourceMap } = await import('../frontend/src/graph/threeResources.js');
  assert.doesNotThrow(() => disposeResourceMap(undefined));
});

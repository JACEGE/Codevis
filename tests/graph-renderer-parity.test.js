const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

test('2D and 3D renderers use the same theme-aware canvas and active layout hook', () => {
  const scene = fs.readFileSync(path.join(root, 'frontend/src/components/GraphScene.jsx'), 'utf8');
  assert.match(scene, /const activeGraphRef = viewMode === '2d' \? fg2dRef : fgRef/);
  assert.match(scene, /useForceLayout\(\{ graphRef: activeGraphRef/);
  assert.match(scene, /const graphBackground = darkTheme \? '#0d1426' : '#edf2f8'/);
  assert.match(scene, /<ForceGraph2D[\s\S]*?backgroundColor=\{graphBackground\}/);
  assert.match(scene, /<ForceGraph3D[\s\S]*?backgroundColor=\{graphBackground\}/);
});

test('2D layout fits the visible graph instead of only recentering it', () => {
  const layout = fs.readFileSync(path.join(root, 'frontend/src/hooks/useForceLayout.js'), 'utf8');
  assert.match(layout, /viewMode === '2d' && forceGraph\.zoomToFit/);
  assert.match(layout, /forceGraph\.zoomToFit\(700, 36/);
});

test('2D labels and outlines are dark-canvas compatible', () => {
  const scene = fs.readFileSync(path.join(root, 'frontend/src/components/GraphScene.jsx'), 'utf8');
  assert.match(scene, /darkTheme \? 'rgba\(17,24,42,0\.92\)' : 'rgba\(255,255,255,0\.92\)'/);
  assert.match(scene, /darkTheme \? '#e7edf8' : '#182234'/);
});

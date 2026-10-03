const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

test('2D and 3D renderers use the same theme-aware canvas and active layout hook', () => {
  const scene = fs.readFileSync(path.join(root, 'frontend/src/components/GraphScene.jsx'), 'utf8');
  assert.match(scene, /const activeGraphRef = viewMode === '2d' \? fg2dRef : fgRef/);
  assert.match(scene, /useForceLayout\(\{ graphRef: activeGraphRef/);
  assert.match(scene, /const colors = themeTokens\(theme\)/);
  assert.match(scene, /const graphBackground = colors\['graph-bg'\]/);
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
  assert.match(scene, /ctx.fillStyle = colors\['graph-label-bg'\]/);
  assert.match(scene, /ctx.fillStyle = colors.text/);
  assert.match(scene, /makeTextSprite\(node.name, colors.text\)/);
});

test('mini graphs and lock overlays follow the same semantic theme as their labels', () => {
  for (const file of ['BrainTab.jsx', 'SpecTab.jsx']) {
    const source = fs.readFileSync(path.join(root, 'frontend/src/components', file), 'utf8');
    assert.match(source, /const colors = themeTokens\(theme\)/);
    assert.match(source, /ctx.fillStyle = colors.text/);
    assert.match(source, /backgroundColor=\{colors\['graph-bg'\]\}/);
    assert.doesNotMatch(source, /ctx\.(?:fillStyle|strokeStyle) = ['"]var\(/);
  }
  const scene = fs.readFileSync(path.join(root, 'frontend/src/components/GraphScene.jsx'), 'utf8');
  const legend = fs.readFileSync(path.join(root, 'frontend/src/components/GraphLegend.jsx'), 'utf8');
  for (const role of ['danger', 'success', 'violet', 'warning', 'info']) {
    assert.ok(scene.includes(`return colors.${role}`), `${role} in canvas`);
    assert.ok(legend.includes(`var(--${role})`), `${role} in legend`);
  }
});

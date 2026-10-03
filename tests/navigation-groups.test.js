const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

test('dashboard navigation exposes a grouped semantic nav with an active page', () => {
  const chrome = fs.readFileSync(path.join(root, 'frontend/src/components/AppTabBar.jsx'), 'utf8');
  assert.match(chrome, /<nav[^>]+aria-label="Dashboard views"/);
  assert.match(chrome, /aria-current=\{active \? 'page'/);
  assert.match(chrome, /app-nav-group-label/);
  assert.match(chrome, /data-group=\{group\.toLowerCase\(\)\}/);
  assert.match(chrome, /className="theme-toggle"/);
});

test('tab registry uses the four product groups and avoids mixed emoji labels', () => {
  const app = fs.readFileSync(path.join(root, 'frontend/src/App.jsx'), 'utf8');
  for (const group of ['Work', 'Analyze', 'Model', 'System']) {
    assert.match(app, new RegExp(`group: '${group}'`));
  }
  assert.doesNotMatch(app.slice(app.indexOf('const TABS = ['), app.indexOf('];', app.indexOf('const TABS = ['))), /[📋🧩🔍🧭🔭🧠📐🤖📚📖⚙]/u);
});

test('workspace header is one always-visible row whose sections open their views on hover', () => {
  const header = fs.readFileSync(path.join(root, 'frontend/src/components/WorkspaceHeader.jsx'), 'utf8');
  const bar = fs.readFileSync(path.join(root, 'frontend/src/components/AppTabBar.jsx'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'frontend/src/demo-theme.css'), 'utf8');
  assert.match(header, /<AppSectionMenus nav=\{nav\} activeTab=\{activeTab\} \/>/);
  // Nothing hides the header any more: no collapse state, no Full-view auto-hide.
  assert.doesNotMatch(header, /collapsed|autohide|revealed/i);
  assert.doesNotMatch(css, /workspace-header--autohide/);
  assert.match(bar, /className="app-nav-current">› \{nav\.current\.label\}/, 'the active section names the current view');
  assert.match(css, /\.app-nav-menu:hover \.app-nav-dropdown, \.app-nav-menu:focus-within \.app-nav-dropdown \{ display:block; \}/, 'hover or keyboard focus opens a section');
});

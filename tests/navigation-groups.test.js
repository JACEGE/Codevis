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

test('workspace header is two rows, collapsible with Ctrl+. and auto-hides in Full view', () => {
  const header = fs.readFileSync(path.join(root, 'frontend/src/components/WorkspaceHeader.jsx'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'frontend/src/demo-theme.css'), 'utf8');
  assert.match(header, /<AppSections nav=\{nav\} compact \/>/, 'sections share the top row, subtitles as tooltips');
  assert.match(header, /<AppViewTabs[^>]+compact \/>/, 'view description moves into the tooltip');
  assert.match(header, /codevis\.header\.collapsed/, 'collapsed state is remembered');
  assert.match(header, /event\.key === '\.'/, 'Ctrl+. toggles');
  assert.match(header, /className="workspace-breadcrumb"/, 'collapsed row shows a breadcrumb');
  assert.match(header, /layout === 'panel'/, 'Full view auto-hides the header');
  assert.match(css, /\.workspace-header--autohide:has\(:focus-visible\)/, 'keyboard focus reveals it; a mouse click does not pin it open');
});

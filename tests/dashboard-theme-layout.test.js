const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('Kanban Done lane participates in the board grid and uses theme surfaces', () => {
  const board = read('frontend/src/components/KanbanBoard.jsx');
  const done = read('frontend/src/components/KanbanDoneColumn.jsx');
  assert.match(board, /<div style=\{styles\.board\}>[\s\S]*<KanbanDoneColumn[\s\S]*<\/div>/);
  assert.match(done, /gridColumn: '1 \/ -1'/);
  assert.match(done, /backgroundColor: dragOver \? 'var\(--surface-hover\)' : 'var\(--surface\)'/);
});

test('stacked dashboard gives the Kanban row a usable bounded height', () => {
  const css = read('frontend/src/demo-theme.css');
  assert.match(css, /grid-template-rows: auto minmax\(340px, 45dvh\) minmax\(420px, 60dvh\) minmax\(180px, 25dvh\) 32px !important/);
});

test('Class diagram follows the application theme and offers bounded zoom', () => {
  const classes = read('frontend/src/components/ClassDiagramTab.jsx');
  assert.match(classes, /theme === 'dark' \? 'dark' : 'default'/);
  assert.match(classes, /Math\.max\(75, value - 25\)/);
  assert.match(classes, /Math\.min\(400, value \+ 25\)/);
  assert.match(classes, /width: `\$\{diagramZoom\}%`/);
});

test('graph overlays inherit theme surfaces instead of hard-coded dark panels', () => {
  const filter = read('frontend/src/components/GraphFilter.jsx');
  const legend = read('frontend/src/components/GraphLegend.jsx');
  assert.doesNotMatch(filter, /background: 'rgba\(17,24,42/);
  assert.doesNotMatch(legend, /background: 'rgba\(17,24,42/);
});

test('an empty type filter keeps its recovery controls visible', () => {
  const filter = read('frontend/src/components/GraphFilter.jsx');
  const panel = read('frontend/src/components/GraphPanel.jsx');
  assert.match(filter, /zIndex: 120/);
  const empty = read('frontend/src/components/GraphEmptyState.jsx');
  assert.match(empty, /All graph nodes are filtered out/);
  assert.match(empty, /Show all node types/);
  assert.match(panel, /onTypeVisibilityChange\?\.\(\{\}\)/);
});

test('the Inspector can expand a file source preview to the complete file', () => {
  const inspector = read('frontend/src/components/InspectorSidebar.jsx');
  const bridge = read('server/bridge.js');
  assert.match(inspector, /Show complete file/);
  assert.match(inspector, /&full=1/);
  assert.match(bridge, /fullFile \? lines\.length : Math\.min\(lines\.length, 60\)/);
});

test('Settings distinguishes current build config from existing graph data and lists its inventory', () => {
  const settings = read('frontend/src/components/SettingsPanel.jsx');
  const sidePanel = read('frontend/src/components/DashboardSidePanel.jsx');
  const bridge = read('server/bridge.js');
  assert.match(settings, /No source directories are configured for the next build/);
  assert.match(settings, /existing database still contains/);
  assert.match(settings, /Graph Inventory/);
  assert.match(settings, /Object\.entries\(typeCounts\)/);
  assert.match(settings, /Work Mode/);
  assert.match(settings, /builds and watchers are disabled/);
  assert.match(sidePanel, /typeCounts=\{typeCounts\}/);
  assert.match(bridge, /workMode:/);
});

test('node budget keeps typing separate from an explicit apply action', () => {
  const settings = read('frontend/src/components/SettingsPanel.jsx');
  assert.match(settings, /budgetDirty/);
  assert.match(settings, /budgetDirty \? 'Apply' : scopeError \? 'Not applied' : 'Applied'/);
  assert.match(settings, /Press Enter or Apply/);
  assert.doesNotMatch(settings, /onBlur=\{applyBudgetDraft\}/);
});

test('Inspector relationship clicks highlight their directed graph edge', () => {
  const inspector = read('frontend/src/components/InspectorSidebar.jsx');
  const app = read('frontend/src/App.jsx');
  assert.match(inspector, /onSelectRelationship\?\.\(\{/);
  assert.match(inspector, /source: incoming \? entry\.other\.id : debugNode/);
  assert.match(app, /replaceActiveLinks\(\[linkKey\]\)/);
  assert.match(app, /uids: \[source, target\].*expand: 0/);
});

test('Documentation is split into navigable collapsed chapters', () => {
  const docs = read('frontend/src/components/DocumentationPanel.jsx');
  assert.match(docs, /splitDocumentation/);
  assert.match(docs, /<details className="codevis-docs-section"/);
  assert.match(docs, /<summary id=\{section\.id\}>/);
  assert.match(docs, /disclosure\.open = true/);
});

test('bridge startup is neutral until Socket.IO reports a real failure', () => {
  const app = read('frontend/src/App.jsx');
  const graph = read('frontend/src/components/GraphEmptyState.jsx');
  assert.match(app, /useState\(null\)/);
  assert.doesNotMatch(app, /transports:\s*\['websocket'\]/);
  assert.match(app, /socket\.on\('connect_error'/);
  assert.match(graph, /Connecting…/);
});

test('Spec overlay uses its existing region counts without dumping raw JSON', () => {
  const spec = read('frontend/src/components/SpecTab.jsx');
  assert.doesNotMatch(spec, /JSON\.stringify\(summary\)/);
  assert.match(spec, /minWidth: 0/);
  assert.match(spec, /overflowWrap: 'anywhere'/);
});

test('Settings surfaces database identity and legacy storage state', () => {
  const settings = read('frontend/src/components/SettingsPanel.jsx');
  assert.match(settings, /Database Identity/);
  assert.match(settings, /databaseIdentity\?\.mismatch/);
  assert.match(settings, /usingLegacyDataDir/);
});

test('Settings refreshes process-level status after a bridge reconnect', () => {
  const app = read('frontend/src/App.jsx');
  const sidePanel = read('frontend/src/components/DashboardSidePanel.jsx');
  const settings = read('frontend/src/components/SettingsPanel.jsx');
  assert.match(app, /<DashboardSidePanel[\s\S]*connected=\{connected\}/);
  assert.match(sidePanel, /<SettingsPanel[\s\S]*connected=\{connected\}/);
  assert.match(settings, /\[activeDb, connected\]/);
});

test('dashboard reuses the App Socket.IO connection for Kanban and status', () => {
  const app = read('frontend/src/App.jsx');
  const sidePanel = read('frontend/src/components/DashboardSidePanel.jsx');
  const kanban = read('frontend/src/components/KanbanBoard.jsx');
  const realtime = read('frontend/src/hooks/useKanbanRealtime.js');
  const status = read('frontend/src/components/StatusBar.jsx');
  assert.match(app, /<StatusBar[^>]+socket=\{socket\}[^>]+connected=\{connected\}/);
  assert.match(sidePanel, /<KanbanBoard[^>]+socket=\{socket\}/);
  assert.match(kanban, /useKanbanRealtime\(\{[\s\S]*socket,/);
  assert.doesNotMatch(realtime, /socket\.io-client|\bio\(BRIDGE_URL/);
  assert.doesNotMatch(status, /socket\.io-client|\bio\(BRIDGE_URL/);
});

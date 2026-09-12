const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const bridge = fs.readFileSync(path.join(root, 'server', 'bridge.js'), 'utf8');
const dashboard = fs.readFileSync(path.join(root, 'lib', 'commands', 'dashboard.mjs'), 'utf8');
const terminalPanel = fs.readFileSync(path.join(root, 'frontend', 'src', 'components', 'TerminalPanel.jsx'), 'utf8');

test('browser shell is per-process opt-in and disabled by default', () => {
  assert.match(dashboard, /CODEVIS_WEB_SHELL\s*=\s*args\.includes\("--web-shell"\)\s*\?\s*"1"\s*:\s*"0"/);
  assert.match(bridge, /if \(WEB_SHELL_ENABLED\) setupTerminalWebSocket\(httpServer\)/);
});

test('dashboard bridge binds only to IPv4 loopback', () => {
  assert.match(bridge, /const BRIDGE_HOST = '127\.0\.0\.1'/);
  assert.match(bridge, /httpServer\.listen\(PORT, BRIDGE_HOST,/);
});

test('enabled browser shell rejects non-local browser origins', () => {
  assert.match(bridge, /if \(!isAllowedBrowserOrigin\(origin\)\)/);
  assert.match(bridge, /HTTP\/1\.1 403 Forbidden/);
});

test('HTTP and Socket.IO CORS accept only local browser origins', () => {
  assert.match(bridge, /require\('\.\/browser-origin.cjs'\)/);
  assert.match(bridge, /app\.use\(requireLocalOrigin\)/);
  assert.match(bridge, /allowRequest: allowLocalSocketRequest/);
  assert.match(bridge, /app\.use\(cors\(localCors\)\)/);
  assert.match(bridge, /origin: localCors\.origin/);
  assert.doesNotMatch(bridge, /origin:\s*['"]\*['"]/);
});

test('status exposes the shell gate and the frontend stays idle while disabled', () => {
  assert.match(bridge, /webShellEnabled: WEB_SHELL_ENABLED/);
  assert.match(terminalPanel, /if \(!bridgeStatus\.webShellEnabled\)/);
  assert.match(terminalPanel, /codevis dashboard --web-shell/);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { transformSync } = require('esbuild');

const source = fs.readFileSync(path.join(__dirname, '../frontend/src/components/TerminalPanel.jsx'), 'utf8');
const compiled = transformSync(source, {
  loader: 'jsx', format: 'cjs', jsxFactory: 'jsx', supported: { 'dynamic-import': false },
}).code;
const flush = () => new Promise(resolve => setImmediate(resolve));

function mount({ delayStatus = false } = {}) {
  const effects = [], sockets = [], terminals = [], statuses = [], refs = [], timers = new Map();
  let releaseStatus;
  const status = new Promise(resolve => { releaseStatus = () => resolve({ json: async () => ({ webShellEnabled: true }) }); });
  if (!delayStatus) releaseStatus();
  class Terminal {
    constructor() { this.options = {}; terminals.push(this); }
    loadAddon() {} open() {} onData() {} attachCustomKeyEventHandler() {} write() {}
    dispose() { this.disposed = true; }
  }
  class Socket {
    static OPEN = 1;
    constructor() { sockets.push(this); }
    close() { this.closed = true; this.onclose?.(); }
  }
  const module = { exports: {} };
  vm.runInNewContext(compiled, {
    module, exports: module.exports, console, AbortController,
    fetch: () => status, WebSocket: Socket,
    ResizeObserver: class { observe() {} disconnect() {} },
    setTimeout(fn) { const id = Symbol(); timers.set(id, fn); return id; },
    clearTimeout(id) { timers.delete(id); },
    jsx(_type, props) { if (props?.ref) props.ref.current = {}; return null; },
    require(name) {
      if (name === 'react') return {
        useEffect(fn) { effects.push(fn); },
        useRef(value) { const ref = { current: value }; refs.push(ref); return ref; },
        useState(value) { return [value, next => statuses.push(next)]; },
      };
      if (name === '../bridgeUrl') return { default: 'http://127.0.0.1:12345', __esModule: true };
      if (name === '../hooks/useTheme') return { default: () => ['dark'], __esModule: true };
      if (name === '@xterm/xterm') return { Terminal };
      if (name === '@xterm/addon-fit') return { FitAddon: class { fit() {} } };
      if (name === '@xterm/addon-web-links') return { WebLinksAddon: class {} };
      if (name === '@xterm/xterm/css/xterm.css') return {};
      throw new Error(`Unexpected dependency: ${name}`);
    },
  });
  module.exports.default();
  const cleanups = effects.map(fn => fn());
  return { sockets, terminals, statuses, refs, timers, releaseStatus,
    unmount() { cleanups.forEach(cleanup => cleanup?.()); } };
}

test('terminal does not initialize after its status request outlives unmount', async () => {
  const ui = mount({ delayStatus: true });
  ui.unmount();
  ui.releaseStatus();
  await flush();
  assert.equal(ui.terminals.length, 0);
  assert.equal(ui.sockets.length, 0);
  assert.deepEqual(ui.statuses, []);
});

test('closing a terminal on unmount cannot schedule a new shell connection', async () => {
  const ui = mount();
  await flush();
  assert.equal(ui.sockets.length, 1);
  ui.unmount();
  assert.equal(ui.sockets[0].closed, true);
  assert.equal(ui.terminals[0].disposed, true);
  assert.equal(ui.timers.size, 0);
  assert.equal(ui.refs[1].current, null);
  assert.equal(ui.refs[2].current, null);
});

test('a live terminal reconnects but an unmounted terminal cancels pending reconnects', async () => {
  const ui = mount();
  await flush();
  ui.sockets[0].onclose();
  assert.equal(ui.timers.size, 1);
  const reconnect = [...ui.timers.values()][0];
  ui.timers.clear();
  reconnect();
  assert.equal(ui.sockets.length, 2);
  ui.sockets[1].onclose();
  ui.unmount();
  assert.equal(ui.timers.size, 0);
  reconnect();
  assert.equal(ui.sockets.length, 2);
});

const test = require('node:test');
const assert = require('node:assert');
const ui = require('../lib/terminal-ui.cjs');

test('terminal UI respects colour and hyperlink conventions', () => {
  assert.strictEqual(ui.colorEnabled({ isTTY: true }, { NO_COLOR: '' }), false);
  assert.strictEqual(ui.colorEnabled({ isTTY: false }, { FORCE_COLOR: '1' }), true);
  assert.strictEqual(ui.link('http://localhost:4018', undefined, { isTTY: false }, {}), 'http://localhost:4018');
  assert.match(ui.link('http://localhost:4018', undefined, { isTTY: true }, {}), /\u001b\]8;;http:\/\/localhost:4018/);
});

const test = require('node:test');
const assert = require('node:assert/strict');

const { isLockingEnabled, lockingStatus, parseLockingOverride } = require('../lib/locking-config.cjs');

test('locking is opt-in and disabled for missing or false config', () => {
  assert.equal(isLockingEnabled({}, {}), false);
  assert.equal(isLockingEnabled({ locking: { enabled: false } }, {}), false);
  assert.deepEqual(lockingStatus({}, {}), { enabled: false, mode: 'disabled' });
});

test('locking can be enabled in config or overridden per process', () => {
  assert.equal(isLockingEnabled({ locking: { enabled: true } }, {}), true);
  assert.equal(isLockingEnabled({ locking: { enabled: false } }, { CODEVIS_LOCKING: 'on' }), true);
  assert.equal(isLockingEnabled({ locking: { enabled: true } }, { CODEVIS_LOCKING: 'off' }), false);
  assert.equal(parseLockingOverride('enabled'), true);
  assert.equal(parseLockingOverride('disabled'), false);
  assert.equal(parseLockingOverride('unexpected'), null);
});

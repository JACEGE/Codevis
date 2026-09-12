const test = require('node:test');
const assert = require('node:assert');

const ladybug = require('../server/ladybug-driver.cjs');

test('connection failure names the incomplete update and diagnostic commands', () => {
    const original = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    const error = ladybug._daemonConnectionError(original);

    assert.match(error.message, /connection twice \(ECONNRESET\)/);
    assert.match(error.message, /graph update did not complete/i);
    assert.match(error.message, /graph may now be stale/i);
    assert.match(error.message, /codevis info/);
    assert.match(error.message, /daemon\.log/);
    assert.strictEqual(error.cause, original);
    assert.strictEqual(error.code, 'ECONNRESET');
});

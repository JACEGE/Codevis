const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../frontend/src/App.jsx'), 'utf8');

test('App socket lifecycle does not reconnect for trace decay or growth-mode changes', () => {
    assert.match(source, /socket\.on\('trace:event', handleTraceEvent\)/);
    assert.match(source, /applyGraph\(data\)/);
    assert.doesNotMatch(source, /\}, \[traceDecayMs, growthMode\]\);/);
});

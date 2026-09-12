const test = require('node:test');
const assert = require('node:assert/strict');

test('split layout accepts safe stored fractions and rejects edge values', async () => {
    const { parseSplit } = await import('../frontend/src/layout/splitModel.js');
    assert.equal(parseSplit('0.65'), 0.65);
    assert.equal(parseSplit('0.05'), 0.5);
    assert.equal(parseSplit('not-a-number', 0.4), 0.4);
});

test('split layout clamps pointer and keyboard changes', async () => {
    const { clampSplit } = await import('../frontend/src/layout/splitModel.js');
    assert.equal(clampSplit(-1), 0.1);
    assert.equal(clampSplit(0.6), 0.6);
    assert.equal(clampSplit(3), 0.9);
});

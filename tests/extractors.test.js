/**
 * Tests for optional-extractor resolution (scripts/extractors.cjs).
 *
 * The rules that matter here are the ones a wrong answer makes invisible: a
 * config that never mentions an extractor must keep the old behaviour, a
 * per-workspace setting must win over the project-wide one, and a misspelled
 * name must be reported rather than silently doing nothing.
 */

const test = require('node:test');
const assert = require('node:assert');
const { resolveExtractors, reportExtractors, OPTIONAL_EXTRACTORS } = require('../scripts/extractors.cjs');

test('a config without extractors keeps every default', () => {
    const { enabled, unknown } = resolveExtractors({ workspaces: { meta: {} } }, 'meta');

    assert.strictEqual(enabled.ros, OPTIONAL_EXTRACTORS.ros.default);
    assert.deepStrictEqual(unknown, []);
});

test('ros defaults to on — an upgrade must not remove data from an existing graph', () => {
    assert.strictEqual(OPTIONAL_EXTRACTORS.ros.default, true);
    assert.strictEqual(resolveExtractors({}).enabled.ros, true);
});

test('a project-wide setting applies to every workspace', () => {
    const config = { extractors: { ros: false }, workspaces: { meta: {}, target: {} } };

    assert.strictEqual(resolveExtractors(config, 'meta').enabled.ros, false);
    assert.strictEqual(resolveExtractors(config, 'target').enabled.ros, false);
});

test('a workspace setting beats the project-wide one', () => {
    const config = {
        extractors: { ros: false },
        workspaces: { meta: {}, target: { extractors: { ros: true } } },
    };

    assert.strictEqual(resolveExtractors(config, 'meta').enabled.ros, false);
    assert.strictEqual(resolveExtractors(config, 'target').enabled.ros, true,
        'the ROS workspace is exactly the case this switch exists for');
});

test('only an explicit false disables — a typo like 0 or "no" does not', () => {
    assert.strictEqual(resolveExtractors({ extractors: { ros: 0 } }).enabled.ros, true);
    assert.strictEqual(resolveExtractors({ extractors: { ros: 'no' } }).enabled.ros, true);
    assert.strictEqual(resolveExtractors({ extractors: { ros: false } }).enabled.ros, false);
});

test('an unknown extractor name is reported, not swallowed', () => {
    const { unknown } = resolveExtractors({ extractors: { rso: false } });
    assert.deepStrictEqual(unknown, ['rso']);

    const lines = [];
    reportExtractors(resolveExtractors({ extractors: { rso: false } }), (l) => lines.push(l));
    assert.ok(lines.some((l) => l.includes("unknown extractor 'rso'")),
        'a misspelled switch that does nothing is worse than no switch');
});

test('a disabled extractor is announced so the build log explains the graph', () => {
    const lines = [];
    reportExtractors(resolveExtractors({ extractors: { ros: false } }), (l) => lines.push(l));

    assert.ok(lines.some((l) => l.includes('disabled: ros')));
});

test('non-object extractors values are ignored rather than crashing the build', () => {
    assert.strictEqual(resolveExtractors({ extractors: null }).enabled.ros, true);
    assert.strictEqual(resolveExtractors({ extractors: 'ros' }).enabled.ros, true);
    assert.strictEqual(resolveExtractors({ extractors: ['ros'] }).enabled.ros, true);
});

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    normalizeWorkspaceName,
    publicWorkspaceName,
} = require('../lib/workspace-names.cjs');

test('public workspace names map to legacy physical databases', () => {
    assert.equal(normalizeWorkspaceName('project_db'), 'target');
    assert.equal(normalizeWorkspaceName('codevis_db'), 'meta');
    assert.equal(normalizeWorkspaceName('project'), 'target');
    assert.equal(normalizeWorkspaceName('codevis'), 'meta');
});

test('legacy workspace aliases remain compatible', () => {
    assert.equal(normalizeWorkspaceName('tool'), 'target');
    assert.equal(normalizeWorkspaceName('target'), 'target');
    assert.equal(normalizeWorkspaceName('meta'), 'meta');
});

test('missing workspace defaults to the project', () => {
    assert.equal(normalizeWorkspaceName(undefined), 'target');
    assert.equal(publicWorkspaceName('target'), 'project_db');
    assert.equal(publicWorkspaceName('meta'), 'codevis_db');
});

test('unknown workspace names fail instead of falling back silently', () => {
    assert.throws(() => normalizeWorkspaceName('production'), /Unknown workspace/);
});

#!/usr/bin/env node

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  selectClassCandidate,
} = require('../scripts/graph_builder.js').__testing__;

const catalog = [
  { uid: 'uid-a-node', name: 'Node', file: 'packages/a/node.py' },
  { uid: 'uid-b-node', name: 'Node', file: 'packages/b/node.py' },
  { uid: 'uid-local', name: 'Local', file: 'app/main.py' },
];

function context({ importedFiles = [], symbols = [] } = {}) {
  return { importedFiles: new Set(importedFiles), symbols };
}

describe('file-aware class resolution', () => {
  it('uses a resolved named import to select one of two same-named classes', () => {
    const result = selectClassCandidate(
      catalog,
      context({
        importedFiles: ['packages/a/node.py', 'packages/b/node.py'],
        symbols: [{
          localName: 'Node',
          originalName: 'Node',
          sourceFile: 'packages/b/node.py',
        }],
      }),
      'app/main.py',
      'Node'
    );

    assert.equal(result.status, 'resolved');
    assert.equal(result.candidate.uid, 'uid-b-node');
    assert.equal(result.context, 'named import');
  });

  it('does not pick the first class when two imported files remain possible', () => {
    const result = selectClassCandidate(
      catalog,
      context({ importedFiles: ['packages/a/node.py', 'packages/b/node.py'] }),
      'app/main.py',
      'Node'
    );

    assert.equal(result.status, 'ambiguous');
    assert.equal(result.context, 'imported file');
    assert.deepEqual(result.candidates.map((candidate) => candidate.uid), [
      'uid-a-node',
      'uid-b-node',
    ]);
  });

  it('does not fall back to a global first match without import context', () => {
    const result = selectClassCandidate(
      catalog,
      context(),
      'app/main.py',
      'Node'
    );

    assert.equal(result.status, 'ambiguous');
    assert.equal(result.context, 'globally unique fallback');
  });

  it('pairs an out-of-line C++ definition with its sibling header', () => {
    const cppCatalog = [
      { uid: 'pkg-a', name: 'Controller', file: 'pkg_a/controller.hpp' },
      { uid: 'pkg-b', name: 'Controller', file: 'pkg_b/controller.hpp' },
    ];
    const result = selectClassCandidate(
      cppCatalog,
      context(),
      'pkg_b/controller.cpp',
      'Controller'
    );

    assert.equal(result.status, 'resolved');
    assert.equal(result.candidate.uid, 'pkg-b');
    assert.equal(result.context, 'C++ sibling header/source');
  });
});

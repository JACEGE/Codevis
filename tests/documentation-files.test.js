const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const {
  DOCUMENTATION_FILES,
  normalizeDocumentationFile,
  readDocumentationFile,
} = require('../server/documentation-files.cjs');

test('documentation endpoint allowlist covers the packaged active guide set', () => {
  for (const expected of ['README.md', 'docs/README.md', 'docs/USER_WORKFLOW.md']) {
    assert.ok(DOCUMENTATION_FILES.includes(expected));
    assert.equal(readDocumentationFile(root, expected).relative, expected);
  }
});

test('documentation paths reject traversal, archives, and arbitrary project files', () => {
  for (const requested of ['../package.json', 'package.json', 'docs/reviews/RELEASE_REVIEW_2026-09-10.md', 'docs/../README.md']) {
    assert.equal(normalizeDocumentationFile(requested), null);
    assert.throws(() => readDocumentationFile(root, requested), { status: 404 });
  }
});

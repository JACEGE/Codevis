const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parseFrontmatter, loadKnowledgeDocs } = require('../scripts/knowledge_markdown.cjs');

test('parses Knowledge frontmatter, block lists, and wiki links', () => {
  const parsed = parseFrontmatter(`---
id: clearance-gradient
title: Clearance Gradient
tags: [geometry, safety]
appliesTo:
  - src/geometry.py
  - src/obs.py#build_observation
---
# Rule

See [[kinematics|the kinematics convention]].
`, 'docs/knowledge/clearance.md');
  assert.equal(parsed.data.id, 'clearance-gradient');
  assert.deepEqual(parsed.data.tags, ['geometry', 'safety']);
  assert.deepEqual(parsed.data.appliesTo, ['src/geometry.py', 'src/obs.py#build_observation']);
});

test('loads configured Markdown recursively with stable identity', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codevis-knowledge-'));
  try {
    const dir = path.join(root, 'docs', 'knowledge', 'architecture');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'rule.md'), `---
id: stable-rule
category: architecture
---
# Stable Rule

See [[other-rule]].
`);
    const docs = loadKnowledgeDocs(root, ['./docs/knowledge']);
    assert.equal(docs.length, 1);
    assert.equal(docs[0].uid, 'knowledge-doc:stable-rule');
    assert.equal(docs[0].title, 'Stable Rule');
    assert.equal(docs[0].sourcePath, 'docs/knowledge/architecture/rule.md');
    assert.deepEqual(docs[0].references, ['other-rule']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects missing and duplicate document ids', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codevis-knowledge-invalid-'));
  try {
    fs.writeFileSync(path.join(root, 'missing.md'), '# Missing');
    assert.throws(() => loadKnowledgeDocs(root, ['.']), /stable frontmatter "id"/);
    fs.writeFileSync(path.join(root, 'missing.md'), '---\nid: same\n---\n# One');
    fs.writeFileSync(path.join(root, 'two.md'), '---\nid: same\n---\n# Two');
    assert.throws(() => loadKnowledgeDocs(root, ['.']), /Duplicate Knowledge Markdown id/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('overlapping Knowledge roots load each physical document only once', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codevis-knowledge-overlap-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'docs'));
  fs.writeFileSync(path.join(root, 'docs/rule.md'), '---\nid: rule\n---\nContent');
  assert.equal(loadKnowledgeDocs(root, ['docs', 'docs/rule.md']).length, 1);
});

test('frontmatter may end at EOF without a trailing newline or body', () => {
  assert.equal(parseFrontmatter('---\nid: rule\n---').data.id, 'rule');
  assert.equal(parseFrontmatter('---\nid: rule\n---').body, '');
});

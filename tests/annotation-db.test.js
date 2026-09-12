const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createAnnotation,
  normalizeInput,
  updateAnnotationStatus,
} = require('../scripts/annotations/annotation_db.cjs');

const record = (values) => ({ get: (key) => values[key] });
const annotationRecord = (overrides = {}) => record({
  id: 'Annotation||id=annotation-1', annotationId: 'annotation-1', targetUid: 'function-1',
  targetName: 'run', targetFile: 'src/run.js', tag: 'entry-point', evidence: 'Called by the CLI bootstrap.',
  confidence: 0.9, weight: 0.8, sourceKind: 'llm', model: 'test-model', status: 'proposed',
  createdBy: 'test-model', createdAt: 10, updatedAt: 10, ...overrides,
});

test('annotation input requires constrained tags, evidence, and bounded scores', () => {
  assert.deepEqual(normalizeInput({
    targetNode: 'Function||file=x||name=run', tag: ' Domain:Entry-Point ', evidence: 'CLI calls it.',
    confidence: 0.9, weight: 0.7,
  }), {
    targetUid: 'Function||file=x||name=run', tag: 'domain:entry-point', evidence: 'CLI calls it.',
    sourceKind: 'llm', confidence: 0.9, weight: 0.7, model: null, createdBy: 'llm',
  });
  assert.throws(() => normalizeInput({ targetNode: 'x', tag: 'bad tag', evidence: 'why' }), /tag must/);
  assert.throws(() => normalizeInput({ targetNode: 'x', tag: 'good', evidence: 'why', confidence: 2 }), /confidence/);
  assert.throws(() => normalizeInput({ targetNode: 'x', tag: 'good', evidence: '' }), /evidence/);
});

test('createAnnotation stores a proposed annotation and exact target identity', async () => {
  let params;
  const session = {
    run: async (query, values) => {
      assert.match(query, /CREATE \(a:Annotation/);
      assert.match(query, /\[:ANNOTATES\]/);
      params = values;
      return { records: [annotationRecord()] };
    },
  };
  const annotation = await createAnnotation(session, {
    targetNode: 'function-1', tag: 'entry-point', evidence: 'Called by the CLI bootstrap.', model: 'test-model',
    confidence: 0.9, weight: 0.8,
  });
  assert.equal(params.targetUid, 'function-1');
  assert.match(params.annotationId, /^annotation-/);
  assert.equal(annotation.status, 'proposed');
  assert.equal(annotation.targetNode, 'function-1');
});

test('only explicit review states can update an annotation', async () => {
  const session = { run: async () => ({ records: [annotationRecord({ status: 'accepted', updatedAt: 20 })] }) };
  const annotation = await updateAnnotationStatus(session, 'annotation-1', 'accepted', 'reviewer');
  assert.equal(annotation.status, 'accepted');
  await assert.rejects(() => updateAnnotationStatus(session, 'annotation-1', 'hidden'), /status must/);
});

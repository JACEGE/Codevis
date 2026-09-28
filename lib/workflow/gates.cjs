'use strict';
const { meaningful, uid } = require('./model.cjs');
const { CONTRACTS } = require('./instructions.cjs');
const { readArtifact } = require('./artifacts.cjs');
const { graphView } = require('./projection.cjs');
const { inspectGraphFreshness } = require('../../scripts/impact/graph_freshness.cjs');
const { isTestPath } = require('../../scripts/test-file.cjs');
async function evaluateGate(session, state, context) {
  const failures = [], warnings = [];
  const check = (ok, code, message, nodeId) => { if (!ok) failures.push({code, message, nodeId}); };
  const phase = state.phases.find(p => p.id === state.currentPhase);
  const submission = phase.submissions.at(-1);
  check(Boolean(submission), 'submission', 'Submit phase evidence before completing.');
  if (!submission) return { passed: false, failures, warnings, checkedAt: Date.now() };
  check(submission.revision >= (phase.requiredRevision || 0), 'resubmission', 'Resubmit evidence after reopening this phase.');
  for (const field of CONTRACTS[phase.id].fields) {
    if (field === 'openQuestions') { check(Array.isArray(submission.data[field]), 'questions', 'Provide an explicit openQuestions array.'); continue; }
    try { meaningful(submission.data[field], field); } catch (e) { check(false, 'required-field', e.message); }
  }
  for (const p of state.phases.filter(p => p.status === 'complete' || p.id === phase.id)) {
    const latest = p.submissions.at(-1);
    if (latest) try { readArtifact(context, latest.artifact); } catch(e) { check(false, 'artifact-integrity', e.message); }
  }
  const graph = await graphView(session, state);
  for (const link of graph.unresolved) check(false, 'unresolved-reference', 'A workflow reference no longer resolves.', link.from);
  const nodes = graph.nodes;
  const out = (key, type) => graph.links.filter(l => l.from === uid(state,key) && l.type === type).map(l => nodes.find(n => n.id === l.to));
  const requirements = state.entities.filter(e => e.label === 'Requirement');
  const cases = state.entities.filter(e => e.label === 'TestCase');
  if (phase.id === 'requirements') {
    check(requirements.length > 0, 'requirements', 'At least one requirement is required.');
    for (const req of requirements) {
      check(out('change','HAS_REQUIREMENT').some(n => n.key === req.id), 'requirement-membership', 'Connect requirement to Change.', req.id);
      const criteria = out(req.id, 'HAS_CRITERION');
      check(criteria.length > 0, 'acceptance', 'Requirement needs acceptance criteria.', req.id);
      for (const ac of criteria) check(out(ac.key, 'VALIDATED_BY').length > 0, 'test-intent', 'Criterion needs behavioral TestCase intent.', ac.key);
    }
    for (const ac of state.entities.filter(e=>e.label==='AcceptanceCriterion')) check(graph.links.some(l=>l.type==='HAS_CRITERION' && l.to===uid(state,ac.id)), 'criterion-membership', 'Criterion needs a requirement.', ac.id);
    for (const tc of cases) check(graph.links.some(l=>l.type==='VALIDATED_BY' && l.to===uid(state,tc.id)), 'test-membership', 'TestCase must protect a requirement or criterion.', tc.id);
    for (const q of Array.isArray(submission.data.openQuestions) ? submission.data.openQuestions : []) {
      check(q && typeof q.question === 'string' && typeof q.blocking === 'boolean', 'question-shape', 'Questions need question and blocking fields.');
      if (q?.blocking) check(typeof q.resolution === 'string' && q.resolution.trim().length >= 12 || typeof q.acceptedBy === 'string' && q.acceptedBy.trim().length > 0,
        'blocking-question', 'Resolve or explicitly accept each blocking question.');
    }
  }
  let freshness;
  if (['analysis','quality','review'].includes(phase.id)) {
    freshness = await inspectGraphFreshness(session, context);
    const planning = context.config.workMode === 'planning' && phase.id === 'analysis';
    check(freshness.state === 'current' || planning, 'graph-freshness', 'Graph is ' + freshness.state + '; rebuild before completing.');
    if (planning) warnings.push({code:'planning', message:'No source analysis is possible yet; graph evidence remains unknown.'});
  }
  if (phase.id === 'analysis') {
    check(out('analysis','IMPACTS').length > 0 || context.config.workMode === 'planning', 'impact', 'Predict affected source symbols.');
    const technical = cases.filter(t => t.phase === 'analysis');
    check(technical.length > 0 || submission.data.noAdditionalTests === true, 'regression-intent', 'Add regression TestCases, or explicitly justify no additional tests in testRationale.');
    for (const t of technical) check(typeof t.reason === 'string' && t.reason.length >= 12, 'test-reason', 'Analysis TestCase needs its reason.', t.id);
  }
  if (['architecture', 'review'].includes(phase.id)) {
    const j = submission.judgment;
    check(j?.decision === 'approved' && typeof j.reviewer === 'string' && j.reviewer.trim() && typeof j.rationale === 'string' && j.rationale.trim().length >= 12,
      'judgment', 'Record approval with reviewer and rationale. This is an attributed judgment, not automatic semantic verification.');
  }
  const tasks = nodes.filter(n => n.label === 'Task');
  if (phase.id === 'planning') {
    check(tasks.length > 0, 'tasks', 'Link existing implementation Tasks.');
    for (const req of requirements) check(graph.links.some(l => l.type === 'IMPLEMENTS' && l.to === uid(state, req.id)), 'task-coverage', 'Requirement needs an implementing Task.', req.id);
  }
  if (['development','quality','review'].includes(phase.id)) {
    for (const task of tasks) check(['review','done'].includes(task.status), 'task-status', 'Task is not ready for review: ' + task.name, task.id);
    for (const tc of cases) {
      check(out(tc.id, 'IMPLEMENTED_BY').some(n => isTestPath(n.file || n.path) && !/\.d\.ts$/.test(n.file || n.path)), 'test-implementation', 'TestCase needs executable test source.', tc.id);
      check(out(tc.id, 'VALIDATES').some(n=>!isTestPath(n.file||n.path)), 'validated-source', 'TestCase needs validated production source.', tc.id);
    }
  }
  if (['quality','review'].includes(phase.id)) {
    if (!context.evaluateQuality) check(false, 'quality-evidence', 'Run Change quality checks before completing.');
    else {
      const report = await context.evaluateQuality(session, state, context);
      failures.push(...report.findings.filter(f=>f.level === 'error'));
      warnings.push(...report.findings.filter(f=>f.level !== 'error'));
    }
  }
  return { passed: failures.length === 0, failures, warnings, freshness, checkedAt: Date.now(),
    judgment: submission.judgment || null, limitation: 'Structural checks do not verify natural-language meaning or test correctness.' };
}
module.exports = { evaluateGate };

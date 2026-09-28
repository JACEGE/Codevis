'use strict';
const { digest, readArtifact } = require('./artifacts.cjs');
const { configuredChecks } = require('./checks.cjs');
const { sourceSnapshot } = require('./quality-snapshot.cjs');
function intentFingerprint(state) {
  return digest(JSON.stringify({entities:state.entities, links:state.links, bindings:state.testBindings || []}));
}
function testResults(state, context, fingerprint) {
  const evidence = state.qualityEvidence;
  let staleReason = null;
  if (evidence) {
    try {
      if (!context) staleReason = 'Current source freshness has not been checked.';
      else if (evidence.fingerprint !== (fingerprint || sourceSnapshot(context).fingerprint)) staleReason = 'Source changed after execution.';
      else if (evidence.configuration !== digest(JSON.stringify(configuredChecks(context.config)))) staleReason = 'Check configuration changed after execution.';
      else if (evidence.intentFingerprint !== intentFingerprint(state)) staleReason = 'Intent, source links or test bindings changed after execution.';
      else readArtifact(context, evidence.artifact);
    } catch (error) { staleReason = error.message; }
  }
  const reportErrors = (evidence?.checks || []).filter(c => c.reportError).map(c => ({check:c.name,message:c.reportError}));
  const cases = state.entities.filter(e => e.label === 'TestCase').map(tc => {
    const bindings = (state.testBindings || []).filter(b => b.testCaseId === tc.id);
    const implementations = state.links.filter(l => l.from === tc.id && l.type === 'IMPLEMENTED_BY');
    const observations = [];
    let reason = null;
    if (!bindings.length) reason = 'No executable test selectors recorded.';
    if (!implementations.length || implementations.some(l => !bindings.some(b => b.implementation.nodeId === l.to.nodeId ||
      b.implementation.label === l.to.label && (b.implementation.file || b.implementation.path) === (l.to.file || l.to.path) && b.implementation.name === l.to.name && b.implementation.owner === l.to.owner))) {
      reason = 'Not every linked test implementation has an execution selector.';
    }
    for (const binding of bindings) {
      const check = evidence?.checks?.find(c => c.name === binding.check);
      const matches = check?.report?.tests.filter(t => t.file === binding.file && t.name === binding.name && (binding.line == null || t.line === binding.line)) || [];
      if (matches.length !== 1) reason = matches.length ? 'Test selector is ambiguous; add a line or use a unique test name.' : 'Selected test was not observed in this run.';
      else observations.push({...matches[0],check:binding.check,implementation:binding.implementation.nodeId});
    }
    const recordedStatus = observations.some(o => o.status === 'fail') ? 'fail' : reason ? 'unknown' :
      observations.some(o => o.status === 'skipped') ? 'skipped' : observations.some(o => o.status === 'todo') ? 'todo' :
      observations.length ? 'pass' : 'unknown';
    return {testCaseId:tc.id, status:staleReason ? 'stale' : recordedStatus, recordedStatus,
      reason:staleReason || reason, at:evidence?.at || null, fingerprint:evidence?.fingerprint || null,
      artifact:evidence?.artifact || null, observations};
  });
  return {cases, reportErrors, stale:!!staleReason, counts:Object.fromEntries(['pass','fail','skipped','todo','unknown','stale'].map(s => [s,cases.filter(c=>c.status===s).length]))};
}
module.exports = { intentFingerprint, testResults };

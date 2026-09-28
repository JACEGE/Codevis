'use strict';
const { testFile } = require('./test-report.cjs');
const { configuredChecks } = require('./checks.cjs');
async function submitTestBindings(session, state, bindings, context) {
  if (bindings === undefined) return;
  if (state.currentPhase !== 'development') throw new Error('Bind executable tests during Development');
  if (!Array.isArray(bindings) || bindings.length > 2000) throw new Error('Expected at most 2000 test bindings');
  const { resolveReference, reference } = require('./projection.cjs');
  const checks = configuredChecks(context.config);
  const normalized = [];
  for (const b of bindings) {
    if (!state.entities.some(e => e.id === b.testCaseId && e.label === 'TestCase')) throw new Error('Unknown TestCase for binding');
    if (!checks.some(c => c.name === b.check && c.testReport)) throw new Error('Binding check needs a configured testReport');
    if (typeof b.name !== 'string' || !b.name.trim() || b.name.length > 2000) throw new Error('Exact test name is required');
    if (b.line != null && (!Number.isSafeInteger(b.line) || b.line < 1)) throw new Error('Invalid test binding line');
    const file = testFile(b.file);
    const implementation = b.implementation?.nodeId && await resolveReference(session, b.implementation);
    if (!implementation) throw new Error('Test implementation source does not exist');
    if ((implementation.file || implementation.path)?.replace(/\\/g,'/') !== file) throw new Error('Binding file must match test implementation source');
    const linked = [];
    for (const link of state.links.filter(l => l.from === b.testCaseId && l.type === 'IMPLEMENTED_BY')) {
      const target = await resolveReference(session, link.to);
      if (target) linked.push(target.id);
    }
    if (!linked.includes(implementation.id)) throw new Error('Binding implementation needs an IMPLEMENTED_BY link');
    const next = {testCaseId:b.testCaseId, check:b.check, file, name:b.name,
      ...(b.line != null ? {line:b.line} : {}), implementation:reference(implementation)};
    if (normalized.some(n => JSON.stringify(n) === JSON.stringify(next))) throw new Error('Duplicate test binding');
    normalized.push(next);
  }
  // Explicit replacement lets users remove obsolete runner selectors.
  state.testBindings = normalized;
}
module.exports = { submitTestBindings };

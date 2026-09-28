'use strict';
const {ideaContext,applyIdeaOrigin}=require('./origin.cjs');
const { createChange, meaningful } = require('./model.cjs');
const { readState, saveState, listStates, readArtifact } = require('./artifacts.cjs');
const { projectChange, graphView } = require('./projection.cjs');
const { phaseInstructions } = require('./instructions.cjs');
const { submit } = require('./submission.cjs');
const { evaluateGate } = require('./gates.cjs');
const { compileContext } = require('./context.cjs');
const { captureSnapshot, sourceSnapshot } = require('./quality-snapshot.cjs');
const { qualityReport } = require('./quality-report.cjs');
const { configuredChecks } = require('./checks.cjs');
const { digest, writeArtifact } = require('./artifacts.cjs');
async function synchronize(session, state, context) {
  try { return { status: 'OK', state, graph: await projectChange(session, state, context), instructions: phaseInstructions(state) }; }
  catch (error) { return { status: 'PROJECTION_PENDING', saved: true, revision: state.revision,
    slug: state.slug, error: error.message, action: 'Resume this Change to replay saved state into the graph.' }; }
}
async function readChange(session, state, options, context) {
  if (options.view === 'tests') return require('./test-results.cjs').testResults(state,context);
  if (options.view === 'quality') return qualityReport(session,state,context);
  if (options.view === 'context') return compileContext(session, state, options, context);
  if (options.view === 'artifact') {
    const artifact = state.artifacts.find(a=>a.path===options.path);
    if (!artifact) throw new Error('Artifact is not part of this Change');
    return { ...artifact, content: readArtifact(context, artifact) };
  }
  return { status:'OK', state, graph:await graphView(session,state,context), instructions:phaseInstructions(state) };
}
// Call only inside the daemon mutex (or an isolated test session).
async function changeOperation(session, options, context) {
  const { operation, slug } = options;
  if (operation === 'test_result') {
    const state=listStates(context).find(s=>s.entities.some(e=>e.label==='TestCase'&&require('./model.cjs').uid(s,e.id)===options.nodeId));
    if(!state)throw new Error('TestCase not found in this workspace');
    const results=require('./test-results.cjs').testResults(state,context);
    return {slug:state.slug,execution:results.cases.find(c=>require('./model.cjs').uid(state,c.testCaseId)===options.nodeId)};
  }
  if (operation === 'trace') return require('./trace.cjs').traceFlow(session,options,context);
  if (operation === 'idea_context') return ideaContext(session,options.ideaId);
  if (operation === 'list') return { changes: listStates(context).map(s => ({ slug: s.slug, changeId: s.changeId,
    sourceIdeaId:s.origin?.ideaId||null, kind:s.kind||'feature', template:s.template?.id||'engineering', title: s.title, status: s.status, currentPhase: s.currentPhase, revision: s.revision, updatedAt: s.updatedAt })) };
  if (operation === 'related') {
    const changes = [];
    for (const state of listStates(context)) {
      const graph = await graphView(session, state, context);
      const links = graph.links.filter(l=>l.from===options.nodeId||l.to===options.nodeId);
      if (links.length) changes.push({slug:state.slug,title:state.title,status:state.status,links});
    }
    return { changes };
  }
  if (operation === 'create' || operation === 'promote_idea') {
    const state = createChange({ ...options, workspace: context.workspace });
    if(operation==='promote_idea') {
      await applyIdeaOrigin(session,state,options);
      try {
        const existing=readState(context,state.slug).state;
        if(existing.origin?.nodeId===state.origin.nodeId&&existing.title===state.title&&existing.description===state.description&&existing.kind===state.kind)return synchronize(session,existing,context);
        throw new Error('CONFLICT: Flow slug already exists');
      }catch(error){if(error.code!=='ENOENT')throw error;}
    }
    saveState(context, state);
    return synchronize(session, state, context);
  }
  const { state, hash } = readState(context, slug);
  if (operation === 'read') return readChange(session,state,options,context);
  if (operation === 'resume') return synchronize(session, state, context);
  if (!Number.isInteger(options.expectedRevision) || options.expectedRevision !== state.revision) throw new Error('CONFLICT: expectedRevision must match current Change revision');
  state.revision++; state.updatedAt = Date.now();
  const phase = state.phases.find(p=>p.id===state.currentPhase);
  let blocked = false;
  if (operation === 'submit') await submit(session, state, options, context);
  else if (operation === 'complete') {
    if (state.status === 'done') throw new Error('Change is already complete');
    phase.gate = await evaluateGate(session,state,{...context,evaluateQuality:qualityReport});
    blocked = !phase.gate.passed;
    if (!blocked) {
      if (phase.id === 'analysis') state.baseline = await captureSnapshot(session,context);
      phase.status = 'complete'; phase.completedAt = Date.now();
      const next = state.phases[state.phases.indexOf(phase)+1];
      if (next) { next.status='active'; next.startedAt=Date.now(); next.agent=options.agent||phase.agent; state.currentPhase=next.id; }
      else state.status='done';
    }
  } else if (operation === 'record_quality') {
    if (state.status==='done' || !['development','quality','review'].includes(state.currentPhase)) throw new Error('Run checks during an active Development, Quality or Review phase');
    const evidence=options.evidence, definitions=configuredChecks(context.config);
    if (!evidence || evidence.fingerprint!==sourceSnapshot(context).fingerprint || evidence.configuration!==digest(JSON.stringify(definitions))) throw new Error('Quality evidence is stale or uses different check configuration');
    if (!Number.isFinite(evidence.at) || evidence.at<=0 || !Array.isArray(evidence.checks) || evidence.checks.length!==definitions.length || evidence.checks.some((c,i)=>c.name!==definitions[i].name||!Number.isInteger(c.exitCode)||!Number.isFinite(c.durationMs)||c.durationMs<0||typeof c.output!=='string')) throw new Error('Incomplete configured check evidence');
    const markdown='# Check execution evidence\n\n'+evidence.provenance+'\n\n'+evidence.checks.map(c=>'## '+c.name+'\n\nExit: '+c.exitCode+'; duration: '+c.durationMs+'ms\n\n'+c.output).join('\n\n');
    const artifact=writeArtifact(context,state,'checks',markdown);state.artifacts.push(artifact);
    state.qualityEvidence={fingerprint:evidence.fingerprint,configuration:evidence.configuration,at:evidence.at,provenance:evidence.provenance,
      checks:require('./test-report.cjs').observedChecks(evidence,definitions),intentFingerprint:require('./test-results.cjs').intentFingerprint(state),artifact};
  } else if (operation === 'reopen') {
    meaningful(options.reason,'reason');
    const index = state.phases.findIndex(p=>p.id===options.phase);
    if (index < 0 || index > state.phases.indexOf(phase)) throw new Error('Can only reopen the current or an earlier phase');
    for (let i=index;i<state.phases.length;i++) {
      state.phases[i].status=i===index?'active':'pending'; state.phases[i].gate=null;
      state.phases[i].completedAt=null; state.phases[i].requiredRevision=state.revision;
    }
    state.currentPhase=options.phase; state.status='active';
    state.qualityEvidence=null;
  } else throw new Error('Unsupported Change operation: ' + operation);
  state.history.push({operation,phase:phase.id,revision:state.revision,at:state.updatedAt,agent:options.agent||phase.agent||'Lead',reason:options.reason||null});
  saveState(context,state,hash);
  const result = await synchronize(session,state,context);
  if (blocked && result.status === 'OK') result.status='GATE_BLOCKED';
  return result;
}
module.exports = { changeOperation, synchronize, readChange };

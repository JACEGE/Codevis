'use strict';
const { PHASES, meaningful, validateState, CODE_LABELS } = require('./model.cjs');
const { resolveReference, reference } = require('./projection.cjs');
const { writeArtifact } = require('./artifacts.cjs');
const SHAPES = {
  HAS_REQUIREMENT: [['Flow'], ['Requirement']], HAS_CRITERION: [['Requirement'], ['AcceptanceCriterion']],
  VALIDATED_BY: [['Requirement', 'AcceptanceCriterion'], ['TestCase']],
  VALIDATES: [['TestCase'], CODE_LABELS], IMPLEMENTED_BY: [['TestCase'], ['File', 'Function']],
  IMPLEMENTS: [['Task'], ['Requirement', 'TestCase']], IMPACTS: [['Phase'], CODE_LABELS],
  REFERENCES: [['Phase', 'Flow', 'ArchitectureDecision'], ['Task', 'Epic', 'Knowledge', 'SpecSequence', 'SpecClassDiagram', 'SpecActivityDiagram', 'SpecUseCaseDiagram', ...CODE_LABELS]],
};
async function submit(session, state, options, context) {
  if (state.status === 'done') throw new Error('Reopen the Change before editing it');
  meaningful(options.markdown, 'markdown', 40);
  if (!options.data || typeof options.data !== 'object' || Array.isArray(options.data)) throw new Error('Structured phase data is required');
  const phase = state.phases.find(p => p.id === state.currentPhase);
  const entities = options.entities || [], links = options.links || [];
  if (!Array.isArray(entities) || !Array.isArray(links) || entities.length > 500 || links.length > 2000) throw new Error('Invalid or oversized submission');
  for (const entity of entities) {
    const prior = state.entities.find(e => e.id === entity.id);
    if (prior && prior.phase !== phase.id) throw new Error('Reopen ' + prior.phase + ' to change ' + entity.id);
    if (entity.label==='ArchitectureDecision' && phase.id!=='architecture')throw new Error('Architecture decisions belong to Architecture');
    if (!['TestCase','ArchitectureDecision'].includes(entity.label) && phase.id !== 'requirements') throw new Error('Requirements and criteria belong to Requirements');
    if (entity.label === 'TestCase' && !['requirements', 'analysis'].includes(phase.id)) throw new Error('Define test intent during Requirements or Analysis');
    if (entity.label === 'TestCase') meaningful(entity.reason, 'TestCase reason');
    const next = { id: entity.id, label: entity.label, title: entity.title, content: entity.content,
      phase: phase.id, origin: phase.id, reason: entity.reason || null };
    if (prior) state.entities[state.entities.indexOf(prior)] = next; else state.entities.push(next);
  }
  const labels = new Map([['change', 'Flow'], ...state.phases.map(({id}) => [id, 'Phase']), ...state.entities.map(e => [e.id, e.label])]);
  const resolve = async endpoint => {
    if (typeof endpoint === 'string') {
      if (!labels.has(endpoint)) throw new Error('Unknown workflow endpoint ' + endpoint);
      return { endpoint, label: labels.get(endpoint) };
    }
    if (!endpoint || typeof endpoint.nodeId !== 'string') throw new Error('External endpoint needs elementId');
    const n = await resolveReference(session, { nodeId: endpoint.nodeId });
    if (!n) throw new Error('Unknown external node ' + endpoint.nodeId);
    if (['Flow','Phase','Requirement','AcceptanceCriterion','TestCase','SourceAnalysis','ArchitectureDecision'].includes(n.label)) throw new Error('Use a local workflow ID for Change entities');
    return { endpoint: reference(n), label: n.label };
  };
  for (const link of links) {
    const shape = SHAPES[link.type];
    if (!shape) throw new Error('Unsupported authored relationship ' + link.type);
    const a = await resolve(link.from), b = await resolve(link.to);
    if (!shape[0].includes(a.label) || !shape[1].includes(b.label)) throw new Error('Invalid endpoints for ' + link.type);
    if (link.type === 'IMPACTS' && link.from !== 'analysis') throw new Error('Impact predictions belong to Analysis');
    if (['VALIDATES', 'IMPLEMENTED_BY'].includes(link.type) && phase.id !== 'development') throw new Error('Link executable validation during Development');
    if (link.type === 'IMPACTS' && phase.id !== 'analysis') throw new Error('Reopen Analysis to change predictions');
    if (link.type === 'IMPLEMENTS' && phase.id !== 'planning') throw new Error('Link Tasks during Planning');
    if (['HAS_REQUIREMENT', 'HAS_CRITERION'].includes(link.type) && phase.id !== 'requirements') throw new Error('Reopen Requirements to edit requirement links');
    if (link.type === 'VALIDATED_BY' && !['requirements','analysis'].includes(phase.id)) throw new Error('Define validation intent before implementation');
    const next = { from: a.endpoint, to: b.endpoint, type: link.type, phase: phase.id };
    if (!state.links.some(l => JSON.stringify(l) === JSON.stringify(next))) state.links.push(next);
  }
  await require('./test-bindings.cjs').submitTestBindings(session,state,options.testBindings,context);
  validateState(state);
  const artifact = writeArtifact(context, state, phase.id, options.markdown);
  state.artifacts.push(artifact);
  phase.agent = meaningful(options.agent || 'Lead', 'agent', 1);
  phase.submissions.push({ revision: state.revision, at: Date.now(), agent: phase.agent, role: phase.role, artifact,
    data: options.data, judgment: options.judgment || null,
    outputs: { entities: structuredClone(state.entities.filter(e=>e.phase===phase.id)), links: structuredClone(state.links.filter(l=>l.phase===phase.id)) } });
  phase.gate = null;
  return state;
}
module.exports = { submit, SHAPES };

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
// Which relationship may be authored in which phase. The submission check and
// the phase instructions both read this table, so what an agent is told is
// what it is held to. REFERENCES may be added in any phase.
const PHASE_LINKS = {
  HAS_REQUIREMENT: ['requirements'], HAS_CRITERION: ['requirements'], VALIDATED_BY: ['requirements', 'analysis'],
  IMPACTS: ['analysis'], IMPLEMENTS: ['planning'], VALIDATES: ['development'], IMPLEMENTED_BY: ['development'],
};
const LOCAL_LABELS = ['Flow','Phase','Requirement','AcceptanceCriterion','TestCase','SourceAnalysis','ArchitectureDecision'];
/** The relationships an agent may author in this phase, with their allowed endpoint labels. */
function allowedLinks(phaseId) {
  return Object.entries(SHAPES).filter(([type]) => !PHASE_LINKS[type] || PHASE_LINKS[type].includes(phaseId))
    .map(([type, [from, to]]) => ({ type, from: type === 'IMPACTS' ? ['analysis (the Phase ID)'] : from, to }));
}
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
    if (!endpoint || typeof endpoint.nodeId !== 'string') throw new Error('External endpoint needs {nodeId}: an elementId, or the taskId/epicId the Task tools return');
    let n = await resolveReference(session, { nodeId: endpoint.nodeId });
    // Task and Epic tools speak taskId/epicId (task-1790…, stored as taskId on both); a Flow link used to
    // accept only the elementId (task:49), which agents had to look up first.
    if (!n) {
      const byId = await session.run('MATCH (n) WHERE (n:Task OR n:Epic) AND n.taskId = $id RETURN elementId(n) AS id LIMIT 2', { id: endpoint.nodeId });
      if (byId.records.length === 1) n = await resolveReference(session, { nodeId: byId.records[0].get('id') });
    }
    if (!n) throw new Error('Unknown external node ' + endpoint.nodeId + '. Use an elementId (e.g. get_task nodeId) or a Task taskId / Epic epicId.');
    if (LOCAL_LABELS.includes(n.label)) throw new Error('Use a local workflow ID for Change entities');
    return { endpoint: reference(n), label: n.label };
  };
  for (const link of links) {
    const shape = SHAPES[link.type];
    if (!shape) throw new Error('Unsupported authored relationship ' + link.type + '. Allowed in ' + phase.id + ': ' + allowedLinks(phase.id).map(l => l.type).join(', '));
    const a = await resolve(link.from), b = await resolve(link.to);
    if (!shape[0].includes(a.label) || !shape[1].includes(b.label)) throw new Error('Invalid endpoints for ' + link.type + ': got ' + a.label + ' -> ' + b.label
      + ', expected ' + shape[0].join('|') + ' -> ' + (shape[1].length > 6 ? shape[1].slice(0, 6).join('|') + '|…' : shape[1].join('|')));
    if (link.type === 'IMPACTS' && link.from !== 'analysis') throw new Error('Impact predictions belong to Analysis: use from: "analysis"');
    const phases = PHASE_LINKS[link.type];
    if (phases && !phases.includes(phase.id)) throw new Error(link.type + ' links are authored during ' + phases.join(' or ') + '; this Flow is in ' + phase.id
      + (phases.every(p => PHASES.findIndex(([id]) => id === p) < PHASES.findIndex(([id]) => id === phase.id)) ? '. Reopen ' + phases.at(-1) + ' to change them.' : '.'));
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
module.exports = { submit, SHAPES, PHASE_LINKS, allowedLinks };

'use strict';
const { randomUUID } = require('node:crypto');
const {templateSnapshot,flowKind}=require('./templates.cjs');
const PHASES = Object.freeze([
  ['requirements', 'Requirements'], ['analysis', 'Source Analyst'], ['architecture', 'Architect'],
  ['planning', 'Planner'], ['development', 'Developer'], ['quality', 'Quality Reviewer'], ['review', 'Reviewer'],
]);
const LABELS = Object.freeze(['Flow', 'Phase', 'Requirement', 'AcceptanceCriterion', 'TestCase', 'SourceAnalysis', 'ArchitectureDecision']);
const RELATIONS = Object.freeze(['HAS_PHASE', 'HAS_REQUIREMENT', 'HAS_CRITERION', 'VALIDATED_BY',
  'VALIDATES', 'IMPLEMENTED_BY', 'IMPLEMENTS', 'IMPACTS', 'DERIVES', 'REFERENCES', 'PROMOTED_TO']);
const CODE_LABELS = Object.freeze(['File', 'Function', 'Class', 'Component', 'Module', 'Endpoint']);
function meaningful(value, name, min = 12) {
  if (typeof value !== 'string' || value.trim().length < min || /^(todo|tbd|placeholder|n\/a|\.\.\.)[.! ]*$/i.test(value.trim()))
    throw new Error(name + ' needs meaningful text (at least ' + min + ' characters)');
  return value.trim();
}
function key(value, name = 'id') {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(value)) throw new Error('Invalid ' + name);
  return value;
}
function createChange({ title, description, slug, workspace = 'project_db', agent = 'Lead', kind = 'feature', template = 'engineering' }, now = Date.now()) {
  meaningful(title, 'title', 8); meaningful(description, 'description');
  slug = key(slug || title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0,70), 'slug');
  if (!['project_db', 'codevis_db'].includes(workspace)) throw new Error('Invalid workflow workspace');
  const workflowTemplate=templateSnapshot(template);
  return { kind:flowKind(kind), template:workflowTemplate, version: 1, changeId: randomUUID(), slug, workspace, title, description, revision: 1,
    status: 'active', currentPhase: 'requirements', createdAt: now, updatedAt: now,
    phases: workflowTemplate.phases.map((id, index) => ({ id, role:PHASES.find(p=>p[0]===id)[1], status: index ? 'pending' : 'active',
      agent: index ? null : agent, startedAt: index ? null : now, completedAt: null, submissions: [], gate: null })),
    entities: [], links: [], artifacts: [], history: [] };
}
function uid(state, id) { return 'change:' + state.changeId + ':' + id; }
function validateState(state) {
  if (state?.version !== 1 || !/^[0-9a-f-]{36}$/.test(state.changeId || '') ||
      !Number.isSafeInteger(state.revision) || state.revision < 1) throw new Error('Invalid Change state');
  key(state.slug, 'slug'); meaningful(state.title, 'title', 8);
  if (!['project_db', 'codevis_db'].includes(state.workspace)) throw new Error('Invalid workflow workspace');
  if(state.kind)flowKind(state.kind);
  const expected=state.template?.phases||PHASES.map(p=>p[0]);
  if(!Array.isArray(expected)||!expected.length||new Set(expected).size!==expected.length||expected.some(id=>!PHASES.some(p=>p[0]===id)))throw new Error('Invalid template phase snapshot');
  if (!Array.isArray(state.phases) || state.phases.length !== expected.length ||
      state.phases.some((p, i) => p.id !== expected[i] || !Array.isArray(p.submissions))) throw new Error('Invalid phases');
  if (!['active', 'done'].includes(state.status) || !PHASES.some(([p]) => p === state.currentPhase)) throw new Error('Invalid workflow status');
  for (const list of ['entities', 'links', 'artifacts', 'history']) if (!Array.isArray(state[list])) throw new Error('Invalid ' + list);
  const ids = new Set(['change', ...PHASES.map(([id]) => id)]);
  for (const entity of state.entities) {
    key(entity.id); if (ids.has(entity.id)) throw new Error('Duplicate entity ' + entity.id); ids.add(entity.id);
    if (!['Requirement', 'AcceptanceCriterion', 'TestCase', 'ArchitectureDecision'].includes(entity.label)) throw new Error('Invalid workflow entity label');
    meaningful(entity.title, entity.id); meaningful(entity.content, entity.id);
    if (!PHASES.some(([id]) => id === entity.phase)) throw new Error('Invalid entity origin');
  }
  if(state.testBindings!==undefined){
    if(!Array.isArray(state.testBindings)||state.testBindings.length>2000)throw new Error('Invalid test bindings');
    for(const b of state.testBindings)if(!b||!state.entities.some(e=>e.id===b.testCaseId&&e.label==='TestCase')||typeof b.check!=='string'||typeof b.file!=='string'||typeof b.name!=='string'||typeof b.implementation?.nodeId!=='string')throw new Error('Invalid test binding');
  }
  for (const link of state.links) {
    if (!RELATIONS.includes(link.type)) throw new Error('Invalid relationship ' + link.type);
    for (const endpoint of [link.from, link.to]) {
      if (typeof endpoint === 'string') { if (!ids.has(endpoint)) throw new Error('Unknown workflow endpoint ' + endpoint); }
      else if (!endpoint || typeof endpoint.nodeId !== 'string' || !endpoint.nodeId) throw new Error('External endpoint needs elementId');
    }
  }
  return state;
}
module.exports = { PHASES, LABELS, RELATIONS, CODE_LABELS, meaningful, key, uid, createChange, validateState };

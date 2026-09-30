'use strict';
const { KIND_GOALS } = require('./templates.cjs');
const { PHASES } = require('./model.cjs');
const { allowedLinks } = require('./submission.cjs');
const CONTRACTS = {
  requirements: { goal: 'Define intended behavior and test intent before implementation design.',
    allowedActions: ['clarify scope', 'record requirements and acceptance criteria', 'define behavioral TestCases'],
    fields: ['problem', 'desiredBehavior', 'scope', 'nonGoals', 'constraints', 'assumptions', 'openQuestions'],
    checks: ['Requirements and measurable criteria exist', 'Every criterion has test intent', 'Blocking questions are resolved or explicitly accepted'] },
  analysis: { goal: 'Use the source graph to predict impact and discover regression scenarios. Distinguish facts, approximations and inference.',
    allowedActions: ['impact', 'analysis_quality', 'predefined_queries', 'read source and related Knowledge/Specs/Tasks', 'add technical TestCases with reasons'],
    fields: ['facts', 'approximations', 'inferences', 'risks', 'testRationale'],
    checks: ['Current graph or explicit planning-mode limitation', 'Predicted source links resolve', 'Analysis test intentions explain their origin'] },
  architecture: { goal: 'Choose the simplest design that satisfies the requirements and existing boundaries.',
    allowedActions: ['record major ArchitectureDecision entities or reference existing decision Knowledge', 'link relevant Spec diagrams', 'compare alternatives'],
    fields: ['responsibilities', 'interfaces', 'compatibility', 'errorHandling', 'testability', 'alternatives', 'simplicity'],
    checks: ['Design reasoning is recorded', 'Approval identifies reviewer and rationale'] },
  planning: { goal: 'Create bounded, reviewable implementation Tasks using the existing Task/Epic tools.',
    allowedActions: ['create_task', 'plan_task_scope', 'plan_task_waves', 'link Tasks to requirements and TestCases'],
    fields: ['strategy', 'dependencies'], checks: ['Every requirement has an implementing Task', 'Referenced Tasks exist'] },
  development: { goal: 'Implement planned Tasks and turn previously defined TestCases into executable tests.',
    allowedActions: ['claim_task', 'read task context', 'edit within task scope', 'run tests', 'link test and production symbols', 'bind exact runner selectors with testBindings; read flow_read view tests', 'complete_task'],
    fields: ['summary', 'validation'], checks: ['Tasks are reviewable or done', 'TestCases link to executable test source and validated production source'] },
  quality: { goal: 'Evaluate traceability, actual impact, tests and quality deltas using current evidence.',
    allowedActions: ['analysis_quality', 'predefined_queries', 'inspect Git diff', 'run configured checks', 'explain scope expansion'],
    fields: ['summary', 'scopeExplanations'], checks: ['Current graph', 'No blocking traceability or configured policy errors', 'Recorded checks match current source'] },
  review: { goal: 'Review requirements, implementation and evidence; explicitly disposition remaining warnings.',
    allowedActions: ['inspect artifacts, tests and diff', 'rerun configured checks when execution evidence is missing or stale', 'record review decision', 'reopen an earlier phase with a reason'],
    fields: ['summary', 'disposition'], checks: ['Explicit approval with reviewer and rationale', 'Earlier artifacts and quality evidence remain valid'] },
};
function phaseInstructions(state) {
  if (state.status === 'done') return { phase: 'done', goal: 'Change is complete.', allowedActions: ['inspect', 'reopen'], revision: state.revision };
  const phase = state.currentPhase, contract = CONTRACTS[phase];
  return { kind:state.kind||'feature', kindGuidance:KIND_GOALS[state.kind]||null, template:state.template||{id:'engineering',version:1}, phase, role: PHASES.find(([id]) => id === phase)[1], revision: state.revision, ...contract,
    requiredOutput: { markdown: 'Detailed human-readable reasoning', data: Object.fromEntries(contract.fields.map(f => [f, f === 'openQuestions' ? 'Array of {question, blocking, resolution, acceptedBy}' : 'Meaningful text'])),
      entities: 'Array of {id,label,title,content}; labels: Requirement, AcceptanceCriterion, TestCase; ArchitectureDecision during Architecture. TestCases include origin and reason.',
      ...(phase==='development'?{testBindings:'Optional replacement array of {testCaseId, check, file, name, line?, implementation:{nodeId}}. Check must configure testReport: codevis-json; implementation must already be linked via IMPLEMENTED_BY. Never author a PASS result.'}:{}),
      links: 'Array of {from,to,type}; local IDs or external {nodeId}: an elementId, or a Task taskId / Epic epicId. Allowed types this phase: see allowedLinks.',
      judgment: 'Architecture/review: {decision: approved, reviewer, rationale}' },
    allowedLinks: allowedLinks(phase),
    completionContract: { deterministic: contract.checks, judgment: 'Natural-language correctness and design suitability require review; structure checks cannot prove them.' } };
}
module.exports = { CONTRACTS, phaseInstructions };

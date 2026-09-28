'use strict';
const { graphView } = require('./projection.cjs');
const { phaseInstructions } = require('./instructions.cjs');
const { readArtifact } = require('./artifacts.cjs');
const { analyzeImpactFromSession } = require('../../scripts/impact/impact_reader.cjs');
async function compileContext(session, state, options, context) {
  const graph = await graphView(session, state, context);
  let selected = new Set(), task = null;
  if (options.taskId) {
    task = graph.nodes.find(n => n.label === 'Task' && (n.taskId === options.taskId || n.id === options.taskId));
    if (!task) throw new Error('Task is not linked to this Change');
    selected.add(task.id);
    // One task's explicit obligations, then their criteria/test cases; never walk via Phase/Change.
    for (const l of graph.links) if (l.from === task.id && ['IMPLEMENTS','AFFECTS','DEPENDS_ON'].includes(l.type)) selected.add(l.to);
    for (let i = 0; i < 3; i++) for (const l of graph.links) {
      if (['HAS_CRITERION','VALIDATED_BY','VALIDATES','IMPLEMENTED_BY'].includes(l.type) && selected.has(l.from)) selected.add(l.to);
      if (l.type === 'VALIDATED_BY' && selected.has(l.to)) selected.add(l.from);
    }
  } else {
    for (const n of graph.nodes) if (n.label !== 'Phase' && !['Change','Flow'].includes(n.label) || n.key === state.currentPhase) selected.add(n.id);
  }
  const nodes = graph.nodes.filter(n => selected.has(n.id)).sort((a,b)=>a.id.localeCompare(b.id));
  const maxNodes = 100, maxCharacters = 24000;
  let used = 0; const included = [];
  for (const n of nodes.slice(0,maxNodes)) {
    const size = JSON.stringify(n).length;
    if (used + size > maxCharacters) break;
    included.push(n); used += size;
  }
  const ids = new Set(included.map(n=>n.id));
  const knowledge = await session.run('MATCH (k:Knowledge)-[:APPLIES_TO]->(n) RETURN elementId(k) AS id, k.name AS name, k.content AS content, elementId(n) AS target');
  const applicableKnowledge = knowledge.records.filter(r=>selected.has(r.get('target'))).map(r=>({id:r.get('id'),name:r.get('name'),content:r.get('content')}));
  const boundedKnowledge = [];
  for (const item of applicableKnowledge.slice(0,10)) {
    const remaining = Math.max(0,maxCharacters-used);
    const content = String(item.content || '').slice(0,remaining);
    boundedKnowledge.push({...item,content,truncated:content.length < String(item.content || '').length}); used += content.length;
  }
  const artifactPhases = options.taskId ? ['architecture'] : {requirements:[],analysis:['requirements'],architecture:['requirements','analysis'],planning:['architecture'],development:['architecture','planning'],quality:['analysis','development'],review:['quality']}[state.currentPhase];
  const artifacts = [];
  for (const phaseId of artifactPhases || []) {
    const artifact = state.phases.find(p=>p.id===phaseId)?.submissions.at(-1)?.artifact;
    if (artifact) { const text = readArtifact(context, artifact); const remaining = Math.max(0,maxCharacters-used); artifacts.push({...artifact,content:text.slice(0,remaining),truncated:text.length>remaining}); used += Math.min(remaining,text.length); }
  }
  const impact = [];
  if (options.includeImpact) for (const n of included.filter(n=>n.source).slice(0,3)) {
    impact.push(await analyzeImpactFromSession(session, {seed:{id:n.id},profile:'fast',depth:1,maxNodes:25,...context}));
  }
  let origin;
  if(!options.taskId&&state.origin){
    const content=state.origin.content.slice(0,Math.max(0,Math.min(8000,maxCharacters-used)));used+=content.length;
    origin={ideaId:state.origin.ideaId,nodeId:state.origin.nodeId,capturedAt:state.origin.capturedAt,content,contextCount:state.origin.context.length,selection:state.origin.selection,truncated:content.length<state.origin.content.length};
  }
  return { origin, change: {slug:state.slug,title:state.title,revision:state.revision}, instructions: phaseInstructions(state), task,
    nodes:included, links:graph.links.filter(l=>ids.has(l.from)&&ids.has(l.to)), artifacts,
    knowledge:boundedKnowledge, impact, policies:context.config.workflow?.policies || {},
    selection:'Explicit task IMPLEMENTS links, requirement criteria/test intent, validation source, applicable Knowledge and architecture artifact; optional bounded impact.',
    budget:{maxNodes,maxCharacters,selectedNodes:included.length,selectedCharacters:used},
    truncation:{nodes:nodes.length>included.length,knowledge:applicableKnowledge.length>10,characters:used>=maxCharacters}, unresolved:graph.unresolved };
}
module.exports = { compileContext };

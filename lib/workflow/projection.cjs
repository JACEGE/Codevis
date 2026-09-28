'use strict';
const { uid, RELATIONS, CODE_LABELS } = require('./model.cjs');
const { resolveRebuiltTargetUid } = require('../source-reference.cjs');
const rowNode = r => ({ id: String(r.get('id')), label: r.get('label'), name: r.get('name'),
  file: r.get('file'), path: r.get('path'), owner: r.get('owner'), status: r.get('status'),
  taskId: r.get('taskId'), assignedTo: r.get('assignedTo'), wave:r.get('wave'), content:r.get('content'), description: r.get('description'), workInstructions: r.get('workInstructions'), bodySnippet:r.get('bodySnippet'), params:r.get('params') });
const FIELDS = 'elementId(n) AS id, n.label AS label, coalesce(n.title,n.name,n.path) AS name, n.file AS file, n.path AS path, n.owner AS owner, n.status AS status, n.taskId AS taskId, n.assignedTo AS assignedTo,n.wave AS wave, n.content AS content, n.description AS description, n.workInstructions AS workInstructions,n.bodySnippet AS bodySnippet,n.params AS params';
async function resolveReference(session, ref) {
  const exact = await session.run('MATCH (n) WHERE elementId(n)=$id RETURN ' + FIELDS, { id: ref.nodeId });
  if (exact.records.length === 1) {
    const n = rowNode(exact.records[0]);
    // A rebuilt numeric-derived UID can be reused by older graphs. Verify the stored selector.
    if (!ref.label || (!CODE_LABELS.includes(n.label) && n.label===ref.label) || (n.label === ref.label && (!ref.file || n.file === ref.file) &&
        (!ref.path || n.path === ref.path) && (!ref.name || n.name === ref.name) && (n.owner || '') === (ref.owner || ''))) return n;
  }
  if (!ref.label || !(ref.file || ref.path)) return null;
  const found = await session.run('MATCH (n) WHERE n.label=$label AND coalesce(n.file,n.path)=$file AND coalesce(n.title,n.name,n.path)=$name AND coalesce(n.owner,\'\')=$owner RETURN ' + FIELDS,
    { label: ref.label, file: ref.file || ref.path, name: ref.name, owner: ref.owner || '' });
  if (found.records.length === 1) return rowNode(found.records[0]);
  // Same resolver as full/incremental rebuild: unique body+parameters only, never a guessed rename.
  if (ref.bodySnippet) {
    const recovered = await resolveRebuiltTargetUid(session, { ...ref, uid: null, nodeLabels:[ref.label] });
    if (recovered) return resolveReference(session,{nodeId:recovered.uid});
  }
  return null;
}
function reference(n) { return { nodeId: n.id, label: n.label, name: n.name, file: n.file, path: n.path, owner: n.owner,bodySnippet:n.bodySnippet,params:n.params }; }
function ownedNodes(state, executions = []) {
  return [{ id: 'change', label: 'Flow', title: state.title, content: state.description, status: state.status, data:{kind:state.kind||'feature',template:state.template,origin:state.origin||null} },
    ...state.phases.map(p => ({ id: p.id, label: 'Phase', title: p.id, content: p.role, status: p.status, data: p })),
    ...state.entities.map(e => ({ ...e, data: e.label==='TestCase'?{...e,execution:executions.find(x=>x.testCaseId===e.id)||{status:'unknown',reason:'No current execution evidence.'}}:e })),
    ...state.phases.filter(p=>p.id==='analysis'&&p.submissions.length).map(p=>({id:'analysis-result',label:'SourceAnalysis',title:'Source analysis findings',content:p.submissions.at(-1).data.facts,status:p.status,data:p.submissions.at(-1)}))];
}
function intendedLinks(state) {
  return [...state.phases.map(p => ({ from: 'change', to: p.id, type: 'HAS_PHASE' })),
    ...state.entities.map(e => ({ from: e.phase, to: e.id, type: 'DERIVES' })), ...state.links,
    ...(state.phases.find(p=>p.id==='analysis')?.submissions.length ? [
      {from:'analysis',to:'analysis-result',type:'DERIVES'},
      ...state.links.filter(l=>l.from==='analysis'&&l.type==='IMPACTS').map(l=>({...l,from:'analysis-result'})),
      ...state.entities.filter(e=>e.phase==='analysis'&&e.label==='TestCase').map(e=>({from:'analysis-result',to:e.id,type:'DERIVES'})),
    ]:[])];
}
async function graphView(session, state, context) {
  const executions=require('./test-results.cjs').testResults(state,context).cases;
  const nodes = ownedNodes(state,executions).map(n => ({ ...n, key: n.id==='change'?'FLOW-'+state.changeId.slice(0,8).toUpperCase():n.id, id: uid(state, n.id) }));
  const links = [], unresolved = [], resolved = new Map();
  const endpoint = async ref => {
    if (typeof ref === 'string') return uid(state, ref);
    const cacheKey = JSON.stringify(ref);
    if (!resolved.has(cacheKey)) resolved.set(cacheKey, await resolveReference(session, ref));
    const n = resolved.get(cacheKey);
    if (!n) return null;
    if (!nodes.some(x => x.id === n.id)) nodes.push({ ...n, external: true, source: CODE_LABELS.includes(n.label) });
    return n.id;
  };
  for (const link of intendedLinks(state)) {
    const from = await endpoint(link.from), to = await endpoint(link.to);
    if (!from || !to) { unresolved.push(link); continue; }
    links.push({ ...link, from, to });
  }
  const taskIds = new Set(nodes.filter(n=>n.label==='Task').map(n=>n.id));
  for (const type of ['AFFECTS','DEPENDS_ON','APPLIES_TO']) {
    const attachedIds=type==='APPLIES_TO'?new Set(nodes.filter(n=>n.label==='Knowledge').map(n=>n.id)):taskIds;
    if (!attachedIds.size) continue;
    const label=type==='APPLIES_TO'?'Knowledge':'Task';
    const rows = await session.run('MATCH (t:'+label+')-[:' + type + ']->(n) RETURN elementId(t) AS task, ' + FIELDS);
    for (const row of rows.records) {
      if (!attachedIds.has(row.get('task'))) continue;
      const n = rowNode(row);
      if (!nodes.some(x=>x.id===n.id)) nodes.push({...n,external:true,source:CODE_LABELS.includes(n.label)});
      links.push({from:row.get('task'),to:n.id,type,managed:false});
    }
  }
  return { nodes, links, unresolved };
}
async function projectChange(session, state, context) {
  const view = await graphView(session, state, context);
  const executions=view.nodes.filter(n=>n.label==='TestCase').map(n=>n.data.execution);
  await session.withTransaction(async tx => {
    // Only delete this projection's relationships. Shared Tasks/source remain untouched.
    for (const type of RELATIONS) await tx.run('MATCH ()-[r:' + type + ']->() WHERE r.kind=$kind DELETE r', { kind: 'change:' + state.changeId });
    const wanted = new Set(ownedNodes(state).map(n => uid(state, n.id)));
    const old = await tx.run('MATCH (n) WHERE n.changeId=$changeId RETURN elementId(n) AS id', { changeId: state.changeId });
    for (const row of old.records) if (!wanted.has(row.get('id'))) await tx.run('MATCH (n) WHERE elementId(n)=$id DETACH DELETE n', { id: row.get('id') });
    for (const n of ownedNodes(state,executions)) {
      await tx.run('MERGE (n:' + n.label + ' {uid:$id}) SET n.label=$label, n.changeId=$changeId, n.title=$title, n.name=$name, n.content=$content, n.status=$status, n.revision=$revision, n.kind=$kind, n.result=$result, n.updatedAt=$updatedAt, n.createdAt=$createdAt',
        { label:n.label, id: uid(state, n.id), changeId: state.changeId, title: n.title, name: n.id, content: n.content || '', status: n.status || 'defined', revision: state.revision,
          kind: n.phase || n.id, result: JSON.stringify(n.data || {}), updatedAt: state.updatedAt, createdAt: state.createdAt });
    }
    for (const link of view.links.filter(l=>l.managed !== false)) await tx.run('MATCH (a),(b) WHERE elementId(a)=$from AND elementId(b)=$to MERGE (a)-[r:' + link.type + ']->(b) SET r.kind=$kind',
      { from: link.from, to: link.to, kind: 'change:' + state.changeId });
  });
  return view;
}
module.exports = { resolveReference, reference, ownedNodes, intendedLinks, graphView, projectChange };

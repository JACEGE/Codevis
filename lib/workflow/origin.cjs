'use strict';
const {reference}=require('./projection.cjs');
const {CODE_LABELS}=require('./model.cjs');
const {flowKind}=require('./templates.cjs');
async function ideaContext(session,ideaId) {
  if(typeof ideaId!=='string'||!ideaId)throw new Error('ideaId is required');
  const found=await session.run('MATCH (i:Idea) WHERE i.taskId=$id OR elementId(i)=$id RETURN elementId(i) AS id,i.taskId AS ideaId,i.content AS content,i.kind AS kind,i.category AS intent',{id:ideaId});
  if(found.records.length!==1)throw new Error('Idea does not exist in this workspace');
  const row=found.records[0],idea={id:row.get('id'),ideaId:row.get('ideaId'),content:row.get('content'),kind:row.get('kind')||null};
  const contexts=new Map();
  for(const type of ['REFERENCES','APPLIES_TO','AFFECTS']){
    const linked=await session.run('MATCH (i:Idea)-[:'+type+']-(n) WHERE elementId(i)=$id RETURN elementId(n) AS id,n.label AS label,coalesce(n.title,n.name,n.path) AS name,n.file AS file,n.path AS path,n.owner AS owner,n.content AS content,n.bodySnippet AS bodySnippet,n.params AS params',{id:idea.id});
    for(const r of linked.records){const n={};for(const key of ['id','label','name','file','path','owner','content','bodySnippet','params'])n[key]=r.get(key);if(CODE_LABELS.includes(n.label)||n.label==='Knowledge'||String(n.label).startsWith('Spec'))contexts.set(n.id,n);}
  }
  return {idea,context:[...contexts.values()].sort((a,b)=>a.id.localeCompare(b.id)),selection:'Only direct REFERENCES, APPLIES_TO or AFFECTS links to Knowledge, Specs or source. No repository-wide context is inferred.'};
}
async function applyIdeaOrigin(session,state,options) {
  const captured=await ideaContext(session,options.ideaId);
  state.kind=flowKind(options.kind||captured.idea.kind||'feature');
  state.origin={ideaId:captured.idea.ideaId,nodeId:captured.idea.id,content:captured.idea.content,capturedAt:Date.now(),context:captured.context.map(reference),selection:captured.selection};
  state.links.push({from:{nodeId:captured.idea.id,label:'Idea',name:captured.idea.ideaId},to:'change',type:'PROMOTED_TO',phase:'requirements'});
  for(const node of captured.context)state.links.push({from:'requirements',to:reference(node),type:'REFERENCES',phase:'requirements'});
}
module.exports={ideaContext,applyIdeaOrigin};

'use strict';
const {listStates}=require('./artifacts.cjs');
const {graphView,resolveReference}=require('./projection.cjs');
const {isTestPath}=require('../../scripts/test-file.cjs');
const FORWARD=new Set(['HAS_CRITERION','VALIDATED_BY','VALIDATES','IMPLEMENTED_BY','IMPLEMENTS','AFFECTS']);
const REVERSE=new Set(['HAS_CRITERION','VALIDATED_BY','IMPLEMENTS','VALIDATES','IMPLEMENTED_BY','AFFECTS']);
function traceSelection(graph,seed,maxNodes=200) {
  const nodes=new Map(graph.nodes.map(n=>[n.id,n]));if(!nodes.has(seed))return {nodes:[],links:[],truncated:false};
  const selected=new Set([seed]),queue=[seed];let truncated=false;
  const include=id=>{if(selected.has(id)||!nodes.has(id))return;if(selected.size>=maxNodes){truncated=true;return;}selected.add(id);queue.push(id);};
  // Walk obligations and proof. Never expand through a Flow or Phase to siblings.
  while(queue.length){const id=queue.shift();const node=nodes.get(id);
    if(['Flow','Change','Phase','SourceAnalysis','Idea'].includes(node.label))continue;
    for(const link of graph.links){
      if(link.from===id&&FORWARD.has(link.type))include(link.to);
      if(link.to===id&&REVERSE.has(link.type))include(link.from);
    }
  }
  // Add provenance only after selecting the implementation/validation branch.
  for(let pass=0;pass<3;pass++)for(const link of graph.links){
    if(selected.has(link.to)&&['HAS_REQUIREMENT','HAS_PHASE','DERIVES','IMPACTS','REFERENCES','APPLIES_TO'].includes(link.type))include(link.from);
    if(selected.has(link.to)&&link.type==='PROMOTED_TO')include(link.from);
  }
  return {nodes:graph.nodes.filter(n=>selected.has(n.id)),links:graph.links.filter(l=>selected.has(l.from)&&selected.has(l.to)),truncated};
}
async function traceFlow(session,options,context) {
  if(typeof options.nodeId!=='string'||!options.nodeId)throw new Error('nodeId is required');
  const nodes=new Map(),links=new Map(),flows=[];let truncated=false;
  const states=listStates(context);const maxNodes=200;
  for(const state of states){
    if(options.slug&&state.slug!==options.slug)continue;
    const graph=await graphView(session,state,context);
    if(!graph.nodes.some(n=>n.id===options.nodeId))continue;
    const result=traceSelection(graph,options.nodeId,maxNodes);
    flows.push({slug:state.slug,title:state.title,status:state.status});truncated ||= result.truncated;
    for(const n of result.nodes){if(nodes.size<maxNodes||nodes.has(n.id))nodes.set(n.id,n);else truncated=true;}
    for(const l of result.links)links.set(l.from+'|'+l.type+'|'+l.to,l);
  }
  if(!nodes.size){const seed=await resolveReference(session,{nodeId:options.nodeId});if(seed)nodes.set(seed.id,seed);}
  const edges=[...links.values()].filter(l=>nodes.has(l.from)&&nodes.has(l.to));
  const findings=[];
  for(const n of nodes.values()){
    const outgoing=type=>edges.filter(l=>l.from===n.id&&l.type===type);
    if(n.label==='Requirement'){
      const criteria=outgoing('HAS_CRITERION');
      if(!outgoing('VALIDATED_BY').length&&(!criteria.length||criteria.some(ac=>!edges.some(l=>l.from===ac.to&&l.type==='VALIDATED_BY'))))findings.push({nodeId:n.id,code:'missing-test-intent',message:'Requirement has incomplete test intent.'});
    }
    if(n.label==='TestCase'&&!outgoing('IMPLEMENTED_BY').length)findings.push({nodeId:n.id,code:'missing-test-implementation',message:'TestCase has no executable test link.'});
    if(n.label==='Task'&&!outgoing('IMPLEMENTS').length)findings.push({nodeId:n.id,code:'missing-task-obligation',message:'Task is not linked to a requirement or TestCase.'});
  }
  return {seed:options.nodeId,flows,findings,truncated,limit:maxNodes,
    graph:{nodes:[...nodes.values()].map(n=>({...n,labels:[n.label],name:n.title||n.name||n.key,isTest:isTestPath(n.file||n.path)})),links:edges.map(l=>({source:l.from,target:l.to,relType:l.type}))},
    note:truncated?'Trace is capped; missing links in this partial view are not proof of missing graph relationships.':'Recorded obligations, test intent, implementation and provenance; static links are not proof of runtime coverage.'};
}
module.exports={traceSelection,traceFlow};

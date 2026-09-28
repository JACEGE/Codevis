const test=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');const os=require('node:os');
const {openTestDb}=require('./helpers/ladybug-session.cjs');
const {changeOperation}=require('../lib/workflow/service.cjs');
const {traceSelection}=require('../lib/workflow/trace.cjs');
const {requirements}=require('./helpers/workflow.cjs');

test('Idea promotion preserves provenance, supports multiple Flows, retries safely and creates no Tasks',async()=>{
 const db=await openTestDb();const projectRoot=fs.mkdtempSync(path.join(os.tmpdir(),'codeflow-promotion-'));
 const ctx={projectRoot,workspace:'project_db',config:{workMode:'planning'},sourceDirs:[]};
 const request={operation:'promote_idea',slug:'rotation',ideaId:'idea-1',title:'Refresh token rotation',description:'Reject reused refresh tokens without ending active sessions.'};
 try{
  await db.session.run("MERGE (:Idea {uid:'idea:one',taskId:'idea-1',name:'idea-1',content:'Raw token rotation idea with unanswered questions.',kind:'bug',status:'open'})");
  await db.session.run("MERGE (:Knowledge {uid:'knowledge:one',name:'Session constraint',content:'Preserve existing session identifiers during rotation.'})");
  await db.session.run("MERGE (:Function {uid:'source:one',name:'rotate',file:'src/token.js'})");
  await db.session.run("MERGE (:Knowledge {uid:'knowledge:unrelated',name:'Unrelated',content:'Do not send unrelated knowledge to the agent.'})");
  await db.session.run("MATCH (i),(k) WHERE elementId(i)='idea:one' AND elementId(k)='knowledge:one' CREATE (i)-[:REFERENCES]->(k)");
  await db.session.run("MATCH (i),(n) WHERE elementId(i)='idea:one' AND elementId(n)='source:one' CREATE (i)-[:AFFECTS]->(n)");
  const first=await changeOperation(db.session,request,ctx);assert.equal(first.status,'OK');assert.equal(first.state.kind,'bug');assert.equal(first.state.currentPhase,'requirements');assert.equal(first.state.template.version,1);
  assert.ok(first.graph.links.some(l=>l.type==='PROMOTED_TO'&&l.from==='idea:one'));
  assert.ok(!first.graph.nodes.some(n=>n.label==='Task'));
  const repeated=await changeOperation(db.session,request,ctx);assert.equal(repeated.state.changeId,first.state.changeId);
  const second=await changeOperation(db.session,{...request,slug:'cleanup',title:'Session cleanup behavior'},ctx);assert.notEqual(second.state.changeId,first.state.changeId);
  const origin=await db.session.run("MATCH (i:Idea)-[:PROMOTED_TO]->(f:Flow) RETURN i.status AS status,count(f) AS count");assert.equal(origin.records[0].get('status'),'open');assert.equal(Number(origin.records[0].get('count')),2);
  const tasks=await db.session.run('MATCH (n:Task) RETURN count(n) AS count');assert.equal(Number(tasks.records[0].get('count')),0);
  const context=await changeOperation(db.session,{operation:'read',slug:'rotation',view:'context'},ctx);
  assert.match(context.origin.content,/unanswered/);assert.ok(context.nodes.some(n=>n.id==='knowledge:one'&&n.content.includes('session identifiers')));assert.ok(!context.nodes.some(n=>n.id==='knowledge:unrelated'));
  assert.match(context.instructions.kindGuidance,/reproduction/);
  await assert.rejects(changeOperation(db.session,{...request,slug:'bad',ideaId:'missing'},ctx),/does not exist/);
  assert.ok(!require('../lib/workflow/artifacts.cjs').listStates(ctx).some(s=>s.slug==='bad'));
  const submitted=await changeOperation(db.session,{operation:'submit',slug:'rotation',expectedRevision:first.state.revision,...requirements},ctx);
  const trace=await changeOperation(db.session,{operation:'trace',nodeId:submitted.graph.nodes.find(n=>n.key==='REQ-1').id},ctx);
  assert.ok(trace.graph.nodes.some(n=>n.labels.includes('Flow')));assert.ok(trace.graph.nodes.some(n=>n.id==='idea:one'));assert.ok(trace.findings.some(f=>f.code==='missing-test-implementation'));
  assert.equal(trace.flows.length,1);
 }finally{await db.cleanup();fs.rmSync(projectRoot,{recursive:true,force:true});}
});
test('source trace follows proof and obligations without expanding sibling requirements through a Flow',()=>{
 const graph={nodes:[['f','Flow'],['p','Phase'],['r','Requirement'],['other','Requirement'],['ac','AcceptanceCriterion'],['tc','TestCase'],['s','Function'],['test','Function'],['t','Task']].map(([id,label])=>({id,label})),links:[
  ['f','r','HAS_REQUIREMENT'],['f','other','HAS_REQUIREMENT'],['f','p','HAS_PHASE'],['p','r','DERIVES'],['r','ac','HAS_CRITERION'],['ac','tc','VALIDATED_BY'],['tc','s','VALIDATES'],['tc','test','IMPLEMENTED_BY'],['t','r','IMPLEMENTS'],['t','s','AFFECTS']].map(([from,to,type])=>({from,to,type}))};
 const trace=traceSelection(graph,'s');assert.ok(trace.nodes.some(n=>n.id==='f'));assert.ok(trace.nodes.some(n=>n.id==='test'));assert.ok(trace.nodes.some(n=>n.id==='t'));assert.ok(!trace.nodes.some(n=>n.id==='other'));
 const capped=traceSelection(graph,'s',3);assert.equal(capped.nodes.length,3);assert.equal(capped.truncated,true);assert.ok(capped.links.every(l=>capped.nodes.some(n=>n.id===l.from)&&capped.nodes.some(n=>n.id===l.to)));
});
test('Testing perspective distinguishes intent from executable source and edge overrides remain independent',async()=>{
 const {perspectiveGraph}=await import('../frontend/src/graph/perspectives.js');
 const graph={nodes:[{id:'r',labels:['Requirement']},{id:'missing',labels:['Requirement']},{id:'tc',labels:['TestCase']},{id:'s',labels:['Function']},{id:'test',labels:['Function'],isTest:true},{id:'unrelated',labels:['Function']}],links:[{source:'r',target:'tc',relType:'VALIDATED_BY'},{source:'tc',target:'s',relType:'VALIDATES'},{source:'tc',target:'test',relType:'IMPLEMENTED_BY'},{source:'s',target:'test',relType:'CALLS'}]};
 const testing=perspectiveGraph(graph,'testing');assert.ok(testing.nodes.some(n=>n.id==='missing'));assert.ok(!testing.nodes.some(n=>n.id==='unrelated'));assert.ok(!testing.links.some(l=>l.relType==='CALLS'));
 const override=perspectiveGraph(graph,'testing',new Set());assert.ok(override.links.some(l=>l.relType==='CALLS'));
 const hidden=perspectiveGraph(graph,'testing',new Set(['VALIDATES']),false);assert.ok(!hidden.nodes.some(n=>n.id==='test'));assert.ok(!hidden.links.some(l=>l.relType==='VALIDATES'));
});

test('analysis findings and architecture decisions are persisted as graph entities with source relationships',async()=>{
 const db=await openTestDb();
 try {
  const state=require('../lib/workflow/model.cjs').createChange({title:'Refactor token storage',description:'Preserve rotation behavior while simplifying persistence.'});
  await db.session.run("MERGE (:Function {uid:'code:rotate',name:'rotate',file:'src/token.js'})");
  state.phases.find(p=>p.id==='analysis').submissions.push({revision:2,agent:'Lead',role:'Source Analyst',data:{facts:'The rotate function persists each replacement.',approximations:'Static callers may omit callback invocations.',inferences:'Concurrent writes need transactional coordination.',risks:'Session identity must remain unchanged.'}});
  state.links.push({from:'analysis',to:{nodeId:'code:rotate',label:'Function',name:'rotate',file:'src/token.js'},type:'IMPACTS'});
  state.entities.push({id:'ADR-1',label:'ArchitectureDecision',title:'Keep replacement atomic',content:'Use one transaction so a concurrent request cannot reuse the old token.',phase:'architecture'});
  state.links.push({from:'ADR-1',to:{nodeId:'code:rotate',label:'Function',name:'rotate',file:'src/token.js'},type:'REFERENCES'});
  await require('../lib/workflow/projection.cjs').projectChange(db.session,state);
  const analysis=await db.session.run('MATCH (a:SourceAnalysis)-[:IMPACTS]->(f:Function) RETURN a.content AS facts,f.name AS name');assert.equal(analysis.records.length,1);assert.match(analysis.records[0].get('facts'),/persists/);
  const decisions=await db.session.run('MATCH (d:ArchitectureDecision)-[:REFERENCES]->(f:Function) RETURN count(f) AS count');assert.equal(Number(decisions.records[0].get('count')),1);
 }finally{await db.cleanup();}
});

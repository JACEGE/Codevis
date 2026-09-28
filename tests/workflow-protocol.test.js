'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'); const os=require('node:os'); const path=require('node:path');
const {openTestDb}=require('./helpers/ladybug-session.cjs');
const {changeOperation}=require('../lib/workflow/service.cjs');
const {requirements}=require('./helpers/workflow.cjs');
async function fixture() {
  const db=await openTestDb(); const projectRoot=fs.mkdtempSync(path.join(os.tmpdir(),'workflow-protocol-'));
  require('node:child_process').execFileSync('git',['init','--quiet'],{cwd:projectRoot,windowsHide:true});
  const ctx={projectRoot,workspace:'project_db',config:{workMode:'planning'},sourceDirs:[]};
  let current;
  const op=async(operation,args={})=>{ const result=await changeOperation(db.session,{operation,slug:'rotation',expectedRevision:current?.state?.revision,...args},ctx); if(result.state)current=result; return result; };
  await op('create',{title:'Refresh token rotation',description:'Reject refresh token reuse across active sessions.'});
  return {db,ctx,op,get current(){return current;},async close(){await db.cleanup();fs.rmSync(projectRoot,{recursive:true,force:true});}};
}
test('requirements cannot advance without criteria, test intent and resolved blocking questions', async()=>{
 const f=await fixture(); try {
  let r=await f.op('complete'); assert.equal(r.status,'GATE_BLOCKED'); assert.equal(r.state.currentPhase,'requirements');
  await f.op('submit',{...structuredClone(requirements),links:requirements.links.filter(l=>l.type!=='VALIDATED_BY'),data:{...requirements.data,openQuestions:[{question:'Should existing sessions expire?',blocking:true}]}});
  r=await f.op('complete'); assert.equal(r.status,'GATE_BLOCKED'); assert.ok(r.state.phases[0].gate.failures.some(x=>x.code==='test-intent')); assert.ok(r.state.phases[0].gate.failures.some(x=>x.code==='blocking-question'));
  await f.op('submit',structuredClone(requirements)); r=await f.op('complete'); assert.equal(r.state.currentPhase,'analysis'); assert.equal(r.instructions.role,'Source Analyst');
  assert.ok(!JSON.stringify(r.instructions).includes('Quality Reviewer'));
  const saved=await f.op('resume'); assert.equal(saved.state.currentPhase,'analysis');
  await assert.rejects(f.op('submit',{...requirements,expectedRevision:1}),/CONFLICT/);
 } finally {await f.close();}
});
test('artifact tampering and reopening invalidate completion, and unknown refs never persist',async()=>{
 const f=await fixture();try{
  await assert.rejects(f.op('submit',{...requirements,links:[{from:'analysis',to:{nodeId:'missing'},type:'IMPACTS'}]}),/Unknown external/);
  assert.equal((await f.op('read')).state.entities.length,0);
  await f.op('submit',structuredClone(requirements));
  const artifact=f.current.state.artifacts.at(-1); fs.appendFileSync(path.join(f.ctx.projectRoot,artifact.path),'\nUnreviewed edit');
  let r=await f.op('complete');assert.equal(r.status,'GATE_BLOCKED');assert.ok(r.state.phases[0].gate.failures.some(x=>x.code==='artifact-integrity'));
  // A new immutable revision documents the edit; old artifacts remain history.
  await f.op('submit',{...structuredClone(requirements),markdown:requirements.markdown+'\nReviewed clarification.'});
  await f.op('complete'); await f.op('reopen',{phase:'requirements',reason:'Clarify expiry behavior before implementation.'});
  r=await f.op('complete');assert.equal(r.status,'GATE_BLOCKED');assert.ok(r.state.phases[0].gate.failures.some(x=>x.code==='resubmission'));
 }finally{await f.close();}
});
test('planning reuses real Tasks and task context selects requirements and test intentions',async()=>{
 const f=await fixture();try{
  await f.op('submit',structuredClone(requirements));await f.op('complete');
  await f.op('submit',{markdown:'# Analysis\nNew project; no source exists yet. Existing runtime behavior cannot be inferred.',data:{facts:'There are no configured source files yet.',approximations:'No static analysis can be performed yet.',inferences:'Token storage will require concurrency control.',risks:'Concurrent requests may replay the same token.',testRationale:'Behavioral test already covers the only known behavior.',noAdditionalTests:true}});
  await f.op('complete');assert.equal(f.current.state.currentPhase,'architecture');
  await f.op('submit',{markdown:'# Architecture\nUse existing session boundaries and one atomic token replacement operation.',data:{responsibilities:'Session layer controls token replacement.',interfaces:'Rotate accepts the existing refresh token.',compatibility:'Keep the current session identifier stable.',errorHandling:'Return rejection for previously consumed tokens.',testability:'Exercise token reuse through public behavior.',alternatives:'A separate rotation subsystem adds unnecessary state.',simplicity:'Use one atomic replacement in the existing boundary.'},judgment:{decision:'approved',reviewer:'Lead',rationale:'The design preserves the existing public boundary.'}});
  await f.op('complete');
  await f.db.session.run("MERGE (:Task {uid:'task:one',taskId:'TASK-1',title:'Implement token rotation',description:'Replace tokens atomically and reject reuse.',workInstructions:'Add the expected behavior and executable tests.',status:'todo'})");
  await f.op('submit',{markdown:'# Plan\nImplement token rotation with the existing Task lifecycle and behavior tests.',data:{strategy:'One bounded task implements rotation and its tests.',dependencies:'No other implementation Tasks are prerequisites.'},links:[{from:{nodeId:'task:one'},to:'REQ-1',type:'IMPLEMENTS'},{from:{nodeId:'task:one'},to:'TC-1',type:'IMPLEMENTS'}]});
  await f.op('complete');assert.equal(f.current.state.currentPhase,'development');
  const ctx=await f.op('read',{view:'context',taskId:'TASK-1'});assert.ok(ctx.nodes.some(n=>n.key==='AC-1'));assert.ok(ctx.nodes.some(n=>n.key==='TC-1'));assert.equal(ctx.task.taskId,'TASK-1');
  const related=await f.op('related',{nodeId:'task:one'});assert.equal(related.changes.length,1);
 }finally{await f.close();}
});

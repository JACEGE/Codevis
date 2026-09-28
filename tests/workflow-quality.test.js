'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');const os=require('node:os');const {execFileSync}=require('node:child_process');
const {openTestDb}=require('./helpers/ladybug-session.cjs');const {requirements}=require('./helpers/workflow.cjs');
const {changeOperation}=require('../lib/workflow/service.cjs');const {metricDeltas,impactDelta}=require('../lib/workflow/quality-report.cjs');
const {runChecks}=require('../lib/workflow/checks.cjs');const {digest}=require('../lib/workflow/artifacts.cjs');
test('quality delta tolerates unchanged legacy debt and classifies introduced, worsened and improved issues',()=>{
 const before=[{key:'same',value:600},{key:'worse',value:600},{key:'better',value:600}];
 const after=[['same',600],['worse',800],['better',200],['new',800]].map(([key,value])=>({key,value,metric:'fileLOC'}));
 const rows=metricDeltas(before,after,{fileLOC:{limit:500,level:'error'}});
 assert.deepEqual(rows.map(r=>r.classification),['unchanged','worsened','improved','newly_introduced']);assert.deepEqual(rows.map(r=>r.level),['info','error','info','error']);
});
test('impact compares source hashes across IDs and records removed and unexpected symbols',()=>{
 const n={id:'old',key:'f',label:'Function',file:'src/a.js',name:'run',hash:'before'};
 const delta=impactDelta({head:'base',symbols:[n],files:{'src/a.js':'before'}},{symbols:[{...n,id:'new',hash:'after'},{...n,id:'unexpected',key:'g',name:'extra'}],files:{'src/a.js':'after'}},[n]);
 assert.equal(delta.actual.length,2);assert.equal(delta.unexpected.length,1);assert.equal(delta.baseCommit,'base');
});
test('full workflow gates quality on executable checks and invalidates evidence after source edits', {timeout:60000},async()=>{
 const db=await openTestDb(),projectRoot=fs.mkdtempSync(path.join(os.tmpdir(),'workflow-quality-'));
 execFileSync('git',['init','--quiet'],{cwd:projectRoot,windowsHide:true});
 fs.mkdirSync(path.join(projectRoot,'src'));fs.mkdirSync(path.join(projectRoot,'tests'));
 fs.writeFileSync(path.join(projectRoot,'src/auth.js'),'function rotate() { return true; }\n');
 fs.writeFileSync(path.join(projectRoot,'tests/auth.test.js'),"const assert=require('node:assert/strict'); assert.equal(true,true);\n");
 const ctx={projectRoot,workspace:'project_db',sourceDirs:['src','tests'],config:{workflow:{checks:[{name:'behavior',command:process.execPath,args:['tests/auth.test.js']}]}}};
 let current;
 const op=async(operation,args={})=>{const r=await changeOperation(db.session,{operation,slug:'rotation',expectedRevision:current?.state.revision,...args},ctx);if(r.state)current=r;return r;};
 const index=async()=>{for(const file of ['src/auth.js','tests/auth.test.js'])await db.session.run("MERGE (f:File {path:$file}) SET f.contentHash=$hash,f.sourceMtime=$mtime,f.parseStatus='current'",{file,hash:digest(fs.readFileSync(path.join(projectRoot,file))),mtime:Math.ceil(fs.statSync(path.join(projectRoot,file)).mtimeMs)});};
 try{
  await index();await db.session.run("MERGE (:Function {uid:'prod',name:'rotate',file:'src/auth.js',owner:'',startLine:1,endLine:1}) MERGE (:Function {uid:'test',name:'rejectReuse',file:'tests/auth.test.js',owner:'',startLine:1,endLine:1})");
  await op('create',{title:'Refresh token rotation',description:'Reject reused refresh tokens consistently.'});await op('submit',structuredClone(requirements));await op('complete');
  await op('submit',{markdown:'# Analysis\nThe rotation function is the existing boundary. Reuse tests must verify public behavior.',data:{facts:'rotate exists in the source graph at src/auth.js.',approximations:'Static calls do not show every possible runtime caller.',inferences:'Concurrent requests may reach the rotation boundary.',risks:'Concurrent requests could reuse a refresh token.',testRationale:'No additional cases beyond the behavioral intent for this fixture.',noAdditionalTests:true},links:[{from:'analysis',to:{nodeId:'prod'},type:'IMPACTS'}]});
  await op('complete');assert.ok(current.state.baseline);
  await op('submit',{markdown:'# Architecture\nImplement at the existing boundary and preserve session semantics.',data:Object.fromEntries(['responsibilities','interfaces','compatibility','errorHandling','testability','alternatives','simplicity'].map(k=>[k,'Use the existing session boundary and public behavior.'])),judgment:{decision:'approved',reviewer:'Lead',rationale:'The design preserves the existing interface.'}});await op('complete');
  await db.session.run("MERGE (:Task {uid:'task',taskId:'TASK-1',title:'Rotate and validate refresh tokens',status:'review'})");
  await op('submit',{markdown:'# Plan\nOne existing Task owns the atomic rotation and its regression test.',data:{strategy:'Implement one bounded task and its behavior tests.',dependencies:'No dependency on other implementation tasks.'},links:[{from:{nodeId:'task'},to:'REQ-1',type:'IMPLEMENTS'}]});await op('complete');
  await op('submit',{markdown:'# Development\nThe behavior test maps to the intended case and validates token rotation.',data:{summary:'Implemented the token rotation and reuse behavior.',validation:'Executable behavior check is linked to the intended test case.'},links:[{from:'TC-1',to:{nodeId:'test'},type:'IMPLEMENTED_BY'},{from:'TC-1',to:{nodeId:'prod'},type:'VALIDATES'}]});await op('complete');assert.equal(current.state.currentPhase,'quality');
  await op('submit',{markdown:'# Quality\nInspect traceability and execute configured checks on the exact working tree.',data:{summary:'Traceability maps requirement through behavior test to source.',scopeExplanations:'No unexpected source expansion is required.'}});
  let r=await op('complete');assert.equal(r.status,'GATE_BLOCKED');assert.ok(r.state.phases[5].gate.failures.some(f=>f.code==='test-evidence'));
  const evidence=await runChecks(ctx);await op('record_quality',{evidence});
  const report=await op('read',{view:'quality'});assert.equal(report.passed,true,JSON.stringify(report.findings));
  fs.appendFileSync(path.join(projectRoot,'src/auth.js'),'// change after tests\n');await index();
  r=await op('complete');assert.equal(r.status,'GATE_BLOCKED');assert.ok(r.state.phases[5].gate.failures.some(f=>f.code==='test-evidence'));
  await op('record_quality',{evidence:await runChecks(ctx)});await op('complete');assert.equal(current.state.currentPhase,'review');
  await op('submit',{markdown:'# Review\nReviewed requirements, test intent, source links and recorded execution evidence.',data:{summary:'The implemented change and behavior checks satisfy the scope.',disposition:'The source comment was reviewed as acceptable scope expansion.'},judgment:{decision:'approved',reviewer:'Reviewer',rationale:'All required checks and traceability links were reviewed.'}});
  const reviewSubmission=structuredClone(current.state.phases.at(-1).submissions.at(-1));
  await op('complete');assert.equal(current.state.status,'done');assert.equal(current.instructions.phase,'done');
  const completedRevision=current.state.revision;
  await assert.rejects(op('record_quality',{evidence:await runChecks(ctx)}),/active Development, Quality or Review/);
  assert.equal((await op('read')).state.revision,completedRevision);
  await op('reopen',{phase:'review',reason:'Review the saved implementation again after a session handoff.'});
  assert.equal(current.state.qualityEvidence,null);
  let resumed=await op('complete');assert.equal(resumed.status,'GATE_BLOCKED');
  assert.ok(resumed.state.phases.at(-1).gate.failures.some(f=>f.code==='resubmission'));
  assert.ok(resumed.state.phases.at(-1).gate.failures.some(f=>f.code==='test-evidence'));
  // Review can obtain fresh observations without changing implementation or reopening Quality.
  await op('record_quality',{evidence:await runChecks(ctx)});
  resumed=await op('complete');assert.equal(resumed.status,'GATE_BLOCKED');
  assert.ok(resumed.state.phases.at(-1).gate.failures.some(f=>f.code==='resubmission'));
  await op('submit',{markdown:'# Reopened review\nReviewed the fresh execution and unchanged source after the handoff.',data:reviewSubmission.data,judgment:reviewSubmission.judgment});
  await op('complete');assert.equal(current.state.status,'done');
 }finally{await db.cleanup();fs.rmSync(projectRoot,{recursive:true,force:true});}
});

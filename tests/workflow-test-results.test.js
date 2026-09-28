'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { openTestDb } = require('./helpers/ladybug-session.cjs');
const { createChange } = require('../lib/workflow/model.cjs');
const { saveState, readState } = require('../lib/workflow/artifacts.cjs');
const { changeOperation } = require('../lib/workflow/service.cjs');
const { runChecks } = require('../lib/workflow/checks.cjs');
const { parseTestReport } = require('../lib/workflow/test-report.cjs');
const { testResults } = require('../lib/workflow/test-results.cjs');
const { requirements } = require('./helpers/workflow.cjs');
const reporter = require('node:url').pathToFileURL(path.resolve(__dirname, '../lib/workflow/node-test-reporter.cjs')).href;

test('reports reject malformed, oversized and invalid observations without inferring passes', () => {
  for (const data of ['', '{}', JSON.stringify({version:1,tests:[{file:'../outside.js',name:'test',status:'pass'}]}),
    JSON.stringify({version:1,tests:[{file:'tests/a.js',name:'test',status:'green'}]})]) {
    assert.throws(() => parseTestReport(data));
  }
  assert.throws(() => parseTestReport(' '.repeat(8*1024*1024+1)));
  const result = parseTestReport(JSON.stringify({version:1,tests:[{file:'tests/a.js',name:'test',status:'skipped',line:3}]}));
  assert.equal(result.tests[0].status,'skipped');
});

async function fixture() {
  const db = await openTestDb();
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(),'codeflow-results-'));
  execFileSync('git',['init','--quiet'],{cwd:projectRoot,windowsHide:true});
  fs.mkdirSync(path.join(projectRoot,'tests'));
  const filename = path.join(projectRoot,'tests/auth.test.cjs');
  fs.writeFileSync(filename, [
    "const test=require('node:test'); const assert=require('node:assert/strict');",
    "test('reject reuse',()=>{const used=new Set(); const rotate=t=>{if(used.has(t))throw Error('used');used.add(t);};rotate('token');assert.throws(()=>rotate('token'),/used/);});",
    "test.skip('concurrent reuse',()=>{});",
  ].join('\n'));
  const config = {workflow:{checks:[{name:'behavior',command:process.execPath,args:['--test','--test-reporter',reporter,'tests/auth.test.cjs'],testReport:'codevis-json'}]}};
  const context = {projectRoot,workspace:'project_db',config,sourceDirs:['tests']};
  const state = createChange({slug:'test-results',title:'Refresh token rotation',description:'Reject token reuse and concurrent replay attempts.'});
  state.currentPhase='development';state.phases[4].status='active';
  state.entities=requirements.entities.map(e=>({...e,phase:'requirements',origin:'requirements'}));
  state.links=[...requirements.links.map(l=>({...l,phase:'requirements'})),
    {from:'TC-1',to:{nodeId:'test-file',label:'File',name:'tests/auth.test.cjs',path:'tests/auth.test.cjs'},type:'IMPLEMENTED_BY',phase:'development'}];
  await db.session.run("MERGE (:File {uid:'test-file',name:'tests/auth.test.cjs',path:'tests/auth.test.cjs'})");
  saveState(context,state);
  let revision=state.revision;
  const op=async(operation,args={})=>{
    const result=await changeOperation(db.session,{operation,slug:state.slug,expectedRevision:revision,...args},context);
    if(result.state)revision=result.state.revision; return result;
  };
  const binding={testCaseId:'TC-1',check:'behavior',file:'tests/auth.test.cjs',name:'reject reuse',implementation:{nodeId:'test-file'}};
  const bind=bindings=>op('submit',{markdown:'# Development\nMap executable tests to the previously defined token reuse behavior.',data:{summary:'Executable tests protect the public behavior.',validation:'Record exact test selectors and source relationships.'},testBindings:bindings});
  return {db,context,filename,state,op,binding,bind,cleanup:async()=>{await db.cleanup();fs.rmSync(projectRoot,{recursive:true,force:true});}};
}

test('real node:test observations survive resume, distinguish skips and invalidate after edits or binding changes', {timeout:60000}, async()=>{
  const f=await fixture();
  try{
    await f.bind([f.binding]);
    await f.op('record_quality',{evidence:await runChecks(f.context)});
    let result=await f.op('read',{view:'tests'});
    assert.equal(result.cases[0].status,'pass',JSON.stringify({result,evidence:readState(f.context,f.state.slug).state.qualityEvidence}));
    assert.equal(result.cases[0].observations[0].name,'reject reuse');
    assert.ok(result.cases[0].at);
    await f.op('resume');
    const projected=await f.db.session.run("MATCH (n:TestCase) RETURN n.result AS result");
    assert.equal(JSON.parse(projected.records[0].get('result')).execution.status,'pass');
    const saved=readState(f.context,f.state.slug).state;
    assert.equal(testResults(saved,f.context).cases[0].status,'pass');
    fs.appendFileSync(f.filename,'\n// source changed');
    assert.equal((await f.op('read',{view:'tests'})).cases[0].status,'stale');
    const graph=await f.op('read',{view:'graph'});
    assert.equal(graph.graph.nodes.find(n=>n.label==='TestCase').data.execution.status,'stale');
    await f.op('record_quality',{evidence:await runChecks(f.context)});
    await f.bind([{...f.binding,name:'concurrent reuse'}]);
    assert.equal((await f.op('read',{view:'tests'})).cases[0].status,'stale');
    await f.op('record_quality',{evidence:await runChecks(f.context)});
    assert.equal((await f.op('read',{view:'tests'})).cases[0].status,'skipped');
    f.context.config.workflow.checks[0].args=['-e','console.log("not a report")'];
    await f.op('record_quality',{evidence:await runChecks(f.context)});
    result=await f.op('read',{view:'tests'});
    assert.equal(result.cases[0].status,'unknown');
    assert.ok(result.reportErrors.length);
  }finally{await f.cleanup();}
});

test('many-to-many bindings require all selected executions, never last-match wins', {timeout:60000},async()=>{
  const f=await fixture();
  try{
    await f.bind([f.binding,{...f.binding,name:'concurrent reuse'}]);
    await f.op('record_quality',{evidence:await runChecks(f.context)});
    assert.equal((await f.op('read',{view:'tests'})).cases[0].status,'skipped');
    fs.appendFileSync(f.filename,"\ntest('reject reuse',()=>assert.fail('regression'));\n");
    await f.bind([f.binding]);
    await f.op('record_quality',{evidence:await runChecks(f.context)});
    const result=await f.op('read',{view:'tests'});
    assert.equal(result.cases[0].status,'unknown');
    assert.match(result.cases[0].reason,/ambiguous/i);
    await f.bind([{...f.binding,line:4}]);
    await f.op('record_quality',{evidence:await runChecks(f.context)});
    assert.equal((await f.op('read',{view:'tests'})).cases[0].status,'fail');
    await assert.rejects(f.bind([{...f.binding,implementation:{nodeId:'missing'}}]),/implementation|source/i);
    await assert.rejects(f.bind([{...f.binding,file:'tests/other.js'}]),/file/i);
  }finally{await f.cleanup();}
});

test('unbound implementations, shared tests, artifact edits and strict result policy are explicit quality signals', {timeout:60000},async()=>{
  const f=await fixture();
  try{
    await f.bind([f.binding]);
    await f.op('record_quality',{evidence:await runChecks(f.context)});
    let state=readState(f.context,f.state.slug).state;
    const context=structuredClone(f.context);
    context.config.workflow.checks[0].args.push('--unrelated');
    assert.equal(testResults(state,context).cases[0].status,'stale');
    // The same observed test can protect another independently defined intent.
    const other={...state.entities.find(e=>e.id==='TC-1'),id:'TC-2',title:'Preserve active sessions'};
    state.entities.push(other);
    state.links.push({...state.links.find(l=>l.type==='IMPLEMENTED_BY'),from:'TC-2'});
    state.testBindings.push({...state.testBindings[0],testCaseId:'TC-2'});
    state.qualityEvidence.intentFingerprint=require('../lib/workflow/test-results.cjs').intentFingerprint(state);
    assert.deepEqual(testResults(state,f.context).cases.map(c=>c.status),['pass','pass']);
    state.links.push({from:'TC-1',to:{nodeId:'unmapped-test',label:'File',path:'tests/extra.cjs'},type:'IMPLEMENTED_BY',phase:'development'});
    state.qualityEvidence.intentFingerprint=require('../lib/workflow/test-results.cjs').intentFingerprint(state);
    assert.equal(testResults(state,f.context).cases[0].status,'unknown');
    assert.equal(testResults(state,f.context).cases[1].status,'pass');
    const filename=path.join(f.context.projectRoot,state.qualityEvidence.artifact.path);
    fs.appendFileSync(filename,'tampered');
    assert.ok(testResults(state,f.context).cases.every(c=>c.status==='stale'));
    await f.bind([{...f.binding,name:'concurrent reuse'}]);
    await f.op('record_quality',{evidence:await runChecks(f.context)});
    let quality=await f.op('read',{view:'quality'});
    assert.equal(quality.findings.find(i=>i.code==='test-result-skipped').level,'warning');
    f.context.config.workflow.policies={testResults:'error'};
    quality=await f.op('read',{view:'quality'});
    assert.equal(quality.findings.find(i=>i.code==='test-result-skipped').level,'error');
    assert.equal(quality.passed,false);
    const revision=readState(f.context,f.state.slug).state.revision;
    await assert.rejects(f.op('record_quality',{expectedRevision:revision-1,evidence:await runChecks(f.context)}),/CONFLICT/);
  }finally{await f.cleanup();}
});

test('process graph exposes observed status without conflating test intent and implementation',async()=>{
  const {changeGraphModel}=await import('../frontend/src/changes/graphModel.js');
  const state=createChange({title:'Protect session tokens',description:'Reject token reuse consistently.'});
  const graph={nodes:[{id:'case',key:'TC-1',label:'TestCase',data:{execution:{status:'stale'}}}],links:[]};
  const model=changeGraphModel({state,graph},{focus:'case'});
  assert.deepEqual(model.nodes[0].data.testSummary,{implementations:0,execution:'stale'});
});

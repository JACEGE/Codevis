'use strict';
const {execFile}=require('node:child_process');const {promisify}=require('node:util');
const {sourceSnapshot}=require('./quality-snapshot.cjs');const {digest}=require('./artifacts.cjs');
const execute=promisify(execFile);
function configuredChecks(config) {
 const checks=config.workflow?.checks;
 if(!Array.isArray(checks)||!checks.length)throw new Error('Configure workflow.checks as [{name,command,args}] in codevis.config.cjs before running Change quality.');
 if(checks.some(c=>typeof c.name!=='string'||!c.name.trim()||typeof c.command!=='string'||!c.command.trim()||!Array.isArray(c.args)||c.args.some(a=>typeof a!=='string')))throw new Error('Invalid workflow.checks; use executable and argument arrays, not shell strings.');
 if(new Set(checks.map(c=>c.name)).size!==checks.length)throw new Error('Check names must be unique');
 if(checks.some(c=>c.testReport!=null&&c.testReport!=='codevis-json'))throw new Error('Unsupported testReport; use codevis-json');
 return checks.map(c=>({...c.testReport?{testReport:c.testReport}:{},name:c.name,command:c.command,args:c.args,timeoutMs:Math.max(1000,Math.min(c.timeoutMs||300000,1800000))}));
}
async function runChecks(context) {
 const env={...process.env};delete env.NODE_TEST_CONTEXT; // Start an independent runner, including when invoked from node:test.
 const definitions=configuredChecks(context.config);const before=sourceSnapshot(context);const checks=[];
 for(const c of definitions) {
  const start=Date.now();let output='',testOutput='',exitCode=0;
  try{const r=await execute(c.command,c.args,{cwd:context.projectRoot,env,windowsHide:true,timeout:c.timeoutMs,maxBuffer:8*1024*1024});output=r.stdout+r.stderr;testOutput=r.stdout;}
  catch(e){testOutput=e.stdout||'';exitCode=typeof e.code==='number'?e.code:1;output=(e.stdout||'')+(e.stderr||'')+'\n'+e.message;}
  checks.push({...c,exitCode,durationMs:Date.now()-start,output,...c.testReport?{testOutput}:{}});
 }
 const after=sourceSnapshot(context);
 if(before.fingerprint!==after.fingerprint)throw new Error('Source changed while checks ran; rerun checks on a stable working tree.');
 return {fingerprint:after.fingerprint,configuration:digest(JSON.stringify(definitions)),checks,at:Date.now(),provenance:'CodeVis CLI observed process exit status; passing commands do not prove behavioral correctness.'};
}
module.exports={configuredChecks,runChecks};

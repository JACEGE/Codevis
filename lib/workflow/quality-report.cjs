'use strict';
const {graphView}=require('./projection.cjs');
const {uid}=require('./model.cjs');
const {readArtifact}=require('./artifacts.cjs');
const {captureSnapshot}=require('./quality-snapshot.cjs');
const {configuredChecks}=require('./checks.cjs');
const {digest}=require('./artifacts.cjs');
const DEFAULTS={fileLOC:{limit:500,level:'warning'},functionLOC:{limit:100,level:'warning'},complexity:{limit:20,level:'warning'},dependencies:{limit:20,level:'warning'}};
function metricDeltas(before,after,policies={}) {
 const previous=new Map((before||[]).map(m=>[m.key,m]));
 return after.flatMap(m=>{
  const policy=policies[m.metric]||DEFAULTS[m.metric];if(!policy)return[];
  if(!Number.isFinite(policy.limit)||!['info','warning','error'].includes(policy.level))throw new Error('Invalid quality policy '+m.metric);
  const old=previous.get(m.key);if(m.value<=policy.limit && (!old||old.value<=policy.limit))return[];
  const classification=m.value<=policy.limit?'improved':!old||old.value<=policy.limit?'newly_introduced':m.value>old.value?'worsened':m.value<old.value?'improved':'unchanged';
  return [{...m,before:old?.value??null,limit:policy.limit,classification,level:['improved','unchanged'].includes(classification)?'info':policy.level,
   code:'metric-'+m.metric,message:m.metric+': '+(old?.value??'new')+' → '+m.value+' ('+classification+')'}];
 });
}
function impactDelta(baseline,current,predicted) {
 const before=new Map((baseline?.symbols||[]).map(n=>[n.key,n]));const after=new Map(current.symbols.map(n=>[n.key,n]));
 const actual=[];
 for(const s of current.symbols)if(!before.has(s.key)||before.get(s.key).hash!==s.hash)actual.push({...s,change:before.has(s.key)?'modified':'added'});
 for(const s of baseline?.symbols||[])if(!after.has(s.key))actual.push({...s,change:'removed'});
 const predictedIds=new Set(predicted.map(n=>n.id));const predictedFiles=new Set(predicted.filter(n=>n.label==='File').map(n=>n.file||n.path));
 const unexpected=actual.filter(n=>!predictedIds.has(n.id)&&!predictedFiles.has(n.file)&&!predicted.some(p=>p.label===n.label&&(p.file||p.path)===n.file&&p.name===n.name));
 const files=[...new Set([...Object.keys(baseline?.files||{}),...Object.keys(current.files)])].filter(f=>baseline?.files?.[f]!==current.files[f]).sort();
 return {predicted,actual,unexpected,files,baseCommit:baseline?.head||null,counts:{predicted:predicted.length,actual:actual.length,unexpected:unexpected.length},
  limitation:'Source-range hashes identify changed parsed symbols. Unparsed files are listed separately; static analysis may miss runtime relationships.'};
}
async function qualityReport(session,state,context) {
 for(const key of ['unvalidatedSource','unexpectedImpact','testResults']) { const value=context.config.workflow?.policies?.[key];if(value&&!['info','warning','error'].includes(value))throw new Error('Invalid policy level '+key); }
 const current=await captureSnapshot(session,context),graph=await graphView(session,state,context),findings=[];
 const add=(code,message,nodeId,level='error')=>findings.push({code,message,nodeId,level});
 if(!state.baseline)add('baseline','Complete Source Analysis to capture a baseline.');
 if(current.freshness.state!=='current')add('graph-freshness','Graph is '+current.freshness.state+'.');
 const out=(id,type)=>graph.links.filter(l=>l.from===uid(state,id)&&l.type===type);
 const reqs=state.entities.filter(e=>e.label==='Requirement'),cases=state.entities.filter(e=>e.label==='TestCase');
 let covered=0,implemented=0;
 for(const req of reqs){const criteria=out(req.id,'HAS_CRITERION');const tested=out(req.id,'VALIDATED_BY').length||criteria.length&&criteria.every(ac=>graph.links.some(l=>l.from===ac.to&&l.type==='VALIDATED_BY'));if(tested)covered++;else add('requirement-without-test','Requirement has no complete test intent.',req.id);}
 for(const tc of cases){if(out(tc.id,'IMPLEMENTED_BY').length)implemented++;else add('test-without-implementation','TestCase has no executable implementation.',tc.id);}
 for(const task of graph.nodes.filter(n=>n.label==='Task')) {
  const obligations=graph.links.filter(l=>l.from===task.id&&l.type==='IMPLEMENTS');
  if(!obligations.length)add('task-without-requirement','Task has no requirement or test-intent obligation: '+task.name,task.id,'warning');
 }
 const predicted=out('analysis','IMPACTS').map(l=>graph.nodes.find(n=>n.id===l.to));
 const impact=impactDelta(state.baseline,current,predicted);
 const validated=new Set(graph.links.filter(l=>l.type==='VALIDATES').map(l=>l.to));
 for(const n of impact.actual.filter(n=>n.change!=='removed'&&n.label!=='File'))if(!validated.has(n.id))add('changed-symbol-without-validation','Changed symbol has no known validation: '+n.name,n.id,context.config.workflow?.policies?.unvalidatedSource||'warning');
 const explanations=state.phases.find(p=>p.id==='quality').submissions.at(-1)?.data?.impactExplanations || [];
 for(const n of impact.unexpected) {
  const explanation=Array.isArray(explanations)&&explanations.find(e=>(e.nodeId===n.id||e.file===n.file)&&typeof e.reason==='string'&&e.reason.trim().length>=12&&e.acceptedBy);
  n.explanation=explanation||null;
  add('unexpected-impact','Unpredicted '+n.change+': '+n.name,n.id,explanation?'info':context.config.workflow?.policies?.unexpectedImpact||'warning');
 }
 findings.push(...metricDeltas(state.baseline?.metrics,current.metrics,context.config.workflow?.policies?.metrics));
 for(const file of current.parseErrors)if(!state.baseline?.parseErrors?.includes(file))add('new-parse-error','New parser error: '+file,null);
 for(const cycle of current.cycles)if(!state.baseline?.cycles?.includes(cycle))add('new-cycle','New bounded import cycle: '+cycle,null,'warning');
 const evidence=state.qualityEvidence;
 if(!evidence||evidence.fingerprint!==current.fingerprint)add('test-evidence','Run configured checks against this exact working tree.');
 else {
  try { if(evidence.configuration!==digest(JSON.stringify(configuredChecks(context.config))))add('check-configuration','Configured checks changed; rerun them.'); } catch(e) {add('check-configuration',e.message);}
  try{readArtifact(context,evidence.artifact);}catch(e){add('evidence-integrity',e.message);}
  if(evidence.checks.some(c=>c.exitCode!==0)||!evidence.checks.length)add('required-checks','All configured checks must pass.');
 }
 const executions=require('./test-results.cjs').testResults(state,context,current.fingerprint);
 for(const error of executions.reportErrors)add('test-report',error.check+': '+error.message);
 for(const result of executions.cases)if(result.status!=='pass')add('test-result-'+result.status,result.testCaseId+': '+(result.reason||result.status),result.testCaseId,result.status==='fail'?'error':context.config.workflow?.policies?.testResults||'warning');
 for(const link of graph.unresolved)add('unresolved-reference','A workflow source/reference is missing.',typeof link.from==='string'?link.from:null);
 return {passed:!findings.some(f=>f.level==='error'),at:Date.now(),fingerprint:current.fingerprint,findings,impact,
  traceability:{requirements:{covered,total:reqs.length},testCases:{implemented,total:cases.length},changedSymbols:{validated:impact.actual.filter(n=>validated.has(n.id)).length,total:impact.actual.length}},
  testResults:executions,checks:(evidence?.checks||[]).map(({report,...check})=>({...check,observedTests:report?.tests.length||0})),freshness:current.freshness,baselineAt:state.baseline?.at||null};
}
module.exports={DEFAULTS,metricDeltas,impactDelta,qualityReport};

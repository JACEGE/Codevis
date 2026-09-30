import {focusPositions} from './navigation.js';

// Whole-flow layout: one column per phase, its direct content stacked below.
const WHOLE_COLUMN = 300, WHOLE_ROW = 200, WHOLE_MAX_ROWS = 6;

export function changeGraphModel(detail, { expanded = new Set(), focus = null, showSource = false, incomplete = false, quality = null, whole = false } = {}) {
  if (!detail?.state || !detail?.graph) return {nodes:[],edges:[],allNodes:[],allLinks:[],children:{}};
  const { state,graph } = detail;
  const phaseOrder=state.phases.map(p=>p.id);
  const titles={requirements:'Requirements',analysis:'Source Analysis',architecture:'Architecture',planning:'Planning',development:'Development',quality:'Quality Gate',review:'Review'};
  const nodes = graph.nodes.map(n=>({...n,status:n.status||(['Requirement','AcceptanceCriterion','TestCase'].includes(n.label)?'defined':null),title:n.label==='Phase'?titles[n.key]:n.title||n.name||n.key}));
  const links = [...graph.links];
  const phase = key=>nodes.find(n=>n.label==='Phase'&&n.key===key);
  const children = Object.fromEntries(nodes.map(n=>[n.id,[]]));
  const addChild=(from,to)=>{if(from&&to&&!children[from]?.includes(to)){children[from] ||= [];children[from].push(to);}};
  const evidence=(parent,key,title,content,status='info',data={})=>{
    const id=parent+':evidence:'+key;
    nodes.push({id,key,label:'Evidence',title,content,status,data,virtual:true});children[id]=[];addChild(parent,id);links.push({from:parent,to:id,type:'EVIDENCE'});return id;
  };
  for (const n of nodes.filter(n=>!n.external)) {
    if(n.label==='Requirement')addChild(phase('requirements')?.id,n.id);
    if(n.label==='TestCase'&&n.data?.phase==='analysis')addChild(phase('analysis')?.id,n.id);
    if(n.label==='ArchitectureDecision')addChild(phase('architecture')?.id,n.id);
    if(n.label==='SourceAnalysis')addChild(phase('analysis')?.id,n.id);
  }
  for(const l of links) {
    if(['HAS_CRITERION','VALIDATED_BY','VALIDATES','IMPLEMENTED_BY','IMPACTS','REFERENCES','PROMOTED_TO'].includes(l.type))addChild(l.from,l.to);
    if(l.type==='PROMOTED_TO')addChild(l.to,l.from);
    if(l.type==='IMPLEMENTS') {addChild(phase('planning')?.id,l.from);addChild(phase('development')?.id,l.from);addChild(l.to,l.from);}
    if(['AFFECTS','DEPENDS_ON','APPLIES_TO'].includes(l.type))addChild(l.from,l.to);
  }
  for(const p of state.phases) {
    const id=phase(p.id)?.id,data=p.submissions.at(-1)?.data;
    if(data&&p.id==='analysis')for(const key of ['facts','approximations','inferences','risks'])evidence(id,key,key[0].toUpperCase()+key.slice(1),data[key]);
    for(const [i,f] of (p.gate?.failures||[]).entries())evidence(id,'gate-'+i,f.code,f.message,'error',f);
  }
  if(quality) {
    const parent=phase('quality')?.id;
    const checks=evidence(parent,'checks','Executed checks',quality.checks.length+' recorded checks',quality.checks.every(c=>c.exitCode===0)&&quality.checks.length?'complete':'warning');
    for(const [i,c] of quality.checks.entries())evidence(checks,String(i),c.name,'Exit '+c.exitCode+' · '+c.durationMs+' ms',c.exitCode===0?'complete':'error',c);
    if(quality.testResults){const results=evidence(parent,'test-results','TestCase execution',JSON.stringify(quality.testResults.counts),quality.testResults.counts.fail?'error':'info');for(const item of quality.testResults.cases){const id=evidence(results,item.testCaseId,item.testCaseId,item.reason||item.status,item.status==='pass'?'complete':item.status==='fail'?'error':'warning',item);const tc=nodes.find(n=>n.key===item.testCaseId);if(tc){addChild(id,tc.id);links.push({from:id,to:tc.id,type:'EVIDENCE'});}}}
    const trace=evidence(parent,'trace','Traceability',JSON.stringify(quality.traceability,null,2),'info',quality.traceability);
    for(const [key,value]of Object.entries(quality.traceability))evidence(trace,key,key,JSON.stringify(value,null,2));
    const impact=evidence(parent,'impact','Predicted / actual impact',quality.impact.counts.predicted+' predicted · '+quality.impact.counts.actual+' changed · '+quality.impact.counts.unexpected+' unexpected','info',quality.impact);
    for(const [i,n]of quality.impact.unexpected.entries()) {
      const id=evidence(impact,String(i),n.name,n.change+' in '+n.file,n.explanation?'info':'warning',n);
      if(nodes.some(x=>x.id===n.id)){addChild(id,n.id);links.push({from:id,to:n.id,type:'IMPACTS'});}
    }
    const issues=evidence(parent,'issues','Quality findings',quality.findings.length+' findings',quality.passed?'info':'error');
    for(const [i,f]of quality.findings.entries())evidence(issues,String(i),f.code,f.message,f.level,f);
  }
  const map=new Map(nodes.map(n=>[n.id,n]));
  for(const n of nodes) {
    if(n.label==='TestCase')n.testSummary={implementations:links.filter(l=>l.from===n.id&&l.type==='IMPLEMENTED_BY').length,execution:n.data?.execution?.status||'unknown'};
    if(n.label==='Task')n.taskSummary={requirements:links.filter(l=>l.from===n.id&&l.type==='IMPLEMENTS'&&map.get(l.to)?.label==='Requirement').length,testCases:links.filter(l=>l.from===n.id&&l.type==='IMPLEMENTS'&&map.get(l.to)?.label==='TestCase').length,symbols:links.filter(l=>l.from===n.id&&l.type==='AFFECTS').length};
  }
  const visible=new Set(); const positions=new Map(); let cursor=0;
  function walk(id,depth,ancestors=new Set()) {
    if(!map.has(id)||ancestors.has(id)||visible.has(id))return;
    const n=map.get(id);
    if(!showSource&&n.source||incomplete&&['done','complete'].includes(n.status)&&n.label!=='Phase')return;
    visible.add(id);positions.set(id,{x:depth*310,y:cursor});cursor+=230;
    if(expanded.has(id)){const next=new Set(ancestors).add(id);for(const child of children[id]||[])walk(child,depth+1,next);}
  }
  if(focus&&map.has(focus)) {
    const related=new Set([focus]);
    for(let i=0;i<5;i++)for(const l of links){
      if(['HAS_CRITERION','VALIDATED_BY','VALIDATES','IMPLEMENTED_BY','AFFECTS'].includes(l.type)&&related.has(l.from))related.add(l.to);
      if(['HAS_CRITERION','VALIDATED_BY','IMPLEMENTS'].includes(l.type)&&related.has(l.to))related.add(l.from);
    }
    const layers=new Map();
    for(const n of nodes.filter(n=>related.has(n.id)&&!['Phase','Change','Flow'].includes(n.label))) {
      if(!showSource&&n.source)continue;
      const rank={Requirement:0,AcceptanceCriterion:1,Task:1,TestCase:2}[n.label]??3;
      if(!layers.has(rank))layers.set(rank,[]);layers.get(rank).push(n);
    }
    const layout=focusPositions(layers);
    for(const layer of layers.values())for(const n of layer){visible.add(n.id);positions.set(n.id,layout.get(n.id));}
  } else if(whole) {
    // Every phase side by side, each with what belongs to it. A Task is linked
    // to both Planning and Development; it is shown once, where it is built.
    const root=nodes.find(n=>['Change','Flow'].includes(n.label));
    if(root){visible.add(root.id);positions.set(root.id,{x:-WHOLE_COLUMN,y:0});}
    // A long phase (a dozen requirements) wraps into sub-columns after
    // WHOLE_MAX_ROWS, so the whole flow fits on screen at a readable zoom.
    const hasDevelopment=Boolean(phase('development'));
    let x=0;
    for(const key of phaseOrder){
      const p=phase(key);if(!p)continue;
      visible.add(p.id);positions.set(p.id,{x,y:0});
      let count=0;
      for(const id of children[p.id]||[]){
        const n=map.get(id);
        if(!n||visible.has(id)||(!showSource&&n.source)||incomplete&&['done','complete'].includes(n.status))continue;
        if(key==='planning'&&hasDevelopment&&n.label==='Task')continue;
        visible.add(id);positions.set(id,{x:x+Math.floor(count/WHOLE_MAX_ROWS)*WHOLE_COLUMN,y:(count%WHOLE_MAX_ROWS+1)*WHOLE_ROW});
        count++;
      }
      x+=Math.max(1,Math.ceil(count/WHOLE_MAX_ROWS))*WHOLE_COLUMN;
    }
  } else {
    const root=nodes.find(n=>['Change','Flow'].includes(n.label));if(root)walk(root.id,0);
    for(const key of phaseOrder) {const p=phase(key);if(p)walk(p.id,0);}
  }
  const wholeLayout=whole&&!(focus&&map.has(focus));
  // In the whole flow the column already says which phase an item belongs to;
  // only the phase chain and links between items are drawn, unlabelled.
  const containers=new Set(nodes.filter(n=>['Change','Flow','Phase'].includes(n.label)).map(n=>n.id));
  const displayedLinks=links.filter(l=>visible.has(l.from)&&visible.has(l.to)&&l.type!=='HAS_PHASE'&&!(wholeLayout&&containers.has(l.from)));
  if(!focus){const flow=[nodes.find(n=>['Change','Flow'].includes(n.label)),...phaseOrder.map(phase)].filter(Boolean);for(let i=1;i<flow.length;i++)displayedLinks.push({from:flow[i-1].id,to:flow[i].id,type:'NEXT'});}
  return { nodes:nodes.filter(n=>visible.has(n.id)).map(n=>({id:n.id,type:'changeNode',position:positions.get(n.id),data:{...n,childCount:children[n.id]?.length||0,expanded:expanded.has(n.id)}})),
    edges:displayedLinks.map((l,i)=>({id:l.from+':'+l.type+':'+l.to+':'+i,source:l.from,target:l.to,label:l.type==='NEXT'||wholeLayout?'':l.type.replaceAll('_',' '),type:'smoothstep',markerEnd:{type:'arrowclosed'},animated:l.type==='NEXT'&&map.get(l.to)?.status==='active'})),
    allNodes:nodes,allLinks:links,children };
}

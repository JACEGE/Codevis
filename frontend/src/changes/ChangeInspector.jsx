import TestExecutionDetails from './TestExecutionDetails';
import useFlowArtifact from './useFlowArtifact';
export default function ChangeInspector({node,model,detail,onSelect,onFocus,onShowNode,getArtifact}) {
  const {artifact,error,open}=useFlowArtifact({scope:node?.id+'|'+detail?.state?.changeId+'|'+detail?.state?.revision,getArtifact});
  if(!node)return <aside className="change-inspector"><h2>Inspect the Flow</h2><p>Select a phase, requirement, TestCase or Task to inspect its evidence and connections.</p></aside>;
  const related=model.allLinks.filter(l=>l.from===node.id||l.to===node.id);
  const phase=node.label==='Phase'?node.data:null;
  const submitted=phase?.submissions?.at(-1);
  const entityHistory=detail.state.phases.flatMap(p=>p.submissions).filter(s=>s.outputs?.entities?.some(e=>e.id===node.key));
  const implementations=related.filter(l=>l.type==='IMPLEMENTED_BY'&&l.from===node.id);
  const openArtifact=(path=submitted?.artifact?.path)=>open(path);
  return <aside className="change-inspector" aria-label="Change node inspector">
    <div className="change-eyebrow">{node.label} {node.key}</div><h2>{node.title}</h2>
    <p>{node.content||node.description}</p>
    <dl><dt>Status</dt><dd>{node.status||'Linked'}</dd>
      {phase&&<><dt>Role</dt><dd>{phase.role}</dd><dt>Agent instance</dt><dd>{phase.agent||'Not started'}</dd><dt>Started</dt><dd>{phase.startedAt?new Date(phase.startedAt).toLocaleString():'—'}</dd><dt>Completed</dt><dd>{phase.completedAt?new Date(phase.completedAt).toLocaleString():'—'}</dd></>}
      {node.label==='TestCase'&&<><dt>Origin</dt><dd>{node.data?.origin}</dd><dt>Reason</dt><dd>{node.data?.reason}</dd><dt>Intent</dt><dd>Defined</dd><dt>Implementation</dt><dd>{implementations.length?implementations.length+' linked':'Missing'}</dd></>}
      {node.assignedTo&&<><dt>Assigned agent</dt><dd>{node.assignedTo}</dd></>}
      {node.file&&<><dt>File</dt><dd>{node.file}</dd></>}
    </dl>
    {node.label==='TestCase'&&<TestExecutionDetails execution={node.data?.execution} onOpenArtifact={openArtifact}/>}
    <div className="change-actions">
      {!['Phase','Change','Flow','Evidence'].includes(node.label)&&<button onClick={()=>onFocus(node.id)}>Focus relationships</button>}
      {node.label!=='Evidence'&&<button onClick={()=>onShowNode(node.id)}>{node.source||!node.external?'Show in Code Graph':'Open in Inspector'}</button>}
      {submitted?.artifact&&<button onClick={()=>openArtifact()}>Open artifact</button>}
    </div>
    {error&&<p role="alert">{error}</p>}
    {artifact&&<section><h3>{artifact.path}</h3><pre>{artifact.content}</pre></section>}
    {phase?.gate&&<section><h3>Completion gate</h3><p>{phase.gate.passed?'Passed':'Needs attention'}</p>{[...phase.gate.failures,...phase.gate.warnings].map((f,i)=><p key={i}>{f.message}</p>)}</section>}
    {['Evidence','SourceAnalysis','ArchitectureDecision'].includes(node.label)&&node.data&&<pre>{JSON.stringify(node.data,null,2)}</pre>}
    <section><h3>Relationships</h3>{related.length===0?<p>No linked evidence yet.</p>:related.map((l,i)=>{
      const other=model.allNodes.find(n=>n.id===(l.from===node.id?l.to:l.from));
      return other&&<button className="change-relation" key={i} onClick={()=>onSelect(other.id)}><small>{l.type.replaceAll('_',' ')}</small>{other.title}</button>;
    })}</section>
    {entityHistory.length>0&&<section><h3>Entity revisions</h3>{entityHistory.map(s=><details key={s.revision}><summary>Revision {s.revision} · {s.agent}</summary><p>{s.outputs.entities.find(e=>e.id===node.key).content}</p></details>)}</section>}
    {phase?.submissions.length>0&&<section><h3>History</h3>{phase.submissions.map(s=><p key={s.revision}>Revision {s.revision} · {s.agent} as {s.role}<br/>{new Date(s.at).toLocaleString()}</p>)}</section>}
  </aside>;
}

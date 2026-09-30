import { useEffect, useState } from 'react';
import { ReactFlow, Background, Controls, MiniMap } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import useChanges from '../hooks/useChanges';
import useFlowNavigation from '../changes/useFlowNavigation';
import FlowNavigation from '../changes/FlowNavigation';
import FlowViewport from '../changes/FlowViewport';
import ChangeNode from '../changes/ChangeNode';
import ChangeInspector from '../changes/ChangeInspector';
import '../changes/changes.css';
const nodeTypes = { changeNode: ChangeNode };
export default function ChangesTab({ db, socket, onShowNode, onOpenGuide, initialSlug, onInitialConsumed }) {
  const work=useChanges(db,socket);
  useEffect(()=>{if(initialSlug){work.setSlug(initialSlug);onInitialConsumed?.();}},[initialSlug]);
  const navigation=useFlowNavigation(work.detail,work.quality,db+'|'+work.slug,work.getQuality);
  const {model,selected,focus,showSource,incomplete,whole,choose,toggle,revealPhase}=navigation;
  const [creating,setCreating]=useState(false);
  const [title,setTitle]=useState(''),[description,setDescription]=useState(''),[showInstructions,setShowInstructions]=useState(false);
  useEffect(()=>{setShowInstructions(false);},[db,work.slug]);
  const nodes=model.nodes.map(n=>({...n,selected:n.id===selected,data:{...n.data,onToggle:focus||whole?null:toggle}}));
  const chosen=model.allNodes.find(n=>n.id===selected);
  const create=async e=>{e.preventDefault();await work.act('create',{title,description});};
  useEffect(()=>{if(work.detail?.state){setCreating(false);setTitle('');setDescription('');}},[work.detail?.state?.changeId]);
  const state=work.detail?.state;
  const checkGate=()=>{revealPhase(state.currentPhase);work.act('complete');};
  const inspectQuality=()=>{revealPhase('quality');work.getQuality();};
  return <main className="changes-view">
    <aside className="changes-catalogue">
      <div className="change-eyebrow">Work / CodeFlow</div><h1>CodeFlow</h1>
      <p>Track one requested change from requirements to reviewed code.</p>
      <button className="change-help" onClick={onOpenGuide}>How CodeFlow works</button>
      <button className="change-primary" onClick={()=>setCreating(!creating)}>New Flow</button>
      {creating&&<form className="change-create" onSubmit={create}><label>Title<input required minLength={8} value={title} onChange={e=>setTitle(e.target.value)}/></label><label>Requested behavior<textarea required minLength={12} value={description} onChange={e=>setDescription(e.target.value)}/></label><button disabled={work.busy}>Create Flow</button></form>}
      <nav aria-label="Flows">{work.changes.map(c=><button key={c.slug} className={'change-catalogue-item'+(work.slug===c.slug?' active':'')} onClick={()=>work.setSlug(c.slug)}><strong>{c.title}</strong><small>{c.currentPhase} · {c.status}</small></button>)}</nav>
      {!work.changes.length&&<p>No Flows yet. Create one to capture requirements and test intent.</p>}
    </aside>
    <section className="change-workspace">
      <header className="change-toolbar"><div><span className="change-eyebrow">{state?'FLOW-'+state.changeId.slice(0,8).toUpperCase()+' · '+(state.kind||'feature'):'Persistent development workflow'}</span><h2>{state?.title||'Open a Flow'}</h2>{state&&<small>Phase: {state.currentPhase} · Revision {state.revision} · {state.status}</small>}</div>
        {state&&<div className="change-actions"><button onClick={work.refresh}>Refresh</button><button disabled={work.busy} onClick={()=>work.act('resume')} title="Restore the graph from saved workflow state">Resume saved state</button><button onClick={()=>setShowInstructions(!showInstructions)}>What to do next</button><button disabled={work.busy||state.status==='done'} onClick={checkGate} title="Validate the current phase; advance only when its gate passes">Validate &amp; advance</button></div>}
      </header>
      {work.error&&<div className="change-error" role="alert">{work.error}</div>}
      {showInstructions&&work.detail?.instructions&&<section className="change-instructions"><strong>{work.detail.instructions.role}</strong><p>{work.detail.instructions.goal}</p>{work.detail.instructions.kindGuidance&&<p>{work.detail.instructions.kindGuidance}</p>}<ul>{work.detail.instructions.completionContract?.deterministic?.map(check=><li key={check}>{check}</li>)}</ul><p>The connected Lead submits this phase through MCP. Validation does not start an agent or run tests.</p><details><summary>Agent contract details</summary><pre>{JSON.stringify(work.detail.instructions,null,2)}</pre></details></section>}
      {state?<><FlowNavigation key={db+'|'+work.slug} model={model} selected={selected} focus={focus} onChoose={choose} onCurrent={navigation.current} onOverview={navigation.overview} onReadable={navigation.readable} onExit={navigation.exitFocus}/><div className="change-filters"><button className="change-whole-toggle" aria-pressed={whole} onClick={()=>navigation.setWhole(!whole)} title="Show every phase side by side with its requirements, decisions and Tasks">{whole?'Back to phase tree':'Whole flow'}</button><label><input type="checkbox" checked={showSource} onChange={e=>navigation.setShowSource(e.target.checked)}/> Source symbols</label><label><input type="checkbox" checked={incomplete} onChange={e=>navigation.setIncomplete(e.target.checked)}/> Incomplete items</label>{!whole&&<button onClick={navigation.collapse}>Collapse all</button>}<span>{nodes.length} visible nodes</span><button onClick={inspectQuality}>Quality evidence</button></div>
      <div className="change-canvas-row"><div className="change-canvas" aria-label="Interactive CodeFlow Graph">
        <ReactFlow key={db+'|'+work.slug} nodes={nodes} edges={model.edges} nodeTypes={nodeTypes} onNodeClick={(_,n)=>navigation.setSelected(n.id)} nodesDraggable={false} nodesConnectable={false} minZoom={0.01} maxZoom={1.8} defaultViewport={{x:0,y:0,zoom:1}}>
          <FlowViewport request={navigation.camera} nodes={nodes} scope={db+'|'+work.slug}/><Background/><Controls showInteractive={false} showFitView={false}/><MiniMap pannable zoomable style={{width:100,height:65}}/>
        </ReactFlow>
      </div><ChangeInspector key={work.slug} node={chosen} model={model} detail={work.detail} onSelect={choose} onFocus={navigation.focusNode} onShowNode={onShowNode} getArtifact={work.getArtifact}/></div></>:<div className="change-empty"><h2>Keep the reasoning connected to the code.</h2><p>Requirements, test intentions, Tasks and evidence share one inspectable graph. Create a Flow, ask your Lead agent to follow its current phase, then inspect and validate the result here.</p></div>}
    </section>
  </main>;
}

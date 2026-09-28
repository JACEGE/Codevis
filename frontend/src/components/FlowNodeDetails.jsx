import {useEffect,useState} from 'react';
import BRIDGE_URL from '../bridgeUrl';
import {requestJson} from '../api/http';
import TestExecutionDetails from '../changes/TestExecutionDetails';
export default function FlowNodeDetails({node,db}) {
    const [evidence,setEvidence]=useState(null),[error,setError]=useState(''),[revision,setRevision]=useState(0),[artifact,setArtifact]=useState(null);
    const isTest=node.labels?.includes('TestCase');
    useEffect(()=>{
        const controller=new AbortController();setEvidence(null);setArtifact(null);setError('');
        if(isTest)requestJson(BRIDGE_URL+'/api/flows/test-results/'+encodeURIComponent(node.id)+'?db='+encodeURIComponent(db),{signal:controller.signal})
            .then(value=>{if(!controller.signal.aborted)setEvidence(value);}).catch(e=>{if(!controller.signal.aborted)setError(e.message);});
        return()=>controller.abort();
    },[node.id,db,isTest,revision]);
    useEffect(()=>{
        if(!artifact?.pending)return;
        const controller=new AbortController();
        requestJson(BRIDGE_URL+'/api/flows/'+encodeURIComponent(evidence.slug)+'?db='+encodeURIComponent(db)+'&view=artifact&path='+encodeURIComponent(artifact.path),{signal:controller.signal})
            .then(value=>{if(!controller.signal.aborted)setArtifact(value);}).catch(e=>{if(!controller.signal.aborted){setError(e.message);setArtifact(null);}});
        return()=>controller.abort();
    },[artifact?.path,artifact?.pending,evidence?.slug,db,node.id]);
    let data={};try{data=typeof node.workflowData==='string'?JSON.parse(node.workflowData):node.workflowData||{};}catch{}
    const analysis=node.labels?.includes('SourceAnalysis')?data.data:null;
    return <section className="flow-node-details"><h3>CodeFlow evidence</h3>
        <p>{node.content}</p>
        <dl>{[['Status',node.status],['Role',data.role],['Agent instance',data.agent],['Revision',node.revision]].filter(([,value])=>value!=null).map(([label,value])=><div key={label}><dt>{label}</dt><dd>{String(value)}</dd></div>)}</dl>
        {isTest&&<><button className="ui-button" onClick={()=>setRevision(n=>n+1)}>Refresh test evidence</button>{error?<p role="alert">{error}</p>:!evidence?<p>Checking execution freshness…</p>:<TestExecutionDetails execution={evidence.execution} onOpenArtifact={path=>setArtifact({path,pending:true})}/>}
        {artifact?.content&&<details open><summary>Recorded execution artifact</summary><pre>{artifact.content}</pre></details>}</>}
        {analysis&&['facts','approximations','inferences','risks'].map(key=><div key={key}><h4>{key}</h4><p>{analysis[key]}</p></div>)}
        {data.gate&&<><h4>Last completion gate: {data.gate.passed?'passed':'blocked'}</h4>{[...data.gate.failures,...data.gate.warnings].map((f,i)=><p key={i}>{f.message}</p>)}</>}
        {data.submissions?.length>0&&<details><summary>{data.submissions.length} recorded submissions</summary>{data.submissions.map(s=><p key={s.revision}>Revision {s.revision}: {s.agent} as {s.role} · {new Date(s.at).toLocaleString()}</p>)}</details>}
    </section>;
}

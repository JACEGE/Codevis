import { useEffect, useRef, useState } from 'react';
import BRIDGE_URL from '../bridgeUrl';
import { requestJson } from '../api/http';
import useRequestLifetime from '../hooks/useRequestLifetime';
import styles from '../kanban/styles';
export const FLOW_KINDS=['feature','bug','refactor','research','architecture','tech-debt'];
export default function CreateFlowDialog({idea,db,onClose,onCreated}) {
    const dialog=useRef(null),submitting=useRef(false);
    const lifetime=useRequestLifetime(db+'|'+idea.ideaId);
    const [slug]=useState(()=> 'flow-'+crypto.randomUUID());
    const [title,setTitle]=useState(idea.content.split('\n')[0].slice(0,100));
    const [description,setDescription]=useState(idea.content),[kind,setKind]=useState(idea.kind||'feature');
    const [context,setContext]=useState(null),[error,setError]=useState(''),[saving,setSaving]=useState(false);
    useEffect(()=>{dialog.current.showModal();},[]);
    useEffect(()=>{const token=lifetime.current;setContext(null);requestJson(BRIDGE_URL+'/api/flows/idea-context/'+encodeURIComponent(idea.ideaId)+'?db='+encodeURIComponent(db)).then(value=>{if(token===lifetime.current)setContext(value);}).catch(e=>{if(token===lifetime.current)setError(e.message);});},[db,idea.ideaId,lifetime]);
    async function submit(event){
        event.preventDefault();if(submitting.current)return;submitting.current=true;setSaving(true);setError('');const token=lifetime.current;
        try{
            const result=await requestJson(BRIDGE_URL+'/api/ideas/'+encodeURIComponent(idea.ideaId)+'/codeflow?db='+encodeURIComponent(db),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({slug,title,description,kind,db})});
            if(token!==lifetime.current)return;
            if(result.status==='PROJECTION_PENDING'){setError('Flow saved. Open CodeFlow and use Resume saved state to repair its graph projection.');return;}
            onCreated(result.state.slug);
        }catch(e){if(token===lifetime.current)setError(e.message);}
        finally{submitting.current=false;if(token===lifetime.current)setSaving(false);}
    }
    const field={display:'grid',gap:5,marginBottom:14,fontSize:13};
    return <dialog ref={dialog} aria-labelledby="create-flow-title" style={{...styles.detailPanel,maxWidth:'calc(100vw - 48px)',color:'var(--text)'}} onCancel={e=>{e.preventDefault();if(!saving)onClose();}}>
        <form onSubmit={submit}><h2 id="create-flow-title">Create CodeFlow</h2><p>Source: {idea.ideaId} · {db}</p>
            <p>The original Idea stays in the inbox. This Flow starts with Requirements Discovery; no implementation Tasks are generated.</p>
            <fieldset disabled={saving} style={{border:0,padding:0}}>
                <label style={field}>Flow title<input required minLength={8} value={title} onChange={e=>setTitle(e.target.value)} style={styles.editInput}/></label>
                <label style={field}>Flow kind<select value={kind} onChange={e=>setKind(e.target.value)} style={styles.editInput}>{FLOW_KINDS.map(k=><option key={k}>{k}</option>)}</select></label>
                <label style={field}>Initial request<textarea required minLength={12} rows={4} value={description} onChange={e=>setDescription(e.target.value)} style={styles.editTextarea}/></label>
                <h3>Explicitly linked context</h3>{!context?<p>Loading linked context…</p>:<><p>Original Idea text{context.context.length?' and:':'. No linked Knowledge, Specs or source nodes.'}</p><ul>{context.context.map(n=><li key={n.id}>{n.label}: {n.name}</li>)}</ul></>}
                <p>All kinds currently use the reviewed engineering phase sequence. Kind-specific guidance is included for the Lead.</p>
            </fieldset>
            {error&&<p role="alert" style={{color:'var(--danger)'}}>{error}</p>}
            <div style={{display:'flex',justifyContent:'flex-end',gap:8}}><button type="button" className="ui-button" disabled={saving} onClick={onClose}>Cancel</button><button className="ui-button ui-button--primary" disabled={saving||!context}>{saving?'Creating…':'Create Flow'}</button></div>
        </form>
    </dialog>;
}

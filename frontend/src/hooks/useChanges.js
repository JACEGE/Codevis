import { useCallback, useEffect, useRef, useState } from 'react';
import BRIDGE_URL from '../bridgeUrl';
import { requestJson } from '../api/http';
import useRequestLifetime from './useRequestLifetime';
export default function useChanges(db, socket) {
  const lifetime = useRequestLifetime(db);
  const sequence = useRef(0), listSequence = useRef(0), mutating = useRef(null);
  const qualityRequested=useRef(false),qualitySequence=useRef(0);
  const [changes,setChanges] = useState([]), [slug,setSlug] = useState('');
  const [detail,setDetail] = useState(null), [error,setError] = useState(''), [busy,setBusy] = useState(false);
  const [quality,setQuality] = useState(null);
  const url = useCallback((tail='') => BRIDGE_URL+'/api/flows'+tail+(tail.includes('?')?'&':'?')+'db='+encodeURIComponent(db),[db]);
  const loadList = useCallback(async()=>{
    const token=lifetime.current, request=++listSequence.current;
    try {const r=await requestJson(url());if(lifetime.current===token&&listSequence.current===request)setChanges(r.changes);}
    catch(e){if(lifetime.current===token&&listSequence.current===request)setError(e.message);}
  },[url,lifetime]);
  const refresh = useCallback(async()=>{
    if(!slug||mutating.current)return;
    const token=lifetime.current, request=++sequence.current,qualityRequest=++qualitySequence.current;
    setQuality(null);
    try{
      const [detailResult,qualityResult]=await Promise.allSettled([
        requestJson(url('/'+encodeURIComponent(slug))),
        qualityRequested.current?requestJson(url('/'+encodeURIComponent(slug)+'?view=quality')):Promise.resolve(null),
      ]);
      if(lifetime.current!==token||sequence.current!==request)return;
      if(detailResult.status==='rejected')throw detailResult.reason;
      setDetail(detailResult.value);setError('');
      if(qualitySequence.current===qualityRequest){
        if(qualityResult.status==='rejected')throw qualityResult.reason;
        setQuality(qualityResult.value);
      }
    }
    catch(e){if(lifetime.current===token&&sequence.current===request)setError(e.message);}
  },[slug,url,lifetime]);
  useEffect(()=>{setChanges([]);setSlug('');setDetail(null);setQuality(null);setError('');setBusy(false);loadList();},[db,loadList]);
  useEffect(()=>{sequence.current++;qualitySequence.current++;qualityRequested.current=false;mutating.current=null;setDetail(null);setQuality(null);setBusy(false);refresh();return()=>{sequence.current++;};},[slug,refresh]);
  useEffect(()=>{
    const refreshAll=()=>{loadList();refresh();};
    const onEvent=event=>{if(event.db===db||event.db==={target:'project_db',meta:'codevis_db'}[db])refreshAll();};
    socket?.on('workflow:changed',onEvent);
    const interval=setInterval(refreshAll,15000);
    return()=>{clearInterval(interval);socket?.off('workflow:changed',onEvent);};
  },[db,socket,loadList,refresh]);
  const act = useCallback(async(operation,data={})=>{
    const token=lifetime.current; const request=++sequence.current;const mutation={token,request};mutating.current=mutation;qualitySequence.current++;setQuality(null);setBusy(true);setError('');
    try{
      const tail=operation==='create'?'':'/'+encodeURIComponent(slug)+'/actions';
      const r=await requestJson(url(tail),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...data,db,operation,expectedRevision:detail?.state.revision})});
      if(lifetime.current!==token||sequence.current!==request)return;
      if(r.status==='PROJECTION_PENDING')throw new Error('Saved; graph synchronization needs Resume. '+r.error);
      setDetail(r);setSlug(r.state.slug);setQuality(null);await loadList();
      if(lifetime.current===token&&sequence.current===request&&r.status==='GATE_BLOCKED')setError('Phase remains open. Inspect the gate findings below.');
    }catch(e){if(lifetime.current===token&&sequence.current===request)setError(e.message);}
    finally{if(mutating.current?.request===request&&mutating.current?.token===token)mutating.current=null;if(lifetime.current===token&&sequence.current===request)setBusy(false);}
  },[db,detail,slug,url,lifetime,loadList]);
  const getQuality=useCallback(async()=>{
    if(!slug||mutating.current)return;
    qualityRequested.current=true;
    const token=lifetime.current,request=sequence.current,qualityRequest=++qualitySequence.current;
    setQuality(null);
    try{const r=await requestJson(url('/'+encodeURIComponent(slug)+'?view=quality'));if(lifetime.current===token&&sequence.current===request&&qualitySequence.current===qualityRequest)setQuality(r);}
    catch(e){if(lifetime.current===token&&sequence.current===request&&qualitySequence.current===qualityRequest)setError(e.message);}
  },[slug,url,lifetime]);
  const getArtifact=useCallback(path=>requestJson(url('/'+encodeURIComponent(slug)+'?view=artifact&path='+encodeURIComponent(path))),[slug,url]);
  return {changes,slug,setSlug,detail,quality,error,busy,act,refresh,getQuality,getArtifact};
}

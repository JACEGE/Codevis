import {useEffect,useRef,useState} from 'react';
import useRequestLifetime from '../hooks/useRequestLifetime';

// An artifact belongs to the inspected revision, not just the selected node.
export default function useFlowArtifact({scope,getArtifact}) {
  const lifetime=useRequestLifetime(scope),sequence=useRef(0);
  const [result,setResult]=useState(null);
  useEffect(()=>{sequence.current++;setResult(null);},[scope]);
  const open=async path=>{
    const token=lifetime.current,request=++sequence.current;
    setResult(null);
    try {
      const artifact=await getArtifact(path);
      if(token===lifetime.current&&request===sequence.current)setResult({scope,artifact});
    } catch(e) {
      if(token===lifetime.current&&request===sequence.current)setResult({scope,error:e.message});
    }
  };
  return {artifact:result?.scope===scope?result.artifact:null,error:result?.scope===scope?result.error:null,open};
}

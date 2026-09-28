import {useEffect,useRef} from 'react';
import {useReactFlow,useViewport} from '@xyflow/react';
import {readableNodeCenter,flowBounds} from './navigation';

export default function FlowViewport({request,nodes,scope}) {
  const flow=useReactFlow(),handled=useRef(null),previous=useRef(null);
  const {zoom}=useViewport();
  useEffect(()=>{
    if(!flow.viewportInitialized||!request||request.scope!==scope||handled.current===request.token)return;
    const node=nodes.find(n=>n.id===request.nodeId);
    if(!node&&!['overview','exit'].includes(request.mode))return;
    handled.current=request.token;
    // Only explicit navigation moves the camera. Polling and inspector updates do not.
    if(request.mode==='overview'){const bounds=flowBounds(nodes);if(bounds)flow.fitBounds(bounds,{padding:0.15,duration:0});return;}
    if(request.mode==='exit'&&previous.current){flow.setViewport(previous.current,{duration:0});previous.current=null;return;}
    if(request.mode==='focus'&&request.remember)previous.current=flow.getViewport();
    if(node){const target=readableNodeCenter(node,flow.getZoom());flow.setCenter(target.x,target.y,{zoom:target.zoom,duration:0});}
  },[flow,request,nodes,scope]);
  return <span className="change-zoom-readout" aria-label="Graph zoom">{Math.round(zoom*100)}%</span>;
}

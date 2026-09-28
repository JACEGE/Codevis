import {useEffect,useMemo,useRef,useState} from 'react';
import {changeGraphModel} from './graphModel';
import {revealAncestors} from './navigation';

export default function useFlowNavigation(detail,quality,scope,onQuality) {
  const [expanded,setExpanded]=useState(new Set()),[selected,setSelected]=useState(null),[focus,setFocus]=useState(null);
  const [showSource,setShowSource]=useState(false),[incomplete,setIncomplete]=useState(false),[camera,setCamera]=useState(null);
  const serial=useRef(0),beforeFocus=useRef(null);
  const model=useMemo(()=>changeGraphModel(detail,{expanded,focus,showSource,incomplete,quality}),[detail,expanded,focus,showSource,incomplete,quality]);
  const state=detail?.state;
  const move=(mode,nodeId,extra={})=>setCamera({mode,nodeId,scope,token:++serial.current,...extra});
  useEffect(()=>{
    setExpanded(new Set());setFocus(null);setShowSource(false);setIncomplete(false);setSelected(null);setCamera(null);beforeFocus.current=null;
  },[scope]);
  useEffect(()=>{
    if(!state)return;
    const phase=detail.graph.nodes.find(n=>n.label==='Phase'&&n.key===state.currentPhase);
    if(phase){setSelected(phase.id);move('node',phase.id);}
  },[scope,state?.changeId]);
  const choose=id=>{
    const node=model.allNodes.find(n=>n.id===id);if(!node)return;
    setSelected(id);
    if(node.source)setShowSource(true);
    // A result explicitly selected through search/relationships must be visible even under a filter.
    setIncomplete(false);
    if(!model.nodes.some(n=>n.id===id)){
      setFocus(null);
      const ancestors=revealAncestors(model,id);
      if(ancestors)setExpanded(old=>new Set([...old,...ancestors]));
      else setFocus(id);
    }
    move('node',id);
  };
  const toggle=id=>{
    setExpanded(old=>{const next=new Set(old);next.has(id)?next.delete(id):next.add(id);return next;});
    setSelected(id);move('node',id);
    if(model.allNodes.find(n=>n.id===id)?.key==='quality')onQuality();
  };
  const revealPhase=key=>{
    const node=model.allNodes.find(n=>n.label==='Phase'&&n.key===key);if(!node)return;
    setSelected(node.id);setFocus(null);setExpanded(old=>new Set(old).add(node.id));move('node',node.id);
  };
  return {model,selected,focus,showSource,incomplete,camera,choose,toggle,revealPhase,setSelected,setShowSource,setIncomplete,
    focusNode:id=>{if(!focus)beforeFocus.current={expanded,selected,showSource,incomplete};setSelected(id);setFocus(id);setShowSource(true);setIncomplete(false);move('focus',id,{remember:!focus});},
    exitFocus:()=>{const previous=beforeFocus.current;setFocus(null);if(previous){setExpanded(previous.expanded);setShowSource(previous.showSource);setIncomplete(previous.incomplete);setSelected(previous.selected);}beforeFocus.current=null;move('exit',previous?.selected||selected);},
    current:()=>revealPhase(state.currentPhase),
    overview:()=>move('overview'),
    readable:()=>choose(selected),
    collapse:()=>{setExpanded(new Set());setFocus(null);const phase=model.allNodes.find(n=>n.label==='Phase'&&n.key===state.currentPhase);setSelected(phase?.id||null);move('node',phase?.id);},
  };
}

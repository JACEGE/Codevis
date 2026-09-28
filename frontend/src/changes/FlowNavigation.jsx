import {useMemo,useState} from 'react';
import {searchFlowNodes} from './navigation';
export default function FlowNavigation({model,selected,focus,onChoose,onCurrent,onOverview,onReadable,onExit}) {
  const [query,setQuery]=useState('');
  const results=useMemo(()=>searchFlowNodes(model.allNodes,query),[model.allNodes,query]);
  const phases=model.allNodes.filter(n=>n.label==='Phase');
  const pick=id=>{onChoose(id);setQuery('');};
  return <div className="flow-navigation" aria-label="Flow graph navigation">
    <button onClick={onCurrent}>Current phase</button>
    <label>Jump to phase<select aria-label="Jump to phase" value={phases.some(n=>n.id===selected)?selected:''} onChange={e=>pick(e.target.value)}>
      <option value="" disabled>Choose phase…</option>{phases.map(n=><option key={n.id} value={n.id}>{n.title}</option>)}
    </select></label>
    <div className="flow-node-search">
      <label htmlFor="flow-node-search">Find in Flow</label>
      <input id="flow-node-search" type="search" value={query} placeholder="ID, title, type or file"
        onChange={e=>setQuery(e.target.value)} onKeyDown={e=>{if(e.key==='Escape'){setQuery('');e.stopPropagation();}if(e.key==='Enter'&&results.matches[0]){e.preventDefault();pick(results.matches[0].id);}}}/>
      {query.trim()&&<div className="flow-search-results" aria-label="Flow search results"><small role="status">{results.total?results.total+' matches'+(results.total>results.matches.length?' · first '+results.matches.length+' shown':''):'No matching nodes'}</small>
        {results.matches.map(n=><button key={n.id} onClick={()=>pick(n.id)}><small>{n.label} {n.key}</small><strong>{n.title}</strong>{n.file&&<small>{n.file}</small>}</button>)}
      </div>}
    </div>
    <button onClick={onReadable} disabled={!selected}>Read selected</button>
    <button onClick={onOverview} title="Fit all currently visible nodes">Overview</button>
    {focus&&<button onClick={onExit}>Back to Flow</button>}
  </div>;
}

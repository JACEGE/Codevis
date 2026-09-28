import { GRAPH_PRESETS } from '../graph/perspectives';
export default function GraphPerspectiveControls({preset,onPreset,relations,hidden,onHidden,showTestSource,onShowTestSource}) {
    return <><select aria-label="Graph perspective" value={preset} onChange={e=>onPreset(e.target.value)}>
        {Object.entries(GRAPH_PRESETS).map(([key,value])=><option key={key} value={key}>{value.title}</option>)}
    </select><details className="graph-edge-filter"><summary>Relationships</summary><div className="graph-edge-options">
        <p>Filter edges independently of node types. Presets select a starting perspective.</p>
        <button className="ui-button" onClick={()=>onHidden(new Set())}>Show all listed</button><button className="ui-button" onClick={()=>onHidden(new Set(relations))}>Hide all listed</button>
        {relations.map(type=><label key={type}><input type="checkbox" checked={!hidden.has(type)} onChange={()=>{const next=new Set(hidden);next.has(type)?next.delete(type):next.add(type);onHidden(next);}}/>{type}</label>)}
    </div></details><label className="graph-test-filter"><input type="checkbox" checked={showTestSource} onChange={e=>onShowTestSource(e.target.checked)}/>Test source</label></>;
}

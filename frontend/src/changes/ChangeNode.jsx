import { EXECUTION_LABELS } from './TestExecutionDetails';
import WorkflowGlyph from '../graph/WorkflowGlyph';
import { memo } from 'react';
import { Handle, Position } from '@xyflow/react';
const statuses = {active:'In progress',complete:'Complete',pending:'Pending',defined:'Defined',done:'Done',review:'In review',in_progress:'In progress',todo:'To do'};
export default memo(function ChangeNode({data,selected}) {
  const phase=data.label==='Phase'?data.data:null;
  return <article className={'change-node'+(selected?' is-selected':'')} data-status={data.status} data-kind={data.label}>
    <Handle type="target" position={Position.Top}/>
    <div className="change-node-kind"><WorkflowGlyph label={data.label}/>{data.source?'Source · '+data.label:data.label}{data.key&&data.label!=='Phase'?' · '+data.key:''}</div>
    <strong title={data.title}>{data.title}</strong>
    <div className="change-node-status">{statuses[data.status]||data.status||'Linked'}</div>
    {phase&&<small>{phase.role}{phase.agent?' · '+phase.agent:''}</small>}
    {data.label==='TestCase'&&<><small>Intent defined · {data.testSummary?.implementations?data.testSummary.implementations+' test links':'Implementation missing'}</small><small className="test-result-label" data-result={data.testSummary?.execution}>Result: {EXECUTION_LABELS[data.testSummary?.execution]||'Not recorded'}</small></>}
    {data.label==='Task'&&<><small>{data.assignedTo||'Unassigned'}{data.wave?' · Wave '+data.wave:''}</small><small>{data.taskSummary?.requirements||0} requirements · {data.taskSummary?.testCases||0} TestCases · {data.taskSummary?.symbols||0} symbols</small></>}
    {data.childCount>0&&data.onToggle&&<button className="nodrag nopan" aria-label={(data.expanded?'Collapse ':'Expand ')+data.title} onClick={e=>{e.stopPropagation();data.onToggle(data.id);}}>{data.expanded?'− Collapse':'+ Expand'} · {data.childCount}</button>}
    <Handle type="source" position={Position.Bottom}/>
  </article>;
});

import { workflowOutline, WORKFLOW_STYLES } from './workflowShapes';
export default function WorkflowGlyph({ label, color, size=16 }) {
    if(!WORKFLOW_STYLES[label])return null;
    const points=workflowOutline(label);
    return <svg aria-hidden="true" width={size} height={size} viewBox="-1.2 -1.2 2.4 2.4" style={{color:color||WORKFLOW_STYLES[label].color,flexShrink:0}}>
        {points?<polygon points={points.map(p=>p.join(',')).join(' ')} fill="currentColor"/>:<circle r=".78" fill="none" stroke="currentColor" strokeWidth=".35"/>}
    </svg>;
}

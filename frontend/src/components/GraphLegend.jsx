import WorkflowGlyph from '../graph/WorkflowGlyph';
import { workflowType, WORKFLOW_STYLES } from '../graph/workflowShapes';
import { useMemo } from 'react';
import { NODE_COLORS, colorForNode, displayNameForLabel } from '../nodePalette';

const LOCK_ITEMS = [
    { color: "var(--violet)", label: 'Planned', matches: n => n.lockStatus === 'planned' },
    { color: "var(--danger)", label: 'Conflict / blocked', matches: n => ['conflict', 'blocked'].includes(n.lockStatus) },
    { color: "var(--success)", label: 'Released', matches: n => n.lockStatus === 'released' },
    { color: "var(--warning)", label: 'Locked by lead', matches: n => n.locked && (n.lockedBy === 'lead' || n.lockedBy?.startsWith('lead-')) },
    { color: 'var(--info)', label: 'Locked by worker', matches: n => n.locked && n.lockedBy && n.lockedBy !== 'lead' && !n.lockedBy.startsWith('lead-') },
];

export default function GraphLegend({ nodes = [], palette = {} }) {
    const types = useMemo(() => {
        const entries = new Map();
        for (const node of nodes) {
            const labels = node.labels || [];
            const label = labels.find(l => palette[l]) || labels.find(l => NODE_COLORS[l]) || node.category || labels[0] || 'Other';
            const color = colorForNode(node, palette);
            const key = `${label}:${color}`;
            const entry = entries.get(key) || { label: displayNameForLabel(label)+(workflowType(labels)&&node.status?' · '+node.status:''), type: workflowType(labels), color, count: 0 };
            entry.count++;
            entries.set(key, entry);
        }
        return [...entries.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
    }, [nodes, palette]);
    const locks = LOCK_ITEMS.filter(item => nodes.some(item.matches));
    return (
        <details className="graph-legend">
            <summary>Legend</summary>
            <div className="graph-legend-content">
                <strong>Node types in view</strong>
                {types.length === 0 && <p>No nodes in view.</p>}
                {types.map(item => <LegendRow key={`${item.label}:${item.color}`} {...item} />)}
                {locks.length > 0 && <>
                    <strong>Lock states in view</strong>
                    <p>These colors override node type colors.</p>
                    {locks.map(item => <LegendRow key={item.label} {...item} />)}
                </>}
            </div>
        </details>
    );
}

function LegendRow({ label, color, count, type }) {
    return <div className="graph-legend-row">
        {type ? <WorkflowGlyph label={type} color={color}/> : <span aria-hidden="true" style={{ background: color }} />}
        <span title={WORKFLOW_STYLES[type]?.shape}>{label}</span>
        {count != null && <small>{count}</small>}
    </div>;
}

import { useMemo } from 'react';
import { NODE_COLORS, colorForNode, displayNameForLabel } from '../nodePalette';

const LOCK_ITEMS = [
    { color: '#a855f7', label: 'Planned', matches: n => n.lockStatus === 'planned' },
    { color: '#ff4444', label: 'Conflict / blocked', matches: n => ['conflict', 'blocked'].includes(n.lockStatus) },
    { color: '#39ff85', label: 'Released', matches: n => n.lockStatus === 'released' },
    { color: '#ffd700', label: 'Locked by lead', matches: n => n.locked && (n.lockedBy === 'lead' || n.lockedBy?.startsWith('lead-')) },
    { color: '#84cc16', label: 'Locked by worker', matches: n => n.locked && n.lockedBy && n.lockedBy !== 'lead' && !n.lockedBy.startsWith('lead-') },
];

export default function GraphLegend({ nodes = [], palette = {} }) {
    const types = useMemo(() => {
        const entries = new Map();
        for (const node of nodes) {
            const labels = node.labels || [];
            const label = labels.find(l => palette[l]) || labels.find(l => NODE_COLORS[l]) || node.category || labels[0] || 'Other';
            const color = colorForNode(node, palette);
            const key = `${label}:${color}`;
            const entry = entries.get(key) || { label: displayNameForLabel(label), color, count: 0 };
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

function LegendRow({ label, color, count }) {
    return <div className="graph-legend-row">
        <span aria-hidden="true" style={{ background: color }} />
        <span>{label}</span>
        {count != null && <small>{count}</small>}
    </div>;
}

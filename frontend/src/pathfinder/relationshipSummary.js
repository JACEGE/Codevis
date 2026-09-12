const idOf = (value) => value?.id ?? value;

function countsToRows(counts) {
    return [...counts.entries()]
        .map(([type, count]) => ({ type, count }))
        .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
}

export function summarizeVisibleRelations(graphData, nodeId) {
    const incoming = new Map();
    const outgoing = new Map();
    for (const link of graphData?.links || []) {
        const type = link.relType || link.type || 'RELATED';
        if (String(idOf(link.source)) === String(nodeId)) {
            outgoing.set(type, (outgoing.get(type) || 0) + 1);
        }
        if (String(idOf(link.target)) === String(nodeId)) {
            incoming.set(type, (incoming.get(type) || 0) + 1);
        }
    }
    const node = (graphData?.nodes || []).find((candidate) => String(candidate.id) === String(nodeId));
    return {
        node: node ? { id: node.id, name: node.name, labels: node.labels || [] } : null,
        incoming: countsToRows(incoming),
        outgoing: countsToRows(outgoing),
    };
}

export function countRelations(rows, allowed) {
    return (rows || []).reduce((total, row) => total + (allowed.has(row.type) ? row.count : 0), 0);
}

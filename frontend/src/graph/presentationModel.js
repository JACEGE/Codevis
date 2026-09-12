export function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export function edgeKey(link) {
    const source = link.source?.id ?? link.source;
    const target = link.target?.id ?? link.target;
    return `${source}->${target}`;
}

export function getLinkWidth(link, { activeLinks, debugEdges, hoverEdges }) {
    const key = edgeKey(link);
    if (debugEdges.has(key)) return 5;
    if (activeLinks.has(key)) return 4;
    if (hoverEdges?.has(key)) return 2.5;
    if (link.relType === 'RENDERS' || link.relType === 'HANDLES') return 1.2;
    if (link.relType === 'PASSES_PROP') return 0.9;
    if (link.relType === 'READS_STATE' || link.relType === 'WRITES_STATE') return 0.8;
    if (link.relType === 'RETURNS') return 0.7;
    return 0.6;
}

export function buildLinkLabel(link) {
    const source = link.source?.name ?? link.source;
    const target = link.target?.name ?? link.target;
    const propInfo = link.propName ? ` (${link.propName})` : '';
    return `<div style="
        background: rgba(10,10,20,0.9);
        border: 1px solid rgba(255,170,0,0.3);
        border-radius: 6px;
        padding: 6px 10px;
        font-family: 'JetBrains Mono', monospace;
        font-size: 11px;
        color: #e0e6f0;
    ">
        <span style="color:#00dcff;">${escapeHtml(source)}</span>
        <span style="color:#ff8c42;"> —[${escapeHtml(link.relType)}${escapeHtml(propInfo)}]→ </span>
        <span style="color:#39ff85;">${escapeHtml(target)}</span>
    </div>`;
}

export function buildNodeLabel(node, { getAgentColor, visibleDegree }) {
    const isTask = node.labels?.includes('Task');
    const accent = isTask ? '#6366f1'
        : node.labels?.includes('Knowledge') ? '#14b8a6'
            : '#00dcff';
    let badge = '';
    if (node.lockStatus === 'conflict' || node.lockStatus === 'blocked') {
        badge = '<span style="color:#ff4444; font-size:10px; margin-left:8px;">CONFLICT</span>';
    } else if (node.locked && node.lockedBy) {
        badge = `<span style="color:${getAgentColor(node.lockedBy)}; font-size:10px; margin-left:8px;">🔒 ${escapeHtml(node.lockedBy)}</span>`;
    }
    const second = isTask
        ? [node.status, node.priority, node.assignedTo].filter(Boolean).map(escapeHtml).join(' · ')
        : node.signature
            ? escapeHtml(node.signature)
            : escapeHtml((node.labels || []).filter((label) => label !== 'Spec').join(', ') || '—');
    const visible = visibleDegree || { out: 0, in: 0 };
    const total = typeof node.dbDegree === 'number' ? node.dbDegree : visible.out + visible.in;
    const hidden = Math.max(0, total - visible.out - visible.in);
    const location = node.file
        ? `${escapeHtml(node.file)}${node.startLine ? `:${escapeHtml(node.startLine)}` : ''}`
        : (node.taskId ? escapeHtml(node.taskId) : '');
    const counts = [
        `<span style="color:#a855f7;">←${visible.in}</span>`,
        `<span style="color:#0ea5e9;">→${visible.out}</span>`,
        hidden > 0 ? `<span style="color:#f59e0b;">+${hidden} hidden</span>` : '',
    ].filter(Boolean).join('  ');
    return `<div style="
        background: rgba(10,10,20,0.94); border: 1px solid ${accent}55;
        border-radius: 6px; padding: 7px 10px; font-family: 'JetBrains Mono', monospace;
        font-size: 11px; color: #e0e6f0; max-width: 460px; line-height: 1.5;
        backdrop-filter: blur(8px);
    ">
        <div style="color:${accent}; font-size:13px; font-weight:700;">
            ${escapeHtml(node.name || 'unnamed')}${badge}
        </div>
        <div style="color:#8b95b0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${second}</div>
        <div style="color:#6b7394; display:flex; gap:14px; justify-content:space-between;">
            <span style="overflow:hidden; text-overflow:ellipsis;">${location}</span>
            <span style="white-space:nowrap;">${counts}</span>
        </div>
        ${node.lastError ? '<div style="color:#ff6b6b; font-size:10px;">⚠ runtime error</div>' : ''}
    </div>`;
}

export default function KanbanTaskCard({
    task,
    column,
    styles,
    priorityBadges,
    epicAccent,
    dragged,
    selected,
    isOpen,
    onOpen,
    onDragStart,
    onDragEnd,
    onToggleSelection,
    onHover,
}) {
    const agentColor = getAgentColor(task.assignedTo) || column.color;

    return (
        <div
            style={{
                ...styles.card,
                display: 'flex',
                gap: '6px',
                alignItems: 'flex-start',
                opacity: dragged ? 0.4 : 1,
                outline: isOpen ? '2px solid var(--accent)' : 'none',
                backgroundColor: selected ? 'var(--surface-hover)' : 'var(--surface-raised)',
                boxShadow: selected ? '0 0 0 2px var(--accent)' : undefined,
            }}
            draggable
            onDragStart={(event) => onDragStart(event, task)}
            onDragEnd={onDragEnd}
            onClick={() => onOpen(task)}
            onMouseEnter={() => onHover?.(affectedNodeNames(task))}
            onMouseLeave={() => onHover?.(new Set())}
        >
            <input
                type="checkbox"
                checked={selected}
                onChange={() => {}}
                onClick={(event) => onToggleSelection(task.taskId, event)}
                style={{ cursor: 'pointer', flexShrink: 0, marginTop: '2px' }}
            />
            <div style={{ flex: 1, minWidth: 0 }}>
                <div style={styles.cardTop}>
                    {task.wave != null && (
                        <span title={waveTitle(task)} style={waveStyle(task.waveStatus)}>
                            🌊 {String(task.wave)}
                        </span>
                    )}
                    {task.epicId && task.seqIndex != null && (
                        <span
                            title={`Step ${task.seqIndex} in "${task.epicTitle}"`}
                            style={{
                                fontSize: 10,
                                fontWeight: 700,
                                lineHeight: 1,
                                padding: '2px 5px',
                                borderRadius: 999,
                                background: `color-mix(in srgb, ${epicAccent} 20%, transparent)`,
                                color: "var(--danger)",
                            }}
                        >
                            {task.seqIndex}
                        </span>
                    )}
                    <span style={styles.cardId}>{task.taskId}</span>
                    {task.priority && priorityBadges[task.priority] && (
                        <span style={{
                            ...styles.priorityBadge,
                            backgroundColor: priorityBadges[task.priority].bg,
                        }}>
                            {priorityBadges[task.priority].label}
                        </span>
                    )}
                </div>
                <div style={styles.cardTitle}>{task.title}</div>
                {task.description && <div style={styles.cardDesc}>{task.description}</div>}
                <div style={styles.cardFooter}>
                    {task.assignedTo && (
                        <span style={{ ...styles.assignee, borderLeft: `2px solid ${agentColor}` }}>
                            {task.assignedTo}
                        </span>
                    )}
                    {task.category && <span style={styles.category}>{task.category}</span>}
                </div>
                {task.lastComment && <div style={styles.comment}>{task.lastComment}</div>}
            </div>
        </div>
    );
}

export function affectedNodeNames(task) {
    return new Set((task.affectedNodes || []).map((node) => node.name));
}

export function getAgentColor(agentId) {
    if (!agentId) return null;
    if (agentId === 'lead' || agentId.startsWith('lead-')) return 'var(--warning)';
    return 'var(--info)';
}

function waveTitle(task) {
    const status = task.waveStatus ? ` (${task.waveStatus})` : '';
    return `Wave ${task.wave}${status} — tasks in the same wave run in parallel`;
}

function waveStyle(status) {
    const active = status === 'active';
    return {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 3,
        fontSize: 10,
        fontWeight: 700,
        lineHeight: 1,
        padding: '2px 6px',
        borderRadius: 999,
        background: active ? 'var(--accent-soft)' : 'var(--surface-hover)',
        color: active ? 'var(--accent)' : 'var(--muted)',
        border: '1px solid var(--border)',
    };
}

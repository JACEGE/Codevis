import { getAgentColor } from './KanbanTaskCard';

export default function KanbanDoneColumn({ column, tasks, styles, collapsed, dragOver,
    selectedTaskIds, selectedTask, draggedTask, onToggleCollapsed, onToggleSelection,
    onDragOver, onDrop, onDragStart, onOpenTask, onRequestDelete }) {
    const taskIds = tasks.map((task) => task.taskId);
    const selectedCount = taskIds.filter((id) => selectedTaskIds.has(id)).length;
    const allSelected = taskIds.length > 0 && selectedCount === taskIds.length;
    const someSelected = selectedCount > 0 && !allSelected;

    return (
        <div
            style={{
                gridColumn: '1 / -1',
                border: '1px solid var(--border)',
                borderRadius: '8px',
                backgroundColor: dragOver ? 'var(--surface-hover)' : 'var(--surface)',
                boxShadow: dragOver ? '0 0 0 2px rgba(120,120,120,0.35) inset' : 'none',
                flexShrink: 0,
                maxHeight: collapsed ? 'none' : '40vh',
                minHeight: collapsed ? '36px' : undefined,
                display: 'flex',
                flexDirection: 'column',
                overflow: 'hidden',
                transition: 'background-color 0.12s, box-shadow 0.12s',
            }}
            onDragOver={(event) => onDragOver(event, column.key)}
            onDrop={(event) => onDrop(event, column.key)}
        >
            <div
                style={{ ...styles.columnHeader, borderBottomColor: column.color, backgroundColor: 'transparent' }}
                onDragOver={(event) => onDragOver(event, column.key)}
                onDrop={(event) => onDrop(event, column.key)}
            >
                {taskIds.length > 0 && (
                    <input type="checkbox" checked={allSelected}
                        ref={(element) => { if (element) element.indeterminate = someSelected; }}
                        onChange={() => onToggleSelection(taskIds)} onClick={(event) => event.stopPropagation()}
                        style={{ cursor: 'pointer', flexShrink: 0 }}
                        title={allSelected ? 'Deselect all in Done' : 'Select all in Done'} />
                )}
                <span style={{ ...styles.columnDot, backgroundColor: column.color }} />
                <span style={styles.columnLabel}>{column.label}</span>
                <span style={styles.columnCount}>{tasks.length}</span>
                <button onClick={onToggleCollapsed} title={collapsed ? 'Expand' : 'Collapse'} style={collapseButtonStyle}>
                    {collapsed ? '▲' : '▼'}
                </button>
            </div>
            {!collapsed && (
                <div style={{ ...styles.cardList, flexDirection: 'row', flexWrap: 'wrap' }}>
                    {tasks.map((task) => (
                        <DoneTaskCard key={task.taskId} task={task} column={column} styles={styles}
                            selected={selectedTaskIds.has(task.taskId)} open={selectedTask === task.taskId}
                            dragged={draggedTask?.taskId === task.taskId} onToggleSelection={onToggleSelection}
                            onDragStart={onDragStart} onOpen={onOpenTask} onRequestDelete={onRequestDelete} />
                    ))}
                </div>
            )}
        </div>
    );
}

function DoneTaskCard({ task, column, styles, selected, open, dragged, onToggleSelection,
    onDragStart, onOpen, onRequestDelete }) {
    const agentColor = getAgentColor(task.assignedTo) || column.color;
    return (
        <div style={{ ...styles.card, width: '220px', display: 'flex', gap: '6px', alignItems: 'flex-start',
            opacity: dragged ? 0.4 : 1, borderLeft: `4px solid ${agentColor}`,
            outline: open ? `2px solid ${agentColor}` : 'none',
            backgroundColor: selected ? 'var(--surface-hover)' : 'var(--surface-raised)',
            boxShadow: selected ? '0 0 0 2px #93c5fd' : undefined }}
            draggable onDragStart={(event) => onDragStart(event, task)} onClick={() => onOpen(task)}>
            <input type="checkbox" checked={selected} onChange={() => {}}
                onClick={(event) => onToggleSelection(task.taskId, event)}
                style={{ cursor: 'pointer', flexShrink: 0, marginTop: '2px' }} />
            <div style={{ flex: 1, minWidth: 0 }}>
                <div style={styles.cardTop}>
                    <span style={styles.cardId}>{task.taskId}</span>
                    <button title="Delete this task permanently" onClick={(event) => {
                        event.stopPropagation();
                        onRequestDelete(task);
                    }} style={styles.cardDelete}>×</button>
                </div>
                <div style={styles.cardTitle}>{task.title}</div>
            </div>
        </div>
    );
}

const collapseButtonStyle = { marginLeft: '4px', background: 'transparent', border: 'none',
    cursor: 'pointer', fontSize: '12px', color: 'var(--muted)', padding: '2px 6px', borderRadius: '3px', lineHeight: 1 };

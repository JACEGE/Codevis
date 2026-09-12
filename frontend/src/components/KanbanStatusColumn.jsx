import EpicGroup from './EpicGroup';

export default function KanbanStatusColumn({
    column,
    columnSpan,
    tasks,
    grouped,
    styles,
    collapsed,
    dragOver,
    selectedTaskIds,
    onToggleCollapsed,
    onToggleSelection,
    onDragOver,
    onDrop,
    renderTaskCard,
    epicById,
    epicAccent,
    epicCollapsed,
    onToggleEpic,
    onDropTaskOnEpic,
    onMoveEpic,
    onOpenEpic,
    epicTaskIds,
    epicSelection,
    draggedTask,
    draggedEpicId,
    onEpicDragStart,
    onEpicDragEnd,
}) {
    const taskIds = tasks.map((task) => task.taskId);
    const selectedCount = taskIds.filter((id) => selectedTaskIds.has(id)).length;
    const allSelected = taskIds.length > 0 && selectedCount === taskIds.length;
    const someSelected = selectedCount > 0 && !allSelected;

    return (
        <div
            style={{
                ...styles.column,
                gridColumn: columnSpan,
                ...(collapsed ? styles.columnCollapsed : {}),
                ...(dragOver ? dragOverStyle : {}),
                transition: 'background-color 0.12s, box-shadow 0.12s',
            }}
            onDragOver={(event) => onDragOver(event, column.key)}
            onDrop={(event) => onDrop(event, column.key)}
        >
            <div style={{ ...styles.columnHeader, borderBottomColor: column.color }}>
                {taskIds.length > 0 && (
                    <input
                        type="checkbox"
                        checked={allSelected}
                        ref={(element) => { if (element) element.indeterminate = someSelected; }}
                        onChange={() => onToggleSelection(taskIds)}
                        onClick={(event) => event.stopPropagation()}
                        style={{ cursor: 'pointer', flexShrink: 0 }}
                        title={allSelected ? 'Deselect all in column' : 'Select all in column'}
                    />
                )}
                <span style={{ ...styles.columnDot, backgroundColor: column.color }} />
                <span style={styles.columnLabel}>{column.label}</span>
                <span style={styles.columnCount}>{tasks.length}</span>
                <button
                    onClick={onToggleCollapsed}
                    aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${column.label}`}
                    aria-expanded={!collapsed}
                    title={collapsed ? 'Expand' : 'Collapse'}
                    style={collapseButtonStyle}
                >
                    {collapsed ? '▼' : '▲'}
                </button>
            </div>

            {!collapsed && (
                <div style={styles.cardList}>
                    {grouped.free.map((task) => renderTaskCard(task, column))}
                    {grouped.groups.map((group) => {
                        const selection = epicSelection(group.epicId);
                        return (
                            <EpicGroup
                                key={group.epicId}
                                group={group}
                                col={column}
                                epic={epicById.get(group.epicId)}
                                accent={epicAccent}
                                collapsed={!!epicCollapsed[group.epicId]}
                                onToggle={onToggleEpic}
                                onDropTask={(taskId) => onDropTaskOnEpic(group.epicId, taskId, column.key)}
                                onMoveEpic={() => onMoveEpic(group.epicId, column.key)}
                                onOpenEpic={onOpenEpic}
                                epicTaskIds={epicTaskIds(group.epicId)}
                                allSelected={selection.all}
                                someSelected={selection.some}
                                onToggleSelection={onToggleSelection}
                                draggedTask={draggedTask}
                                draggedEpicId={draggedEpicId}
                                onEpicDragStart={onEpicDragStart}
                                onEpicDragEnd={onEpicDragEnd}
                            >
                                {group.tasks.map((task) => renderTaskCard(task, column))}
                            </EpicGroup>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

const dragOverStyle = {
    backgroundColor: 'var(--surface-hover)',
    boxShadow: '0 0 0 2px rgba(120,120,120,0.35) inset',
};

const collapseButtonStyle = {
    marginLeft: '4px',
    background: 'transparent',
    border: 'none',
    cursor: 'pointer',
    fontSize: '12px',
    color: 'var(--muted)',
    padding: '2px 6px',
    borderRadius: '3px',
    lineHeight: 1,
};

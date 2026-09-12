import { useState } from 'react';

export default function IdeaDumpColumn({
    column,
    columnSpan,
    ideas,
    intents,
    priorityBadges,
    styles,
    collapsed,
    onToggleCollapsed,
    editingId,
    editingText,
    onEditingTextChange,
    onStartEdit,
    onCancelEdit,
    onSaveEdit,
    onDelete,
    onToggleIntent,
    onPatch,
    newText,
    onNewTextChange,
    newIntent,
    onNewIntentChange,
    newPriority,
    onNewPriorityChange,
    onCreate,
}) {
    return (
        <div style={{
            ...styles.column,
            gridColumn: columnSpan,
            ...(collapsed ? styles.columnCollapsed : {}),
        }}>
            <ColumnHeader
                column={column}
                count={ideas.length}
                collapsed={collapsed}
                onToggle={onToggleCollapsed}
                styles={styles}
            />
            {!collapsed && (
                <div style={styles.cardList}>
                    <IdeaComposer
                        column={column}
                        intents={intents}
                        priorityBadges={priorityBadges}
                        styles={styles}
                        text={newText}
                        onTextChange={onNewTextChange}
                        selectedIntents={newIntent}
                        onIntentsChange={onNewIntentChange}
                        priority={newPriority}
                        onPriorityChange={onNewPriorityChange}
                        onCreate={onCreate}
                    />
                    {ideas.map((idea) => (
                        <IdeaCard
                            key={idea.ideaId}
                            idea={idea}
                            column={column}
                            intents={intents}
                            priorityBadges={priorityBadges}
                            styles={styles}
                            editing={editingId === idea.ideaId}
                            editingText={editingText}
                            onEditingTextChange={onEditingTextChange}
                            onStartEdit={onStartEdit}
                            onCancelEdit={onCancelEdit}
                            onSaveEdit={onSaveEdit}
                            onDelete={onDelete}
                            onToggleIntent={onToggleIntent}
                            onPatch={onPatch}
                        />
                    ))}

                </div>
            )}
        </div>
    );
}

function ColumnHeader({ column, count, collapsed, onToggle, styles }) {
    return (
        <div style={{ ...styles.columnHeader, borderBottomColor: column.color }}>
            <span style={{ ...styles.columnDot, backgroundColor: column.color }} />
            <span style={styles.columnLabel}>{column.label}</span>
            <span style={styles.columnCount}>{count}</span>
            <button onClick={onToggle} title={collapsed ? 'Expand' : 'Collapse'} style={collapseButtonStyle}>
                {collapsed ? '▼' : '▲'}
            </button>
        </div>
    );
}

function IdeaCard(props) {
    const { idea, column, editing, editingText, onEditingTextChange, onSaveEdit,
        onCancelEdit, onStartEdit, onDelete, onToggleIntent, onPatch } = props;
    const [expanded, setExpanded] = useState(false);
    return (
        <div style={{ ...props.styles.card, borderLeft: `4px solid ${column.color}`, cursor: 'default' }}>
            {editing ? (
                <div>
                    <textarea
                        value={editingText}
                        onChange={(event) => onEditingTextChange(event.target.value)}
                        autoFocus
                        style={editTextareaStyle}
                        onKeyDown={(event) => {
                            if (event.key === 'Enter' && !event.shiftKey) {
                                event.preventDefault();
                                onSaveEdit(idea.ideaId);
                            }
                            if (event.key === 'Escape') onCancelEdit();
                        }}
                    />
                    <div style={editActionsStyle}>
                        <button onClick={() => onSaveEdit(idea.ideaId)} style={saveButtonStyle}>Save</button>
                        <button onClick={onCancelEdit} style={cancelButtonStyle}>Cancel</button>
                    </div>
                </div>
            ) : (
                <div>
                    <div style={{ ...ideaContentStyle, ...(!expanded ? { display: '-webkit-box', WebkitLineClamp: 4, WebkitBoxOrient: 'vertical', overflow: 'hidden' } : {}) }}>{idea.content}</div>
                    {idea.content?.length > 180 && <button className="ui-button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? 'Show less' : 'Show more'}</button>}
                    <IntentControls
                        {...props}
                        selected={idea.intent || []}
                        priority={idea.priority || ''}
                        onToggle={(key) => onToggleIntent(idea, key)}
                        onPriorityChange={(priority) => onPatch(idea.ideaId, { priority })}
                    />
                    <div style={cardActionsStyle}>
                        <button onClick={() => onStartEdit(idea)} style={editButtonStyle}>Edit</button>
                        <button onClick={() => onDelete(idea.ideaId)} style={deleteButtonStyle}>Delete</button>
                    </div>
                </div>
            )}
        </div>
    );
}

function IdeaComposer(props) {
    const { column, text, onTextChange, selectedIntents, onIntentsChange,
        priority, onPriorityChange, onCreate } = props;
    return (
        <div style={{ marginTop: '4px' }}>
            <textarea
                value={text}
                onChange={(event) => onTextChange(event.target.value)}
                aria-label="New idea" placeholder="Drop an idea here..."
                style={{ ...composerTextareaStyle, border: `1px solid ${column.color}44` }}
                onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                        event.preventDefault();
                        onCreate();
                    }
                }}
            />
            <IntentControls
                {...props}
                selected={selectedIntents}
                onToggle={(key) => onIntentsChange(selectedIntents.includes(key)
                    ? selectedIntents.filter((item) => item !== key)
                    : [...selectedIntents, key])}
                onPriorityChange={onPriorityChange}
            />
            <button
                onClick={onCreate}
                disabled={!text.trim()}
                style={{
                    ...addButtonStyle,
                    background: text.trim() ? column.color : '#ccc',
                    cursor: text.trim() ? 'pointer' : 'not-allowed',
                }}
            >
                Add idea
            </button>
        </div>
    );
}

function IntentControls({ intents, priorityBadges, styles, selected, onToggle, priority, onPriorityChange }) {
    return (
        <div style={intentRowStyle}>
            {intents.map((option) => {
                const active = selected.includes(option.key);
                return (
                    <button
                        key={option.key}
                        aria-pressed={active}
                        onClick={() => onToggle(option.key)}
                        title={`Mark as ${option.label}`}
                        style={{
                            ...styles.intentChip,
                            background: active ? option.color : 'transparent',
                            color: active ? '#fff' : 'var(--muted)',
                            borderColor: active ? option.color : 'var(--border)',
                        }}
                    >
                        {option.label}
                    </button>
                );
            })}
            <select
                value={priority}
                onChange={(event) => onPriorityChange(event.target.value)}
                aria-label="Priority"
                style={{
                    ...styles.intentPriority,
                    color: priorityBadges[priority] ? '#fff' : 'var(--muted)',
                    background: priorityBadges[priority]?.bg || 'transparent',
                    borderColor: priorityBadges[priority]?.bg || 'var(--border)',
                }}
            >
                <option value="" style={styles.intentPriorityOption}>Priority</option>
                {Object.entries(priorityBadges).map(([key, badge]) => (
                    <option key={key} value={key} style={styles.intentPriorityOption}>{badge.label}</option>
                ))}
            </select>
        </div>
    );
}

const collapseButtonStyle = { marginLeft: '4px', background: 'transparent', border: 'none', cursor: 'pointer', fontSize: '12px', color: 'var(--muted)', padding: '2px 6px', borderRadius: '3px', lineHeight: 1 };
const editTextareaStyle = { width: '100%', minHeight: '50px', fontSize: '12px', fontFamily: 'inherit', padding: '4px', borderRadius: '4px', border: '1px solid var(--border)', background: 'var(--surface-raised)', color: 'var(--text)', boxSizing: 'border-box', resize: 'vertical' };
const composerTextareaStyle = { width: '100%', minHeight: '44px', fontSize: '12px', fontFamily: 'inherit', padding: '6px', borderRadius: '5px', boxSizing: 'border-box', resize: 'vertical', backgroundColor: 'var(--surface-raised)', color: 'var(--text)' };
const editActionsStyle = { display: 'flex', gap: '4px', marginTop: '4px' };
const cardActionsStyle = { display: 'flex', gap: '6px', justifyContent: 'flex-end' };
const intentRowStyle = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '3px', marginTop: '3px', marginBottom: '4px' };
const ideaContentStyle = { fontSize: '12px', color: 'var(--text)', overflowWrap: 'anywhere', lineHeight: 1.4, marginBottom: '4px' };
const saveButtonStyle = { fontSize: '10px', padding: '2px 8px', background: '#0369a1', color: '#fff', border: 'none', borderRadius: '3px', cursor: 'pointer' };
const cancelButtonStyle = { fontSize: '10px', padding: '2px 8px', background: 'var(--surface-raised)', color: 'var(--text)', border: 'none', borderRadius: '3px', cursor: 'pointer' };
const editButtonStyle = { fontSize: '10px', color: '#0369a1', background: 'transparent', border: 'none', cursor: 'pointer' };
const deleteButtonStyle = { fontSize: '10px', color: '#dc2626', background: 'transparent', border: 'none', cursor: 'pointer' };
const addButtonStyle = { marginTop: '3px', fontSize: '11px', padding: '3px 10px', color: '#fff', border: 'none', borderRadius: '4px' };

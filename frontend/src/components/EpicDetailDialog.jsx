import ScopeModeControl from './ScopeModeControl';

export default function EpicDetailDialog({
    db,
    epicDetail,
    setEpicDetail,
    styles,
    epicDetailLoading,
    EPIC_ACCENT,
    epicEditing,
    startEpicEdit,
    COLUMNS,
    PRIORITY_BADGE,
    epicForm,
    setEpicForm,
    epicSaveError,
    saveEpicEdit,
    epicSaving,
    cancelEpicEdit,
    openTaskDetail,
}) {
    return (
        <>
            {epicDetail && (
                <div style={styles.overlay} onClick={() => setEpicDetail(null)}>
                    <div style={styles.detailPanel} onClick={e => e.stopPropagation()}>
                        <div style={styles.detailHeader}>
                            <div style={styles.detailId}>{epicDetail.epicId}</div>
                            <div style={styles.detailClose} onClick={() => setEpicDetail(null)}>x</div>
                        </div>

                        {epicDetailLoading ? (
                            <div style={styles.detailLoading}>Loading...</div>
                        ) : epicDetail.error ? (
                            <div style={{ ...styles.detailLoading, color: '#dc2626' }}>{epicDetail.error}</div>
                        ) : (
                            <>
                                <div style={{
                                    display: 'flex', alignItems: 'center', gap: 8,
                                    marginBottom: 6,
                                }}>
                                    <span style={{
                                        width: 10, height: 10, borderRadius: '50%',
                                        background: EPIC_ACCENT, flexShrink: 0,
                                    }} />
                                    <h2 style={{ ...styles.detailTitle, margin: 0, flex: 1 }}>{epicDetail.title}</h2>
                                    {!epicEditing && (
                                        <button onClick={startEpicEdit} style={styles.editBtn}>Edit epic</button>
                                    )}
                                </div>

                                <ScopeModeControl taskId={epicDetail.epicId} db={db} epic />
                                <div style={styles.detailMeta}>
                                    {/* Kein Dropdown mehr: der Status wird aus den Tasks
                                        ABGELEITET (siehe deriveEpicStatus in der Bridge).
                                        Ein Feld, das man von Hand nachziehen muss, ist nach
                                        dem zweiten Task falsch — genau das war der Fall,
                                        in dem ein Epic 'backlog' meldete, waehrend ein Task
                                        schon in Review lag. */}
                                    <span
                                        title="Derived from the tasks' statuses — not set by hand"
                                        style={{
                                            ...styles.detailStatus,
                                            color: (COLUMNS.find(c => c.key === epicDetail.status) || {}).color || '#6b7394',
                                        }}
                                    >{epicDetail.status}</span>
                                    {epicDetail.priority && PRIORITY_BADGE[epicDetail.priority] && (
                                        <span style={{
                                            ...styles.priorityBadge,
                                            backgroundColor: PRIORITY_BADGE[epicDetail.priority].bg,
                                        }}>{PRIORITY_BADGE[epicDetail.priority].label}</span>
                                    )}
                                    <span style={styles.detailCategory}>
                                        {(epicDetail.tasks || []).filter(t => t.status === 'done').length}
                                        {' / '}{(epicDetail.tasks || []).length} complete
                                    </span>
                                </div>

                                {epicEditing && epicForm ? (
                                    /* Arbeitet auf einer Kopie — nichts erreicht den Graphen
                                       vor Save, damit Cancel wirklich verwirft. */
                                    <div style={styles.detailSection}>
                                        <div style={styles.editLabel}>Title</div>
                                        <input
                                            value={epicForm.title}
                                            onChange={e => setEpicForm(f => ({ ...f, title: e.target.value }))}
                                            style={styles.editInput}
                                        />
                                        <div style={styles.editLabel}>Priority</div>
                                        <select
                                            value={epicForm.priority || 'medium'}
                                            onChange={e => setEpicForm(f => ({ ...f, priority: e.target.value }))}
                                            style={{ ...styles.editInput, cursor: 'pointer' }}
                                        >
                                            {['critical', 'high', 'medium', 'low'].map(p =>
                                                <option key={p} value={p}>{p}</option>)}
                                        </select>
                                        <div style={styles.editLabel}>Description</div>
                                        <textarea
                                            value={epicForm.description}
                                            onChange={e => setEpicForm(f => ({ ...f, description: e.target.value }))}
                                            rows={10}
                                            style={styles.editTextarea}
                                        />
                                        <div style={styles.editLabel}>Work Instructions</div>
                                        <textarea
                                            value={epicForm.workInstructions}
                                            onChange={e => setEpicForm(f => ({ ...f, workInstructions: e.target.value }))}
                                            rows={10}
                                            style={styles.editTextarea}
                                        />
                                        {epicSaveError && (
                                            <div style={{ color: '#dc2626', fontSize: 12, marginTop: 6 }}>{epicSaveError}</div>
                                        )}
                                        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                                            <button onClick={saveEpicEdit} disabled={epicSaving} style={styles.editSaveBtn}>
                                                {epicSaving ? 'Saving…' : 'Save'}
                                            </button>
                                            <button
                                                onClick={cancelEpicEdit}
                                                style={styles.bulkClearBtn}
                                            >Cancel</button>
                                        </div>
                                    </div>
                                ) : (
                                <>
                                {epicDetail.description && (
                                    <div style={styles.detailSection}>
                                        <div style={styles.detailSectionLabel}>Description</div>
                                        <div style={styles.detailDesc}>
                                            {epicDetail.description.split('\n').map((line, i) => (
                                                <div key={i}>{line || ' '}</div>
                                            ))}
                                        </div>
                                    </div>
                                )}

                                {epicDetail.workInstructions && (
                                    <div style={styles.detailSection}>
                                        <div style={styles.detailSectionLabel}>Work Instructions</div>
                                        <div style={{
                                            ...styles.detailDesc,
                                            borderLeftColor: '#ff8c42',
                                            backgroundColor: 'rgba(255,140,66,0.04)',
                                        }}>
                                            {epicDetail.workInstructions.split('\n').map((line, i) => (
                                                <div key={i}>{line || ' '}</div>
                                            ))}
                                        </div>
                                    </div>
                                )}
                                </>
                                )}

                                <div style={styles.detailSection}>
                                    <div style={styles.detailSectionLabel}>
                                        Ordered tasks ({(epicDetail.tasks || []).length})
                                    </div>
                                    {/* Die Reihenfolge steuert ueber get_next_task, welchen
                                        Task ein Worker als naechstes bekommt — deshalb steht
                                        die Position hier vorne und nicht als Beiwerk. */}
                                    {(epicDetail.tasks || []).map((t, i) => (
                                        <div
                                            key={t.taskId}
                                            onClick={() => { setEpicDetail(null); openTaskDetail(t); }}
                                            style={{
                                                display: 'flex', alignItems: 'center', gap: 8,
                                                padding: '5px 8px', marginTop: 3, borderRadius: 5,
                                                border: '1px solid #eee', background: '#fafafa',
                                                cursor: 'pointer',
                                            }}
                                        >
                                            <span style={{
                                                fontSize: 10, fontWeight: 700, color: '#888',
                                                width: 16, textAlign: 'right', flexShrink: 0,
                                            }}>{i + 1}</span>
                                            <span style={{
                                                flex: 1, minWidth: 0, fontSize: 12, color: '#1a1a1a',
                                                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                                            }}>{t.title}</span>
                                            <span style={{
                                                flexShrink: 0, fontSize: 9, fontWeight: 700,
                                                textTransform: 'uppercase', letterSpacing: '0.04em',
                                                padding: '1px 6px', borderRadius: 3,
                                                color: (COLUMNS.find(c => c.key === t.status) || {}).color || '#6b7394',
                                                background: ((COLUMNS.find(c => c.key === t.status) || {}).color || '#6b7394') + '1a',
                                            }}>{t.status}</span>
                                        </div>
                                    ))}
                                    {(epicDetail.tasks || []).length === 0 && (
                                        <div style={{ fontSize: 12, color: '#888', fontStyle: 'italic', padding: '4px 0' }}>
                                            No tasks yet — drag a card onto the group on the board.
                                        </div>
                                    )}
                                </div>
                            </>
                        )}
                    </div>
                </div>
            )}

        </>
    );
}

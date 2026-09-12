import ScopeModeControl from './ScopeModeControl';

export default function TaskDetailDialog({
    db,
    selectedTask,
    editingTask,
    closeDetail,
    styles,
    detailLoading,
    taskDetail,
    taskForm,
    setTaskForm,
    taskSaveError,
    saveTaskEdit,
    taskSaving,
    cancelTaskEdit,
    PRIORITY_BADGE,
    startTaskEdit,
    setDeleteError,
    setPendingDelete,
    editingId,
    setEditingId,
    editingText,
    setEditingText,
    deleteComment,
    saveEdit,
    newComment,
    setNewComment,
    addComment,
    onShowNode,
}) {
    const hasDraft = editingTask || Boolean(newComment?.trim()) || editingId != null;
    return (
        <>
            {selectedTask && (
                /* While editing, a click on the backdrop is ignored — closing there
                   would throw away everything typed without asking. Cancel is the
                   way out of edit mode. */
                <div style={styles.overlay} onClick={editingTask ? undefined : closeDetail}>
                    <div style={styles.detailPanel} onClick={e => e.stopPropagation()}>
                        {detailLoading ? (
                            <div style={styles.detailLoading}>Loading...</div>
                        ) : taskDetail ? (
                            <>
                                <div style={styles.detailHeader}>
                                    <div style={styles.detailId} title="The task id cannot be changed">
                                        {taskDetail.taskId}
                                    </div>
                                    {/* Closing mid-edit would drop the draft without a
                                        word, so while editing this asks first. */}
                                    <div
                                        style={styles.detailClose}
                                        onClick={() => {
                                            if (editingTask && !window.confirm('Unsaved changes to this task will be lost. Close anyway?')) return;
                                            closeDetail();
                                        }}
                                    >x</div>
                                </div>

                                {editingTask && taskForm ? (
                                /* Edit form — works on a draft copy. Nothing reaches the
                                   graph until Save, so Cancel really does discard. */
                                <div style={styles.detailSection}>
                                    <div style={{ marginBottom: '12px' }}>
                                        <label style={styles.editLabel}>Title</label>
                                        <input
                                            value={taskForm.title}
                                            autoFocus
                                            onChange={e => setTaskForm(f => ({ ...f, title: e.target.value }))}
                                            style={styles.editInput}
                                        />
                                    </div>

                                    <div style={{ marginBottom: '12px' }}>
                                        <label style={styles.editLabel}>Priority</label>
                                        <select
                                            value={taskForm.priority}
                                            onChange={e => setTaskForm(f => ({ ...f, priority: e.target.value }))}
                                            style={{ ...styles.editInput, fontSize: '13px', cursor: 'pointer' }}
                                        >
                                            {['critical', 'high', 'medium', 'low'].map(p => (
                                                <option key={p} value={p}>{p}</option>
                                            ))}
                                        </select>
                                    </div>

                                    <div style={{ marginBottom: '12px' }}>
                                        <label style={styles.editLabel}>Description</label>
                                        <textarea
                                            value={taskForm.description}
                                            onChange={e => setTaskForm(f => ({ ...f, description: e.target.value }))}
                                            style={{ ...styles.editTextarea, minHeight: '110px' }}
                                        />
                                    </div>

                                    <div style={{ marginBottom: '12px' }}>
                                        <label style={styles.editLabel}>Work Instructions</label>
                                        <textarea
                                            value={taskForm.workInstructions}
                                            onChange={e => setTaskForm(f => ({ ...f, workInstructions: e.target.value }))}
                                            style={{
                                                ...styles.editTextarea,
                                                minHeight: '110px',
                                                fontFamily: "'JetBrains Mono', monospace",
                                                fontSize: '12px',
                                            }}
                                        />
                                    </div>

                                    {taskSaveError && <div style={styles.confirmError}>{taskSaveError}</div>}

                                    <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                                        <button
                                            onClick={saveTaskEdit}
                                            disabled={taskSaving || !taskForm.title.trim()}
                                            style={{
                                                ...styles.editSaveBtn,
                                                opacity: taskSaving || !taskForm.title.trim() ? 0.5 : 1,
                                                cursor: taskSaving || !taskForm.title.trim() ? 'not-allowed' : 'pointer',
                                            }}
                                        >
                                            {taskSaving ? 'Saving...' : 'Save'}
                                        </button>
                                        <button onClick={cancelTaskEdit} disabled={taskSaving} style={styles.confirmCancel}>
                                            Cancel
                                        </button>
                                        <span style={{ fontSize: '11px', color: '#999' }}>
                                            Status stays put — move the card to change it.
                                        </span>
                                    </div>
                                </div>
                                ) : (
                                <>
                                <h2 style={styles.detailTitle}>{taskDetail.title}</h2>
                                <ScopeModeControl taskId={taskDetail.taskId} db={db} />

                                <div style={styles.detailMeta}>
                                    {taskDetail.priority && PRIORITY_BADGE[taskDetail.priority] && (
                                        <span style={{
                                            ...styles.priorityBadge,
                                            backgroundColor: PRIORITY_BADGE[taskDetail.priority].bg,
                                            fontSize: '11px', padding: '2px 8px'
                                        }}>
                                            {PRIORITY_BADGE[taskDetail.priority].label}
                                        </span>
                                    )}
                                    <span style={styles.detailStatus}>{taskDetail.status}</span>
                                    {taskDetail.assignedTo && (
                                        <span style={styles.detailAssignee}>{taskDetail.assignedTo}</span>
                                    )}
                                    {taskDetail.category && (
                                        <span style={styles.detailCategory}>{taskDetail.category}</span>
                                    )}
                                </div>

                                {/* Edit is always offered; Delete only on done tasks — the
                                    bridge refuses to delete anything else (409), so a button
                                    elsewhere would only promise something it can't do. */}
                                <div style={styles.detailActions}>
                                    <button onClick={startTaskEdit} style={styles.editBtn}>
                                        Edit task
                                    </button>
                                    {taskDetail.status === 'done' && (
                                        <button
                                            onClick={() => { setDeleteError(null); setPendingDelete(taskDetail); }}
                                            style={styles.detailDeleteBtn}
                                            title="Delete this task permanently"
                                        >
                                            Delete task
                                        </button>
                                    )}
                                </div>

                                <div style={styles.detailSection}>
                                    <div style={styles.detailSectionLabel}>Description</div>
                                    <div style={styles.detailDesc}>
                                        {taskDetail.description?.split('\n').map((line, i) => (
                                            <div key={i}>{line || ' '}</div>
                                        ))}
                                    </div>
                                </div>

                                {taskDetail.workInstructions && (
                                    <div style={styles.detailSection}>
                                        <div style={styles.detailSectionLabel}>Work Instructions</div>
                                        <div style={{
                                            ...styles.detailDesc,
                                            borderLeftColor: '#ff8c42',
                                            backgroundColor: 'rgba(255,140,66,0.04)',
                                            whiteSpace: 'pre-wrap',
                                            fontFamily: "'JetBrains Mono', monospace",
                                            fontSize: '12px',
                                        }}>
                                            {taskDetail.workInstructions}
                                        </div>
                                    </div>
                                )}
                                </>
                                )}

                                {taskDetail.affectedNodes?.length > 0 && (
                                    <div style={styles.detailSection}>
                                        <div style={styles.detailSectionLabel}>
                                            Affected Nodes ({taskDetail.affectedNodes.length})
                                        </div>
                                        <div style={styles.nodeList}>
                                            {taskDetail.affectedNodes.map((node, i) => (
                                                <div key={node.id ?? i} style={styles.nodeItem}>
                                                    <span style={styles.nodeLabel}>{node.label}</span>
                                                    <button
                                                        type="button"
                                                        disabled={hasDraft || node.id == null || !onShowNode}
                                                        aria-label={`Show ${node.name} in graph`}
                                                        title={hasDraft ? 'Save or cancel your draft before navigating.' : `Show node and its connections: ${node.id ?? 'identity unavailable'}`}
                                                        onClick={() => {
                                                            if (hasDraft || node.id == null || !onShowNode) return;
                                                            onShowNode(node.id, 1);
                                                            closeDetail();
                                                        }}
                                                        style={{ ...styles.nodeName, background: 'transparent', border: 0,
                                                            padding: 0, font: 'inherit', textAlign: 'left',
                                                            textDecoration: 'underline', cursor: hasDraft ? 'default' : 'pointer' }}
                                                    >{node.name}</button>
                                                    {node.file && <span style={styles.nodeFile}>{node.file}</span>}
                                                    <span style={{
                                                        ...styles.lockBadge,
                                                        backgroundColor: node.locked ? 'rgba(239,68,68,0.12)' : 'rgba(34,197,94,0.12)',
                                                        color: node.locked ? '#dc2626' : '#16a34a'
                                                    }}>
                                                        {node.locked ? 'locked by ' + node.lockedBy : 'free'}
                                                    </span>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                )}

                                {taskDetail.lastComment && (
                                    <div style={styles.detailSection}>
                                        <div style={styles.detailSectionLabel}>Last Status Comment</div>
                                        <div style={styles.detailComment}>
                                            <span style={styles.commentAuthor}>{taskDetail.updatedBy}:</span>
                                            {taskDetail.lastComment}
                                        </div>
                                    </div>
                                )}

                                <div style={styles.detailSection}>
                                    <div style={styles.detailSectionLabel}>
                                        Comments ({(taskDetail.comments || []).length})
                                    </div>
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                                        {(taskDetail.comments || []).map(c => (
                                            <div key={c.id} style={{
                                                backgroundColor: '#f8f8f5',
                                                border: '1px solid #ebebeb',
                                                borderRadius: '6px',
                                                padding: '8px 10px',
                                                fontSize: '12px',
                                            }}>
                                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                                                    <span style={{ fontWeight: 600, color: '#1a1a1a' }}>
                                                        {c.author}
                                                        <span style={{ fontWeight: 400, color: '#999', marginLeft: '6px', fontSize: '10px' }}>
                                                            {new Date(c.ts).toLocaleString()}
                                                            {c.editedAt && ' (edited)'}
                                                        </span>
                                                    </span>
                                                    {editingId !== c.id && (
                                                        <span style={{ display: 'flex', gap: '6px' }}>
                                                            <button onClick={() => { setEditingId(c.id); setEditingText(c.text); }}
                                                                style={{ border: 'none', background: 'transparent', color: '#0369a1', cursor: 'pointer', fontSize: '11px' }}>
                                                                edit
                                                            </button>
                                                            <button onClick={() => deleteComment(c.id)}
                                                                style={{ border: 'none', background: 'transparent', color: '#dc2626', cursor: 'pointer', fontSize: '11px' }}>
                                                                delete
                                                            </button>
                                                        </span>
                                                    )}
                                                </div>
                                                {editingId === c.id ? (
                                                    <div>
                                                        <textarea value={editingText} onChange={e => setEditingText(e.target.value)}
                                                            style={{ width: '100%', minHeight: '50px', fontSize: '12px', fontFamily: 'inherit', padding: '6px', borderRadius: '4px', border: '1px solid #ccc', boxSizing: 'border-box' }} />
                                                        <div style={{ display: 'flex', gap: '6px', marginTop: '4px' }}>
                                                            <button onClick={() => saveEdit(c.id)}
                                                                style={{ fontSize: '11px', padding: '3px 10px', background: '#0369a1', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>save</button>
                                                            <button onClick={() => { setEditingId(null); setEditingText(''); }}
                                                                style={{ fontSize: '11px', padding: '3px 10px', background: '#e5e5e5', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>cancel</button>
                                                        </div>
                                                    </div>
                                                ) : (
                                                    <div style={{ color: '#333', whiteSpace: 'pre-wrap' }}>{c.text}</div>
                                                )}
                                            </div>
                                        ))}
                                        <div style={{ marginTop: '4px' }}>
                                            <textarea
                                                value={newComment}
                                                onChange={e => setNewComment(e.target.value)}
                                                placeholder="Add a comment..."
                                                style={{ width: '100%', minHeight: '50px', fontSize: '12px', fontFamily: 'inherit', padding: '8px', borderRadius: '6px', border: '1px solid #ccc', boxSizing: 'border-box', resize: 'vertical' }}
                                            />
                                            <button onClick={addComment} disabled={!newComment.trim()}
                                                style={{ marginTop: '4px', fontSize: '12px', padding: '5px 14px', background: newComment.trim() ? '#0369a1' : '#ccc', color: '#fff', border: 'none', borderRadius: '4px', cursor: newComment.trim() ? 'pointer' : 'not-allowed' }}>
                                                Add Comment
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            </>
                        ) : (
                            <div style={styles.detailLoading}>Task not found</div>
                        )}
                    </div>
                </div>
            )}

        </>
    );
}

export default function ConfirmTaskDeleteDialog({ task, error, styles, onCancel, onConfirm }) {
    if (!task) return null;

    return (
        <div style={{ ...styles.overlay, zIndex: 1100 }} onClick={onCancel}>
            <div style={styles.confirmPanel} onClick={(event) => event.stopPropagation()}>
                <div style={styles.confirmTitle}>Delete this task?</div>
                <div style={styles.confirmBody}>
                    <div style={styles.confirmTaskTitle}>{task.title}</div>
                    <div style={styles.confirmTaskId}>{task.taskId}</div>
                </div>
                <div style={styles.confirmNote}>
                    The task node and its edges are removed from the graph. This cannot be undone.
                </div>
                {error && <div style={styles.confirmError}>{error}</div>}
                <div style={styles.confirmActions}>
                    <button onClick={onCancel} style={styles.confirmCancel}>Cancel</button>
                    <button onClick={onConfirm} style={styles.confirmDelete}>Delete</button>
                </div>
            </div>
        </div>
    );
}

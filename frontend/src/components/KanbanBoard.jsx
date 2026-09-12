import { useState, useEffect, useCallback, useRef } from 'react';

import BRIDGE_URL from '../bridgeUrl';
import IdeaDumpColumn from './IdeaDumpColumn';
import ConfirmTaskDeleteDialog from './ConfirmTaskDeleteDialog';
import TaskDetailDialog from './TaskDetailDialog';
import EpicDetailDialog from './EpicDetailDialog';
import CreateWorkItemDialog from './CreateWorkItemDialog';
import KanbanStatusColumn from './KanbanStatusColumn';
import KanbanTaskCard from './KanbanTaskCard';
import KanbanDoneColumn from './KanbanDoneColumn';
import { colorForLabel } from '../nodePalette';
import useKanbanRealtime from '../hooks/useKanbanRealtime';
import useIdeas from '../hooks/useIdeas';
import useEpics from '../hooks/useEpics';
import useTaskDetails from '../hooks/useTaskDetails';
import useBulkTaskMove from '../hooks/useBulkTaskMove';
import useKanbanDragDrop from '../hooks/useKanbanDragDrop';
import { getEpicSelection, groupTasksByEpic, indexTasksByStatus } from '../kanban/boardModel';
import styles from '../kanban/styles';

// Idea Dump sits left of all task columns. It is intentionally NOT in the
// COLUMNS array because ideas are a different entity type (different endpoints,
// no drag-to-task-column, inline CRUD instead of a detail modal).
const IDEA_COLUMN = { key: 'idea_dump', label: 'Idea Dump', color: '#f59e0b' };

// Was aus einer Idee werden soll. Mehrfachauswahl, weil aus einem Zettel oft
// beides fällt — eine Aufgabe UND das Wissen, warum sie so gelöst wird.
// Die Auswahl ist eine Notiz, keine Umwandlung: die passiert weiterhin bewusst
// (promote_idea_to_task). Deshalb Chips zum Umschalten, kein "Convert"-Knopf.
const IDEA_INTENTS = [
    { key: 'task', label: 'Task', color: '#0369a1' },
    { key: 'epic', label: 'Epic', color: '#7c3aed' },
    { key: 'knowledge', label: 'Know', color: '#0d9488' },
];

const COLUMNS = [
    { key: 'backlog', label: 'Backlog', color: '#6b7394' },
    { key: 'todo', label: 'To Do', color: '#00dcff' },
    { key: 'in_progress', label: 'In Progress', color: '#ff8c42' },
    { key: 'blocked', label: 'Blocked', color: '#ff4444' },
    { key: 'needs_info', label: 'Needs Info', color: '#ffcc00' },
    { key: 'review', label: 'Review', color: '#a855f7' },
    { key: 'done', label: 'Done', color: '#39ff85' },
];

/**
 * Board layout: three full-width rows instead of one sideways-scrolling strip.
 *
 *   row 1   Idea Dump · Backlog · To Do          (intake)
 *   row 2   In Progress · Blocked · Needs Info · Review   (in flight)
 *   row 3   Done                                  (archive)
 *
 * Expressed as spans in a 12-column grid rather than as nested flex rows: 12 is
 * divisible by both 3 and 4, so every column in a row is exactly the same width
 * and every row spans the full board — which is the part that has to hold when
 * the panel is resized. A flex-per-row version drifts as soon as one column's
 * content is wider than another's.
 */
const COLUMN_SPAN = {
    idea_dump: 'span 4',
    backlog: 'span 4',
    todo: 'span 4',
    in_progress: 'span 3',
    blocked: 'span 3',
    needs_info: 'span 3',
    review: 'span 3',
    // 'done' is rendered as its own full-width strip below the grid.
};

const PRIORITY_BADGE = {
    critical: { label: 'CRIT', bg: '#ff4444' },
    high: { label: 'HIGH', bg: '#ff8c42' },
    medium: { label: 'MED', bg: '#6b7394' },
    low: { label: 'LOW', bg: '#3a3f55' },
};


export default function KanbanBoard({ onCardHover, db: dbProp, socket, onShowNode }) {
    const [tasks, setTasks] = useState([]);
    const taskUpdates = useRef(new WeakMap());
    const [creating, setCreating] = useState(null);
    // Every board write moves the card locally FIRST and tells the bridge
    // after. That is the right feel, and it was a lie whenever the bridge said
    // no: the errors were swallowed by `.catch(() => {})`, so a rejected status
    // change stayed on screen as if it had happened. Worse, `fetch` does not
    // reject on HTTP 500 at all — those never reached the catch to begin with.
    const [writeError, setWriteError] = useState(null);
    const reportWriteError = useCallback((message) => setWriteError(message), []);
    // Which graph the board reads tasks from. In the dashboard it follows the
    // DB toggle (dbProp); standalone (?view=kanban) it resolves the bridge's
    // active DB once. Tasks created via MCP land in 'target' by default, so the
    // board must NOT be hardcoded to 'meta' (that showed an empty board).
    const [db, setDb] = useState(dbProp || 'project_db');
    useEffect(() => { setCreating(null); }, [dbProp, db]);
    useEffect(() => {
        if (dbProp) { setDb(dbProp); return; }
        let cancelled = false;
        fetch(`${BRIDGE_URL}/api/status`)
            .then(r => (r.ok ? r.json() : null))
            .then(cfg => { if (!cancelled && cfg && cfg.activeDb) setDb(cfg.activeDb); })
            .catch(() => {});
        return () => { cancelled = true; };
    }, [dbProp]);
    const [collapsed, setCollapsed] = useState({ done: true });
    const {
        selectedTask,
        taskDetail, setTaskDetail,
        detailLoading,
        newComment, setNewComment,
        editingId, setEditingId,
        editingText, setEditingText,
        pendingDelete, setPendingDelete,
        deleteError, setDeleteError,
        editingTask,
        taskForm, setTaskForm,
        taskSaving,
        taskSaveError,
        openTaskDetail,
        closeDetail,
        startTaskEdit,
        cancelTaskEdit,
        saveTaskEdit,
        addComment,
        saveComment,
        deleteComment,
        deleteTask,
    } = useTaskDetails({ db, setTasks, onError: reportWriteError });

    const {
        epics,
        epicCollapsed,
        epicDetail, setEpicDetail,
        epicDetailLoading,
        epicEditing,
        epicForm, setEpicForm,
        epicSaving,
        epicSaveError,
        reloadEpics,
        openEpicDetail,
        startEpicEdit,
        saveEpicEdit,
        cancelEpicEdit,
        toggleEpicCollapsed,
    } = useEpics({ db });

    const {
        ideas, setIdeas,
        newIdeaText, setNewIdeaText,
        newIdeaIntent, setNewIdeaIntent,
        newIdeaPriority, setNewIdeaPriority,
        editingIdeaId, editingIdeaText, setEditingIdeaText,
        ideaCollapsed, setIdeaCollapsed,
        createIdea, patchIdea, toggleIdeaIntent, saveIdeaEdit, deleteIdea,
        startIdeaEdit, cancelIdeaEdit,
    } = useIdeas({ db, onError: reportWriteError });

    const {
        selectedTasks,
        bulkTargetStatus, setBulkTargetStatus,
        moveResult,
        clearSelection,
        toggleTaskSelection,
        toggleColumnSelection,
        moveSelectedTasks: handleBulkMove,
    } = useBulkTaskMove({ db, setTasks, optimisticUpdates: taskUpdates.current });

    const { connected, requestTasks } = useKanbanRealtime({
        db,
        socket,
        setTasks,
        setIdeas,
        setTaskDetail,
        onError: reportWriteError,
    });

    const {
        draggedTask,
        draggedEpicId, setDraggedEpicId,
        dragOverCol,
        handleDragStart,
        handleDragOver,
        handleDragEnd,
        handleDrop,
        dropTaskOnEpic,
        moveEpicToStatus,
    } = useKanbanDragDrop({
        db,
        tasks,
        setTasks,
        optimisticUpdates: taskUpdates.current,
        reloadEpics,
        requestTasks,
        onError: reportWriteError,
    });




    const tasksByStatus = indexTasksByStatus(tasks, COLUMNS.map((column) => column.key));

    const EPIC_ACCENT = colorForLabel('Epic');
    const epicById = new Map(epics.map(e => [e.epicId, e]));

    // Alle Tasks eines Epics über ALLE Spalten hinweg. Die Gruppen-Checkbox
    // wählt den ganzen Epic aus, nicht nur den Teil, der zufällig in dieser
    // Spalte liegt — sonst wäre "alle verschieben" ein Klick pro Spalte.
    const epicTaskIds = (epicId) => tasks.filter(t => t.epicId === epicId).map(t => t.taskId);
    const epicSelection = (epicId) => getEpicSelection(tasks, epicId, selectedTasks);

    /**
     * Teilt die Tasks EINER Spalte in freie Karten und Epic-Gruppen.
     *
     * Freie Tasks bleiben, was sie waren — ein Epic ist ein Bündel, kein Zwang.
     * Innerhalb einer Gruppe wird nach seqIndex sortiert, damit die Reihenfolge
     * auch dann stimmt, wenn nur ein Teil des Epics in dieser Spalte liegt.
     */
    const groupTasks = groupTasksByEpic;

    /**
     * Die Task-Karte — EINE Definition für beide Orte.
     *
     * Sie wird direkt in der Spalte gerendert und als children in eine EpicGroup
     * gereicht. Eine zweite Variante für den Gruppenfall wäre binnen weniger
     * Änderungen von dieser abgewichen.
     */
    const renderTaskCard = (task, column) => (
        <KanbanTaskCard
            key={task.taskId}
            task={task}
            column={column}
            styles={styles}
            priorityBadges={PRIORITY_BADGE}
            epicAccent={EPIC_ACCENT}
            dragged={draggedTask?.taskId === task.taskId}
            selected={selectedTasks.has(task.taskId)}
            isOpen={selectedTask === task.taskId}
            onOpen={openTaskDetail}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
            onToggleSelection={toggleTaskSelection}
            onHover={onCardHover}
        />
    );

    return (
        <div className="kanban-board" style={styles.container}>
            <header style={styles.header}>
                <h1 style={styles.title}>Kanban</h1>
                <div style={{
                    ...styles.connectionDot,
                    backgroundColor: connected == null ? '#f59e0b' : connected ? '#22c55e' : '#ef4444'
                }} />
                <span style={styles.connectionText}>
                    {connected == null ? 'Connecting' : connected ? 'Live' : 'Disconnected'}
                </span>
                <span style={styles.taskCount}>
                    {tasks.length} tasks · {epics.length} epics · {ideas.length} ideas
                </span>
                <button className="ui-button ui-button--primary" onClick={() => setCreating('task')}>New Task</button>
                <button className="ui-button" onClick={() => setCreating('epic')}>New Epic</button>
            </header>

            {creating && <CreateWorkItemDialog key={`${db}:${creating}`} kind={creating} db={db}
                onClose={() => setCreating(null)} onCreated={item => {
                    setCreating(null);
                    if (creating === 'epic') { reloadEpics(); openEpicDetail(item.epicId); }
                    else { requestTasks(); openTaskDetail(item); }
                }} />}

            {epics.some(epic => !tasks.some(task => task.epicId === epic.epicId)) && (
                <section aria-label="Epics without tasks" style={{ padding: '8px 12px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 12 }}>Epics without tasks:</span>
                    {epics.filter(epic => !tasks.some(task => task.epicId === epic.epicId)).map(epic => (
                        <button key={epic.epicId} style={styles.editBtn} onClick={() => openEpicDetail(epic.epicId)}
                            onDragOver={event => { if (draggedTask) event.preventDefault(); }}
                            onDrop={event => { event.preventDefault(); if (draggedTask) dropTaskOnEpic(epic.epicId, draggedTask.taskId, draggedTask.status); }}>
                            {epic.title}
                        </button>
                    ))}
                    <span style={{ fontSize: 12 }}>Drag a task onto an epic to add it.</span>
                </section>
            )}

            {/* Bulk action bar — visible only when tasks are selected.
                Sits between header and board so it never overlaps cards.
                Shows "N of M moved" on partial failure so nothing disappears silently. */}
            {selectedTasks.size > 0 && (
                <div style={styles.bulkBar}>
                    <span style={styles.bulkCount}>
                        {selectedTasks.size} task{selectedTasks.size !== 1 ? 's' : ''} selected
                    </span>
                    <select
                        value={bulkTargetStatus}
                        onChange={e => setBulkTargetStatus(e.target.value)}
                        style={styles.bulkSelect}
                    >
                        <option value="">Move to...</option>
                        {COLUMNS.map(col => (
                            <option key={col.key} value={col.key}>{col.label}</option>
                        ))}
                    </select>
                    <button
                        onClick={handleBulkMove}
                        disabled={!bulkTargetStatus}
                        style={{
                            ...styles.bulkMoveBtn,
                            opacity: bulkTargetStatus ? 1 : 0.45,
                            cursor: bulkTargetStatus ? 'pointer' : 'not-allowed',
                        }}
                    >
                        Move
                    </button>
                    <button
                        onClick={clearSelection}
                        style={styles.bulkClearBtn}
                    >
                        Deselect all
                    </button>
                    {moveResult && (
                        <span style={{
                            fontSize: '12px',
                            color: moveResult.failedIds.length > 0 ? '#dc2626' : '#16a34a',
                            fontWeight: 600,
                        }}>
                            {moveResult.moved} of {moveResult.total} moved
                            {moveResult.failedIds.length > 0 &&
                                ' · failed: ' + moveResult.failedIds.join(', ')}
                        </span>
                    )}
                </div>
            )}

            {/* A rejected write used to leave the card sitting in its new
                column as though it had worked. Now it says so, and stays until
                dismissed — a drag that silently did nothing is worse than an
                error message. */}
            {writeError && (
                <div
                    onClick={() => setWriteError(null)}
                    title="Click to dismiss"
                    style={{
                        margin: '4px 8px', padding: '6px 10px', fontSize: 12,
                        color: '#fff', background: '#dc2626', borderRadius: 6,
                        cursor: 'pointer', fontWeight: 600,
                    }}
                >
                    {writeError}
                </div>
            )}

            {/* Empty-state hint — one slim line ABOVE the board, not a block
                inside it. The old version was a centred placeholder that sat in
                the grid while the columns rendered underneath it anyway, so an
                empty board said "No tasks" twice: once as a big graphic and once
                as a "0" on every column. The columns already carry the count;
                the only thing they cannot say is WHICH graph is empty or that
                the bridge is gone. That is all this line says now. */}
            {tasks.length === 0 && (
                <div style={styles.emptyHint}>
                    {connected
                        ? `No tasks in the “${db}” graph — tasks created in the other graph are not shown here.`
                        : connected === false
                        ? `No connection to the bridge (${BRIDGE_URL}).`
                        : 'Connecting to the bridge…'}
                </div>
            )}

            <div style={styles.board}>
                <IdeaDumpColumn
                    column={IDEA_COLUMN}
                    columnSpan={COLUMN_SPAN[IDEA_COLUMN.key]}
                    ideas={ideas}
                    intents={IDEA_INTENTS}
                    priorityBadges={PRIORITY_BADGE}
                    styles={styles}
                    collapsed={ideaCollapsed}
                    onToggleCollapsed={() => setIdeaCollapsed((value) => !value)}
                    editingId={editingIdeaId}
                    editingText={editingIdeaText}
                    onEditingTextChange={setEditingIdeaText}
                    onStartEdit={startIdeaEdit}
                    onCancelEdit={cancelIdeaEdit}
                    onSaveEdit={saveIdeaEdit}
                    onDelete={deleteIdea}
                    onToggleIntent={toggleIdeaIntent}
                    onPatch={patchIdea}
                    newText={newIdeaText}
                    onNewTextChange={setNewIdeaText}
                    newIntent={newIdeaIntent}
                    onNewIntentChange={setNewIdeaIntent}
                    newPriority={newIdeaPriority}
                    onNewPriorityChange={setNewIdeaPriority}
                    onCreate={createIdea}
                />

                {COLUMNS.filter((column) => column.key !== 'done').map((column) => (
                    <KanbanStatusColumn
                        key={column.key}
                        column={column}
                        columnSpan={COLUMN_SPAN[column.key]}
                        tasks={tasksByStatus[column.key]}
                        grouped={groupTasks(tasksByStatus[column.key])}
                        styles={styles}
                        collapsed={collapsed[column.key] ?? tasksByStatus[column.key].length === 0}
                        dragOver={dragOverCol === column.key}
                        selectedTaskIds={selectedTasks}
                        onToggleCollapsed={() => setCollapsed((current) => ({
                            ...current,
                            [column.key]: !(current[column.key] ?? tasksByStatus[column.key].length === 0),
                        }))}
                        onToggleSelection={toggleColumnSelection}
                        onDragOver={handleDragOver}
                        onDrop={handleDrop}
                        renderTaskCard={renderTaskCard}
                        epicById={epicById}
                        epicAccent={EPIC_ACCENT}
                        epicCollapsed={epicCollapsed}
                        onToggleEpic={toggleEpicCollapsed}
                        onDropTaskOnEpic={dropTaskOnEpic}
                        onMoveEpic={moveEpicToStatus}
                        onOpenEpic={openEpicDetail}
                        epicTaskIds={epicTaskIds}
                        epicSelection={epicSelection}
                        draggedTask={draggedTask}
                        draggedEpicId={draggedEpicId}
                        onEpicDragStart={setDraggedEpicId}
                        onEpicDragEnd={() => setDraggedEpicId(null)}
                    />
                ))}

                <KanbanDoneColumn
                    column={COLUMNS.find((column) => column.key === 'done')}
                    tasks={tasksByStatus.done}
                    styles={styles}
                    collapsed={!!collapsed.done}
                    dragOver={dragOverCol === 'done'}
                    selectedTaskIds={selectedTasks}
                    selectedTask={selectedTask}
                    draggedTask={draggedTask}
                    onToggleCollapsed={() => setCollapsed((current) => ({ ...current, done: !current.done }))}
                    onToggleSelection={toggleColumnSelection}
                    onDragOver={handleDragOver}
                    onDrop={handleDrop}
                    onDragStart={handleDragStart}
                    onOpenTask={openTaskDetail}
                    onRequestDelete={(task) => {
                        setDeleteError(null);
                        setPendingDelete(task);
                    }}
                />
            </div>

            <ConfirmTaskDeleteDialog
                task={pendingDelete}
                error={deleteError}
                styles={styles}
                onCancel={() => setPendingDelete(null)}
                onConfirm={deleteTask}
            />

            <EpicDetailDialog
                db={db}
                epicDetail={epicDetail}
                setEpicDetail={setEpicDetail}
                styles={styles}
                epicDetailLoading={epicDetailLoading}
                EPIC_ACCENT={EPIC_ACCENT}
                epicEditing={epicEditing}
                startEpicEdit={startEpicEdit}
                COLUMNS={COLUMNS}
                PRIORITY_BADGE={PRIORITY_BADGE}
                epicForm={epicForm}
                setEpicForm={setEpicForm}
                epicSaveError={epicSaveError}
                saveEpicEdit={saveEpicEdit}
                epicSaving={epicSaving}
                cancelEpicEdit={cancelEpicEdit}
                openTaskDetail={openTaskDetail}
            />

            <TaskDetailDialog
                db={db}
                onShowNode={onShowNode}
                selectedTask={selectedTask}
                editingTask={editingTask}
                closeDetail={closeDetail}
                styles={styles}
                detailLoading={detailLoading}
                taskDetail={taskDetail}
                taskForm={taskForm}
                setTaskForm={setTaskForm}
                taskSaveError={taskSaveError}
                saveTaskEdit={saveTaskEdit}
                taskSaving={taskSaving}
                cancelTaskEdit={cancelTaskEdit}
                PRIORITY_BADGE={PRIORITY_BADGE}
                startTaskEdit={startTaskEdit}
                setDeleteError={setDeleteError}
                setPendingDelete={setPendingDelete}
                editingId={editingId}
                setEditingId={setEditingId}
                editingText={editingText}
                setEditingText={setEditingText}
                deleteComment={deleteComment}
                saveEdit={saveComment}
                newComment={newComment}
                setNewComment={setNewComment}
                addComment={addComment}
            />
        </div>
    );
}

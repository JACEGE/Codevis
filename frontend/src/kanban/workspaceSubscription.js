import { matchesWorkspace, removeById, upsertById, workspaceRequestId } from './realtimeModel.js';

// Own the lifetime of every response, including polls and A -> B -> A switches.
export function subscribeKanbanWorkspace({ db, socket, setConnected, setTasks, setIdeas, setTaskDetail, onError, fetchTasks }) {
  let live = true;
  let taskRequest;
  let ideaRequest;
  let taskRevision = 0;
  let ideaRevision = 0;
  let pollRequest = 0;
  let taskSnapshotRevision = 0;
  let ideaSnapshotRevision = 0;
  const requestTasks = () => {
    if (!live) return;
    taskRequest = workspaceRequestId();
    taskSnapshotRevision = taskRevision;
    socket.emit('tasks:request', { db, requestId: taskRequest });
  };
  const requestIdeas = () => {
    if (!live) return;
    ideaRequest = workspaceRequestId();
    ideaSnapshotRevision = ideaRevision;
    socket.emit('ideas:request', { db, requestId: ideaRequest });
  };
  const requestInitialData = () => {
    setConnected(true);
    requestTasks();
    requestIdeas();
  };
  const scoped = handler => payload => { if (live && matchesWorkspace(payload, db)) handler(payload); };
  const taskChange = handler => scoped(payload => { taskRevision++; handler(payload); });
  const ideaChange = handler => scoped(payload => { ideaRevision++; handler(payload); });
  const listeners = {
    connect: requestInitialData,
    disconnect: () => setConnected(false),
    connect_error: () => setConnected(false),
    'tasks:init': (items, meta) => {
      if (live && matchesWorkspace(meta, db) && meta.requestId === taskRequest) {
        if (taskSnapshotRevision !== taskRevision) { requestTasks(); return; }
        taskRevision++;
        setTasks(items);
      }
    },
    'ideas:init': (items, meta) => {
      if (live && matchesWorkspace(meta, db) && meta.requestId === ideaRequest) {
        if (ideaSnapshotRevision !== ideaRevision) { requestIdeas(); return; }
        ideaRevision++;
        setIdeas(items);
      }
    },
    'task:status-changed': taskChange(task => setTasks(items => upsertById(items, task, 'taskId'))),
    'task:created': taskChange(task => setTasks(items => upsertById(items, task, 'taskId'))),
    'task:deleted': taskChange(({ taskId }) => setTasks(items => removeById(items, taskId, 'taskId'))),
    'task:comments-changed': scoped(({ taskId, comments }) => {
      setTaskDetail(current => current?.taskId === taskId ? { ...current, comments } : current);
    }),
    'idea:created': ideaChange(idea => setIdeas(items => upsertById(items, idea, 'ideaId'))),
    'idea:updated': ideaChange(idea => setIdeas(items => upsertById(items, idea, 'ideaId'))),
    'idea:deleted': ideaChange(({ ideaId }) => setIdeas(items => removeById(items, ideaId, 'ideaId'))),
    'locks:changed': scoped(requestTasks),
  };
  for (const [event, handler] of Object.entries(listeners)) socket.on(event, handler);
  if (socket.connected) requestInitialData();
  const poll = async () => {
    const request = ++pollRequest;
    const revision = taskRevision;
    try {
      const tasks = await fetchTasks();
      if (live && request === pollRequest && revision === taskRevision) {
        taskRevision++;
        setTasks(tasks);
      }
    } catch (error) {
      if (live && request === pollRequest && revision === taskRevision) onError?.(`Task refresh failed: ${error.message}`);
    }
  };
  const timer = setInterval(poll, 10000);
  return {
    requestTasks, poll,
    dispose() {
      live = false;
      clearInterval(timer);
      for (const [event, handler] of Object.entries(listeners)) socket.off(event, handler);
    },
  };
}

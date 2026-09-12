import { useCallback, useEffect, useRef, useState } from 'react';

import BRIDGE_URL from '../bridgeUrl';
import { requestJson } from '../api/http';
import { subscribeKanbanWorkspace } from '../kanban/workspaceSubscription';

export default function useKanbanRealtime({ db, socket, setTasks, setIdeas, setTaskDetail, onError }) {
  const [connected, setConnected] = useState(null);
  const subscription = useRef(null);
  const requestTasks = useCallback(() => subscription.current?.requestTasks(), []);

  useEffect(() => {
    setTasks([]);
    setIdeas([]);
    setTaskDetail(null);
    if (!socket) { setConnected(false); return undefined; }
    const current = subscribeKanbanWorkspace({
      db, socket, setConnected, setTasks, setIdeas, setTaskDetail, onError,
      fetchTasks: () => requestJson(`${BRIDGE_URL}/api/tasks?db=${encodeURIComponent(db)}`),
    });
    subscription.current = current;
    return () => { current.dispose(); subscription.current = null; };
  }, [db, onError, setIdeas, setTaskDetail, setTasks, socket]);

  return { connected, requestTasks };
}

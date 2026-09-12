import { useCallback, useRef } from 'react';
import { requestJson } from '../api/http';
import { applyOptimisticUpdate, reconcileOptimisticUpdate } from '../kanban/optimisticUpdates';
import useRequestLifetime from './useRequestLifetime';

export default function useOptimisticTaskUpdate({ db, setTasks, optimisticUpdates }) {
    const localUpdates = useRef(new WeakMap());
    const updates = optimisticUpdates ?? localUpdates.current;
    const lifetime = useRequestLifetime(db);

    return useCallback(async (taskId, patch, url, options) => {
        const workspace = lifetime.current;
        const operation = { state: 'pending' };
        setTasks(current => current.map(task => task.taskId === taskId
            ? applyOptimisticUpdate(updates, task, patch, operation) : task));
        try {
            const result = await requestJson(url, options);
            operation.state = 'succeeded';
            return result;
        } catch (error) {
            operation.state = 'failed';
            throw error;
        } finally {
            if (workspace === lifetime.current) {
                setTasks(current => current.map(task => reconcileOptimisticUpdate(updates, task)));
            }
        }
    }, [db, setTasks, updates]);
}

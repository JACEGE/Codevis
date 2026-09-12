import { useCallback, useEffect, useRef, useState } from 'react';

import BRIDGE_URL from '../bridgeUrl';
import useRequestLifetime from './useRequestLifetime';
import useOptimisticTaskUpdate from './useOptimisticTaskUpdate';

export default function useBulkTaskMove({ db, setTasks, optimisticUpdates }) {
    const lifetime = useRequestLifetime(db);
    const updateTask = useOptimisticTaskUpdate({ db, setTasks, optimisticUpdates });
    const selectionRevision = useRef(0);
    const moveRequest = useRef(0);
    const [selectedTasks, setSelectedTasks] = useState(new Set());
    const [bulkTargetStatus, setBulkTargetStatus] = useState('');
    const [moveResult, setMoveResult] = useState(null);

    useEffect(() => {
        setSelectedTasks(new Set());
        setMoveResult(null);
        setBulkTargetStatus('');
    }, [db]);

    const clearSelection = useCallback(() => {
        selectionRevision.current++;
        setSelectedTasks(new Set());
        setMoveResult(null);
    }, []);

    const toggleTaskSelection = useCallback((taskId, event) => {
        selectionRevision.current++;
        event.stopPropagation();
        setSelectedTasks((current) => {
            const next = new Set(current);
            if (next.has(taskId)) next.delete(taskId);
            else next.add(taskId);
            return next;
        });
    }, []);

    const toggleColumnSelection = useCallback((taskIds) => {
        selectionRevision.current++;
        setSelectedTasks((current) => {
            const next = new Set(current);
            const allSelected = taskIds.length > 0 && taskIds.every((id) => next.has(id));
            if (allSelected) taskIds.forEach((id) => next.delete(id));
            else taskIds.forEach((id) => next.add(id));
            return next;
        });
    }, []);

    const moveSelectedTasks = useCallback(async () => {
        if (!bulkTargetStatus || selectedTasks.size === 0) return;
        const workspace = lifetime.current;
        const selection = selectionRevision.current;
        const request = ++moveRequest.current;
        const taskIds = [...selectedTasks];
        const results = await Promise.allSettled(taskIds.map((taskId) => updateTask(
            taskId, { status: bulkTargetStatus },
            `${BRIDGE_URL}/api/tasks/${taskId}/status?db=${encodeURIComponent(db)}`,
            {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status: bulkTargetStatus, updatedBy: 'user' }),
            },
        )));
        if (workspace !== lifetime.current || request !== moveRequest.current) return;
        const failedIds = taskIds.filter((_, index) => results[index].status === 'rejected');

        if (failedIds.length > 0) {
            const failed = new Set(failedIds);
            if (selection === selectionRevision.current) {
                setMoveResult({ moved: taskIds.length - failedIds.length, total: taskIds.length, failedIds });
                setSelectedTasks(failed);
            }
        } else {
            if (selection === selectionRevision.current) clearSelection();
        }
    }, [bulkTargetStatus, clearSelection, db, selectedTasks, updateTask]);

    return {
        selectedTasks,
        bulkTargetStatus, setBulkTargetStatus,
        moveResult, setMoveResult,
        clearSelection,
        toggleTaskSelection,
        toggleColumnSelection,
        moveSelectedTasks,
    };
}

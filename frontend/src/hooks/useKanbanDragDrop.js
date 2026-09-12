import { useCallback, useEffect, useState } from 'react';

import BRIDGE_URL from '../bridgeUrl';
import useRequestLifetime from './useRequestLifetime';
import useOptimisticTaskUpdate from './useOptimisticTaskUpdate';

export default function useKanbanDragDrop({ db, tasks, setTasks, optimisticUpdates, reloadEpics, requestTasks, onError }) {
    const lifetime = useRequestLifetime(db);
    const updateTask = useOptimisticTaskUpdate({ db, setTasks, optimisticUpdates });
    const [draggedTask, setDraggedTask] = useState(null);
    const [draggedEpicId, setDraggedEpicId] = useState(null);
    const [dragOverCol, setDragOverCol] = useState(null);

    const write = useCallback(async (taskId, patch, url, options, label) => {
        const workspace = lifetime.current;
        try {
            await updateTask(taskId, patch, url, options);
            return true;
        } catch (error) {
            if (workspace === lifetime.current) onError(`${label} failed: ${error.message}`);
            return false;
        }
    }, [onError, updateTask]);

    const handleDragStart = useCallback((event, task) => {
        setDraggedTask(task);
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', task.taskId);
    }, []);

    const handleDragOver = useCallback((event, columnKey) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        if (columnKey !== undefined) setDragOverCol((current) => current === columnKey ? current : columnKey);
    }, []);

    const handleDragEnd = useCallback(() => {
        setDraggedTask(null);
        setDraggedEpicId(null);
        setDragOverCol(null);
    }, []);

    useEffect(() => { handleDragEnd(); }, [db, handleDragEnd]);

    const moveEpicToStatus = useCallback(async (epicId, status) => {
        const workspace = lifetime.current;
        const members = tasks.filter((task) => task.epicId === epicId && task.status !== status);
        await Promise.all(members.map((task) => write(
            task.taskId, { status },
            `${BRIDGE_URL}/api/tasks/${task.taskId}/status?db=${encodeURIComponent(db)}`,
            {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status, updatedBy: 'user' }),
            },
            `Status update for "${task.title || task.taskId}"`,
        )));
        if (workspace === lifetime.current) requestTasks();
    }, [db, requestTasks, tasks, write]);

    const handleDrop = useCallback(async (event, status) => {
        event.preventDefault();
        const workspace = lifetime.current;
        // Consume this drag now; its eventual response must not end a new drag.
        handleDragEnd();
        if (draggedEpicId) {
            await moveEpicToStatus(draggedEpicId, status);
            return;
        }

        if (draggedTask?.epicId) {
            const task = draggedTask;
            const removed = await write(
                task.taskId, { epicId: null, epicTitle: null, seqIndex: null },
                `${BRIDGE_URL}/api/epics/${task.epicId}/tasks/${task.taskId}?db=${encodeURIComponent(db)}`,
                { method: 'DELETE' },
                `Remove "${task.title || task.taskId}" from epic`,
            );
            if (workspace !== lifetime.current || !removed) return;
            requestTasks();
            await reloadEpics();
            if (workspace !== lifetime.current) return;
        }

        if (!draggedTask || draggedTask.status === status) {
            return;
        }

        const task = draggedTask;
        await write(
            task.taskId, { status },
            `${BRIDGE_URL}/api/tasks/${task.taskId}/status?db=${encodeURIComponent(db)}`,
            {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status, updatedBy: 'user' }),
            },
            `Status update for "${task.title || task.taskId}"`,
        );
    }, [db, draggedEpicId, draggedTask, handleDragEnd, moveEpicToStatus,
        reloadEpics, requestTasks, write]);

    const dropTaskOnEpic = useCallback(async (epicId, taskId, status) => {
        const workspace = lifetime.current;
        handleDragEnd();
        const task = tasks.find((item) => item.taskId === taskId);
        try {
            await updateTask(
                taskId, { epicId, epicTitle: null, seqIndex: null },
                `${BRIDGE_URL}/api/epics/${epicId}/tasks/${taskId}?db=${encodeURIComponent(db)}`,
                { method: 'PUT' },
            );
            if (workspace !== lifetime.current) return;
            if (task && task.status !== status) {
                await updateTask(
                    taskId, { status },
                    `${BRIDGE_URL}/api/tasks/${taskId}/status?db=${encodeURIComponent(db)}`,
                    {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ status, updatedBy: 'user' }),
                    },
                );
            }
        } catch (error) {
            if (workspace === lifetime.current) onError(`Could not add task to epic: ${error.message}`);
        } finally {
            if (workspace === lifetime.current) {
                requestTasks();
                await reloadEpics();
            }
        }
    }, [db, handleDragEnd, onError, reloadEpics, requestTasks, updateTask, tasks]);

    return {
        draggedTask,
        draggedEpicId, setDraggedEpicId,
        dragOverCol,
        handleDragStart,
        handleDragOver,
        handleDragEnd,
        handleDrop,
        dropTaskOnEpic,
        moveEpicToStatus,
    };
}

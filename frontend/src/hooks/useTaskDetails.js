import { useCallback, useEffect, useRef, useState } from 'react';

import BRIDGE_URL from '../bridgeUrl';
import { requestJson } from '../api/http';

export default function useTaskDetails({ db, setTasks, onError }) {
    const detailRequest = useRef(0);
    const workspaceRequest = useRef(0);
    const [selectedTask, setSelectedTask] = useState(null);
    const [taskDetail, setTaskDetail] = useState(null);
    const [detailLoading, setDetailLoading] = useState(false);
    const [newComment, setNewComment] = useState('');
    const [editingId, updateEditingId] = useState(null);
    const [editingText, updateEditingText] = useState('');
    const commentDraftRevision = useRef(0);
    const setEditingId = useCallback((value) => {
        commentDraftRevision.current++;
        updateEditingId(value);
    }, []);
    const setEditingText = useCallback((value) => {
        commentDraftRevision.current++;
        updateEditingText(value);
    }, []);
    const [pendingDelete, updatePendingDelete] = useState(null);
    const deleteRevision = useRef(0);
    const setPendingDelete = useCallback(value => {
        deleteRevision.current++;
        updatePendingDelete(value);
    }, []);
    const [deleteError, setDeleteError] = useState(null);
    const [editingTask, setEditingTask] = useState(false);
    const [taskForm, updateTaskForm] = useState(null);
    const formRevision = useRef(0);
    const setTaskForm = useCallback((value) => {
        formRevision.current++;
        updateTaskForm(value);
    }, []);
    const [taskSaving, setTaskSaving] = useState(false);
    const [taskSaveError, setTaskSaveError] = useState(null);

    const closeDetail = useCallback(() => {
        detailRequest.current++;
        setDetailLoading(false);
        setSelectedTask(null);
        setTaskDetail(null);
        setNewComment('');
        setEditingId(null);
        setEditingText('');
        setEditingTask(false);
        setTaskForm(null);
        setTaskSaveError(null);
        setTaskSaving(false);
    }, []);

    useEffect(() => {
        workspaceRequest.current++;
        closeDetail();
        setPendingDelete(null);
        setDeleteError(null);
        return () => { detailRequest.current++; workspaceRequest.current++; };
    }, [db, closeDetail]);

    const openTaskDetail = useCallback(async (task) => {
        closeDetail();
        const request = ++detailRequest.current;
        setTaskDetail(null);
        setSelectedTask(task.taskId);
        setDetailLoading(true);
        try {
            const detail = await requestJson(
                `${BRIDGE_URL}/api/tasks/${task.taskId}?db=${encodeURIComponent(db)}`,
            );
            if (request === detailRequest.current) setTaskDetail(detail);
        } catch (error) {
            if (request === detailRequest.current) onError(`Task details could not be loaded: ${error.message}`);
        } finally {
            if (request === detailRequest.current) setDetailLoading(false);
        }
    }, [db, onError, closeDetail]);

    const startTaskEdit = useCallback(() => {
        if (!taskDetail) return;
        setTaskForm({
            title: taskDetail.title || '',
            description: taskDetail.description || '',
            workInstructions: taskDetail.workInstructions || '',
            priority: taskDetail.priority || 'medium',
        });
        setTaskSaveError(null);
        setEditingTask(true);
    }, [taskDetail]);

    const cancelTaskEdit = useCallback(() => {
        setEditingTask(false);
        setTaskForm(null);
        setTaskSaveError(null);
    }, []);

    const saveTaskEdit = useCallback(async () => {
        if (!taskDetail || !taskForm) return;
        if (!taskForm.title.trim()) {
            setTaskSaveError('A task needs a title.');
            return;
        }
        const request = detailRequest.current;
        const workspace = workspaceRequest.current;
        const revision = formRevision.current;
        setTaskSaving(true);
        setTaskSaveError(null);
        try {
            const saved = await requestJson(
                `${BRIDGE_URL}/api/tasks/${taskDetail.taskId}?db=${encodeURIComponent(db)}`,
                {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        title: taskForm.title.trim(),
                        description: taskForm.description,
                        workInstructions: taskForm.workInstructions,
                        priority: taskForm.priority,
                        updatedBy: 'user',
                    }),
                },
            );
            if (workspace !== workspaceRequest.current) return;
            setTasks((current) => current.map((task) => (
                task.taskId === saved.taskId ? { ...task, ...saved } : task
            )));
            if (request !== detailRequest.current) return;
            setTaskDetail((current) => current?.taskId === saved.taskId ? { ...current, ...saved } : current);
            if (revision === formRevision.current) {
                setEditingTask(false);
                setTaskForm(null);
            }
        } catch (error) {
            if (request === detailRequest.current) setTaskSaveError(error.message);
        } finally {
            if (request === detailRequest.current) setTaskSaving(false);
        }
    }, [db, setTasks, taskDetail, taskForm]);

    const addComment = useCallback(async () => {
        if (!newComment.trim() || !taskDetail) return;
        const request = detailRequest.current;
        try {
            await requestJson(commentUrl(db, taskDetail.taskId), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: newComment, author: 'user' }),
            });
            if (request === detailRequest.current) setNewComment(current => current === newComment ? '' : current);
        } catch (error) {
            if (request === detailRequest.current) onError(`Comment could not be added: ${error.message}`);
        }
    }, [db, newComment, onError, taskDetail]);

    const saveComment = useCallback(async (commentId) => {
        if (!editingText.trim() || !taskDetail) return;
        const request = detailRequest.current;
        const draft = commentDraftRevision.current;
        try {
            await requestJson(commentUrl(db, taskDetail.taskId, commentId), {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: editingText }),
            });
            if (request !== detailRequest.current || draft !== commentDraftRevision.current) return;
            setEditingId(null);
            setEditingText('');
        } catch (error) {
            if (request === detailRequest.current && draft === commentDraftRevision.current) onError(`Comment could not be saved: ${error.message}`);
        }
    }, [db, editingText, onError, taskDetail]);

    const deleteComment = useCallback(async (commentId) => {
        if (!taskDetail) return;
        const request = detailRequest.current;
        try {
            await requestJson(commentUrl(db, taskDetail.taskId, commentId), { method: 'DELETE' });
        } catch (error) {
            if (request === detailRequest.current) onError(`Comment could not be deleted: ${error.message}`);
        }
    }, [db, onError, taskDetail]);

    const deleteTask = useCallback(async () => {
        if (!pendingDelete) return;
        const taskId = pendingDelete.taskId;
        const confirmation = deleteRevision.current;
        const workspace = workspaceRequest.current;
        const request = detailRequest.current;
        try {
            await requestJson(
                `${BRIDGE_URL}/api/tasks/${taskId}?db=${encodeURIComponent(db)}`,
                { method: 'DELETE' },
            );
            if (workspace !== workspaceRequest.current) return;
            setTasks((current) => current.filter((task) => task.taskId !== taskId));
            if (confirmation === deleteRevision.current) {
                setPendingDelete(null);
                setDeleteError(null);
            }
            if (request === detailRequest.current && selectedTask === taskId) closeDetail();
        } catch (error) {
            if (workspace === workspaceRequest.current && confirmation === deleteRevision.current) setDeleteError(error.message);
        }
    }, [closeDetail, db, pendingDelete, selectedTask, setTasks]);

    return {
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
    };
}

function commentUrl(db, taskId, commentId) {
    const suffix = commentId == null ? '' : `/${commentId}`;
    return `${BRIDGE_URL}/api/tasks/${taskId}/comments${suffix}?db=${encodeURIComponent(db)}`;
}

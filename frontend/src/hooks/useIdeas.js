import { useCallback, useEffect, useRef, useState } from 'react';

import BRIDGE_URL from '../bridgeUrl';
import { requestJson } from '../api/http';
import useRequestLifetime from './useRequestLifetime';
import { applyOptimisticUpdate, reconcileOptimisticUpdate } from '../kanban/optimisticUpdates';

export default function useIdeas({ db, onError }) {
    const lifetime = useRequestLifetime(db);
    const editRevision = useRef(0);
    const optimisticUpdates = useRef(new WeakMap());
    const [ideas, setIdeas] = useState([]);
    const [newIdeaText, setNewIdeaText] = useState('');
    const [newIdeaIntent, setNewIdeaIntent] = useState([]);
    const [newIdeaPriority, setNewIdeaPriority] = useState('');
    const [editingIdeaId, setEditingIdeaId] = useState(null);
    const [editingIdeaText, updateEditingIdeaText] = useState('');
    const setEditingIdeaText = useCallback((value) => {
        editRevision.current++;
        updateEditingIdeaText(value);
    }, []);
    const [ideaCollapsed, setIdeaCollapsed] = useState(false);

    const createIdea = useCallback(async () => {
        const content = newIdeaText.trim();
        if (!content) return;
        const workspace = lifetime.current;
        try {
            await requestJson(`${BRIDGE_URL}/api/ideas?db=${encodeURIComponent(db)}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    content,
                    createdBy: 'user',
                    intent: newIdeaIntent,
                    priority: newIdeaPriority,
                }),
            });
            if (workspace === lifetime.current) setNewIdeaText(current => current === newIdeaText ? '' : current);
        } catch (error) {
            if (workspace === lifetime.current) onError(`Idea could not be created: ${error.message}`);
        }
    }, [db, newIdeaIntent, newIdeaPriority, newIdeaText, onError]);

    const patchIdea = useCallback(async (ideaId, patch) => {
        const workspace = lifetime.current;
        const operation = { state: 'pending' };
        setIdeas((current) => current.map((idea) => (
            idea.ideaId === ideaId ? applyOptimisticUpdate(optimisticUpdates.current, idea, patch, operation) : idea
        )));
        try {
            await requestJson(`${BRIDGE_URL}/api/ideas/${ideaId}?db=${encodeURIComponent(db)}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(patch),
            });
            operation.state = 'succeeded';
        } catch (error) {
            operation.state = 'failed';
            if (workspace !== lifetime.current) return;
            onError(`Idea could not be updated: ${error.message}`);
        } finally {
            if (workspace === lifetime.current) {
                setIdeas(current => current.map(idea => reconcileOptimisticUpdate(optimisticUpdates.current, idea)));
            }
        }
    }, [db, onError]);

    const toggleIdeaIntent = useCallback((idea, key) => {
        const current = Array.isArray(idea.intent) ? idea.intent : [];
        const intent = current.includes(key)
            ? current.filter((item) => item !== key)
            : [...current, key];
        patchIdea(idea.ideaId, { intent });
    }, [patchIdea]);

    const cancelIdeaEdit = useCallback(() => {
        setEditingIdeaId(null);
        setEditingIdeaText('');
    }, []);

    useEffect(() => {
        setIdeas([]);
        cancelIdeaEdit();
    }, [db, cancelIdeaEdit]);

    const saveIdeaEdit = useCallback(async (ideaId) => {
        const content = editingIdeaText.trim();
        if (!content) return;
        const workspace = lifetime.current;
        const revision = editRevision.current;
        try {
            await requestJson(`${BRIDGE_URL}/api/ideas/${ideaId}?db=${encodeURIComponent(db)}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content }),
            });
            if (workspace === lifetime.current && revision === editRevision.current) cancelIdeaEdit();
        } catch (error) {
            if (workspace === lifetime.current && revision === editRevision.current) onError(`Idea could not be saved: ${error.message}`);
        }
    }, [cancelIdeaEdit, db, editingIdeaText, onError]);

    const deleteIdea = useCallback(async (ideaId) => {
        const workspace = lifetime.current;
        try {
            await requestJson(`${BRIDGE_URL}/api/ideas/${ideaId}?db=${encodeURIComponent(db)}`, {
                method: 'DELETE',
            });
        } catch (error) {
            if (workspace === lifetime.current) onError(`Idea could not be deleted: ${error.message}`);
        }
    }, [db, onError]);

    const startIdeaEdit = useCallback((idea) => {
        setEditingIdeaId(idea.ideaId);
        setEditingIdeaText(idea.content);
    }, []);

    return {
        ideas, setIdeas,
        newIdeaText, setNewIdeaText,
        newIdeaIntent, setNewIdeaIntent,
        newIdeaPriority, setNewIdeaPriority,
        editingIdeaId, editingIdeaText, setEditingIdeaText,
        ideaCollapsed, setIdeaCollapsed,
        createIdea, patchIdea, toggleIdeaIntent, saveIdeaEdit, deleteIdea,
        startIdeaEdit, cancelIdeaEdit,
    };
}

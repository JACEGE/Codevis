import { useCallback, useEffect, useRef, useState } from 'react';

import BRIDGE_URL from '../bridgeUrl';
import { requestJson } from '../api/http';
import useRequestLifetime from './useRequestLifetime';

const EPIC_COLLAPSE_KEY = 'codevis.kanban.epicCollapsed';

export default function useEpics({ db }) {
    const lifetime = useRequestLifetime(db);
    const listRequest = useRef(0);
    const detailRequest = useRef(0);
    const formRevision = useRef(0);
    const [epics, setEpics] = useState([]);
    const [epicCollapsed, setEpicCollapsed] = useState(loadEpicCollapsed);
    const [epicDetail, updateEpicDetail] = useState(null);
    const [epicDetailLoading, setEpicDetailLoading] = useState(false);
    const [epicEditing, setEpicEditing] = useState(false);
    const [epicForm, updateEpicForm] = useState(null);
    const setEpicForm = useCallback((value) => {
        formRevision.current++;
        updateEpicForm(value);
    }, []);
    const [epicSaving, setEpicSaving] = useState(false);
    const [epicSaveError, setEpicSaveError] = useState(null);
    const setEpicDetail = useCallback((value) => {
        detailRequest.current++;
        updateEpicDetail(value);
        setEpicDetailLoading(false);
        setEpicEditing(false);
        setEpicForm(null);
        setEpicSaving(false);
        setEpicSaveError(null);
    }, [setEpicForm]);

    const reloadEpics = useCallback(async () => {
        if (lifetime.current.key !== db) return;
        const workspace = lifetime.current;
        const request = ++listRequest.current;
        try {
            const data = await requestJson(`${BRIDGE_URL}/api/epics?db=${encodeURIComponent(db)}`);
            if (workspace === lifetime.current && request === listRequest.current) setEpics(Array.isArray(data) ? data : []);
        } catch {
            // Keep a known list through a transient refresh failure.
        }
    }, [db]);

    useEffect(() => {
        setEpics([]);
        setEpicDetail(null);
        reloadEpics();
    }, [reloadEpics, setEpicDetail]);

    const openEpicDetail = useCallback(async (epicId) => {
        setEpicDetail({ epicId, loading: true });
        const workspace = lifetime.current;
        const request = detailRequest.current;
        setEpicDetailLoading(true);
        try {
            const detail = await requestJson(
                `${BRIDGE_URL}/api/epics/${epicId}?db=${encodeURIComponent(db)}`,
            );
            if (workspace === lifetime.current && request === detailRequest.current) updateEpicDetail(detail);
        } catch (error) {
            if (workspace === lifetime.current && request === detailRequest.current) updateEpicDetail({ epicId, error: error.message });
        } finally {
            if (workspace === lifetime.current && request === detailRequest.current) setEpicDetailLoading(false);
        }
    }, [db]);

    const startEpicEdit = useCallback(() => {
        setEpicSaveError(null);
        setEpicForm({
            title: epicDetail?.title || '',
            description: epicDetail?.description || '',
            workInstructions: epicDetail?.workInstructions || '',
            priority: epicDetail?.priority || 'medium',
        });
        setEpicEditing(true);
    }, [epicDetail]);

    const saveEpicEdit = useCallback(async () => {
        if (!epicDetail || !epicForm) return;
        const workspace = lifetime.current;
        const request = detailRequest.current;
        const revision = formRevision.current;
        setEpicSaving(true);
        setEpicSaveError(null);
        try {
            await requestJson(
                `${BRIDGE_URL}/api/epics/${epicDetail.epicId}?db=${encodeURIComponent(db)}`,
                {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(epicForm),
                },
            );
            if (workspace !== lifetime.current) return;
            if (request === detailRequest.current) {
                updateEpicDetail((current) => current?.epicId === epicDetail.epicId ? { ...current, ...epicForm } : current);
                if (revision === formRevision.current) {
                    setEpicEditing(false);
                    setEpicForm(null);
                }
            }
            await reloadEpics();
        } catch (error) {
            if (workspace === lifetime.current && request === detailRequest.current && revision === formRevision.current) setEpicSaveError(error.message);
        } finally {
            if (workspace === lifetime.current && request === detailRequest.current) setEpicSaving(false);
        }
    }, [db, epicDetail, epicForm, reloadEpics]);

    const cancelEpicEdit = useCallback(() => {
        setEpicEditing(false);
        setEpicForm(null);
        setEpicSaveError(null);
    }, []);

    const toggleEpicCollapsed = useCallback((epicId, value) => {
        setEpicCollapsed((current) => {
            const next = { ...current, [epicId]: value };
            try { localStorage.setItem(EPIC_COLLAPSE_KEY, JSON.stringify(next)); } catch {}
            return next;
        });
    }, []);

    return {
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
    };
}

export function loadEpicCollapsed() {
    try { return JSON.parse(localStorage.getItem(EPIC_COLLAPSE_KEY) || '{}'); }
    catch { return {}; }
}

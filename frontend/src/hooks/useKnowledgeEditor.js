import { useEffect, useRef, useState } from 'react';
import BRIDGE_URL from '../bridgeUrl';
import { requestJson } from '../api/http';
import useRequestLifetime from './useRequestLifetime';

export default function useKnowledgeEditor({ node, nodeId, db, onSaved }) {
    const lifetime = useRequestLifetime(JSON.stringify([db, nodeId]));
    const revision = useRef(0);
    const [editing, updateEditing] = useState(false);
    const [draft, updateDraft] = useState('');
    const [localContent, setLocalContent] = useState(null);
    const [saving, setSaving] = useState(false);
    const [saveError, setSaveError] = useState(null);
    const setEditing = value => { revision.current++; updateEditing(value); };
    const setDraft = value => { revision.current++; updateDraft(value); };
    useEffect(() => {
        setEditing(false); setDraft(''); setLocalContent(null); setSaveError(null); setSaving(false);
    }, [db, nodeId]);
    const knowledgeContent = localContent ?? node?.content ?? '';
    const saveKnowledge = async () => {
        if (!nodeId || node?.kind === 'markdown' || saving) return;
        const request = lifetime.current;
        const submittedRevision = revision.current;
        setSaving(true); setSaveError(null);
        try {
            const saved = await requestJson(`${BRIDGE_URL}/api/knowledge`, {
                method: 'PATCH', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ nodeId, content: draft, db }),
            });
            if (request !== lifetime.current) return;
            setLocalContent(saved.content);
            if (submittedRevision === revision.current) setEditing(false);
            onSaved?.(nodeId, saved.content);
        } catch (error) {
            if (request === lifetime.current) setSaveError(error.message);
        } finally {
            if (request === lifetime.current) setSaving(false);
        }
    };
    return { editing, setEditing, draft, setDraft, knowledgeContent, saving, saveError, setSaveError, saveKnowledge };
}

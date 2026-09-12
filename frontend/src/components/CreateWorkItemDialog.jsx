import { useEffect, useRef, useState } from 'react';
import BRIDGE_URL from '../bridgeUrl';
import { requestJson } from '../api/http';
import useRequestLifetime from '../hooks/useRequestLifetime';
import styles from '../kanban/styles';

export default function CreateWorkItemDialog({ kind, db, onClose, onCreated }) {
    const dialog = useRef(null);
    const submitting = useRef(false);
    const lifetime = useRequestLifetime(db);
    const [form, setForm] = useState({ title: '', description: '', workInstructions: '', priority: 'medium' });
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState(null);
    const label = kind === 'epic' ? 'Epic' : 'Task';
    useEffect(() => { dialog.current.showModal(); }, []);
    const change = field => event => setForm(current => ({ ...current, [field]: event.target.value }));
    async function submit(event) {
        event.preventDefault();
        if (submitting.current) return;
        submitting.current = true;
        const workspace = lifetime.current;
        setSaving(true);
        setError(null);
        try {
            const result = await requestJson(`${BRIDGE_URL}/api/${kind === 'epic' ? 'epics' : 'tasks'}`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...form, title: form.title.trim(), description: form.description.trim(),
                    workInstructions: form.workInstructions.trim(), db, createdBy: 'user' }),
            });
            if (workspace === lifetime.current) onCreated(result);
        } catch (failure) {
            if (workspace === lifetime.current) setError(failure.body?.problems?.join('\n') || failure.message);
        } finally {
            submitting.current = false;
            if (workspace === lifetime.current) setSaving(false);
        }
    }
    const fieldStyle = { display: 'grid', gap: 5, marginBottom: 14, fontSize: 13 };
    return (
        <dialog ref={dialog} aria-labelledby="create-work-item-title"
            style={{ ...styles.detailPanel, maxWidth: 'calc(100vw - 48px)', color: 'var(--text)' }}
            onCancel={event => { event.preventDefault(); if (!saving) onClose(); }}>
            <form onSubmit={submit}>
                <h2 id="create-work-item-title" style={{ marginTop: 0 }}>New {label}</h2>
                <p style={{ fontSize: 12 }}>Create in <strong>{db}</strong> · Backlog</p>
                <fieldset disabled={saving} style={{ padding: 0, border: 0, margin: 0 }}>
                    <label style={fieldStyle}>Title (at least 8 characters)
                        <input autoFocus required minLength={8} value={form.title} onChange={change('title')} style={styles.editInput} />
                    </label>
                    <label style={fieldStyle}>Description (at least 80 characters)
                        <textarea required minLength={80} rows={4} value={form.description} onChange={change('description')}
                            placeholder="Describe the problem, desired outcome, and constraints." style={styles.editTextarea} />
                    </label>
                    <label style={fieldStyle}>Work instructions (at least 50 characters)
                        <textarea required minLength={50} rows={3} value={form.workInstructions} onChange={change('workInstructions')}
                            placeholder="List implementation steps and measurable acceptance criteria." style={styles.editTextarea} />
                    </label>
                    <label style={fieldStyle}>Priority
                        <select value={form.priority} onChange={change('priority')} style={styles.editInput}>
                            {['low', 'medium', 'high', 'critical'].map(value => <option key={value} value={value}>{value[0].toUpperCase() + value.slice(1)}</option>)}
                        </select>
                    </label>
                </fieldset>
                {error && <p role="alert" style={{ color: '#b91c1c', whiteSpace: 'pre-wrap' }}>{error}</p>}
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                    <button type="button" disabled={saving} onClick={onClose} style={styles.editBtn}>Cancel</button>
                    <button type="submit" disabled={saving} style={styles.editSaveBtn}>{saving ? 'Creating…' : `Create ${label}`}</button>
                </div>
            </form>
        </dialog>
    );
}

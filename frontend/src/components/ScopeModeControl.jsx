import { useEffect, useState } from 'react';
import BRIDGE_URL from '../bridgeUrl';
import { requestJson } from '../api/http';
import useRequestLifetime from '../hooks/useRequestLifetime';

export default function ScopeModeControl({ taskId, db, epic = false }) {
    const lifetime = useRequestLifetime(`${db}:${taskId}`);
    const [policy, setPolicy] = useState(null);
    const [error, setError] = useState(null);
    const [saving, setSaving] = useState(false);
    useEffect(() => {
        const current = lifetime.current;
        setPolicy(null); setError(null); setSaving(false);
        requestJson(`${BRIDGE_URL}/api/work-items/${encodeURIComponent(taskId)}/scope-policy?db=${encodeURIComponent(db)}`)
            .then(value => { if (current === lifetime.current) setPolicy(value); })
            .catch(failure => { if (current === lifetime.current) setError(failure.message); });
    }, [db, taskId]);
    async function change(event) {
        const current = lifetime.current;
        setSaving(true); setError(null);
        try {
            const value = await requestJson(`${BRIDGE_URL}/api/work-items/${encodeURIComponent(taskId)}/scope-policy`, {
                method: 'PATCH', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ db, scopeMode: event.target.value }),
            });
            if (current === lifetime.current) setPolicy(value);
        } catch (failure) { if (current === lifetime.current) setError(failure.message); }
        finally { if (current === lifetime.current) setSaving(false); }
    }
    const active = policy && !['backlog', 'todo', 'open', 'done'].includes(policy.status);
    return <section style={{ margin: '16px 0', fontSize: 13, color: '#334155', lineHeight: 1.5 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {epic ? 'Default edit mode' : 'Edit mode'}
            <select aria-label={epic ? 'Default edit mode' : 'Edit mode'} value={policy?.mode || 'inherit'}
                style={{ color: '#1e293b', background: '#fff', border: '1px solid #94a3b8', borderRadius: 5, padding: '5px 8px' }}
                disabled={!policy || saving || (!epic && active)} onChange={change}>
                <option value="inherit">Inherit {epic ? '(project default)' : '(Epic / project)'}</option>
                <option value="open">Open</option><option value="strict">Strict</option><option value="flexible">Flexible</option>
            </select>
        </label>
        <p>Open: free files, no planned scope required. Strict: planned files only. Flexible: explicitly expand into free files. All modes respect other tasks’ claims.</p>
        {policy && <p>{policy.lockingEnabled ? `Effective mode: ${policy.effectiveMode}.` : 'Project locking is disabled; edit modes are not enforced.'}
            {epic ? ' Changes apply when inherited tasks are next claimed.' : active ? ' Checkpoint and move to To Do before changing mode.' : ''}</p>}
        {error && <p role="alert" style={{ color: '#b91c1c' }}>{error}</p>}
    </section>;
}

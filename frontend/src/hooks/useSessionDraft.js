import { useCallback, useEffect, useState } from 'react';

// Keep drafts through view unmounts even when browser storage is unavailable.
// sessionStorage scopes persisted drafts to this browser tab and bridge origin.
const drafts = new Map();

function readDraft(key, fallback) {
    if (drafts.has(key)) return drafts.get(key);
    try {
        const stored = sessionStorage.getItem(key);
        if (stored != null) return JSON.parse(stored);
    } catch { /* unavailable storage or an invalid old draft */ }
    return fallback;
}

export default function useSessionDraft(key, fallback) {
    const [entry, setEntry] = useState(() => ({ key, value: readDraft(key, fallback) }));
    // A database change must never render or persist the previous workspace's text.
    const current = entry.key === key ? entry : { key, value: readDraft(key, fallback) };
    if (entry.key !== key) setEntry(current);

    useEffect(() => {
        drafts.set(current.key, current.value);
        try { sessionStorage.setItem(current.key, JSON.stringify(current.value)); } catch {}
    }, [current.key, current.value]);

    const setValue = useCallback((next) => {
        setEntry(previous => {
            if (previous.key !== key) return previous;
            return { key, value: typeof next === 'function' ? next(previous.value) : next };
        });
    }, [key]);
    return [current.value, setValue];
}

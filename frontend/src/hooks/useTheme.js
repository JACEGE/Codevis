import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'codevis.theme';
const EVENT_NAME = 'codevis-theme-change';

function initialTheme() {
    try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored === 'light' || stored === 'dark') return stored;
    } catch {}
    return 'dark';
}

export default function useTheme() {
    const [theme, setLocalTheme] = useState(initialTheme);

    useEffect(() => {
        document.documentElement.dataset.theme = theme;
        document.documentElement.style.colorScheme = theme;
    }, [theme]);

    useEffect(() => {
        const sync = (event) => setLocalTheme(event.detail);
        window.addEventListener(EVENT_NAME, sync);
        return () => window.removeEventListener(EVENT_NAME, sync);
    }, []);

    const setTheme = useCallback((next) => {
        const value = next === 'light' ? 'light' : 'dark';
        try { localStorage.setItem(STORAGE_KEY, value); } catch {}
        window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: value }));
    }, []);

    return [theme, setTheme];
}

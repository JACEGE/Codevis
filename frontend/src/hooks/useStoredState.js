import { useEffect, useState } from 'react';

export default function useStoredState(key, fallback, deserialize = identity) {
    const [value, setValue] = useState(() => {
        try {
            const stored = localStorage.getItem(key);
            return stored == null ? fallback : deserialize(stored, fallback);
        } catch {
            return fallback;
        }
    });

    useEffect(() => {
        try { localStorage.setItem(key, String(value)); } catch {}
    }, [key, value]);

    return [value, setValue];
}

function identity(value) {
    return value;
}

import { useEffect, useRef } from 'react';

// Capture .current before awaiting, compare it afterwards. Unlike a db string,
// this token distinguishes A -> B -> A and invalidates callbacks on unmount.
export default function useRequestLifetime(key) {
    const lifetime = useRef({ key });
    if (lifetime.current.key !== key) lifetime.current = { key };
    useEffect(() => {
        lifetime.current = { key };
        return () => { lifetime.current = {}; };
    }, [key]);
    return lifetime;
}

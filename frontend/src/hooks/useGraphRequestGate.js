import { useCallback, useRef } from 'react';
import useRequestLifetime from './useRequestLifetime';

// All temporary graph views share one ordering domain. Reset/new navigation
// invalidates earlier responses; workspace lifetimes also distinguish A -> B -> A.
export default function useGraphRequestGate(db) {
    const lifetime = useRequestLifetime(db);
    const revision = useRef(0);
    const invalidate = useCallback(() => { revision.current++; }, []);
    const capture = useCallback(() => {
        const workspace = lifetime.current;
        const request = revision.current;
        return () => workspace === lifetime.current && request === revision.current;
    }, []);
    const begin = useCallback(() => { invalidate(); return capture(); }, [capture, invalidate]);
    return { begin, capture, invalidate };
}

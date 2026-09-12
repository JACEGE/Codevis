import { useCallback, useEffect, useRef, useState } from 'react';

const MAX_TRACE_LOG = 30;

export default function useTraceActivity({ setStats }) {
    const [activeLinks, setActiveLinks] = useState(new Set());
    const [traceLog, setTraceLog] = useState([]);
    const [traceDecayMs, setTraceDecayMs] = useState(4000);
    const decayMsRef = useRef(traceDecayMs);
    const timersRef = useRef(new Set());

    useEffect(() => { decayMsRef.current = traceDecayMs; }, [traceDecayMs]);
    useEffect(() => () => {
        timersRef.current.forEach(clearTimeout);
        timersRef.current.clear();
    }, []);

    const handleTraceEvent = useCallback((event) => {
        const { caller, callee, callerName, calleeName } = event;
        const linkKey = `${caller}->${callee}`;
        setActiveLinks((current) => new Set(current).add(linkKey));
        setStats((current) => ({ ...current, activeTraces: current.activeTraces + 1 }));
        setTraceLog((current) => [
            { caller: callerName || caller, callee: calleeName || callee, time: Date.now() },
            ...current,
        ].slice(0, MAX_TRACE_LOG));

        const timer = setTimeout(() => {
            setActiveLinks((current) => {
                const next = new Set(current);
                next.delete(linkKey);
                return next;
            });
            timersRef.current.delete(timer);
        }, decayMsRef.current);
        timersRef.current.add(timer);
    }, [setStats]);

    const clearActiveLinks = useCallback(() => setActiveLinks(new Set()), []);
    const replaceActiveLinks = useCallback((links) => setActiveLinks(new Set(links)), []);

    return {
        activeLinks,
        traceLog,
        traceDecayMs,
        setTraceDecayMs,
        handleTraceEvent,
        clearActiveLinks,
        replaceActiveLinks,
    };
}

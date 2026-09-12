import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import BRIDGE_URL from '../bridgeUrl';
import { DEFAULT_TYPE_VISIBILITY } from '../components/GraphFilter';

export default function useGraphScope({ dashboard, activeDb, detailLevel, setActiveDb, setDetailLevel }) {
    const [typeVisibility, setTypeVisibility] = useState(() => {
        try {
            const stored = JSON.parse(localStorage.getItem('codevis.typeVisibility') || 'null');
            return stored && typeof stored === 'object'
                ? { ...DEFAULT_TYPE_VISIBILITY, ...stored }
                : DEFAULT_TYPE_VISIBILITY;
        } catch { return DEFAULT_TYPE_VISIBILITY; }
    });
    const [includeIsolated, setIncludeIsolated] = useState(false);
    const [nodeBudget, setNodeBudget] = useState(() => {
        try {
            const stored = parseInt(localStorage.getItem('codevis.maxNodes'), 10);
            if (Number.isFinite(stored) && stored >= 0) return stored;
        } catch { /* localStorage blocked */ }
        return null;
    });
    const [graphScope, updateGraphScope] = useState(null);
    const [scopePending, setScopePending] = useState(false);
    const [scopeError, setScopeError] = useState(null);
    const [retry, setRetry] = useState(0);
    // A new object also distinguishes A -> B -> A from one uninterrupted A.
    const workspaceRef = useRef({ activeDb, detailLevel });
    if (workspaceRef.current.activeDb !== activeDb || workspaceRef.current.detailLevel !== detailLevel) {
        workspaceRef.current = { activeDb, detailLevel };
    }
    const statusRequestRef = useRef(0);
    const scopeInFlightRef = useRef(false);
    const setGraphScope = useCallback((scope) => {
        // A live graph is newer than a status snapshot requested before it.
        statusRequestRef.current++;
        updateGraphScope(scope);
    }, []);
    const retryScope = useCallback(() => setRetry(value => value + 1), []);

    useEffect(() => () => { statusRequestRef.current++; }, []);

    useEffect(() => {
        try { localStorage.setItem('codevis.typeVisibility', JSON.stringify(typeVisibility)); }
        catch { /* localStorage blocked */ }
    }, [typeVisibility]);

    useEffect(() => {
        if (nodeBudget !== null) return;
        const cap = dashboard?.visibleNodeCap;
        if (Number.isFinite(cap) && cap >= 0) setNodeBudget(Math.floor(cap));
        else if (graphScope) setNodeBudget(graphScope.budget ?? 0);
    }, [dashboard, graphScope, nodeBudget]);

    useEffect(() => {
        if (nodeBudget === null) return;
        try { localStorage.setItem('codevis.maxNodes', String(nodeBudget)); } catch { /* localStorage blocked */ }
    }, [nodeBudget]);

    const refreshFromBridge = useCallback(async () => {
        // Status is not an acknowledgement of a scope POST still being loaded.
        if (scopeInFlightRef.current) return;
        const workspace = workspaceRef.current;
        const request = ++statusRequestRef.current;
        try {
            const res = await fetch(`${BRIDGE_URL}/api/status`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            if (request !== statusRequestRef.current || workspace !== workspaceRef.current) return;
            if (data.activeDb) setActiveDb(data.activeDb);
            if (data.detailLevel != null) setDetailLevel(data.detailLevel);
            if (data.scope) {
                setGraphScope(data.scope);
                setScopePending(false);
            }
        } catch (error) {
            console.error('[CodeVis] Refresh failed:', error.message);
        }
    }, [setActiveDb, setDetailLevel, setGraphScope]);

    useEffect(() => {
        const timer = setTimeout(refreshFromBridge, 600);
        return () => clearTimeout(timer);
    }, [activeDb, detailLevel, refreshFromBridge]);

    const scopeReady = graphScope !== null;
    useEffect(() => {
        // null is uninitialised; only the explicit stored value 0 means All.
        if (!graphScope || nodeBudget === null) return;
        const loadable = graphScope.loadable || 0;
        const wanted = {
            budget: nodeBudget > 0 && (!loadable || nodeBudget < loadable) ? nodeBudget : null,
            hiddenTypes: Object.keys(typeVisibility).filter((key) => !typeVisibility[key]).sort(),
            includeIsolated,
        };
        const key = JSON.stringify(wanted);
        const loaded = JSON.stringify({
            budget: graphScope.budget ?? null,
            hiddenTypes: [...(graphScope.hiddenTypes || [])].sort(),
            includeIsolated: Boolean(graphScope.includeIsolated),
        });
        if (key === loaded) {
            setScopePending(false);
            setScopeError(null);
            return;
        }
        let current = true;
        const workspace = workspaceRef.current;
        const controller = new AbortController();
        let timeout;
        statusRequestRef.current++;
        scopeInFlightRef.current = true;
        setScopePending(true);
        setScopeError(null);
        const timer = setTimeout(async () => {
            timeout = setTimeout(() => controller.abort(), 60000);
            try {
                const res = await fetch(`${BRIDGE_URL}/api/graph/scope`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(wanted),
                    signal: controller.signal,
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
                if (!current || workspace !== workspaceRef.current) return;
                if (data.scope) setGraphScope(data.scope);
                setScopePending(false);
            } catch (error) {
                if (!current || workspace !== workspaceRef.current) return;
                setScopePending(false);
                setScopeError(controller.signal.aborted ? 'Graph update timed out. Please retry.' : `Graph update failed: ${error.message}`);
            } finally {
                clearTimeout(timeout);
                if (current) scopeInFlightRef.current = false;
            }
        }, 350);
        return () => {
            current = false;
            scopeInFlightRef.current = false;
            clearTimeout(timer);
            clearTimeout(timeout);
            controller.abort();
        };
    // A workspace/level change alone must not re-post the previous graph's
    // scope or clear its loading indicator. Wait for the new graph snapshot.
    // Graph broadcasts are observations, not user edits. Reposting on every
    // snapshot makes windows with different saved budgets reload each other.
    }, [nodeBudget, typeVisibility, includeIsolated, scopeReady, retry, setGraphScope]);

    const nodeFilter = useMemo(() => ({
        visible: typeVisibility,
        maxNodes: nodeBudget > 0 ? nodeBudget : null,
    }), [typeVisibility, nodeBudget]);

    return {
        graphScope, includeIsolated, nodeBudget, nodeFilter, scopePending, scopeError, retryScope, typeVisibility,
        refreshFromBridge, setGraphScope, setIncludeIsolated, setNodeBudget,
        setScopePending, setTypeVisibility,
    };
}

import { useEffect, useMemo, useState } from 'react';
import BRIDGE_URL from '../bridgeUrl';

// The mode buttons used the .debug-mode-btn.active class, whose colours
// (--accent-cyan on translucent white) come from when this panel was a dark HUD
// overlay. It now renders in the light right-hand panel, where that active state
// is all but invisible — you could not tell which mode you were in. These styles
// are explicit and theme-independent, and match the tab bar's indigo accent so
// "selected" looks the same everywhere in the app.
const modeBtn = (active) => ({
    flex: 1,
    padding: '7px 10px',
    fontSize: 11,
    fontWeight: active ? 600 : 500,
    fontFamily: 'inherit',
    cursor: 'pointer',
    borderRadius: 6,
    transition: 'background 0.15s, border-color 0.15s, color 0.15s',
    color: active ? '#ffffff' : 'var(--muted, #888)',
    background: active ? '#6366f1' : 'transparent',
    border: `1px solid ${active ? '#6366f1' : 'var(--border, #e0e0e0)'}`,
});

const stepBtn = (disabled) => ({
    width: 34,
    height: 34,
    fontSize: 13,
    fontFamily: 'inherit',
    borderRadius: 8,
    border: '1px solid var(--border, #e0e0e0)',
    background: 'transparent',
    color: disabled ? 'var(--muted, #bbb)' : 'var(--text, #1a1a1a)',
    opacity: disabled ? 0.4 : 1,
    cursor: disabled ? 'not-allowed' : 'pointer',
});

const WALK_RELATIONS = new Set(['CALLS', 'RENDERS']);

function relationText(rows) {
    return rows.map(({ type, count }) => `${type} ×${count}`).join(', ');
}

function DebugStepper({
    debugNode,
    callStack,
    debugSequence, // The array of states pre-calculated by App.jsx
    debugStep,     // Current N
    sequentialMode,
    traceDirection,
    relationshipSummary,
    graphNodes = [],
    db = 'project_db',
    routeResult,
    onFindRoute,
    onStepChange,
    onSequentialChange,
    onTraceDirectionChange,
    onReset,
    onInspect,
}) {
    const [routeTarget, setRouteTarget] = useState('');
    const [routeQuery, setRouteQuery] = useState('');
    const [remoteTargets, setRemoteTargets] = useState([]);
    const [routeRelations, setRouteRelations] = useState('calls-renders');
    const [routePending, setRoutePending] = useState(false);
    const [routeError, setRouteError] = useState(null);

    useEffect(() => {
        setRouteTarget('');
        setRouteQuery('');
        setRemoteTargets([]);
        setRouteError(null);
    }, [debugNode]);

    useEffect(() => {
        if (routeQuery.trim().length < 2) {
            setRemoteTargets([]);
            return undefined;
        }
        const controller = new AbortController();
        const timer = setTimeout(() => {
            fetch(`${BRIDGE_URL}/api/pathfinder/nodes?q=${encodeURIComponent(routeQuery.trim())}&db=${encodeURIComponent(db)}&limit=40`, { signal: controller.signal })
                .then((response) => response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`)))
                .then((data) => setRemoteTargets(data.nodes || []))
                .catch((error) => {
                    if (error.name !== 'AbortError') setRouteError(String(error.message || error));
                });
        }, 180);
        return () => { clearTimeout(timer); controller.abort(); };
    }, [db, routeQuery]);

    const localTargets = useMemo(() => graphNodes
        .filter((node) => node.id !== debugNode && node.name)
        .slice()
        .sort((a, b) => String(a.name).localeCompare(String(b.name))), [debugNode, graphNodes]);
    const routeTargets = routeQuery.trim().length >= 2 ? remoteTargets : localTargets;

    const submitRoute = async () => {
        if (!routeTarget || !onFindRoute) return;
        setRoutePending(true);
        setRouteError(null);
        try {
            await onFindRoute({
                targetNode: routeTarget,
                relations: routeRelations === 'calls'
                    ? ['CALLS', 'CALLS_CONDITIONALLY']
                    : ['CALLS', 'CALLS_CONDITIONALLY', 'RENDERS'],
            });
        } catch (error) {
            setRouteError(String(error.message || error));
        } finally {
            setRoutePending(false);
        }
    };

    // If no node selected, don't render
    if (debugNode == null) return null;

    // `|| 1` used to paper over the empty case, which made "nothing found" look
    // like "one step" and produced a slider stuck at 0/0 with no explanation.
    //
    // Three states, not two. App.jsx pushes a root entry before it walks the
    // children (see the BFS branch of the sequence effect), so a node WITHOUT
    // outgoing edges yields a list of length 1 — not 0. Length 0 means no tree
    // was loaded at all. Both leave the slider immobile; only maxSteps > 0 is a
    // slider worth showing.
    const pathCount = debugSequence?.length || 0;
    const hasPath = pathCount > 0;
    const maxSteps = Math.max(0, pathCount - 1);
    const hasSteps = maxSteps > 0;
    const branches = debugSequence?.[debugStep]?.debugBranches || [];
    const outgoingWalks = (relationshipSummary?.outgoing || [])
        .filter(({ type }) => WALK_RELATIONS.has(type))
        .reduce((total, row) => total + row.count, 0);
    const incomingWalks = (relationshipSummary?.incoming || [])
        .filter(({ type }) => WALK_RELATIONS.has(type))
        .reduce((total, row) => total + row.count, 0);
    const nodeKind = relationshipSummary?.node?.labels?.[0] || 'node';

    const noPathExplanation = () => {
        if (traceDirection === 'in') {
            if (incomingWalks === 0 && outgoingWalks > 0) {
                return `This ${nodeKind} calls or renders other visible nodes, but none call or render it.`;
            }
            return `This ${nodeKind} has no incoming CALLS/RENDERS path in the loaded graph subset.`;
        }
        if (outgoingWalks === 0 && incomingWalks > 0) {
            return `The visible graph has ${incomingWalks} incoming CALLS/RENDERS edge(s) to this ${nodeKind}, but Pathfinder follows outgoing edges. It is called by others; it does not call or render another visible node.`;
        }
        if (relationshipSummary?.outgoing?.length) {
            return `This ${nodeKind} has outgoing visible edges (${relationText(relationshipSummary.outgoing)}), but none form an outgoing CALLS/RENDERS path.`;
        }
        if (relationshipSummary?.incoming?.length) {
            return `This ${nodeKind} only has incoming visible edges (${relationText(relationshipSummary.incoming)}). Pathfinder follows outgoing CALLS/RENDERS paths.`;
        }
        return `This ${nodeKind} has no outgoing CALLS/RENDERS path in the loaded graph subset.`;
    };

    const handleSequentialToggle = () => {
        if (onSequentialChange) {
            onSequentialChange(!sequentialMode);
        }
    };

    return (
        // Override the .debug-stepper positioning: it still carries the fixed
        // bottom/translateX from its overlay days, but it sits in normal flow now.
        <div className="debug-stepper" style={{ position: 'static', transform: 'none', width: 'auto', padding: 14 }}>
            <div style={{ marginBottom: 14, padding: 10, border: '1px solid var(--border, #e0e0e0)', borderRadius: 8 }}>
                <div style={{ fontSize: 11, fontWeight: 700, marginBottom: 7 }}>A → Z route</div>
                <input
                    aria-label="Search route destination"
                    value={routeQuery}
                    onChange={(event) => { setRouteQuery(event.target.value); setRouteTarget(''); }}
                    placeholder="Search nodes…"
                    style={{ width: '100%', boxSizing: 'border-box', marginBottom: 6, padding: '7px 8px', borderRadius: 6, border: '1px solid var(--border, #ddd)', background: 'var(--surface, #fff)', color: 'var(--text, #1a1a1a)' }}
                />
                <select
                    aria-label="Route destination"
                    value={routeTarget}
                    onChange={(event) => setRouteTarget(event.target.value)}
                    style={{ width: '100%', minWidth: 0, padding: '7px 8px', borderRadius: 6, border: '1px solid var(--border, #ddd)', background: 'var(--surface, #fff)', color: 'var(--text, #1a1a1a)' }}
                >
                    <option value="">Choose destination…</option>
                    {routeTargets.map((node) => (
                        <option key={node.id} value={node.id}>
                            {node.name}{node.file ? ` — ${node.file}` : ''}
                        </option>
                    ))}
                </select>
                <div style={{ display: 'flex', gap: 6, marginTop: 7 }}>
                    <select
                        aria-label="Route relationship types"
                        value={routeRelations}
                        onChange={(event) => setRouteRelations(event.target.value)}
                        style={{ flex: 1, minWidth: 0, padding: '6px 7px', borderRadius: 6, border: '1px solid var(--border, #ddd)', background: 'var(--surface, #fff)', color: 'var(--text, #1a1a1a)', fontSize: 11 }}
                    >
                        <option value="calls-renders">Calls + renders</option>
                        <option value="calls">Calls only</option>
                    </select>
                    <button
                        type="button"
                        onClick={submitRoute}
                        disabled={!routeTarget || routePending}
                        style={{ ...modeBtn(Boolean(routeTarget) && !routePending), flex: '0 0 auto' }}
                    >
                        {routePending ? 'Searching…' : 'Find route'}
                    </button>
                </div>
                {routeError && <div style={{ marginTop: 7, color: '#dc2626', fontSize: 11 }}>{routeError}</div>}
                {routeResult?.status === 'NO_PATH' && (
                    <div style={{ marginTop: 7, color: '#b45309', fontSize: 11 }}>
                        No static route found within {routeResult.maxHops} hops.
                    </div>
                )}
                {routeResult?.status === 'OK' && (
                    <div style={{ marginTop: 7, color: '#0f766e', fontSize: 11 }}>
                        {routeResult.paths.length} shortest route{routeResult.paths.length === 1 ? '' : 's'} · {routeResult.paths[0].hops} hop{routeResult.paths[0].hops === 1 ? '' : 's'}
                    </div>
                )}
            </div>

            {/* Mode toggle — aria-pressed so the active mode is not conveyed by colour alone. */}
            <div style={{ display: 'flex', gap: 6 }}>
                <button
                    style={modeBtn(traceDirection === 'out')}
                    aria-pressed={traceDirection === 'out'}
                    onClick={() => onTraceDirectionChange?.('out')}
                    title="Follow what this node calls or renders"
                >
                    Calls →
                </button>
                <button
                    style={modeBtn(traceDirection === 'in')}
                    aria-pressed={traceDirection === 'in'}
                    onClick={() => onTraceDirectionChange?.('in')}
                    title="Follow callers and components that render this node"
                >
                    ← Called by
                </button>
            </div>
            <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                <button
                    style={modeBtn(!sequentialMode)}
                    aria-pressed={!sequentialMode}
                    onClick={() => { if (sequentialMode) handleSequentialToggle(); }}
                    title="Show every edge up to depth N at once"
                >
                    🌐 Depth
                </button>
                <button
                    style={modeBtn(sequentialMode)}
                    aria-pressed={sequentialMode}
                    onClick={() => { if (!sequentialMode) handleSequentialToggle(); }}
                    title="Walk one root-to-leaf path at a time"
                >
                    🔦 One path
                </button>
            </div>

            {/* Step slider — or, when there is nothing to step through, the
                reason why. A range input with min=max=0 is not broken, it is
                just mute; saying so beats leaving a dead control on screen. */}
            {hasSteps ? (
                <div className="debug-speed" style={{ margin: '14px 0', width: '100%', justifyContent: 'space-between' }}>
                    <span className="speed-label" style={{ textAlign: 'left', minWidth: '30px' }}>0</span>
                    <input
                        type="range"
                        min="0"
                        max={maxSteps}
                        step="1"
                        value={debugStep}
                        onChange={(e) => onStepChange(Number(e.target.value))}
                        className="slider speed-slider"
                        style={{ flex: 1, margin: '0 12px' }}
                    />
                    <span className="speed-label" style={{ minWidth: '40px' }}>N={debugStep}/{maxSteps}</span>
                </div>
            ) : (
                <div style={{
                    margin: '14px 0', padding: '10px 12px', fontSize: 12, lineHeight: 1.5,
                    color: 'var(--muted, #888)', background: 'rgba(127,127,127,0.08)',
                    borderRadius: 6, border: '1px solid var(--border, #e0e0e0)',
                }}>
                    {hasPath
                        ? noPathExplanation()
                        : 'No call tree loaded for this node.'}
                    {relationshipSummary && (
                        <div style={{ marginTop: 6, fontSize: 11 }}>
                            <strong>Visible outgoing:</strong> {relationText(relationshipSummary.outgoing) || 'none'}
                            {' · '}<strong>incoming:</strong> {relationText(relationshipSummary.incoming) || 'none'}
                        </div>
                    )}
                    {onInspect && (
                        <button type="button" onClick={onInspect} style={{ ...stepBtn(false), width: 'auto', height: 30, marginTop: 8, padding: '0 10px', fontSize: 11 }}>
                            Open in Inspector
                        </button>
                    )}
                </div>
            )}

            {/* Call Stack Breadcrumb */}
            <div className="debug-callstack">
                <span className="debug-label">Active Track</span>
                <div className="callstack-trail">
                    {(callStack || []).map((entry, i) => (
                        <span key={i} className="callstack-item">
                            {i > 0 && <span className="callstack-arrow">→</span>}
                            <span className={`callstack-name ${i === callStack.length - 1 ? 'active' : ''}`}>
                                {entry.name || `#${entry.id || entry}`}
                            </span>
                        </span>
                    ))}
                </div>
            </div>

            {/* Visual Info */}
            <div className="debug-sequential-info" style={{ marginTop: '8px' }}>
                <span className="debug-label">
                    {sequentialMode
                        // No "Path 1" when there is no path — the number was
                        // derived from the step index and showed up even at zero.
                        ? (hasPath ? `🔦 Following: Path ${debugStep + 1}` : '🔦 One path — nothing to follow')
                        : `🌐 Showing: Depth ${debugStep}`}
                </span>
                {branches.length > 0 && (
                    <span className="seq-remaining" style={{ color: 'var(--accent-orange)' }}>
                        +{branches.length} branches from tip
                    </span>
                )}
            </div>

            {/* Controls */}
            <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                <button
                    style={{ ...stepBtn(false), width: 'auto', padding: '0 12px', fontSize: 11 }}
                    onClick={onReset}
                    title="Clear the selection and the traced route"
                >
                    🔄 Reset
                </button>
                <button
                    style={{ ...stepBtn(debugStep <= 0), marginLeft: 'auto' }}
                    onClick={() => onStepChange(debugStep - 1)}
                    disabled={debugStep <= 0}
                    title={debugStep <= 0 ? 'Already at the start' : 'Step back'}
                >
                    ⏮
                </button>
                <button
                    style={stepBtn(debugStep >= maxSteps)}
                    onClick={() => onStepChange(debugStep + 1)}
                    disabled={debugStep >= maxSteps}
                    title={debugStep >= maxSteps ? 'Already at the end' : 'Step forward'}
                >
                    ⏭
                </button>
            </div>
        </div>
    );
}

export default DebugStepper;

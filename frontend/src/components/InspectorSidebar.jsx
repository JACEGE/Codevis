import { useMemo, useState, useEffect, useCallback } from 'react';

import BRIDGE_URL from '../bridgeUrl';
import useKnowledgeEditor from '../hooks/useKnowledgeEditor';
import useRequestLifetime from '../hooks/useRequestLifetime';
import ImpactSection from './ImpactSection';

/**
 * InspectorSidebar — what the graph knows about the selected node.
 *
 * This panel used to compute its neighbour lists by filtering `graphData` in the
 * browser. That had two consequences nobody could see from the outside: it only
 * ever showed CALLS edges (one of ~48 relationship types in the schema), and it
 * only showed neighbours that had survived the view's node budget. A function
 * with twelve callers listed three, and looked like a function with three
 * callers.
 *
 * It now asks the database (GET /api/node/detail) and shows every edge in both
 * directions with its properties — the condition on a conditional call, the prop
 * names on a PASSES_PROP, the variable a data flow travels through. All of that
 * was already in the graph and was never displayed anywhere.
 *
 * The code shown is read from disk (GET /api/node/source), not `bodySnippet`:
 * the stored snippet is 120 characters of body with all whitespace collapsed,
 * which is unreadable as code and only as fresh as the last build.
 */

// Relationship types, with a reading for each direction. The direction is half
// the meaning — "calls" and "is called by" are the same edge — so a single label
// per type would be wrong in one of the two lists.
const REL_LABELS = {
    CALLS: { out: 'calls', in: 'called by' },
    CALLS_CONDITIONALLY: { out: 'conditionally calls', in: 'conditionally called by' },
    RENDERS: { out: 'renders', in: 'rendered by' },
    INHERITS: { out: 'inherits from', in: 'inherited by' },
    INSTANTIATES: { out: 'instantiates', in: 'instantiated by' },
    USES_TYPE: { out: 'uses type', in: 'type used by' },
    DECORATED_BY: { out: 'decorated by', in: 'decorates' },
    PASSES_PROP: { out: 'passes props to', in: 'receives props from' },
    PASSES_CALLBACK: { out: 'passes callback to', in: 'receives callback from' },
    DATA_FLOWS_TO: { out: 'data flows to', in: 'data flows from' },
    RETURNS: { out: 'returns', in: 'returned by' },
    AWAITS: { out: 'awaits', in: 'awaited by' },
    ASYNC_CHAIN: { out: 'async chains to', in: 'async chained from' },
    FETCHES: { out: 'fetches', in: 'fetched by' },
    HANDLES: { out: 'handles', in: 'handled by' },
    ON_EVENT: { out: 'on event', in: 'event from' },
    CONTAINS: { out: 'contains', in: 'lives in' },
    DECLARES: { out: 'declares', in: 'declared in' },
    CONTAINS_FLOW: { out: 'control flow', in: 'control flow of' },
    CONTAINS_STMT: { out: 'statements', in: 'statement of' },
    READS_STATE: { out: 'reads state', in: 'read by' },
    WRITES_STATE: { out: 'writes state', in: 'written by' },
    HAS_EFFECT: { out: 'effect', in: 'effect of' },
    CONSUMES_CONTEXT: { out: 'consumes context', in: 'context consumed by' },
    AFFECTS: { out: 'affects', in: 'affected by' },
    TOUCHED: { out: 'edited', in: 'edited by' },
    CREATED: { out: 'created', in: 'created by' },
    REMOVED: { out: 'removed', in: 'removed by' },
    APPLIES_TO: { out: 'applies to', in: 'knowledge for' },
    ANNOTATES: { out: 'annotates', in: 'annotated by' },
    REFERENCES: { out: 'references', in: 'referenced by' },
    FULFILLED_BY: { out: 'fulfilled by', in: 'fulfills' },
    DERIVES: { out: 'produced', in: 'derived from' },
    PROMOTED_TO: { out: 'promoted to', in: 'promoted from' },
    LOG_OF: { out: 'log of', in: 'logs' },
    // Runtime — written by the profiler, absent unless a session was recorded.
    TRIGGERS: { out: 'triggers', in: 'triggered by' },
    TRIGGERS_LEAF: { out: 'triggers (leaf)', in: 'triggered by' },
    TRIGGERS_RENDER: { out: 'renders (runtime)', in: 'rendered by' },
    RUNTIME_RENDERS: { out: 'renders (runtime)', in: 'rendered by' },
    CLICKS_ON: { out: 'clicks on', in: 'clicked by' },
    CLICKED_ELEMENT: { out: 'clicked element', in: 'click from' },
    EXECUTION_STEP: { out: 'execution step', in: 'step of' },
    EXECUTION_NEXT: { out: 'next', in: 'previous' },
    MAPS_TO: { out: 'maps to', in: 'mapped from' },
    MAPS_TO_STATIC: { out: 'maps to static', in: 'static mapped from' },
    SHOWS: { out: 'shows', in: 'shown by' },
    HAS_CHILD: { out: 'child', in: 'parent' },
    IMPORTS: { out: 'imports', in: 'imported by' },
    IMPORTS_SYMBOL: { out: 'imports symbol', in: 'symbol imported by' },
    EXPORTS_SYMBOL: { out: 'exports', in: 'exported by' },
    RESOLVES_TO: { out: 'resolves to', in: 'target of' },
    ALIAS_OF: { out: 'alias of', in: 'aliased by' },
    WRAPS: { out: 'wraps', in: 'wrapped by' },
    BELONGS_TO: { out: 'belongs to', in: 'comprises' },
    WATCHES: { out: 'watches', in: 'watched by' },
    REALIZED_BY: { out: 'realized by', in: 'realizes' },
    SPEC_RELATES: { out: 'spec relation to', in: 'spec relation from' },
    DEPENDS_ON: { out: 'depends on', in: 'required by' },
    PUBLISHES_TOPIC: { out: 'publishes', in: 'published by' },
    SUBSCRIBES_TOPIC: { out: 'subscribes to', in: 'subscribed by' },
    USES_TOPIC: { out: 'uses topic', in: 'topic used by' },
    PROVIDES_SERVICE: { out: 'provides service', in: 'service of' },
    CALLS_SERVICE: { out: 'calls service', in: 'service called by' },
    PROVIDES_ACTION: { out: 'provides action', in: 'action of' },
    USES_ACTION: { out: 'uses action', in: 'action used by' },
};

// Relations that get their own sections further down, so they are not repeated
// in the generic relationship list.
const STATE_RELS = new Set(['READS_STATE', 'WRITES_STATE', 'HAS_EFFECT', 'CONSUMES_CONTEXT']);
const RUNTIME_RELS = new Set([
    'TRIGGERS', 'TRIGGERS_LEAF', 'TRIGGERS_RENDER', 'CLICKS_ON', 'CLICKED_ELEMENT',
    'RUNTIME_RENDERS', 'EXECUTION_STEP', 'EXECUTION_NEXT', 'MAPS_TO', 'MAPS_TO_STATIC',
    'SHOWS', 'PERFORMED', 'NAVIGATED', 'HAS_CHILD',
]);

// What to show first. Everything unlisted keeps its natural order behind these —
// a CONTAINS list of forty statements should not push the callers off screen.
const REL_ORDER = [
    'CALLS', 'CALLS_CONDITIONALLY', 'RENDERS', 'INHERITS', 'INSTANTIATES',
    'PASSES_PROP', 'PASSES_CALLBACK', 'DATA_FLOWS_TO', 'USES_TYPE', 'DECORATED_BY',
    'HANDLES', 'ON_EVENT', 'FETCHES', 'AWAITS', 'ASYNC_CHAIN', 'RETURNS',
    'IMPORTS', 'IMPORTS_SYMBOL', 'EXPORTS_SYMBOL', 'RESOLVES_TO', 'ALIAS_OF', 'WRAPS',
    'ANNOTATES', 'CONTAINS', 'DECLARES',
];

const PROP_LABELS = {
    condition: 'when', branch: 'branch', via: 'via', inFunc: 'in',
    event: 'event', resolvedBy: 'resolved via', method: 'method',
    props: 'props', hasSpread: 'spread', spreadVars: 'spread vars',
    count: 'count', role: 'role', msgType: 'type', callback: 'callback',
    qos: 'QoS', kind: 'kind', confidence: 'confidence', name: 'name',
    at: 'at', lastSeen: 'last seen', lastClicked: 'last clicked',
};

function relLabel(relType, direction) {
    const entry = REL_LABELS[relType];
    if (entry) return entry[direction];
    // Unknown type — show the raw name rather than inventing a wording, and
    // mark the direction so the list stays readable.
    return direction === 'out' ? relType : `${relType} (incoming)`;
}

function fmtDate(ms) {
    if (!ms) return null;
    try { return new Date(Number(ms)).toLocaleString(); } catch { return null; }
}

function fmtProps(props) {
    const parts = [];
    for (const [key, value] of Object.entries(props || {})) {
        if (key === 'at' || key === 'lastSeen' || key === 'lastClicked') {
            const d = fmtDate(value);
            if (d) parts.push(`${PROP_LABELS[key]} ${d}`);
            continue;
        }
        const label = PROP_LABELS[key] || key;
        const shown = Array.isArray(value) ? value.join(', ') : String(value);
        if (!shown) continue;
        parts.push(`${label}: ${shown}`);
    }
    return parts;
}

function Section({ title, count, children, defaultOpen = true, accent }) {
    const [open, setOpen] = useState(defaultOpen);
    return (
        <div className="inspector-section">
            <h3
                className="inspector-heading"
                onClick={() => setOpen(o => !o)}
                style={{ cursor: 'pointer', userSelect: 'none' }}
            >
                <span style={{ opacity: 0.5, fontSize: 9 }}>{open ? '▼' : '▶'}</span>
                {title}
                {count != null && <span className="inspector-count" style={accent ? { background: `${accent}18`, color: accent } : undefined}>{count}</span>}
            </h3>
            {open && children}
        </div>
    );
}

function InspectorSidebar({
    debugNode, callStack, graphData, onExpandAst, db = 'target',
    onFindRoute, onKnowledgeSaved, onSelectNode, onSelectRelationship, onSearch,
}) {
    // The node as the *view* has it — used only until the detail request lands,
    // so the panel shows a name immediately instead of a spinner on every click.
    const viewNode = useMemo(() => {
        if (debugNode == null) return null;
        return graphData.nodes.find(n => n.id === debugNode) || null;
    }, [debugNode, graphData]);

    const [detail, setDetail] = useState(null);
    const [detailError, setDetailError] = useState(null);
    const [loading, setLoading] = useState(false);
    const [source, setSource] = useState(null);
    const [loadingFullSource, setLoadingFullSource] = useState(false);
    const [sourceError, setSourceError] = useState(null);
    const nodeLifetime = useRequestLifetime(JSON.stringify([db, debugNode]));
    const [annotations, setAnnotations] = useState([]);
    const [annotationError, setAnnotationError] = useState(null);
    const [annotationSaving, setAnnotationSaving] = useState(null);

    // ── The dossier ─────────────────────────────────────────────────────────
    useEffect(() => {
        const request = nodeLifetime.current;
        const current = () => request === nodeLifetime.current;
        setAnnotationSaving(null);
        setSourceError(null);
        if (debugNode == null) { setDetail(null); setSource(null); setAnnotations([]); setLoadingFullSource(false); return; }
        const ctrl = new AbortController();
        setLoading(true);
        setDetailError(null);
        setDetail(null);
        setSource(null);
        setAnnotations([]);
        setAnnotationError(null);
        setLoadingFullSource(false);

        fetch(`${BRIDGE_URL}/api/node/detail?nodeId=${encodeURIComponent(debugNode)}&db=${db}`, { signal: ctrl.signal })
            .then(async res => {
                if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
                return res.json();
            })
            .then(data => { if (current()) { setDetail(data); setLoading(false); } })
            .catch(err => {
                if (err.name === 'AbortError' || !current()) return;
                setDetailError(String(err.message || err));
                setLoading(false);
            });

        // Source is a separate request on purpose: it touches the filesystem and
        // a slow disk must not hold up the relationship lists, which are the
        // reason to open this panel at all.
        fetch(`${BRIDGE_URL}/api/node/source?nodeId=${encodeURIComponent(debugNode)}&db=${db}`, { signal: ctrl.signal })
            .then(res => (res.ok ? res.json() : null))
            .then(data => data && current() && setSource(data))
            .catch(() => { /* no source is a normal state — Task, Knowledge, deleted file */ });

        fetch(`${BRIDGE_URL}/api/annotations?nodeId=${encodeURIComponent(debugNode)}&db=${db}`, { signal: ctrl.signal })
            .then(async res => {
                if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
                return res.json();
            })
            .then(data => { if (current()) setAnnotations(data.annotations || []); })
            .catch(err => {
                if (err.name !== 'AbortError' && current()) setAnnotationError(String(err.message || err));
            });

        return () => ctrl.abort();
    }, [debugNode, db]);

    const reviewAnnotation = useCallback(async (annotationId, status) => {
        const request = nodeLifetime.current;
        setAnnotationSaving(annotationId);
        setAnnotationError(null);
        try {
            const res = await fetch(`${BRIDGE_URL}/api/annotations/${encodeURIComponent(annotationId)}/status`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status, db, updatedBy: 'dashboard-user' }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
            if (request !== nodeLifetime.current) return;
            setAnnotations((current) => current.map((item) =>
                item.annotationId === annotationId ? data.annotation : item));
        } catch (err) {
            if (request === nodeLifetime.current) setAnnotationError(String(err.message || err));
        } finally {
            if (request === nodeLifetime.current) setAnnotationSaving(null);
        }
    }, [db]);

    const loadFullSource = useCallback(async () => {
        if (debugNode == null) return;
        const request = nodeLifetime.current;
        setLoadingFullSource(true);
        setSourceError(null);
        try {
            const res = await fetch(`${BRIDGE_URL}/api/node/source?nodeId=${encodeURIComponent(debugNode)}&db=${db}&full=1`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            if (request === nodeLifetime.current) setSource(data);
        } catch (err) {
            if (request === nodeLifetime.current) setSourceError(String(err.message || err));
        } finally {
            if (request === nodeLifetime.current) setLoadingFullSource(false);
        }
    }, [debugNode, db]);

    const node = detail?.node || viewNode;
    // Nur gesetzt, wenn die Bridge diesen Knoten als Diagramm-Knoten erkennt.
    const spec = detail?.spec || null;
    const isKnowledge = !!node?.labels?.includes('Knowledge');
    const isTask = !!node?.labels?.includes('Task');
    const isEpic = !!node?.labels?.includes('Epic');

    const { editing, setEditing, draft, setDraft, knowledgeContent, saving, saveError, setSaveError, saveKnowledge } =
        useKnowledgeEditor({ node, nodeId: debugNode, db, onSaved: onKnowledgeSaved });

    // ── Relationship groups, split into the sections that display them ──────
    const { structural, stateRels, runtimeRels, astCount } = useMemo(() => {
        const relations = detail?.relations || {};
        const counts = detail?.counts || {};
        const structural = [];
        const stateRels = [];
        const runtimeRels = [];

        for (const [key, entries] of Object.entries(relations)) {
            const [direction, relType] = key.split(':');
            // `total` is the database's count for this type; `entries` is what
            // was shipped. They differ when the row cap bit, and the group says
            // so instead of presenting a slice as the whole.
            const group = { key, direction, relType, entries, total: counts[key] ?? entries.length };
            if (STATE_RELS.has(relType)) stateRels.push(group);
            else if (RUNTIME_RELS.has(relType)) runtimeRels.push(group);
            else structural.push(group);
        }

        // Raw AST tokens are deliberately not fetched — they are counted in the
        // thousands on a component and would bury everything else. Naming the
        // number keeps that an honest omission rather than a silent one.
        const astCount = (counts['out:CONTAINS_AST'] || 0) + (counts['in:CONTAINS_AST'] || 0);

        const rank = (g) => {
            const i = REL_ORDER.indexOf(g.relType);
            return (i === -1 ? REL_ORDER.length : i) * 2 + (g.direction === 'out' ? 0 : 1);
        };
        structural.sort((a, b) => rank(a) - rank(b));
        stateRels.sort((a, b) => rank(a) - rank(b));
        runtimeRels.sort((a, b) => rank(a) - rank(b));

        return { structural, stateRels, runtimeRels, astCount };
    }, [detail]);

    const selectNode = useCallback((id) => {
        if (onSelectNode) onSelectNode(id);
    }, [onSelectNode]);

    const selectRelationship = useCallback((entry, group) => {
        const incoming = group.direction === 'in';
        onSelectRelationship?.({
            source: incoming ? entry.other.id : debugNode,
            target: incoming ? debugNode : entry.other.id,
            relType: group.relType,
            other: entry.other,
        });
        selectNode(entry.other.id);
    }, [debugNode, onSelectRelationship, selectNode]);

    const copyLocation = useCallback(() => {
        if (!node?.file) return;
        const loc = node.startLine ? `${node.file}:${node.startLine}` : node.file;
        navigator.clipboard?.writeText(loc);
    }, [node]);

    if (debugNode == null) {
        return (
            <div
                style={{
                    height: '100%', display: 'flex', flexDirection: 'column',
                    alignItems: 'center', justifyContent: 'center', gap: 8,
                    textAlign: 'center', padding: 24, color: 'var(--muted, #888)',
                }}
            >
                <div style={{ fontSize: 36, opacity: 0.4 }}>🔍</div>
                <div style={{ fontWeight: 600, color: 'var(--text, #1a1a1a)' }}>
                    No node selected
                </div>
                <div style={{ fontSize: 13, lineHeight: 1.5 }}>
                    Click a node in the graph to inspect it.
                </div>
                {onSearch && <button className="ui-button" onClick={onSearch}>Find code or work</button>}
            </div>
        );
    }

    // Flags that say something about the code, as short badges rather than rows.
    const badges = [];
    if (node?.isAsync) badges.push({ text: 'async', color: '#0369a1' });
    if (node?.isHook) badges.push({ text: 'hook', color: '#7c3aed' });
    if (node?.isComponent) badges.push({ text: 'component', color: '#0891b2' });
    if (node?.isHttpHandler) badges.push({ text: 'http', color: '#c2410c' });
    if (node?.locked && node?.lockedBy) badges.push({ text: `🔒 ${node.lockedBy}`, color: '#b45309' });
    if (node?.lockStatus === 'conflict' || node?.lockStatus === 'blocked') {
        badges.push({ text: 'CONFLICT', color: '#dc2626' });
    }
    if (node?.lastError) badges.push({ text: '⚠ error', color: '#dc2626' });

    return (
        <div className="hud-panel inspector-sidebar">
            {/* ── Kopf ─────────────────────────────────────────────────────── */}
            <div className="inspector-section">
                <div className="inspector-node-name">{node?.name || `#${debugNode}`}</div>

                {node?.signature && (
                    <div className="inspector-signature">{node.signature}</div>
                )}

                {node?.file && (
                    <div className="inspector-file" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ flex: 1 }}>
                            {node.file}{node.startLine ? `:${node.startLine}` : ''}
                            {node.endLine != null && node.startLine !== node.endLine ? `–${node.endLine}` : ''}
                        </span>
                        <button
                            onClick={copyLocation}
                            title="Copy path:line"
                            style={{
                                border: '1px solid var(--border, #ddd)', background: 'transparent',
                                borderRadius: 4, fontSize: 10, padding: '1px 6px', cursor: 'pointer',
                                color: 'var(--muted, #888)', fontFamily: 'inherit',
                            }}
                        >
                            copy
                        </button>
                    </div>
                )}

                <div className="inspector-labels">
                    {(node?.labels || []).map(l => (
                        <span key={l} className="inspector-label-tag">{l}</span>
                    ))}
                    {badges.map(b => (
                        <span
                            key={b.text}
                            className="inspector-label-tag"
                            style={{ background: `${b.color}14`, color: b.color, borderColor: `${b.color}33` }}
                        >
                            {b.text}
                        </span>
                    ))}
                </div>

                {/* How connected this node is, and how much of that the current
                    view is actually showing. A node whose neighbours were left
                    out by the node budget otherwise looks like a leaf. */}
                {detail && (
                    <div style={{ fontSize: 11, color: 'var(--muted, #888)', marginTop: 4 }}>
                        {detail.totalEdges} edge{detail.totalEdges === 1 ? '' : 's'} in the graph
                        {astCount > 0 && `, ${astCount} of them AST tokens (not listed)`}
                        {detail.truncated && ' — list truncated'}
                    </div>
                )}

                {node?.renamedFrom && (
                    <div style={{ fontSize: 11, color: '#b45309', marginTop: 4 }}>
                        previously named <code>{node.renamedFrom}</code>
                        {fmtDate(node.renamedAt) ? ` (${fmtDate(node.renamedAt)})` : ''}
                    </div>
                )}
                {node?.movedFrom && (
                    <div style={{ fontSize: 11, color: '#b45309', marginTop: 2 }}>
                        previously in <code>{node.movedFrom}</code>
                    </div>
                )}

                {loading && (
                    <div style={{ fontSize: 11, color: 'var(--muted, #888)', marginTop: 6 }}>
                        loading details…
                    </div>
                )}
                {detailError && (
                    <div style={{ fontSize: 11, color: '#dc2626', marginTop: 6 }}>
                        Could not load details: {detailError}
                    </div>
                )}

                {/* Spec-Knoten haben keinen AST — sie stammen aus einem
                    Diagramm, nicht aus geparstem Code. */}
                {onExpandAst && !isKnowledge && !isTask && !isEpic && !spec && (
                    <button
                        className="inspector-ast-btn"
                        onClick={() => onExpandAst(debugNode)}
                        title="Load this node's atomic level (variables, control flow, statements) into the graph"
                        style={{
                            marginTop: 10, padding: '6px 12px', fontSize: 12, fontWeight: 600,
                            color: '#fff', background: '#6366f1', border: 'none',
                            borderRadius: 6, cursor: 'pointer', fontFamily: 'inherit',
                        }}
                    >
                        ⚛ Show AST level
                    </button>
                )}
                {onFindRoute && !isKnowledge && !isTask && !isEpic && (
                    <button
                        type="button"
                        onClick={onFindRoute}
                        title="Use this node as the start of an A-to-Z route search"
                        style={{
                            marginTop: 8, marginLeft: onExpandAst && !spec ? 6 : 0,
                            padding: '6px 12px', fontSize: 12, fontWeight: 600,
                            color: '#fff', background: '#0f766e', border: 'none',
                            borderRadius: 6, cursor: 'pointer', fontFamily: 'inherit',
                        }}
                    >
                        Find route from here
                    </button>
                )}
            </div>

            {/* ── Diagramm-Knoten ──────────────────────────────────────────────
                Ein Spec-Knoten hat keine Datei, keine Zeilen, keinen Quelltext
                — das Panel zeigte deshalb praktisch nichts an. Was ihn erklärt,
                steht woanders: aus welchem Diagramm er stammt, zu welcher
                Klasse er gehört, wie er laut Diagramm aussieht, und ob dahinter
                schon Code steht. Genau das ist dieser Block. */}
            {spec && (
                <Section title="From the diagram" accent="#f43f5e">
                    {spec.diagram && (
                        <div style={{ fontSize: 12, marginBottom: 6 }}>
                            {spec.diagram.title || spec.diagram.specId}
                            {spec.diagram.sourceFile && (
                                <div style={{ fontSize: 11, color: 'var(--muted,#888)', fontFamily: 'ui-monospace, monospace' }}>
                                    {spec.diagram.sourceFile}
                                </div>
                            )}
                        </div>
                    )}

                    {/* Bei einer SpecClass trägt `signature` den gebundenen
                        Codenamen und ist damit dasselbe wie der Titel oben —
                        dann bringt die Zeile nichts. */}
                    {spec.signature && spec.signature !== node?.name && (
                        <div className="inspector-signature" style={{ marginBottom: 6 }}>{spec.signature}</div>
                    )}

                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
                        {spec.owner && <span className="inspector-label-tag">in {spec.owner}</span>}
                        {['public', 'private', 'protected', 'package'].includes(spec.visibility) && (
                            <span className="inspector-label-tag">{spec.visibility}</span>
                        )}
                        {spec.params && <span className="inspector-label-tag">({spec.params})</span>}
                        {spec.returns && <span className="inspector-label-tag">→ {spec.returns}</span>}
                    </div>

                    {/* Die wichtigste Zeile für jemanden, der das umsetzen soll.
                        Sie kommt aus der REALIZED_BY-Kante, nicht aus einer
                        Eigenschaft — eine Kante kann nicht auf Code zeigen, den
                        es nicht mehr gibt.

                        Eine Methode hat keine eigene Bindung: sie gehört zu
                        ihrer Klasse, und die Frage ist, ob sie IN dieser Klasse
                        schon steht. Ein Feld hat im Code-Graphen gar keine
                        Entsprechung — dort sagt das Panel deshalb nichts. */}
                    {spec.memberStatus ? (
                        spec.memberStatus.implemented ? (
                            <div style={{ fontSize: 12 }}>
                                <span style={{ color: '#16a34a' }}>● Implemented in </span>
                                <button
                                    onClick={() => onSelectNode && onSelectNode(spec.memberStatus.fn.uid)}
                                    title="Go to function"
                                    style={{
                                        border: 'none', background: 'transparent', padding: 0,
                                        color: '#0369a1', cursor: onSelectNode ? 'pointer' : 'default',
                                        fontFamily: 'inherit', fontSize: 12, textDecoration: 'underline',
                                    }}
                                >
                                    {spec.memberStatus.ownerRealized}.{spec.memberStatus.fn.name}
                                </button>
                            </div>
                        ) : (
                            <div style={{ fontSize: 12, color: '#b45309' }}>
                                {spec.memberStatus.ownerRealized
                                    ? `○ Missing from ${spec.memberStatus.ownerRealized}`
                                    : `○ ${spec.memberStatus.owner} is not implemented yet`}
                            </div>
                        )
                    ) : !spec.bindable ? null : spec.realizedBy ? (
                        <div style={{ fontSize: 12 }}>
                            <span style={{ color: '#16a34a' }}>● Implemented by </span>
                            <button
                                onClick={() => onSelectNode && onSelectNode(spec.realizedBy.uid)}
                                title="Go to code node"
                                style={{
                                    border: 'none', background: 'transparent', padding: 0,
                                    color: '#0369a1', cursor: onSelectNode ? 'pointer' : 'default',
                                    fontFamily: 'inherit', fontSize: 12, textDecoration: 'underline',
                                }}
                            >
                                {spec.realizedBy.label} {spec.realizedBy.name}
                            </button>
                            {spec.realizedBy.file && (
                                <div style={{ fontSize: 11, color: 'var(--muted,#888)' }}>{spec.realizedBy.file}</div>
                            )}
                        </div>
                    ) : (
                        <div style={{ fontSize: 12, color: '#b45309' }}>
                            ○ Not implemented — {spec.binding === 'ambiguous'
                                ? 'multiple nodes match this name; binding unresolved'
                                : 'no code node with this name'}
                        </div>
                    )}

                    {spec.members && spec.members.length > 0 && (
                        <div style={{ marginTop: 8 }}>
                            <div style={{ fontSize: 11, color: 'var(--muted,#888)', marginBottom: 3 }}>
                                Declared in diagram ({spec.members.length})
                            </div>
                            {spec.members.map((m) => (
                                <div key={`${m.kind}-${m.name}`} style={{ fontSize: 12, fontFamily: 'ui-monospace, monospace', lineHeight: 1.5 }}>
                                    <span style={{ opacity: 0.5 }}>{m.kind === 'field' ? '·' : 'ƒ'}</span> {m.signature}
                                    {m.visibility && <span style={{ opacity: 0.5, fontSize: 11 }}> {m.visibility}</span>}
                                </div>
                            ))}
                        </div>
                    )}
                </Section>
            )}

            {/* ── Task-Felder ──────────────────────────────────────────────── */}
            {!isKnowledge && !isTask && !isEpic && !spec && <ImpactSection nodeId={debugNode} db={db} />}

            {isTask && (node?.description || node?.status) && (
                <Section title="Task" accent="#6366f1">
                    <div style={{ display: 'flex', gap: 6, marginBottom: 6, flexWrap: 'wrap' }}>
                        {node.status && <span className="inspector-label-tag">{node.status}</span>}
                        {node.priority && <span className="inspector-label-tag">{node.priority}</span>}
                        {node.assignedTo && <span className="inspector-label-tag">{node.assignedTo}</span>}
                        {node.taskId && <span className="inspector-label-tag">{node.taskId}</span>}
                    </div>
                    {node.description && (
                        <div style={{ fontSize: 12, lineHeight: 1.6, whiteSpace: 'pre-wrap', color: 'var(--text, #1a1a1a)' }}>
                            {node.description}
                        </div>
                    )}
                    {node.summary && (
                        <div style={{ fontSize: 11, lineHeight: 1.6, marginTop: 6, color: '#047857' }}>
                            {node.summary}
                        </div>
                    )}
                </Section>
            )}

            {isEpic && (
                <Section title="Epic" accent="#7c3aed">
                    <div style={{ display: 'flex', gap: 6, marginBottom: 6, flexWrap: 'wrap' }}>
                        {node.status && <span className="inspector-label-tag">{node.status}</span>}
                        {node.priority && <span className="inspector-label-tag">{node.priority}</span>}
                        {node.taskId && <span className="inspector-label-tag">{node.taskId}</span>}
                    </div>
                    {node.description && <div style={{ fontSize: 12, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{node.description}</div>}
                    {node.workInstructions && (
                        <div style={{ marginTop: 8 }}>
                            <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--muted,#888)', textTransform: 'uppercase' }}>Work instructions</div>
                            <div style={{ fontSize: 12, lineHeight: 1.6, whiteSpace: 'pre-wrap', marginTop: 3 }}>{node.workInstructions}</div>
                        </div>
                    )}
                    {node.summary && <div style={{ fontSize: 11, lineHeight: 1.6, marginTop: 8, color: '#047857' }}>{node.summary}</div>}
                </Section>
            )}

            {/* ── Quelltext ────────────────────────────────────────────────── */}
            {(source?.source || node?.bodySnippet) && (
                <Section
                    title="Source"
                    count={source?.source ? `${source.firstLine}–${source.firstLine + source.source.split('\n').length - 1}` : 'snippet'}
                >
                    {source?.source ? (
                        <>
                        <pre
                            style={{
                                margin: 0, fontFamily: 'var(--font-mono, monospace)', fontSize: 11,
                                lineHeight: 1.5, background: 'var(--bg, #fafafa)',
                                border: '1px solid var(--border, #ddd)', borderRadius: 4,
                                padding: '8px 0', maxHeight: 320, overflow: 'auto',
                            }}
                        >
                            {source.source.split('\n').map((line, i) => (
                                <div key={i} style={{ display: 'flex', gap: 10, padding: '0 8px' }}>
                                    <span style={{
                                        color: 'var(--muted, #999)', textAlign: 'right', minWidth: 32,
                                        userSelect: 'none', flexShrink: 0,
                                    }}>
                                        {source.firstLine + i}
                                    </span>
                                    <span style={{ whiteSpace: 'pre', color: 'var(--text, #1a1a1a)' }}>{line}</span>
                                </div>
                            ))}
                        </pre>
                        {source.truncatedTail && (
                            <button
                                type="button"
                                className="inspector-ast-btn"
                                onClick={loadFullSource}
                                disabled={loadingFullSource}
                                style={{ marginTop: 8, width: '100%', padding: '7px 10px', cursor: loadingFullSource ? 'wait' : 'pointer' }}
                            >
                                {loadingFullSource ? 'Loading complete file…' : `Show complete file (${source.totalLines} lines)`}
                            </button>
                        )}
                        {sourceError && <div role="alert" style={{ color: '#dc2626' }}>{sourceError}</div>}
                        </>
                    ) : (
                        <>
                            <div className="inspector-snippet">{node.bodySnippet}</div>
                            <div style={{ fontSize: 10, color: 'var(--muted, #888)', marginTop: 4 }}>
                                File not readable — stored snippet from the last build.
                                {source?.reason ? ` (${source.reason})` : ''}
                            </div>
                        </>
                    )}
                </Section>
            )}

            {/* ── Signatur-Details ─────────────────────────────────────────── */}
            {(node?.params || node?.returnType || node?.acceptsProps?.length
                || node?.decorators?.length || node?.declaredType || node?.url) && (
                <Section title="Interface" defaultOpen={false}>
                    <dl style={{ margin: 0, fontSize: 11, lineHeight: 1.7 }}>
                        {node.params && <Row label="Parameters" value={node.params} />}
                        {node.returnType && <Row label="Returns" value={node.returnType} />}
                        {node.declaredType && <Row label="Type" value={node.declaredType} />}
                        {node.acceptsProps?.length > 0 && <Row label="Props" value={node.acceptsProps.join(', ')} />}
                        {node.decorators?.length > 0 && <Row label="Decorators" value={node.decorators.join(', ')} />}
                        {node.url && <Row label="Route" value={`${node.method || ''} ${node.url}`.trim()} />}
                        {node.hookType && <Row label="Hook" value={node.hookType} />}
                        {node.language && <Row label="Language" value={node.language} />}
                        {node.callSites != null && (
                            <Row
                                label="Call sites"
                                value={`${node.callsResolved ?? 0} of ${node.callSites} resolved`}
                            />
                        )}
                    </dl>
                </Section>
            )}

            {/* ── Beziehungen ──────────────────────────────────────────────── */}
            {structural.length > 0 && (
                <Section title="Relationships" count={structural.reduce((n, g) => n + g.entries.length, 0)}>
                    {structural.map(group => (
                        <RelGroup key={group.key} group={group} onSelect={selectRelationship} />
                    ))}
                </Section>
            )}

            {/* ── Zustand & Effekte ────────────────────────────────────────── */}
            {(stateRels.length > 0 || node?.deps?.length > 0) && (
                <Section title="State & Effects" count={stateRels.reduce((n, g) => n + g.entries.length, 0) || undefined}>
                    {stateRels.map(group => (
                        <RelGroup key={group.key} group={group} onSelect={selectRelationship} />
                    ))}
                    {node?.deps?.length > 0 && (
                        <div style={{ fontSize: 11, marginTop: 6, color: 'var(--muted, #888)' }}>
                            Dependencies: <code>{node.deps.join(', ')}</code>
                        </div>
                    )}
                </Section>
            )}

            {/* ── Wissen ───────────────────────────────────────────────────── */}
            {(annotations.length > 0 || annotationError) && (
                <Section title="Semantic annotations" count={annotations.length} accent="#7c3aed">
                    {annotationError && (
                        <div style={{ color: '#dc2626', fontSize: 11, marginBottom: 8 }}>{annotationError}</div>
                    )}
                    {annotations.map((annotation) => (
                        <div key={annotation.annotationId} style={{ marginBottom: 10, padding: 9, border: '1px solid var(--border, #e0e0e0)', borderRadius: 7 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                                <span className="inspector-label-tag" style={{ color: '#7c3aed' }}>{annotation.tag}</span>
                                <span className="inspector-label-tag">{annotation.status}</span>
                                <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--muted, #888)' }}>
                                    confidence {Math.round((annotation.confidence ?? 0) * 100)}% · weight {Math.round((annotation.weight ?? 0) * 100)}%
                                </span>
                            </div>
                            <div style={{ marginTop: 6, fontSize: 11, lineHeight: 1.5 }}>{annotation.evidence}</div>
                            {(annotation.model || annotation.createdBy) && (
                                <div style={{ marginTop: 4, fontSize: 10, color: 'var(--muted, #888)' }}>
                                    proposed by {annotation.model || annotation.createdBy}
                                </div>
                            )}
                            {annotation.status === 'proposed' && (
                                <div style={{ display: 'flex', gap: 6, marginTop: 7 }}>
                                    <button
                                        type="button"
                                        disabled={annotationSaving === annotation.annotationId}
                                        onClick={() => reviewAnnotation(annotation.annotationId, 'accepted')}
                                        style={{ padding: '4px 9px', border: 0, borderRadius: 5, background: '#16a34a', color: '#fff', cursor: 'pointer', fontSize: 11 }}
                                    >
                                        Accept
                                    </button>
                                    <button
                                        type="button"
                                        disabled={annotationSaving === annotation.annotationId}
                                        onClick={() => reviewAnnotation(annotation.annotationId, 'rejected')}
                                        style={{ padding: '4px 9px', border: 0, borderRadius: 5, background: '#dc2626', color: '#fff', cursor: 'pointer', fontSize: 11 }}
                                    >
                                        Reject
                                    </button>
                                </div>
                            )}
                        </div>
                    ))}
                </Section>
            )}

            {detail?.knowledge?.length > 0 && (
                <Section title="Knowledge" count={detail.knowledge.length} accent="#0d9488">
                    {detail.knowledge.map(k => (
                        <div key={k.id} style={{ marginBottom: 10 }}>
                            <div
                                onClick={() => selectNode(k.id)}
                                style={{
                                    fontSize: 12, fontWeight: 600, color: '#0d9488',
                                    cursor: onSelectNode ? 'pointer' : 'default',
                                }}
                            >
                                {k.name}
                                {k.category && (
                                    <span className="inspector-label-tag" style={{ marginLeft: 6 }}>{k.category}</span>
                                )}
                            </div>
                            {k.content && (
                                <div style={{
                                    fontSize: 11, lineHeight: 1.6, whiteSpace: 'pre-wrap',
                                    color: 'var(--text, #1a1a1a)', marginTop: 3,
                                }}>
                                    {k.content}
                                </div>
                            )}
                        </div>
                    ))}
                </Section>
            )}

            {/* Knowledge node itself — editable, as before. */}
            {isKnowledge && (
                <Section title="Content" accent="#0d9488">
                    {!editing ? (
                        <>
                            <div style={{
                                fontSize: 13, lineHeight: 1.6, whiteSpace: 'pre-wrap',
                                color: 'var(--text, #1a1a1a)',
                            }}>
                                {knowledgeContent || (
                                    <span style={{ color: 'var(--muted, #888)' }}>No content yet.</span>
                                )}
                            </div>
                            {node.kind === 'markdown' ? (
                                <p style={{ fontSize: 12, color: 'var(--muted, #888)' }}>
                                    Managed by Markdown. Edit <code>{node.sourcePath || 'the source file'}</code> and synchronize the graph.
                                </p>
                            ) : <button
                                disabled={!detail || loading}
                                onClick={() => { setDraft(knowledgeContent); setEditing(true); }}
                                style={{
                                    marginTop: 10, padding: '6px 12px', fontSize: 12, fontWeight: 600,
                                    color: '#fff', background: '#0369a1', border: 'none', borderRadius: 6,
                                    cursor: 'pointer', fontFamily: 'inherit',
                                }}
                            >
                                ✎ Edit
                            </button>}
                        </>
                    ) : (
                        <>
                            <textarea
                                value={draft}
                                onChange={e => setDraft(e.target.value)}
                                autoFocus
                                style={{
                                    width: '100%', minHeight: 160, fontSize: 13, lineHeight: 1.5,
                                    fontFamily: 'inherit', padding: 8, borderRadius: 6,
                                    border: '1px solid #ccc', boxSizing: 'border-box', resize: 'vertical',
                                }}
                            />
                            {saveError && (
                                <div style={{ color: '#dc2626', fontSize: 11, marginTop: 4 }}>{saveError}</div>
                            )}
                            <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                                <button
                                    onClick={saveKnowledge}
                                    disabled={saving}
                                    style={{
                                        fontSize: 12, padding: '5px 14px',
                                        background: saving ? '#9ca3af' : '#16a34a', color: '#fff',
                                        border: 'none', borderRadius: 6, cursor: saving ? 'default' : 'pointer',
                                    }}
                                >
                                    {saving ? 'Saving…' : 'Save'}
                                </button>
                                <button
                                    onClick={() => { setEditing(false); setSaveError(null); }}
                                    disabled={saving}
                                    style={{
                                        fontSize: 12, padding: '5px 14px', background: '#e5e5e5',
                                        border: 'none', borderRadius: 6, cursor: 'pointer',
                                    }}
                                >
                                    Cancel
                                </button>
                            </div>
                        </>
                    )}
                </Section>
            )}

            {/* ── Arbeit & Historie ────────────────────────────────────────── */}
            {(detail?.tasks?.length > 0 || node?.lastError) && (
                <Section title="Work & History" count={detail?.tasks?.length || undefined} accent="#b45309">
                    {(detail?.tasks || []).map((t, i) => (
                        <div
                            key={`${t.id}-${t.relType}-${i}`}
                            onClick={() => selectNode(t.id)}
                            style={{
                                display: 'flex', gap: 8, alignItems: 'baseline', padding: '3px 0',
                                cursor: onSelectNode ? 'pointer' : 'default', fontSize: 11,
                            }}
                        >
                            <span style={{ color: 'var(--muted, #888)', minWidth: 62, fontSize: 10 }}>
                                {t.relType === 'CREATED' ? 'created' : t.relType === 'REMOVED' ? 'removed'
                                    : t.relType === 'TOUCHED' ? 'edited' : 'affects'}
                            </span>
                            <span style={{ flex: 1, color: 'var(--text, #1a1a1a)' }}>{t.title || t.taskId}</span>
                            {t.status && <span className="inspector-label-tag">{t.status}</span>}
                            {fmtDate(t.at) && (
                                <span style={{ color: 'var(--muted, #888)', fontSize: 10 }}>{fmtDate(t.at)}</span>
                            )}
                        </div>
                    ))}

                    {node?.lastError && (
                        <div style={{ marginTop: 8 }}>
                            <div style={{ fontSize: 11, color: '#dc2626', fontWeight: 600 }}>
                                Last runtime error
                                {fmtDate(node.lastErrorTimestamp) ? ` — ${fmtDate(node.lastErrorTimestamp)}` : ''}
                            </div>
                            <div className="inspector-snippet" style={{ marginTop: 4 }}>{node.lastError}</div>
                            {node.lastErrorStack && (
                                <details style={{ marginTop: 4 }}>
                                    <summary style={{ fontSize: 10, color: 'var(--muted, #888)', cursor: 'pointer' }}>
                                        Stack
                                    </summary>
                                    <div className="inspector-snippet" style={{ marginTop: 4, maxHeight: 160 }}>
                                        {node.lastErrorStack}
                                    </div>
                                </details>
                            )}
                        </div>
                    )}
                </Section>
            )}

            {/* ── Laufzeit ─────────────────────────────────────────────────── */}
            {runtimeRels.length > 0 && (
                <Section
                    title="Runtime"
                    count={runtimeRels.reduce((n, g) => n + g.entries.length, 0)}
                    defaultOpen={false}
                    accent="#0891b2"
                >
                    {runtimeRels.map(group => (
                        <RelGroup key={group.key} group={group} onSelect={selectRelationship} />
                    ))}
                </Section>
            )}

            {/* ── Call Stack (Pathfinder-Lauf) ─────────────────────────────── */}
            {callStack?.length > 0 && (
                <Section title="Call Stack" count={callStack.length} defaultOpen={false}>
                    <div className="inspector-stack">
                        {[...callStack].reverse().map((entry, i) => (
                            <div key={i} className={`inspector-stack-item ${i === 0 ? 'active' : ''}`}>
                                <span className="stack-depth">{callStack.length - i - 1}</span>
                                <span className="stack-name">{entry.name}</span>
                            </div>
                        ))}
                    </div>
                </Section>
            )}
        </div>
    );
}

function Row({ label, value }) {
    return (
        <div style={{ display: 'flex', gap: 8 }}>
            <dt style={{ color: 'var(--muted, #888)', minWidth: 80, flexShrink: 0 }}>{label}</dt>
            <dd style={{ margin: 0, fontFamily: 'var(--font-mono, monospace)', wordBreak: 'break-word' }}>{value}</dd>
        </div>
    );
}

/**
 * One relationship type in one direction, with its neighbours. Long lists are
 * capped with a "show all" toggle rather than scrolled: a File node's CONTAINS
 * list is hundreds of entries and would bury every other section.
 */
function RelGroup({ group, onSelect }) {
    const [expanded, setExpanded] = useState(false);
    const LIMIT = 8;
    const entries = expanded ? group.entries : group.entries.slice(0, LIMIT);
    const hidden = group.entries.length - entries.length;
    const incoming = group.direction === 'in';

    return (
        <div style={{ marginBottom: 8 }}>
            <div style={{
                fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.8,
                color: incoming ? '#7c3aed' : '#0369a1', marginBottom: 2,
            }}>
                {incoming ? '←' : '→'} {relLabel(group.relType, group.direction)}
                <span style={{ color: 'var(--muted, #888)', marginLeft: 6 }}>
                    {group.total > group.entries.length
                        ? `${group.entries.length} of ${group.total}`
                        : group.total}
                </span>
            </div>
            <div className="inspector-list">
                {entries.map((e, i) => {
                    const props = fmtProps(e.props);
                    return (
                        <div
                            key={`${e.other.id}-${i}`}
                            className={`inspector-list-item ${incoming ? 'incoming' : 'outgoing'}`}
                            onClick={() => onSelect && onSelect(e, group)}
                            title={e.other.file || undefined}
                            style={{ cursor: onSelect ? 'pointer' : 'default', alignItems: 'flex-start' }}
                        >
                            <span className="list-arrow">{incoming ? '←' : '→'}</span>
                            <span style={{ flex: 1, minWidth: 0 }}>
                                <span className="list-name">{e.other.name || `#${e.other.id}`}</span>
                                {props.length > 0 && (
                                    <span style={{
                                        display: 'block', fontSize: 10, color: 'var(--muted, #888)',
                                        fontFamily: 'var(--font-mono, monospace)', wordBreak: 'break-word',
                                    }}>
                                        {props.join(' · ')}
                                    </span>
                                )}
                            </span>
                        </div>
                    );
                })}
            </div>
            {hidden > 0 && (
                <button
                    onClick={() => setExpanded(true)}
                    style={{
                        fontSize: 10, color: 'var(--muted, #888)', background: 'none',
                        border: 'none', cursor: 'pointer', padding: '2px 6px', fontFamily: 'inherit',
                    }}
                >
                    … show {hidden} more
                </button>
            )}
        </div>
    );
}

export default InspectorSidebar;

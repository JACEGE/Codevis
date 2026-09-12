import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import BRIDGE_URL from '../bridgeUrl';
import useRequestLifetime from '../hooks/useRequestLifetime';
import { rowKeys, rowIpv6s } from '../explore/rowIdentity';
import { resultColumns } from '../explore/resultColumns';

/**
 * ExploreTab — self-service graph exploration without asking an agent.
 *
 * Three sections:
 *   1. Stats bar   — node/edge counts per type, file count, last build time.
 *   2. Scan buttons — named predefined queries (same list as the MCP tool
 *                     `predefined_queries`); each runs on click and fills the
 *                     results table.
 *   3. Free-text query editor — arbitrary read-only Cypher, results in a
 *                     scrollable table, row-cap warning if the limit is hit.
 *
 * Write operations are blocked server-side (POST /api/graph/query rejects
 * any query containing CREATE / MERGE / SET / DELETE / DETACH / REMOVE / DROP).
 * The UI does not add a second client-side gate — the server is the authority.
 */

const PANEL = {
    height: '100%',
    boxSizing: 'border-box',
    padding: 12,
    overflow: 'auto',
    overflowX: 'hidden',
    minWidth: 0,
    background: 'var(--bg, #0b0d10)',
    color: 'var(--text, #e4e4e7)',
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
};

const CONTROL = {
    padding: '6px 10px',
    fontSize: 12,
    borderRadius: 8,
    cursor: 'pointer',
    border: '1px solid var(--border, #2a2f37)',
    background: 'var(--surface, #14171c)',
    color: 'var(--text, #e4e4e7)',
    fontFamily: 'inherit',
};

const SECTION = {
    flexShrink: 0,
    border: '1px solid var(--border, #2a2f37)',
    borderRadius: 10,
    padding: 16,
    background: 'var(--surface, #14171c)',
    minWidth: 0,
};

const SECTION_TITLE = {
    fontSize: 13,
    fontWeight: 600,
    marginBottom: 12,
    color: 'var(--text, #e4e4e7)',
};

// Scans whose answer is a claim about COMPLETENESS: "nothing calls this", "this
// is the biggest function there is". A graph that lags behind the code makes
// them wrong rather than merely imprecise — a function whose only caller sits in
// an unparsed file looks dead here.
//
// That is worth saying, not worth locking. Refusing to run them meant the one
// state in which you most want to look at the graph was the state in which the
// buttons stopped working, and the graph is stale after every single edit.
// magic_numbers gehört dazu, magic_number_sites nicht: die Einstufung "hoch"
// heißt "steht in mindestens drei Dateien". Fehlt eine Datei im Graphen, sinkt
// die Zahl und der Fund wird kleingeredet. Die reine Fundstellenliste behauptet
// dagegen nichts über Vollständigkeit.
const CONFIDENCE_SENSITIVE = new Set(['dead_code', 'most_complex_functions', 'magic_numbers']);

// Scan categories shown in the UI — each maps to one or more predefined query names.
// We keep a curated subset rather than dumping all 40+ queries at once.
const SCAN_BUTTONS = [
    { label: 'Potential Dead Code', query: 'dead_code' },
    { label: 'God Functions', query: 'most_complex_functions' },
    { label: 'Duplicates (callees)', query: 'duplicate_functions_by_callees' },
    { label: 'Recursion', query: 'direct_recursion' },
    { label: 'Entry Points', query: 'entry_points' },
    { label: 'Circular Imports', query: 'circular_imports' },
    { label: 'API Endpoints', query: 'api_endpoints' },
    { label: 'Missing Props', query: 'missing_props' },
    { label: 'Runtime Errors', query: 'functions_with_errors' },
    { label: 'Magic Numbers', query: 'magic_numbers' },
    { label: 'Magic Number Sites', query: 'magic_number_sites' },
];

// Welche Werte einer Zeile einen Knoten adressieren, steht in
// ../explore/rowIdentity.js — als reines JS, damit es geprüft werden kann.

/**
 * Rendering directives, written as Cypher comments:
 *
 *   // @expand 2              2 hops of neighbours around the result set
 *   // @raw                   keep the containment edges the architecture
 *                             level hides (the atomic view)
 *   // @types Function,Class  show exactly these node types, ignoring the
 *                             filter panel. `@types *` means all of them.
 *
 * They are not Cypher, so they are parsed here and stripped before the query is
 * sent — the graph database never sees them.
 */
function parseDirectives(cypher) {
    // Blank out string literals first, keeping length so every index still
    // lines up with the original. Without this, a query searching for the
    // literal '// @raw' would have that text cut out of it.
    const masked = cypher.replace(
        /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g,
        (m) => ' '.repeat(m.length)
    );

    let expand = 0;
    let raw = false;
    let types = null;   // null = leave it to the filter panel
    let stripped = '';
    let last = 0;
    for (const m of masked.matchAll(/\/\/[^\n]*@(?:expand|raw|atomic|all|types)[^\n]*/gi)) {
        const text = cypher.slice(m.index, m.index + m[0].length);
        const expandMatch = text.match(/@expand(?:\s*[:=]?\s*(\d+))?/i);
        if (expandMatch) {
            expand = Math.min(3, expandMatch[1] ? parseInt(expandMatch[1], 10) : 1);
        }
        if (/@(?:raw|atomic|all)\b/i.test(text)) raw = true;
        // @types Function, Class   /   @types *
        const typesMatch = text.match(/@types\s*[:=]?\s*([A-Za-z0-9_,*\s]+)/i);
        if (typesMatch) {
            const list = typesMatch[1]
                .split(/[,\s]+/)
                .map((s) => s.trim())
                .filter(Boolean);
            types = list.includes('*') ? '*' : list;
        }
        stripped += cypher.slice(last, m.index);
        last = m.index + m[0].length;
    }
    return { expand, raw, types, cypher: (stripped + cypher.slice(last)).trim() };
}

/** Put a directive comment on the query text, replacing any that is there. */
function withDirectives(cypher, { expand, raw, types }) {
    const body = parseDirectives(cypher).cypher;
    const parts = [];
    if (raw) parts.push('@raw');
    if (expand > 0) parts.push(`@expand ${expand}`);
    if (types === '*') parts.push('@types *');
    else if (Array.isArray(types) && types.length) parts.push(`@types ${types.join(',')}`);
    return parts.length ? `// ${parts.join(' ')}\n${body}` : body;
}

/** Format an epoch-millisecond timestamp as a human-readable relative string. */
function relativeTime(ms) {
    if (!ms) return 'never';
    const diff = Date.now() - ms;
    const secs = Math.floor(diff / 1000);
    if (secs < 60) return `${secs}s ago`;
    const mins = Math.floor(secs / 60);
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return new Date(ms).toLocaleDateString();
}

/** Render a single stat chip in the stats bar. */
function Chip({ label, value }) {
    return (
        <span style={{ fontSize: 12, color: 'var(--muted, #94a3b8)', whiteSpace: 'nowrap' }}>
            <strong style={{ color: 'var(--text, #e4e4e7)' }}>{value}</strong> {label}
        </span>
    );
}

/**
 * Einen zu breiten Bereich mit der Maus schieben können, statt nur über seine
 * Scrollleiste.
 *
 * Die Ergebnistabelle einer Abfrage wie „God Functions" hat ein Dutzend
 * Spalten und ist damit deutlich breiter als das Panel. Bisher blieb dafür
 * ausschließlich der schmale Balken ganz unten — man musste erst ans Ende der
 * Tabelle scrollen, um überhaupt an ihn heranzukommen, und dann pixelgenau
 * treffen. Greifen und ziehen geht überall.
 *
 * Was dabei NICHT kaputtgehen darf: ein Klick auf „Show", das Markieren von
 * Text zum Kopieren einer uid, und das normale vertikale Scrollen. Deshalb
 * beginnt das Schieben erst nach ein paar Pixeln Bewegung, Bedienelemente sind
 * ausgenommen, und wo nichts überläuft, passiert gar nichts.
 */
function useDragScroll() {
    const ref = useRef(null);
    const drag = useRef({ active: false, moved: false, startX: 0, startLeft: 0 });
    const [grabbing, setGrabbing] = useState(false);
    // Ein Greif-Cursor über etwas, das sich nicht schieben lässt, ist eine
    // Lüge. Also messen — und zwar auch nach jedem Ergebniswechsel, denn die
    // Spaltenzahl entscheidet, ob überhaupt etwas überläuft.
    //
    // Callback-Ref statt Effekt: die Tabelle existiert beim ersten Rendern noch
    // gar nicht (ohne Ergebnis rendert die Komponente früher zurück), ein
    // Effekt mit leerer Abhängigkeitsliste liefe also genau einmal ins Leere.
    const [scrollable, setScrollable] = useState(false);
    const observerRef = useRef(null);
    const attach = useCallback((el) => {
        if (observerRef.current) { observerRef.current.disconnect(); observerRef.current = null; }
        ref.current = el;
        if (!el) { setScrollable(false); return; }
        const check = () => setScrollable(el.scrollWidth > el.clientWidth + 1);
        check();
        if (typeof ResizeObserver === 'undefined') return;
        const ro = new ResizeObserver(check);
        ro.observe(el);
        // Die Tabelle selbst: sie wächst mit der Spaltenzahl, nicht mit dem
        // Panel — ohne sie bliebe ein Ergebniswechsel unbemerkt.
        if (el.firstElementChild) ro.observe(el.firstElementChild);
        observerRef.current = ro;
    }, []);

    const onPointerDown = useCallback((e) => {
        const el = ref.current;
        if (!el || e.button !== 0) return;
        if (el.scrollWidth <= el.clientWidth) return;
        if (e.target.closest?.('button, a, input, select, textarea')) return;
        drag.current = { active: true, moved: false, startX: e.clientX, startLeft: el.scrollLeft };
    }, []);

    const onPointerMove = useCallback((e) => {
        const el = ref.current;
        const d = drag.current;
        if (!el || !d.active) return;
        const dx = e.clientX - d.startX;
        // Unterhalb der Schwelle ist es ein Klick oder eine Textauswahl.
        if (!d.moved && Math.abs(dx) < 4) return;
        if (!d.moved) {
            d.moved = true;
            setGrabbing(true);
            el.setPointerCapture?.(e.pointerId);
        }
        el.scrollLeft = d.startLeft - dx;
        e.preventDefault();
    }, []);

    const endDrag = useCallback((e) => {
        const el = ref.current;
        if (drag.current.moved && el?.hasPointerCapture?.(e.pointerId)) {
            el.releasePointerCapture(e.pointerId);
        }
        drag.current.active = false;
        setGrabbing(false);
    }, []);

    return {
        ref: attach,
        grabbing,
        scrollable,
        handlers: {
            onPointerDown, onPointerMove,
            onPointerUp: endDrag, onPointerCancel: endDrag, onPointerLeave: endDrag,
        },
    };
}

/** Result table for query results. Handles empty, truncated, and error states. */
function ResultTable({ rows, truncated, limit, error, loading, graphData, onShowNode, onInspectNode }) {
    const pan = useDragScroll();
    const [showIdentifiers, setShowIdentifiers] = useState(false);
    if (loading) {
        return <div style={{ color: 'var(--muted, #94a3b8)', fontSize: 13 }}>Running…</div>;
    }
    if (error) {
        return (
            <div style={{ color: '#ef4444', fontSize: 13, padding: '8px 0' }}>
                {error}
            </div>
        );
    }
    if (!rows) return null;
    if (rows.length === 0) {
        return (
            <div style={{
                padding: '20px 0',
                textAlign: 'center',
                color: 'var(--muted, #94a3b8)',
                fontSize: 13,
                border: '1px dashed var(--border, #2a2f37)',
                borderRadius: 8,
            }}>
                No results — the graph has nothing matching this query.
            </div>
        );
    }

    // The graph gets every row; the table gets the first slice of them. 25k
    // rows is a perfectly reasonable graph and a browser-killing <table>.
    const TABLE_ROW_LIMIT = 500;
    const tableRows = rows.length > TABLE_ROW_LIMIT ? rows.slice(0, TABLE_ROW_LIMIT) : rows;
    const { columns, hasIdentifiers } = resultColumns(rows[0], showIdentifiers);
    const nodes = graphData?.nodes || [];
    const nodesById = new Map(nodes.map((node) => [String(node.id), node]));
    const nodesByIpv6 = new Map(nodes.filter((node) => node.ipv6).map((node) => [String(node.ipv6), node]));
    const resolveNode = (row) => {
        const { uids, ipv6s } = rowKeys(row);
        // Predefined queries deliberately return `elementId(n) AS uid`. Looking
        // only for a column literally named `id` made their Function rows say
        // "Not in loaded graph" even though the exact node was already present.
        // Accept identities from any alias, just like the query-subgraph loader.
        for (const uid of uids) {
            const hit = nodesById.get(uid);
            if (hit) return hit;
        }
        if (row.id !== null && row.id !== undefined) {
            const hit = nodesById.get(String(row.id));
            if (hit) return hit;
        }
        for (const ipv6 of ipv6s) {
            const hit = nodesByIpv6.get(ipv6);
            if (hit) return hit;
        }
        return null;
    };
    return (
        <div>
            {truncated && (
                <div style={{ fontSize: 12, color: '#f59e0b', marginBottom: 6 }}>
                    The query returned more than {limit?.toLocaleString()} rows and was cut there —
                    add a LIMIT clause or narrow the WHERE.
                </div>
            )}
            {tableRows.length < rows.length && (
                <div style={{ fontSize: 12, color: 'var(--muted, #94a3b8)', marginBottom: 6 }}>
                    Table shows the first {tableRows.length} of {rows.length.toLocaleString()} rows.
                    The graph has all of them.
                </div>
            )}
            {hasIdentifiers && <label className="explore-identifiers"><input type="checkbox" checked={showIdentifiers} onChange={event => setShowIdentifiers(event.target.checked)} /> Show internal identifiers</label>}
            <div
                ref={pan.ref}
                {...pan.handlers}
                title={pan.scrollable ? 'Drag the table sideways to see more columns.' : undefined}
                style={{
                    overflowX: 'auto',
                    cursor: !pan.scrollable ? 'default' : pan.grabbing ? 'grabbing' : 'grab',
                    // Nur WÄHREND des Ziehens: sonst liesse sich in der Tabelle
                    // kein Text mehr markieren.
                    userSelect: pan.grabbing ? 'none' : 'auto',
                }}
            >
                <table style={{
                    width: '100%',
                    borderCollapse: 'collapse',
                    fontSize: 12,
                    fontFamily: 'monospace',
                }}>
                    <thead>
                        <tr>
                            {columns.map((col) => (
                                <th key={col} style={{
                                    textAlign: 'left',
                                    padding: '6px 10px',
                                    borderBottom: '1px solid var(--border, #2a2f37)',
                                    color: 'var(--muted, #94a3b8)',
                                    fontWeight: 600,
                                    whiteSpace: 'nowrap',
                                }}>
                                    {col}
                                </th>
                            ))}
                            <th style={{ padding: '6px 10px', borderBottom: '1px solid var(--border, #2a2f37)', whiteSpace: 'nowrap' }}>
                                Actions
                            </th>
                        </tr>
                    </thead>
                    <tbody>
                        {tableRows.map((row, i) => {
                            const node = resolveNode(row);
                            const hasIdentity = rowIpv6s(row).length > 0
                                || (row.id !== null && row.id !== undefined);
                            return (
                            <tr key={i} style={{ background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.02)' }}>
                                {columns.map((col) => {
                                    const val = row[col];
                                    const display = val === null || val === undefined
                                        ? <span style={{ color: 'var(--muted, #94a3b8)' }}>null</span>
                                        : Array.isArray(val)
                                            ? val.join(', ')
                                            : String(val);
                                    return (
                                        <td key={col} title={String(val ?? '')} style={{
                                            padding: '5px 10px',
                                            borderBottom: '1px solid var(--border, #2a2f37)',
                                            maxWidth: 220,
                                            overflow: 'hidden',
                                            textOverflow: 'ellipsis',
                                            whiteSpace: 'nowrap',
                                        }}>
                                            {display}
                                        </td>
                                    );
                                })}
                                <td style={{ padding: '5px 10px', borderBottom: '1px solid var(--border, #2a2f37)', whiteSpace: 'nowrap' }}>
                                    {(node || rowKeys(row).uids.length === 1) ? (
                                        <span style={{ display: 'flex', gap: 6 }}>
                                            <button type="button" style={CONTROL} onClick={() => onInspectNode?.(node?.id ?? rowKeys(row).uids[0])}>Inspect</button>
                                            <button type="button" style={CONTROL} onClick={() => onShowNode?.(node?.id ?? rowKeys(row).uids[0], 1)}>Show in graph</button>
                                        </span>
                                    ) : (
                                        <span title={hasIdentity ? 'The query hit is outside the graph subset currently loaded by the dashboard.' : 'Return elementId(node) AS uid (recommended) or node.ipv6 AS ipv6 in the query.'} style={{ color: 'var(--muted, #94a3b8)', fontSize: 11 }}>
                                            {hasIdentity ? 'Not in loaded graph' : 'No id / ipv6'}
                                        </span>
                                    )}
                                </td>
                            </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
            <div style={{ fontSize: 11, color: 'var(--muted, #94a3b8)', marginTop: 6 }}>
                {rows.length} row{rows.length !== 1 ? 's' : ''}
            </div>
        </div>
    );
}

export default function ExploreTab({ db, graphData, onShowNode, onResultGraph, onInspectNode }) {
    const [stats, setStats] = useState(null);
    const [statsError, setStatsError] = useState(null);
    const [predefined, setPredefined] = useState([]);

    // Query runner state — shared by scan buttons and free-text editor.
    const [queryText, setQueryText] = useState('');
    const [activeQueryName, setActiveQueryName] = useState(null);
    const [queryResult, setQueryResult] = useState(null);  // { rows, truncated, limit }
    const [queryError, setQueryError] = useState(null);
    const [queryLoading, setQueryLoading] = useState(false);
    const [graphResult, setGraphResult] = useState(null);
    const [graphError, setGraphError] = useState(null);
    const abortRef = useRef(null);
    const panelRef = useRef(null);
    const resultRef = useRef(null);
    useEffect(() => {
        if (queryLoading || (!queryResult && !queryError)) return;
        const panel = panelRef.current;
        const result = resultRef.current;
        if (!panel || !result) return;
        // Keep Run nearby while bringing the first result rows into view.
        const top = panel.scrollTop + result.getBoundingClientRect().top - panel.getBoundingClientRect().top - 76;
        panel.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    }, [queryLoading, queryResult, queryError]);
    const workspaceLifetime = useRequestLifetime(db);
    useEffect(() => {
        setStats(null); setQueryResult(null); setGraphResult(null);
        setQueryError(null); setGraphError(null); setQueryLoading(false);
        setActiveQueryName(null); setActiveScanName(null);
        return () => { abortRef.current?.abort(); };
    }, [db]);

    // Which predefined scan is on screen — decides whether the staleness caveat
    // is relevant to the result below. A free-text query is not a scan, so it
    // clears this.
    const [activeScanName, setActiveScanName] = useState(null);

    // The stale banner is dismissed by remembering WHICH staleness was dismissed,
    // not a boolean. Ticking a flag would hide the banner for good the first time
    // it is closed; keyed on the count it comes back as soon as the situation is
    // a different one, and stays gone while it is the same one.
    const [dismissedStaleCount, setDismissedStaleCount] = useState(null);

    const stale = Boolean(stats) && stats.graphState !== 'current';
    const staleBannerVisible = stale && dismissedStaleCount !== stats.staleFileCount;

    // What the directive buttons show as active — read back out of the query
    // text, so typing `// @expand 2` lights the same button up.
    const directives = useMemo(() => parseDirectives(queryText), [queryText]);

    // Fetch graph stats on mount and whenever the active DB changes.
    useEffect(() => {
        let alive = true;
        setStatsError(null);
        const params = db ? `?db=${encodeURIComponent(db)}` : '';
        fetch(`${BRIDGE_URL}/api/graph/stats${params}`)
            .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
            .then((d) => { if (alive) setStats(d); })
            .catch((e) => { if (alive) setStatsError(e.message); });
        return () => { alive = false; };
    }, [db]);

    // Fetch the predefined query catalogue once (it never changes at runtime).
    useEffect(() => {
        fetch(`${BRIDGE_URL}/api/graph/predefined-queries`)
            .then((r) => r.ok ? r.json() : null)
            .then((d) => { if (d && d.queries) setPredefined(d.queries); })
            .catch(() => {});
    }, []);

    const runQuery = useCallback((rawCypher, label) => {
        if (abortRef.current) abortRef.current.abort();
        const ctrl = new AbortController();
        const workspace = workspaceLifetime.current;
        const current = () => workspace === workspaceLifetime.current && abortRef.current === ctrl && !ctrl.signal.aborted;
        let querySucceeded = false;
        abortRef.current = ctrl;
        setQueryLoading(true);
        setQueryError(null);
        setGraphError(null);
        setGraphResult(null);
        setQueryResult(null);
        onResultGraph?.(null);
        setActiveQueryName(label || null);
        const { expand, raw, types, cypher } = parseDirectives(rawCypher);
        return fetch(`${BRIDGE_URL}/api/graph/query`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: cypher, db }),
            signal: ctrl.signal,
        })
            .then((r) => r.json().then((body) => ({ ok: r.ok, body })))
            .then(({ ok, body }) => {
                if (!current()) return;
                if (ok) {
                    querySucceeded = true;
                    setQueryResult(body);
                    const rows = body.rows || [];
                    const keys = rows.map(rowKeys);
                    const uids = [...new Set(keys.flatMap((k) => k.uids))];
                    const ipv6s = [...new Set(keys.flatMap((k) => k.ipv6s))];
                    return fetch(`${BRIDGE_URL}/api/graph/subgraph`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ ipv6s, uids, db, expand }),
                        signal: ctrl.signal,
                    })
                        .then((r) => r.json().then((subgraph) => ({ ok: r.ok, subgraph })))
                        .then(({ ok: graphOk, subgraph }) => {
                            if (!current()) return;
                            if (!graphOk) throw new Error(subgraph.error || 'Could not load query graph');
                            const shownIpv6s = new Set(
                                subgraph.nodes.flatMap((node) => [node.ipv6, node.id].filter(Boolean))
                            );
                            const shownRows = rows.filter(
                                (row) => rowIpv6s(row).some((ipv6) => shownIpv6s.has(ipv6))
                            ).length;
                            const status = {
                                shown: shownRows,
                                unavailable: rows.length - shownRows,
                                total: rows.length,
                                nodes: subgraph.nodes.length,
                                links: subgraph.links.length,
                                expanded: subgraph.expanded || 0,
                                hops: subgraph.hops || 0,
                                capped: Boolean(subgraph.capped),
                                raw,
                                types,
                            };
                            setGraphResult(status);
                            onResultGraph?.({ nodes: subgraph.nodes, links: subgraph.links, raw, types });
                        });
                } else {
                    setQueryError(body.error || 'Unknown error');
                }
            })
            .catch((e) => {
                if (e.name !== 'AbortError' && current()) {
                    if (querySucceeded) setGraphError(e.message);
                    else setQueryError(e.message);
                }
            })
            .finally(() => { if (current()) setQueryLoading(false); });
    }, [db, onResultGraph]);

    const handleScanClick = useCallback((scanName, scanLabel) => {
        const entry = predefined.find((q) => q.name === scanName);
        if (!entry) return;
        setActiveScanName(scanName);
        // Keep whatever the directive buttons are set to — a scan is a
        // different query, not a different way of looking at one.
        const text = withDirectives(entry.query, directives);
        setQueryText(text);
        runQuery(text, scanLabel);
    }, [predefined, runQuery, directives]);

    const handleSubmit = useCallback((e) => {
        e.preventDefault();
        setActiveScanName(null);
        if (queryText.trim()) runQuery(queryText.trim(), null);
    }, [queryText, runQuery]);

    // Build the stats chips — show total nodes, total edges, file count, last build.
    const totalNodes = stats
        ? Object.values(stats.nodesByLabel).reduce((a, b) => a + b, 0)
        : null;
    const totalEdges = stats
        ? Object.values(stats.edgesByType).reduce((a, b) => a + b, 0)
        : null;

    return (
        <div ref={panelRef} className="explore-panel" style={PANEL}>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
                <h2 style={{ margin: 0, fontSize: 20, fontWeight: 600 }}>Explore</h2>
                <span style={{ fontSize: 12, color: 'var(--muted, #94a3b8)' }}>
                    {db || 'active db'}
                </span>
            </div>

            {/* ── Section 1: Stats ───────────────────────────────────────── */}
            <div style={SECTION}>
                <div style={SECTION_TITLE}>Graph Overview</div>
                {/* `stats` ist beim ersten Render null. Ohne die erste Bedingung
                    ist `null?.graphState !== 'current'` wahr, und der Block unten
                    dereferenziert null — der Tab blieb dadurch komplett weiss. */}
                {staleBannerVisible && (
                    <div style={{
                        padding: '8px 10px', marginBottom: 10, border: '1px solid #f59e0b',
                        borderRadius: 6, color: '#f59e0b', fontSize: 12,
                        display: 'flex', alignItems: 'flex-start', gap: 10,
                    }}>
                        <span style={{ flex: 1, minWidth: 0 }}>
                            The graph is {stats.staleFileCount} source file{stats.staleFileCount === 1 ? '' : 's'} behind the code.
                            All scans use this saved graph and may miss recent changes. Treat findings as provisional until the graph is current.
                        </span>
                        <button
                            type="button"
                            onClick={() => setDismissedStaleCount(stats.staleFileCount)}
                            title="Dismiss. Comes back when the number of stale files changes."
                            style={{ ...CONTROL, padding: '0 7px', color: '#f59e0b', lineHeight: 1.6, flexShrink: 0 }}
                        >
                            ✕
                        </button>
                    </div>
                )}
                {statsError && (
                    <div style={{ color: '#ef4444', fontSize: 12 }}>Could not load stats: {statsError}</div>
                )}
                {!stats && !statsError && (
                    <div style={{ color: 'var(--muted, #94a3b8)', fontSize: 12 }}>Loading…</div>
                )}
                <details><summary>Node counts & build details</summary>
                {stats && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 20px' }}>
                        <Chip label="nodes total" value={totalNodes?.toLocaleString() ?? '–'} />
                        <Chip label="edges total" value={totalEdges?.toLocaleString() ?? '–'} />
                        <Chip label="files" value={stats.fileCount?.toLocaleString() ?? '–'} />
                        {/* Two chips, because they answer different questions and
                            used to be conflated: how old is the GRAPH, and how
                            old is the CODE it was built from. This one showed
                            the newest source mtime under the label "last build",
                            so a freshly built graph of untouched code looked
                            weeks stale — and a graph nobody had rebuilt looked
                            fresh the moment you edited a file. */}
                        <Chip label="last build" value={relativeTime(stats.lastBuilt)} />
                        <Chip label="newest source" value={relativeTime(stats.lastParsed)} />
                        {Object.entries(stats.nodesByLabel)
                            .filter(([lbl]) => !['ASTNode', 'BraindumpSession'].includes(lbl))
                            .sort((a, b) => b[1] - a[1])
                            .slice(0, 8)
                            .map(([lbl, cnt]) => (
                                <Chip key={lbl} label={lbl} value={cnt.toLocaleString()} />
                            ))}
                        {stats.extractors && Object.entries(stats.extractors)
                            .filter(([, on]) => on)
                            .map(([name]) => (
                                <Chip key={name} label="extractor" value={name} />
                            ))}
                    </div>
                )}
                </details>
            </div>

            {/* ── Section 2: Scan Buttons ────────────────────────────────── */}
            <div style={SECTION}>
                <div style={SECTION_TITLE}>Quick Scans</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                    {SCAN_BUTTONS.map(({ label, query }) => (
                        <button
                            key={query}
                            style={{
                                ...CONTROL,
                                background: activeQueryName === label ? 'var(--border, #2a2f37)' : 'var(--surface, #14171c)',
                                fontWeight: activeQueryName === label ? 600 : 400,
                            }}
                            onClick={() => handleScanClick(query, label)}
                            disabled={queryLoading}
                        >
                            {label}
                        </button>
                    ))}
                </div>
            </div>

            {/* ── Section 3: Free-text Query ─────────────────────────────── */}
            <div style={SECTION}>
                <div style={SECTION_TITLE}>Custom Query</div>
                <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <textarea
                        aria-label="Cypher query"
                        value={queryText}
                        onChange={(e) => setQueryText(e.target.value)}
                        placeholder={'MATCH (f:Function) RETURN elementId(f) AS uid, f.name AS name, f.file AS file ORDER BY name LIMIT 50'}
                        rows={4}
                        style={{
                            ...CONTROL,
                            resize: 'vertical',
                            width: '100%',
                            boxSizing: 'border-box',
                            fontFamily: 'monospace',
                            fontSize: 12,
                            lineHeight: 1.5,
                            cursor: 'text',
                        }}
                    />
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <button type="submit" className="ui-button ui-button--primary" disabled={queryLoading || !queryText.trim()}>
                            {queryLoading ? 'Running…' : 'Run'}
                        </button>
                        <button
                            type="button"
                            style={{ ...CONTROL, opacity: queryText ? 1 : 0.4 }}
                            disabled={!queryText}
                            onClick={() => {
                                setQueryText(''); setQueryResult(null); setQueryError(null);
                                setGraphResult(null); setGraphError(null); setActiveQueryName(null);
                                onResultGraph?.(null);
                            }}
                        >
                            Clear
                        </button>
                        <span style={{ fontSize: 11, color: 'var(--muted, #94a3b8)' }}>
                            Read-only — writes are blocked server-side
                        </span>
                    </div>
            {(queryResult || queryError || queryLoading) && (
                <div ref={resultRef} style={SECTION}>
                    <h3 style={SECTION_TITLE}>Results</h3>
                    {activeQueryName && (
                        <div style={{ ...SECTION_TITLE, marginBottom: 8 }}>
                            {activeQueryName}
                        </div>
                    )}
                    {/* Not dismissable, because it is not an interruption: it sits
                        on the result it qualifies instead of between you and the
                        button that produces it. */}
                    {stale && CONFIDENCE_SENSITIVE.has(activeScanName) && queryResult && (
                        <div style={{ fontSize: 11.5, color: '#f59e0b', marginBottom: 8, lineHeight: 1.5 }}>
                            Provisional — the graph is {stats.staleFileCount} file{stats.staleFileCount === 1 ? '' : 's'} behind the code,
                            and this scan asks whether something is <em>absent</em>. A function whose only caller
                            lives in a stale file shows up here as dead. Rebuild before acting on a row.
                        </div>
                    )}
                    {graphResult && (
                        <div style={{ fontSize: 12, color: graphResult.unavailable ? '#f59e0b' : '#16a34a', marginBottom: 8 }}>
                            Graph: {graphResult.shown} / {graphResult.total} results shown; {graphResult.unavailable} not representable
                            {' — '}{graphResult.nodes} nodes, {graphResult.links} edges
                            {graphResult.expanded > 0 && ` (incl. ${graphResult.expanded} neighbours, ${graphResult.hops} hop${graphResult.hops === 1 ? '' : 's'})`}
                            {graphResult.raw && ' · containment edges kept'}
                            {graphResult.capped && ' · neighbourhood capped at 6000 nodes'}
                        </div>
                    )}
                    {graphError && (
                        <div style={{ fontSize: 12, color: '#ef4444', marginBottom: 8 }}>
                            Query results loaded, but the graph could not be shown: {graphError}
                        </div>
                    )}
                    <ResultTable
                        rows={queryResult?.rows}
                        truncated={queryResult?.truncated}
                        limit={queryResult?.limit}
                        error={queryError}
                        loading={queryLoading}
                        graphData={graphData}
                        onShowNode={onShowNode}
                        onInspectNode={onInspectNode}
                    />
                </div>
            )}
                    <details className="editor-options"><summary>Graph display options & query help</summary>
                    {/* The same two directives as buttons. Typing `// @raw` is
                        fine and stays supported — but nobody discovers a tag
                        they have to know about, and these are exactly the two
                        knobs that decide whether a query draws structure or a
                        field of dots. */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                        <label style={{ fontSize: 11.5, color: 'var(--muted, #94a3b8)', display: 'flex', alignItems: 'center', gap: 6 }}>
                            Show connected items outside the query:
                            <input
                                type="number"
                                min={0}
                                max={3}
                                value={directives.expand}
                                onChange={(e) => {
                                    const n = Math.max(0, Math.min(3, Number(e.target.value) || 0));
                                    setQueryText((t) => withDirectives(t, { ...directives, expand: n }));
                                }}
                                style={{
                                    ...CONTROL,
                                    width: 52,
                                    padding: '3px 6px',
                                    cursor: 'text',
                                    fontFamily: 'monospace',
                                }}
                                title="0 = only what the query matched. 1 = also everything one edge away from a result, 2 = one edge further, and so on (max 3)."
                            />
                            <span style={{ fontSize: 11, opacity: 0.8 }}>
                                {directives.expand === 0
                                    ? '0 — only what the query matched'
                                    : `${directives.expand} step${directives.expand === 1 ? '' : 's'} out from each result`}
                            </span>
                        </label>
                        <button
                            type="button"
                            onClick={() => setQueryText((t) => withDirectives(t, { ...directives, raw: !directives.raw }))}
                            style={{
                                ...CONTROL,
                                padding: '3px 9px',
                                background: directives.raw ? '#0f766e' : CONTROL.background,
                                color: directives.raw ? '#ffffff' : CONTROL.color,
                                fontWeight: directives.raw ? 600 : 400,
                            }}
                            title="Keep the containment edges the architecture level hides — the atomic view"
                        >
                            @raw — all edges
                        </button>
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--muted, #94a3b8)', lineHeight: 1.6 }}>
                        Both are plain Cypher comments (<code>// @raw @expand 1</code>) and can be typed
                        instead. The number is how far past the result the graph may reach: at{' '}
                        <strong>0</strong> every node drawn is a row in the table below, and the only
                        edges are the ones that happen to run between two results — which is why a
                        result often looks like unconnected dots. Each step adds what hangs one edge
                        further out, whether or not it matches the query.{' '}
                        <strong>@raw</strong> keeps the containment edges (<code>CONTAINS</code>,{' '}
                        <code>DECLARES</code>, <code>RETURNS</code>) that the architecture level hides —
                        those are what hold atomic nodes to their function. The filter panel always
                        applies on top unless <code>@types</code> overrides it, and <code>ASTNode</code>{' '}
                        is switched off there by default, so atomic results stay hidden until you tick
                        it.
                        <br />
                        Return <code>elementId(n) AS uid</code> for an exact result: uid is the primary
                        key, ipv6 is not — the same ipv6 can name several nodes, so an ipv6-keyed
                        query may also include unrelated collisions. Every uid and ipv6 column
                        counts, so{' '}
                        <code>RETURN elementId(a) AS caller, elementId(b) AS callee</code> draws both
                        ends of a relationship.
                    </div>
                    </details>
                </form>
            </div>

            {/* ── Results ────────────────────────────────────────────────── */}

        </div>
    );
}

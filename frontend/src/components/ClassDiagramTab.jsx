import React, { useEffect, useMemo, useRef, useState } from 'react';
import BRIDGE_URL from '../bridgeUrl';
import loadMermaid, { isChunkLoadError, withMermaidTheme } from '../lib/loadMermaid';
import useTheme from '../hooks/useTheme';
import DiagramViewport from './DiagramViewport';

/**
 * ClassDiagramTab — the class structure of the analysed code, drawn from the
 * graph.
 *
 * The diagram is generated server-side (scripts/diagram/), so this component
 * only fetches and renders. The bridge returns Mermaid *and* PlantUML in one
 * response: Mermaid is what renders here, PlantUML is what round-trips back
 * through import_spec — hence both are offered for download rather than making
 * the user re-request in another format.
 */

// Der Loader liegt in ../lib/loadMermaid.js — dieselbe Quelle, aus der auch
// RosTab lädt. Zwei Ladepfade bedeuteten zwei initialize()-Aufrufe, und der
// zweite setzt Mermaids Registry zurück, während der erste noch rendert.

const PANEL = {
    height: '100%', boxSizing: 'border-box', padding: 24, overflow: 'auto',
    background: 'var(--bg, #0b0d10)', color: 'var(--text, #e4e4e7)',
};
const CONTROL = {
    padding: '6px 10px', fontSize: 12, borderRadius: 8, cursor: 'pointer',
    border: '1px solid var(--border, #2a2f37)', background: 'var(--surface, #14171c)',
    color: 'var(--text, #e4e4e7)', fontFamily: 'inherit',
};

function download(filename, text) {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}

/** One stat chip in the header row. */
function Stat({ label, value }) {
    return (
        <span style={{ fontSize: 12, color: 'var(--muted, #94a3b8)' }}>
            <strong style={{ color: 'var(--text, #e4e4e7)' }}>{value}</strong> {label}
        </span>
    );
}

/** Checkbox styled as a control chip. `onChange` receives the boolean. */
function Toggle({ checked, onChange, disabled, title, children }) {
    return (
        <label title={title} style={{ ...CONTROL, display: 'flex', alignItems: 'center', gap: 6, opacity: disabled ? 0.5 : 1 }}>
            <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
            {children}
        </label>
    );
}

export default function ClassDiagramTab({ db }) {
    const [theme] = useTheme();
    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [renderError, setRenderError] = useState(null);
    /**
     * Die Renderphase hatte bisher gar keinen Zustand.
     *
     * Es gibt ZWEI Effekte: der erste holt die Daten und schaltet `loading` —
     * der endet, sobald die Antwort da ist. Der zweite laedt Mermaid nach und
     * rendert. In diesem Fenster gilt loading=false, die Kopfzahlen kommen
     * bereits aus den NEUEN Daten, und im Container hängt noch das ALTE SVG.
     * Das sah aus wie "Zähler stimmt, Diagramm nicht" — in Wahrheit war der
     * Render nur noch nicht durch.
     */
    const [rendering, setRendering] = useState(false);
    const [pathPrefix, setPathPrefix] = useState('');
    const [appliedPrefix, setAppliedPrefix] = useState('');
    // null = let the bridge decide ('auto': switched above ~40 classes). The
    // checkbox then shows the value the bridge actually applied (data.options).
    const [onlyConnected, setOnlyConnected] = useState(null);
    const [includeUses, setIncludeUses] = useState(null);
    const [groupByDirectory, setGroupByDirectory] = useState(null);
    const [showMethods, setShowMethods] = useState(true);
    const [compact, setCompact] = useState(false);
    const [showPrivate, setShowPrivate] = useState(false);
    const [includeTests, setIncludeTests] = useState(false);
    const [showSource, setShowSource] = useState(false);
    const [sourceFormat, setSourceFormat] = useState('mermaid');
    const [svg, setSvg] = useState('');
    // Every mermaid render needs its own id; reusing one leaves the previous
    // SVG's definitions behind and arrows start pointing at stale nodes.
    const renderSeq = useRef(0);

    const query = useMemo(() => {
        const p = new URLSearchParams();
        if (db) p.set('db', db);
        if (appliedPrefix) p.set('pathPrefix', appliedPrefix);
        if (onlyConnected !== null) p.set('onlyConnected', String(onlyConnected));
        if (includeUses !== null) p.set('includeUses', String(includeUses));
        if (groupByDirectory !== null) p.set('groupByDirectory', String(groupByDirectory));
        if (!showMethods) p.set('includeMethods', 'false');
        if (compact) p.set('compact', 'true');
        if (showPrivate) p.set('memberVisibility', 'all');
        if (!includeTests) p.set('includeTests', 'false');
        return p.toString();
    }, [db, appliedPrefix, onlyConnected, includeUses, groupByDirectory, showMethods, compact, showPrivate, includeTests]);

    useEffect(() => {
        let alive = true;
        setLoading(true);
        setError(null);
        fetch(`${BRIDGE_URL}/api/diagram/class?${query}`)
            .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
            .then((d) => { if (alive) setData(d); })
            .catch((e) => { if (alive) setError(e.message); })
            .finally(() => { if (alive) setLoading(false); });
        return () => { alive = false; };
    }, [query]);

    useEffect(() => {
        if (!data || !data.mermaid) return undefined;
        let alive = true;
        setRenderError(null);
        setRendering(true);
        const id = `classdiagram-${renderSeq.current++}`;
        // Theme pro Diagramm statt global: der Loader wird mit RosTab geteilt,
        // und dessen Panel ist dunkel. Dieser Tab liegt auf hellem Grund — mit
        // dem globalen 'dark' kamen schwarze Kaesten auf Weiß heraus.
        //
        // Die Direktive wird NICHT einfach vorangestellt: der Generator liefert
        // einen Frontmatter-Block, und der zählt nur als erste Zeile. Siehe
        // withMermaidTheme — genau daran ist hier jedes Diagramm gescheitert.
        const source = withMermaidTheme(data.mermaid, theme === 'dark' ? 'dark' : 'default');
        loadMermaid()
            .then((mermaid) => mermaid.render(id, source))
            .then((out) => { if (alive) setSvg(out.svg); })
            // A mermaid parse error must not blank the tab: the source view below
            // is still useful, and the message says which line broke.
            //
            // Ein Chunk-Ladefehler ist dagegen kein Diagrammfehler, sondern ein
            // veralteter Tab — er bekommt eine eigene Anzeige mit Reload.
            .catch((e) => {
                if (!alive) return;
                setRenderError({ message: e.message || String(e), stale: isChunkLoadError(e) });
            })
            .finally(() => { if (alive) setRendering(false); });
        return () => { alive = false; };
    }, [data, theme]);

    const stats = (data && data.stats) || {};
    const applied = (data && data.options) || {};
    const empty = !loading && !error && data && stats.classes === 0;
    // Tri-state toggles: an explicit choice wins, otherwise show what 'auto' did.
    const effective = (explicit, key) => (explicit !== null ? explicit : Boolean(applied[key]));
    const autoNotes = [];
    if (applied.large) {
        if (includeUses === null && !applied.includeUses) autoNotes.push('uses arrows off');
        if (onlyConnected === null && applied.onlyConnected) autoNotes.push(`${stats.isolatedHidden || 0} unconnected classes hidden`);
        if (groupByDirectory === null && applied.groupByDirectory) autoNotes.push('grouped by folder');
        if (applied.includeUses && applied.minUseCalls > 1) autoNotes.push(`uses arrows only with ≥ ${applied.minUseCalls} calls`);
    }

    return (
        <div style={PANEL}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14, height: '100%' }}>
                <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
                    <h2 style={{ margin: 0, fontSize: 20, fontWeight: 600 }}>🧩 Class diagram</h2>
                    {/* Zahlen ausgrauen, solange das Bild sie noch nicht einholt.
                        Sonst steht ein aktueller Zaehler scharf neben einem alten
                        Diagramm und behauptet, beide gehoerten zusammen. */}
                    <div style={{
                        display: 'flex', gap: 14,
                        opacity: (loading || rendering) ? 0.45 : 1,
                        transition: 'opacity 0.15s',
                    }}>
                        <Stat label="classes" value={stats.classes ?? '–'} />
                        <Stat label="external bases" value={stats.externalBases ?? '–'} />
                        <Stat label="attributes" value={stats.attributes ?? '–'} />
                        <Stat label="inheritance" value={stats.inheritance ?? '–'} />
                        <Stat label="associations" value={stats.associations ?? '–'} />
                        <Stat label="uses" value={stats.uses ?? '–'} />
                    </div>
                </div>

                <div style={{ fontSize: 13, color: 'var(--muted, #94a3b8)' }}>
                    Generated from the code graph — no diagram file involved. Library base classes are drawn as
                    <code style={{ margin: '0 4px' }}>&lt;&lt;external&gt;&gt;</code>. A solid arrow is an
                    association — a field whose declared type is another class. A dotted arrow is
                    &ldquo;uses&rdquo;, derived from calls between the classes&rsquo; methods, and is only drawn
                    where no stronger relation already says it.
                </div>

                <form
                    onSubmit={(e) => { e.preventDefault(); setAppliedPrefix(pathPrefix.trim()); }}
                    style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}
                >
                    <input
                        value={pathPrefix}
                        onChange={(e) => setPathPrefix(e.target.value)}
                        placeholder="path prefix, e.g. src/core"
                        style={{ ...CONTROL, cursor: 'text', minWidth: 220 }}
                    />
                    <button type="submit" style={CONTROL}>Apply</button>
                    <Toggle checked={effective(onlyConnected, 'onlyConnected')} onChange={setOnlyConnected} title="Hide classes without any relation">
                        only connected
                    </Toggle>
                    <Toggle checked={effective(includeUses, 'includeUses')} onChange={setIncludeUses} title="Dotted arrows derived from method calls between classes">
                        uses
                    </Toggle>
                    <Toggle checked={effective(groupByDirectory, 'groupByDirectory')} onChange={setGroupByDirectory} title="Frame classes by directory">
                        group by folder
                    </Toggle>
                    <Toggle checked={compact} onChange={setCompact} title="Class names only, no members">
                        compact
                    </Toggle>
                    <Toggle checked={showMethods} onChange={setShowMethods} disabled={compact}>
                        methods
                    </Toggle>
                    <Toggle checked={showPrivate} onChange={setShowPrivate} disabled={compact} title="Include _private members and dunders">
                        private
                    </Toggle>
                    <Toggle checked={includeTests} onChange={setIncludeTests}>
                        tests
                    </Toggle>
                    <span style={{ flex: 1 }} />
                    <button type="button" style={CONTROL} disabled={!data} onClick={() => setShowSource((v) => !v)}>
                        {showSource ? 'Hide source' : 'Show source'}
                    </button>
                    <button type="button" style={CONTROL} disabled={!data} onClick={() => download('class-diagram.puml', data.plantuml)}>
                        Download PlantUML
                    </button>
                    <button type="button" style={CONTROL} disabled={!data} onClick={() => download('class-diagram.mmd', data.mermaid)}>
                        Download Mermaid
                    </button>
                </form>

                {(autoNotes.length > 0 || stats.usesOmitted > 0) && (
                    <div style={{ fontSize: 12, color: 'var(--muted, #94a3b8)' }}>
                        {autoNotes.length > 0 && <>Large diagram ({stats.classes} classes): {autoNotes.join(' · ')} — change it with the toggles above. </>}
                        {stats.usesOmitted > 0 && <>{stats.usesOmitted} weaker uses arrows omitted (only the {stats.uses} with the most calls are drawn).</>}
                    </div>
                )}
                {loading && <div style={{ color: 'var(--muted, #94a3b8)', fontSize: 13 }}>Loading…</div>}
                {error && <div style={{ color: '#ef4444', fontSize: 13 }}>Couldn&rsquo;t load: {error}</div>}
                {empty && (
                    <div style={{ padding: 32, textAlign: 'center', color: 'var(--muted, #94a3b8)', fontSize: 14, border: '1px dashed var(--border, #2a2f37)', borderRadius: 10 }}>
                        No classes in this graph. Either the code isn&rsquo;t class-based, the graph hasn&rsquo;t been built
                        yet (<code>codevis build</code>), or the path prefix excluded everything.
                    </div>
                )}
                {renderError && renderError.stale && (
                    <div style={{
                        display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
                        fontSize: 13, color: 'var(--text, #e4e4e7)', padding: '10px 12px',
                        border: '1px solid #38bdf8', borderRadius: 10,
                        background: 'rgba(56,189,248,0.08)',
                    }}>
                        <span>
                            The app has been rebuilt — this page is still running the old build
                            and can no longer load the diagram code.
                        </span>
                        <button
                            type="button"
                            style={{ ...CONTROL, borderColor: '#38bdf8' }}
                            onClick={() => window.location.reload()}
                        >Reload page</button>
                    </div>
                )}
                {renderError && !renderError.stale && (
                    <div style={{ color: '#f59e0b', fontSize: 13 }}>
                        Diagram couldn&rsquo;t be rendered ({renderError.message}) — the source below is still valid.
                    </div>
                )}

                <DiagramViewport
                    svg={svg}
                    resetKey={query}
                    style={{ flex: 1, minHeight: 320, border: '1px solid var(--border, #2a2f37)', borderRadius: 10, background: 'var(--surface, #14171c)' }}
                />

                {showSource && data && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        {/* Mermaid is what is drawn above; PlantUML is the
                            round-trip format for import_spec. */}
                        <div style={{ display: 'flex', gap: 6 }} role="tablist" aria-label="Source format">
                            {['mermaid', 'plantuml'].map((fmt) => (
                                <button
                                    key={fmt}
                                    type="button"
                                    role="tab"
                                    aria-selected={sourceFormat === fmt}
                                    style={{ ...CONTROL, fontWeight: sourceFormat === fmt ? 600 : 400, borderColor: sourceFormat === fmt ? 'var(--accent, #38bdf8)' : undefined }}
                                    onClick={() => setSourceFormat(fmt)}
                                >{fmt === 'mermaid' ? 'Mermaid (rendered)' : 'PlantUML'}</button>
                            ))}
                        </div>
                        <pre style={{ margin: 0, maxHeight: 300, overflow: 'auto', fontSize: 12, padding: 12, borderRadius: 10, border: '1px solid var(--border, #2a2f37)', background: 'var(--surface, #14171c)' }}>
                            {sourceFormat === 'mermaid' ? data.mermaid : data.plantuml}
                        </pre>
                    </div>
                )}
            </div>
        </div>
    );
}

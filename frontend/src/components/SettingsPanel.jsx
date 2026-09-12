import { useState, useEffect } from 'react';

import BRIDGE_URL from '../bridgeUrl';
import GraphDetailSlider from './GraphDetailSlider';
import GraphScopeError from './GraphScopeError';

/**
 * SettingsPanel — workspace, source dirs and graph rendering options.
 *
 * Lives in the right-hand tab strip. It used to be a collapsed strip in the
 * top-left HUD, where it read as a status badge rather than a control and was
 * simply not found — the tabs are where people already look for a panel.
 * Being a tab, it is always open: the collapse toggle is gone with the HUD.
 */
function SettingsPanel({ activeDb, connected, growthMode, growthSpeed, maxVisibleNodes, max3dNodes = 4000, totalNodes, dbTotal, typeCounts = {}, detailLevel, pending, scopeError, onRetryScope, freezeLayout, onConfigChange, onRefresh }) {
    // How far the number field reaches: everything this detail level COULD
    // load, which is what the bridge reports as `scope.loadable`.
    //
    // It used to be the count of nodes already loaded — and since that count is
    // itself the result of the limit, the field could only ever read "500 of
    // 500". It looked like a maxed-out setting on a project with 92 000 nodes
    // in the database. `dbTotal` is now shown next to it so the difference
    // between "this level" and "the whole graph" is visible rather than
    // guessed.
    const loadableNodes = Math.max(0, Math.floor(Number(totalNodes) || 0));
    // step MUST divide the track evenly, i.e. stay 1. A "nicer" step of
    // max/200 makes the right-hand end unreachable whenever it does not divide
    // the range: with max 2171 and step 11 the largest attainable value is
    // 2166, so the "end means All" check below never fires and the uncapped
    // state is lost again — the exact bug this panel already had once.
    const [db, setDb] = useState(activeDb);
    // Keep typing separate from applying. A controlled number input that writes
    // on every keypress cannot ever be cleared: deleting the last digit emits
    // an empty string, Number('') becomes 0, and the rendered setting instantly
    // writes a number back. Empty now deliberately means "all".
    const [budgetDraft, setBudgetDraft] = useState('');
    const [budgetDirty, setBudgetDirty] = useState(false);
    useEffect(() => {
        setBudgetDraft(Number.isFinite(maxVisibleNodes) ? String(maxVisibleNodes) : '');
        setBudgetDirty(false);
    }, [maxVisibleNodes]);

    const applyBudgetDraft = () => {
        const text = budgetDraft.trim();
        if (!text) {
            setBudgetDirty(false);
            onConfigChange?.({ maxVisibleNodes: Infinity });
            return;
        }
        const value = Number(text);
        if (!Number.isFinite(value) || value < 1) return;
        setBudgetDirty(false);
        onConfigChange?.({
            maxVisibleNodes: loadableNodes > 0 && value >= loadableNodes ? Infinity : Math.floor(value),
        });
    };
    const [loading, setLoading] = useState(false);
    const [sourceDirs, setSourceDirs] = useState([]);
    const [statusState, setStatusState] = useState(null);
    const statusReady = statusState?.db === activeDb && statusState.ready;
    const [locking, setLocking] = useState({ enabled: false, mode: 'disabled' });
    const [workMode, setWorkMode] = useState('code');
    const [databaseIdentity, setDatabaseIdentity] = useState(null);
    const [usingLegacyDataDir, setUsingLegacyDataDir] = useState(false);
    const [metaUnlockOpen, setMetaUnlockOpen] = useState(false);
    const [metaUnlockSecret, setMetaUnlockSecret] = useState('');
    const [switchError, setSwitchError] = useState('');
    // Verlangt die Bridge ein Geheimnis für den Selbst-Graphen? Nur dann, wenn
    // CODEVIS_META_UNLOCK_SECRET dort gesetzt ist — der Ausnahmefall einer
    // exponierten Bridge. Im Normalfall genügt eine Rückfrage, denn wovor hier
    // geschützt wird, ist ein Fehlklick und kein Angreifer.
    const [metaUnlockRequired, setMetaUnlockRequired] = useState(false);

    // Which directories the active graph was built from. Keyed on activeDb
    // because the two workspaces have different source dirs — switching the
    // database without refetching would leave the previous one's paths on
    // screen, which is worse than showing none.
    useEffect(() => {
        let cancelled = false;
        setStatusState(null);
        fetch(`${BRIDGE_URL}/api/status`)
            .then((res) => {
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                return res.json();
            })
            .then((data) => {
                if (cancelled) return;
                setSourceDirs(data.sourceDirs || []);
                setLocking(data.locking || { enabled: false, mode: 'disabled' });
                setWorkMode(data.workMode === 'planning' ? 'planning' : 'code');
                setDatabaseIdentity(data.databaseIdentity || null);
                setUsingLegacyDataDir(Boolean(data.usingLegacyDataDir));
                setMetaUnlockRequired(Boolean(data.metaUnlockRequired));
                setStatusState({db: activeDb, ready: true});
            })
            .catch((err) => {
                if (!cancelled) setStatusState({db: activeDb, error: err.message});
            });
        return () => { cancelled = true; };
    }, [activeDb, connected]);

    useEffect(() => {
        setDb(activeDb);
    }, [activeDb]);

    const handleSwitchDb = async (newDb, unlockSecret) => {
        setLoading(true);
        setSwitchError('');
        try {
            const res = await fetch(`${BRIDGE_URL}/api/switch-db`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ db: newDb, unlockSecret })
            });
            const data = await res.json();
            if (!res.ok || !data.ok) {
                throw new Error(data.error || `HTTP ${res.status}`);
            }
            setDb(newDb);
            setMetaUnlockOpen(false);
            setMetaUnlockSecret('');
            if (onConfigChange) onConfigChange({ activeDb: newDb });
        } catch (err) {
            console.error('[Settings] DB switch failed:', err);
            setDb(activeDb);
            setSwitchError(err.message || 'Database switch failed.');
        } finally {
            setLoading(false);
        }
    };

    const handleGrowthToggle = () => {
        if (onConfigChange) {
            onConfigChange({ growthMode: !growthMode });
        }
    };

    const dbLabel = db === 'project_db' ? 'Project' : 'CodeVis';
    const missingDirs = sourceDirs.filter((dir) => !dir.exists).length;
    const inventory = Object.entries(typeCounts)
        .filter(([, count]) => Number(count) > 0)
        .sort((a, b) => Number(b[1]) - Number(a[1]) || a[0].localeCompare(b[0]));

    return (
        <div className="settings-tab">
            <div className="settings-tab-header">
                <span className="settings-icon">⚙</span>
                <span className="settings-tab-title">Settings</span>
                <span className="settings-db-badge">{dbLabel}</span>
            </div>

            <div className="settings-body">
                    {/* DB Selector */}
                    <div className="settings-section">
                        <label className="settings-label">Database</label>
                        <div className="db-switcher">
                            <button
                                className={`db-btn ${db === 'project_db' ? 'active' : ''}`}
                                onClick={() => handleSwitchDb('project_db')}
                                disabled={loading}
                            >
                                Project
                            </button>
                            <button
                                className={`db-btn ${db === 'codevis_db' ? 'active' : ''}`}
                                onClick={() => {
                                    if (db === 'codevis_db') return;
                                    setSwitchError('');
                                    setMetaUnlockOpen(true);
                                }}
                                disabled={loading}
                            >
                                {db === 'codevis_db' ? 'CodeVis' : (metaUnlockRequired ? '🔒 CodeVis' : 'CodeVis')}
                            </button>
                        </div>
                        {/* Der Selbst-Graph ist ein Wechsel des Arbeitsgegenstands, kein
                            Berechtigungsproblem. Deshalb steht hier eine Rückfrage, die
                            SAGT, was sich ändert — und nur dann ein Passwortfeld, wenn
                            die Bridge tatsächlich ein Geheimnis verlangt. */}
                        {metaUnlockOpen && db !== 'codevis_db' && (
                            <form
                                onSubmit={(e) => {
                                    e.preventDefault();
                                    handleSwitchDb('codevis_db', metaUnlockRequired ? metaUnlockSecret : undefined);
                                }}
                                style={{ marginTop: 10 }}
                            >
                                {/* Englisch wie der Rest dieser Oberfläche. Die
                                    Kommentare im Code sind deutsch, die Beschriftungen
                                    nicht — beim ersten Entwurf hatte ich das
                                    durcheinandergebracht. */}
                                <div className="settings-source-meta" style={{ marginBottom: 6 }}>
                                    Switch to the CodeVis graph? Tasks, locks and edits will then
                                    apply to <strong>CodeVis itself</strong>, not to your project.
                                    {metaUnlockRequired && ' This bridge requires the configured unlock secret.'}
                                </div>
                                <div className="limit-row">
                                    {metaUnlockRequired && (
                                        <input
                                            type="password"
                                            className="limit-input"
                                            value={metaUnlockSecret}
                                            onChange={(e) => setMetaUnlockSecret(e.target.value)}
                                            placeholder="Unlock secret"
                                            autoFocus
                                            autoComplete="off"
                                            style={{ flex: 1 }}
                                        />
                                    )}
                                    <button
                                        type="submit"
                                        className="settings-refresh-btn"
                                        disabled={loading || (metaUnlockRequired && !metaUnlockSecret)}
                                    >
                                        {metaUnlockRequired ? 'Unlock' : 'Switch'}
                                    </button>
                                    <button
                                        type="button"
                                        className="settings-refresh-btn"
                                        onClick={() => {
                                            setMetaUnlockOpen(false);
                                            setMetaUnlockSecret('');
                                            setSwitchError('');
                                        }}
                                        disabled={loading}
                                    >
                                        Cancel
                                    </button>
                                </div>
                            </form>
                        )}
                        {/* Solange der Selbst-Graph aktiv ist, muss das sichtbar bleiben.
                            Ein Wechsel, den man nach zehn Minuten vergessen hat, ist
                            derselbe Fehler wie ein versehentlicher. */}
                        {db === 'codevis_db' && (
                            <div className="settings-source-meta" style={{ marginTop: 8 }}>
                                ⚠ Active: <strong>CodeVis self-graph</strong> — anything you create or edit
                                here affects CodeVis, not your project.
                            </div>
                        )}
                        {switchError && (
                            <div className="settings-source-meta" style={{ color: '#ef4444', marginTop: 6 }}>
                                {switchError}
                            </div>
                        )}
                    </div>

                    {!statusReady && <div className="settings-source-meta" role="status">
                        {statusState?.error ? `Workspace configuration could not be loaded: ${statusState.error}` : 'Loading workspace configuration…'}
                    </div>}
                    {statusReady && <>
                    {db === 'project_db' && (
                        <div className="settings-section">
                            <label className="settings-label">Work Mode</label>
                            <div className="settings-source-empty">
                                <strong>{workMode === 'planning' ? 'Planning' : 'Code graph'}</strong>
                                <span>
                                    {workMode === 'planning'
                                        ? ' — builds and watchers are disabled. Switch after code exists with codevis init code.'
                                        : ' — configured source files can be parsed into the project graph.'}
                                </span>
                            </div>
                        </div>
                    )}

                    {/* Source dirs of the active workspace */}
                    <div className="settings-section">
                        <label className="settings-label">Source Dirs</label>
                        {sourceDirs.length === 0 ? (
                            <div className="settings-source-empty">
                                <strong>No source directories are configured for the next build.</strong>
                                {dbTotal > 0 && (
                                    <span>
                                        {' '}The existing database still contains {Number(dbTotal).toLocaleString()} nodes
                                        from an earlier build. Configure sources with <code>codevis init</code> before rebuilding it.
                                    </span>
                                )}
                            </div>
                        ) : (
                            <div className="settings-source-list">
                                {sourceDirs.map((dir) => (
                                    <div
                                        key={dir.resolved}
                                        className={`settings-source-item ${dir.exists ? '' : 'missing'}`}
                                        title={dir.resolved}
                                    >
                                        <span className="settings-source-mark">{dir.exists ? '✓' : '✗'}</span>
                                        <span>{dir.path}</span>
                                    </div>
                                ))}
                                {missingDirs > 0 && (
                                    <div className="settings-source-meta">
                                        {missingDirs} of {sourceDirs.length} paths do not exist — the graph
                                        cannot contain what was never there to parse.
                                    </div>
                                )}
                            </div>
                        )}
                    </div>

                    {(databaseIdentity?.mismatch || !databaseIdentity?.recorded || usingLegacyDataDir) && (
                        <div className="settings-section">
                            <label className="settings-label">Database Identity</label>
                            <div className="settings-source-meta">
                                {databaseIdentity?.mismatch
                                    ? 'Blocked: this database was built from different source directories. Move it aside or restore the recorded configuration before rebuilding.'
                                    : !databaseIdentity?.recorded
                                    ? 'Unverified database: rebuild this graph once to record its project and source directories.'
                                    : null}
                                {usingLegacyDataDir
                                    ? ' Legacy storage is active because data contains an existing database. Stop CodeVis and move the database files to .codevis, or set CODEVIS_DATA_DIR explicitly.'
                                    : null}
                            </div>
                        </div>
                    )}

                    <div className="settings-section">
                        <label className="settings-label">Multi-agent Locking</label>
                        <div className="settings-source-meta">
                            <strong>{locking.enabled ? 'Enabled' : 'Disabled'}</strong>
                            {' '}— experimental node reservations are {locking.enabled ? 'enforced' : 'not created or required'}.
                            {' '}Set <code>locking.enabled</code> in <code>codevis.config.cjs</code>, then restart the dashboard and MCP client.
                        </div>
                    </div>

                    </>}
                    <div className="settings-section">
                        <label className="settings-label">Graph Inventory</label>
                        <div className="settings-inventory-summary">
                            <span><strong>{Number(dbTotal || 0).toLocaleString()}</strong> total nodes</span>
                            <span><strong>{inventory.length}</strong> node types</span>
                            <span><strong>{Number(totalNodes || 0).toLocaleString()}</strong> loadable here</span>
                        </div>
                        {inventory.length > 0 ? (
                            <div className="settings-inventory-grid">
                                {inventory.map(([label, count]) => (
                                    <div className="settings-inventory-item" key={label}>
                                        <span className="settings-inventory-label" title={label}>{label}</span>
                                        <strong>{Number(count).toLocaleString()}</strong>
                                    </div>
                                ))}
                            </div>
                        ) : (
                            <div className="settings-source-meta">No node-type census is available yet. Refresh the graph status.</div>
                        )}
                    </div>

                    {/* Graph size.
                        The old "Node Limits" block (Seeds / Functions / Modules /
                        Endpoints + Apply) used to sit here. It is gone because it
                        did nothing: loadGraphData builds its query from labels and
                        the detail level and never reads those numbers — the bridge
                        happily served 2000 nodes with "Functions: 200" on screen.
                        What actually bounds the graph is the detail level, and at
                        level 3 the node cap below. */}
                    {/* Detail level.
                        This control was removed once, on the argument that the
                        three levels only answer "how much" — which the node
                        budget answers better. That was half right: the budget
                        answers how MANY, the level answers WHICH KINDS, and no
                        budget can reach a node type the query never asks for.
                        With the level gone, variables and syntax nodes were
                        unreachable from the dashboard at all, and the ceiling on
                        the budget slider looked like a bug.
                        The two now compose: the level picks what the graph is
                        drawn from, the budget picks how much of it arrives. */}
                    <div className="settings-section">
                        <label className="settings-label">
                            Detail Level
                            {/* The first switch to level 2 or 3 reads the whole
                                syntax tree — measured at 25–29s here. Silence for
                                half a minute reads as a dead control. */}
                            {pending && (
                                <span style={{ marginLeft: 8, fontWeight: 400, opacity: 0.7 }}>
                                    loading…
                                </span>
                            )}
                        </label>
                        <GraphDetailSlider
                            level={detailLevel ?? 1}
                            onLevelChange={(lvl) => onConfigChange && onConfigChange({ detailLevel: lvl })}
                            embedded
                        />
                    </div>


                    {/* Visibility & Growth Mode */}
                    <div className="settings-section">
                        {/* The number belongs here, not only on the slider behind
                            "Filter ▼" on the canvas: this is the value you set
                            once and leave alone, and hunting for it in a popover
                            over the graph is where it kept getting lost. */}
                        <label className="settings-label">
                            Node Budget
                            {/* Holt den Stand direkt bei der Bridge. Die Zahlen
                                hier kamen bisher nur per Socket-Ereignis an, und
                                ein verlorenes oder verspaetetes Ereignis liess
                                eine Obergrenze stehen, die zur vorigen Datenbank
                                oder Detailstufe gehoerte. Der Knopf fragt nach,
                                statt zu warten. */}
                            {onRefresh && (
                                <button
                                    type="button"
                                    className="settings-refresh-btn"
                                    onClick={onRefresh}
                                    title="Re-query the numbers from the bridge"
                                >
                                    ↻ Refresh
                                </button>
                            )}
                        </label>
                        <div className="limit-row">
                            <span className="limit-name">Nodes</span>
                            <input
                                type="number"
                                className="limit-input"
                                min="1"
                                max={loadableNodes || undefined}
                                step="1"
                                placeholder="All"
                                value={budgetDraft}
                                onChange={(e) => {
                                    setBudgetDraft(e.target.value);
                                    setBudgetDirty(true);
                                }}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter') {
                                        e.preventDefault();
                                        applyBudgetDraft();
                                    }
                                }}
                            />
                            <button
                                type="button"
                                onClick={applyBudgetDraft}
                                disabled={!budgetDirty || pending}
                                style={{
                                    padding: '5px 10px', borderRadius: 6,
                                    border: '1px solid var(--border)',
                                    background: budgetDirty ? '#6366f1' : 'var(--surface)',
                                    color: budgetDirty ? '#fff' : 'var(--muted)',
                                    cursor: !budgetDirty || pending ? 'default' : 'pointer',
                                    opacity: pending ? 0.65 : 1,
                                }}
                            >
                                {pending ? 'Loading…' : budgetDirty ? 'Apply' : scopeError ? 'Not applied' : 'Applied'}
                            </button>
                            {/* The ceiling, right next to the field. A bare number
                                box showing "1360" reads as a limit you have hit,
                                not as a value you may raise — the field's `max` is
                                2918 and nothing on screen said so. The slider in
                                the canvas filter has always shown "1360 / 2918";
                                this is the same statement. */}
                            <span className="limit-name" style={{ marginLeft: 6, opacity: 0.7 }}>
                                / {loadableNodes}
                            </span>
                        </div>
                        <div className="settings-source-meta">
                            Leave the field empty for all loadable nodes. Press Enter or Apply
                            to use a typed value; the graph updates only after that confirmation.
                            {' '}
                            {Number.isFinite(maxVisibleNodes)
                                ? `Budget ${Math.min(maxVisibleNodes, loadableNodes)} of ${loadableNodes} nodes loadable at this level`
                                : `All ${loadableNodes} nodes loadable at this level`}
                            {dbTotal ? ` · ${dbTotal} in the database.` : '.'}
                            {' '}The bridge spends the budget along the edges, so a smaller
                            graph still holds together.
                        </div>

                        <GraphScopeError error={scopeError} onRetry={onRetryScope} />

                        {/* The 3D→2D switchover. It was a constant in App.jsx, so
                            the only way to see a big graph in 3D was to edit the
                            source — and the only way to find out the machine can
                            take more than 4000 was to try. Now you can try. */}
                        <div className="limit-row" style={{ marginTop: 10 }}>
                            <span className="limit-name">3D up to</span>
                            <input
                                type="number"
                                className="limit-input"
                                min="100"
                                max="100000"
                                step="500"
                                value={max3dNodes}
                                onChange={(e) => {
                                    const v = Number(e.target.value);
                                    if (Number.isFinite(v) && v >= 100) {
                                        onConfigChange && onConfigChange({ max3dNodes: v });
                                    }
                                }}
                            />
                            <span className="limit-name" style={{ marginLeft: 6, opacity: 0.7 }}>
                                nodes
                            </span>
                        </div>
                        <div className="settings-source-meta">
                            Above this the view falls back to 2D. 3D builds one mesh and one
                            label per node, so the cost is per node and the freeze is sudden —
                            4000 is where it was observed. Raise it if your machine takes more;
                            the 2D renderer stays the faster one either way.
                        </div>
                    </div>

                    <div className="settings-section">
                        {/* A "Max Visible Nodes" slider stood here, showing the
                            same value as the number field above and as the slider
                            behind "Filter ▼" — one setting, three controls, and
                            no way to tell which one was in charge. The number
                            field is the one that stays. */}

                        <label className="settings-checkbox-row" onClick={handleGrowthToggle}>
                            <span className={`checkbox-indicator ${growthMode ? 'checked' : ''}`}>
                                {growthMode ? '✓' : ''}
                            </span>
                            <span className="settings-label">Incremental Growth</span>
                        </label>

                        {/* Only meaningful while the graph is actually growing, so
                            it appears with the mode instead of sitting there inert.
                            One node per tick means 50k nodes take 83 minutes — the
                            reason this control exists at all. */}
                        {growthMode && (
                            <>
                                <div className="limit-row" style={{ marginTop: '4px', marginBottom: '6px' }}>
                                    <span className="limit-name">Growth Speed</span>
                                    <span className="limit-input" style={{ background: 'transparent', border: 'none', textAlign: 'right', padding: 0 }}>
                                        {growthSpeed}/tick
                                    </span>
                                </div>
                                <input
                                    type="range"
                                    min="1" max="200" step="1"
                                    value={growthSpeed}
                                    onChange={(e) => onConfigChange && onConfigChange({ growthSpeed: Number(e.target.value) })}
                                    className="slider speed-slider"
                                    style={{ width: '100%', marginBottom: '10px' }}
                                />
                            </>
                        )}

                        <label className="settings-checkbox-row" onClick={() => onConfigChange && onConfigChange({ freezeLayout: !freezeLayout })}>
                            <span className={`checkbox-indicator ${freezeLayout ? 'checked' : ''}`}>
                                {freezeLayout ? '✓' : ''}
                            </span>
                            <span className="settings-label">Freeze Layout (Performance)</span>
                        </label>
                    </div>
            </div>
        </div>
    );
}

export default SettingsPanel;

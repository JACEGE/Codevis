export default function GraphEmptyState({ bridgeUrl, connected, loadedEmpty, filteredEmpty, onResetFilters }) {
    const complete = connected === true && loadedEmpty;
    const filtered = complete && filteredEmpty;
    return (
        <div role="status" style={{
            position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center', gap: 10, textAlign: 'center',
            padding: 24, background: 'var(--surface, #ffffff)', color: 'var(--muted, #888)',
            zIndex: 50, pointerEvents: filtered ? 'auto' : 'none',
        }}>
            <div aria-hidden="true" style={{ fontSize: 40, opacity: 0.4 }}>
                {connected === false ? '\u{1F50C}' : complete ? '\u25CB' : '\u23F3'}
            </div>
            <div style={{ fontWeight: 600, fontSize: 15, color: 'var(--text, #1a1a1a)' }}>
                {connected === false ? 'No data / connection error'
                    : filtered ? 'All graph nodes are filtered out'
                    : complete ? 'No graph nodes to display'
                    : connected ? 'Loading graph…' : 'Connecting…'}
            </div>
            <div style={{ fontSize: 13 }}>
                {connected === false ? <>Is the bridge running on <code>{bridgeUrl}</code>?</>
                    : filtered ? 'Choose node types in Filter, or restore all types below.'
                    : complete ? 'This graph scope is empty. Check the workspace and detail level in Settings, or build the project graph with codevis build.'
                    : connected ? 'Connected — waiting for graph data from the bridge.'
                    : 'Establishing the bridge connection.'}
            </div>
            {filtered && (
                <button type="button" onClick={onResetFilters} style={{
                    padding: '7px 12px', border: '1px solid var(--border)', borderRadius: 6,
                    background: 'var(--surface-raised, var(--surface))', color: 'var(--text)',
                    cursor: 'pointer', font: 'inherit', fontWeight: 600,
                }}>Show all node types</button>
            )}
        </div>
    );
}

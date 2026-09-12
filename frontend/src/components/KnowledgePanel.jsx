import { useEffect, useMemo, useState } from 'react';
import BRIDGE_URL from '../bridgeUrl';

const KINDS = {
    knowledge: { label: 'Knowledge', icon: '📚', color: '#0f766e' },
    epics: { label: 'Epics', icon: '◈', color: '#7c3aed' },
    tasks: { label: 'Tasks', icon: '◆', color: '#4f46e5' },
};

export default function KnowledgePanel({ db, onShowNode, onInspectNode, onSelectTab }) {
    const [data, setData] = useState({ knowledge: [], epics: [], tasks: [] });
    const [enabled, setEnabled] = useState({ knowledge: true, epics: true, tasks: true });
    const [collapsed, setCollapsed] = useState({ knowledge: false, epics: false, tasks: false });
    const [query, setQuery] = useState('');
    const [sortBy, setSortBy] = useState('created-desc');
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');

    useEffect(() => {
        const ctrl = new AbortController();
        setLoading(true);
        setError('');
        fetch(`${BRIDGE_URL}/api/context?db=${encodeURIComponent(db)}`, { signal: ctrl.signal })
            .then(async (res) => {
                const body = await res.json();
                if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
                return body;
            })
            .then(setData)
            .catch((err) => { if (err.name !== 'AbortError') setError(err.message); })
            .finally(() => { if (!ctrl.signal.aborted) setLoading(false); });
        return () => ctrl.abort();
    }, [db]);

    const sections = useMemo(() => {
        const q = query.trim().toLowerCase();
        const priorityRank = { critical: 0, high: 1, medium: 2, low: 3 };
        const compare = (a, b) => {
            if (sortBy === 'created-asc') return (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0);
            if (sortBy === 'name') return String(a.name || '').localeCompare(String(b.name || ''));
            if (sortBy === 'priority') return (priorityRank[a.priority] ?? 9) - (priorityRank[b.priority] ?? 9)
                || String(a.name || '').localeCompare(String(b.name || ''));
            return (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0);
        };
        return Object.entries(KINDS).map(([kind, meta]) => ({
            kind, meta,
            items: (data[kind] || []).filter((item) => !q ||
                `${item.name || ''} ${item.taskId || ''} ${item.category || ''} ${item.content || ''} ${item.description || ''} ${item.status || ''}`
                    .toLowerCase().includes(q)).sort(compare),
        }));
    }, [data, query, sortBy]);

    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
            <div style={{ padding: 10, borderBottom: '1px solid var(--border,#ddd)' }}>
                <input aria-label="Search context" value={query} onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search knowledge, epics and tasks…"
                    style={{ width: '100%', boxSizing: 'border-box', padding: '8px 10px', border: '1px solid var(--border,#ddd)', borderRadius: 6, background: 'var(--bg,#f5f5f0)', color: 'var(--text,#222)' }} />
                <select value={sortBy} onChange={(e) => setSortBy(e.target.value)} aria-label="Sort context items"
                    style={{ width: '100%', boxSizing: 'border-box', marginTop: 7, padding: '6px 8px', border: '1px solid var(--border,#ddd)', borderRadius: 6, background: 'var(--surface,#fff)', color: 'var(--text,#222)', fontSize: 12 }}>
                    <option value="created-desc">Newest created first</option>
                    <option value="created-asc">Oldest created first</option>
                    <option value="name">Name A–Z</option>
                    <option value="priority">Priority</option>
                </select>
                <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                    {Object.entries(KINDS).map(([kind, meta]) => (
                        <button key={kind} aria-pressed={enabled[kind]} onClick={() => setEnabled((old) => ({ ...old, [kind]: !old[kind] }))}
                            style={{ padding: '4px 8px', borderRadius: 12, border: `1px solid ${meta.color}`, cursor: 'pointer', fontSize: 11, color: enabled[kind] ? '#fff' : meta.color, background: enabled[kind] ? meta.color : 'transparent' }}>
                            {meta.icon} {meta.label} ({data[kind]?.length || 0})
                        </button>
                    ))}
                </div>
            </div>
            <div style={{ flex: 1, overflow: 'auto', minHeight: 0, padding: '6px 0' }}>
                {loading && <div style={{ padding: 14, color: 'var(--muted,#888)' }}>Loading context…</div>}
                {error && <div style={{ padding: 14, color: '#b91c1c' }}>{error}</div>}
                {!loading && !error && !sections.some(({kind, items}) => enabled[kind] && items.length > 0) && (
                    <div style={{ padding: 16 }}>
                        <p>{query.trim() ? 'No results for this search in the selected categories.' : Object.values(enabled).some(Boolean) ? 'No context items yet in the selected categories.' : 'Choose a category above to show context items.'}</p>
                        {query.trim() ? <button className="ui-button" onClick={() => setQuery('')}>Clear search</button> : Object.values(enabled).some(Boolean) && <button className="ui-button" onClick={() => onSelectTab?.('kanban')}>Open Kanban to create work items</button>}
                    </div>
                )}
                {!loading && !error && sections.filter(({ kind }) => enabled[kind]).filter(({ items }) => items.length > 0).map(({ kind, meta, items }) => (
                    <section key={kind} style={{ marginBottom: 12 }}>
                        <button onClick={() => setCollapsed((old) => ({ ...old, [kind]: !old[kind] }))}
                            aria-expanded={!collapsed[kind]}
                            style={{ width: '100%', display: 'flex', justifyContent: 'space-between', padding: '8px 10px', border: '1px solid var(--border,#ddd)', borderRadius: 7, background: 'var(--surface-soft,rgba(127,127,127,.06))', cursor: 'pointer', fontSize: 12, fontWeight: 700, textTransform: 'uppercase', color: meta.color }}>
                            <span>{meta.icon} {meta.label} ({items.length})</span>
                            <span>{collapsed[kind] ? '▸' : '▾'}</span>
                        </button>
                        {!collapsed[kind] && items.map((item) => (
                            <div key={item.id} style={{ padding: '7px 10px', borderBottom: '1px solid var(--border,#eee)', display: 'grid', gridTemplateColumns: '1fr auto', gap: 8, alignItems: 'center' }}>
                                <button onClick={() => onInspectNode?.(item.id)} title="Open in Inspector"
                                    style={{ minWidth: 0, border: 0, padding: 0, background: 'transparent', textAlign: 'left', cursor: 'pointer', color: 'var(--text,#222)' }}>
                                    <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12.5, fontWeight: 600 }}>{item.name}</div>
                                    <div style={{ fontSize: 10.5, color: 'var(--muted,#888)', marginTop: 2 }}>{item.taskId || item.category || item.status || meta.label}</div>
                                </button>
                                <button onClick={() => onShowNode?.(item.id, kind === 'epics' ? 2 : 1)}
                                    style={{ border: `1px solid ${meta.color}`, color: meta.color, background: 'transparent', borderRadius: 5, padding: '4px 7px', cursor: 'pointer', fontSize: 11 }}>
                                    Show in graph
                                </button>
                            </div>
                        ))}
                    </section>
                ))}
            </div>
        </div>
    );
}

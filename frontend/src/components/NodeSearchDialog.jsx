import { useEffect, useRef, useState } from 'react';
import BRIDGE_URL from '../bridgeUrl';
import { requestJson } from '../api/http';

export default function NodeSearchDialog({ db, onClose, onSelect }) {
    const dialog = useRef(null);
    const [query, setQuery] = useState('');
    const [result, setResult] = useState(null);
    const [error, setError] = useState(null);
    const [loading, setLoading] = useState(false);
    const [retry, setRetry] = useState(0);

    useEffect(() => {
        const element = dialog.current;
        element.showModal();
        element.querySelector('input')?.focus();
        return () => element.close();
    }, []);

    useEffect(() => {
        let active = true;
        const controller = new AbortController();
        setResult(null);
        setError(null);
        setLoading(Boolean(query.trim()));
        if (!query.trim()) return () => { active = false; };
        const timer = setTimeout(async () => {
            try {
                const data = await requestJson(`${BRIDGE_URL}/api/nodes/search?db=${encodeURIComponent(db)}&q=${encodeURIComponent(query.trim())}`, {
                    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
                });
                if (active) setResult(data);
            } catch (err) {
                if (active) setError(err.status === 404
                    ? 'Search is unavailable on this server (HTTP 404). If CodeVis was updated, stop and restart its dashboard server, then retry. Reloading the page alone does not update the server.'
                    : err.name === 'TimeoutError' ? 'Search timed out. Try a more specific name or retry.' : `Search failed: ${err.message}`);
            } finally {
                if (active) setLoading(false);
            }
        }, 250);
        return () => { active = false; clearTimeout(timer); controller.abort(); };
    }, [db, query, retry]);

    return (
        <dialog ref={dialog} className="node-search-dialog" aria-labelledby="node-search-title" onCancel={onClose}>
            <div className="node-search-heading">
                <h2 id="node-search-title">Find code and work</h2>
                <button type="button" className="ui-button" onClick={onClose}>Close</button>
            </div>
            <p>Search files, functions, classes, modules, endpoints, tasks, epics and knowledge in {db}. Results include items outside the visible graph.</p>
            <label htmlFor="node-search-input">Name or file path</label>
            <input id="node-search-input" autoFocus type="search" maxLength={200} value={query}
                placeholder="For example: renderText or frontend/src"
                onChange={event => setQuery(event.target.value)}
                onKeyDown={event => {
                    if (event.key === 'Enter' && result?.items.length === 1) onSelect(result.items[0].id);
                    if (event.key === 'ArrowDown') dialog.current.querySelector('.node-search-result')?.focus();
                }} />
            <div role="status" className="node-search-status">
                {loading ? 'Searching…' : error || (result ? result.items.length ? `${result.items.length} result${result.items.length === 1 ? '' : 's'}${result.hasMore ? ' shown — refine your search to see more.' : ''}` : 'No matches. Try a shorter name or a different path.' : 'Type a name or path to get started.')}
            </div>
            {error && <button className="ui-button" onClick={() => setRetry(value => value + 1)}>Retry search</button>}
            <ul className="node-search-results" aria-label="Search results">
                {result?.items.map(item => <li key={item.id}>
                    <button className="node-search-result" onClick={() => onSelect(item.id)}>
                        <span className="node-search-result-heading"><strong>{item.name}</strong><span>{item.labels.join(', ')}</span></span>
                        {item.file && <span className="node-search-path">{item.file}{item.startLine ? `:${item.startLine}` : ''}</span>}
                    </button>
                </li>)}
            </ul>
        </dialog>
    );
}

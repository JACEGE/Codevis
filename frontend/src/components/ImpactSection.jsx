import { useEffect, useRef, useState } from 'react';
import BRIDGE_URL from '../bridgeUrl';

const confidenceColor = { exact: 'var(--success, #047857)', likely: 'var(--accent)', possible: 'var(--warning, #b45309)', unknown: 'var(--muted)' };

function Item({ node, suffix }) {
    return (
        <div style={{ padding: '5px 0', borderBottom: '1px solid var(--border,#eee)', fontSize: 11 }}>
            <div style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}>
                {node.confidence && <span style={{ color: confidenceColor[node.confidence], fontWeight: 700 }} title="Confidence that this item is affected in the current code">{node.confidence === 'unknown' ? 'Unverified' : node.confidence}</span>}
                <span style={{ fontWeight: 600 }}>{node.name}</span>
                {suffix && <span style={{ color: 'var(--muted,#888)' }}>{suffix}</span>}
            </div>
            {node.file && <div style={{ color: 'var(--muted,#888)', marginTop: 2 }}>{node.file}{node.startLine ? `:${node.startLine}` : ''}</div>}
        </div>
    );
}

export default function ImpactSection({ nodeId, db }) {
    const [result, setResult] = useState(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const [profile, setProfile] = useState('balanced');
    const requestId = useRef(0);
    useEffect(() => {
        setResult(null); setError(null); setLoading(false);
        return () => { requestId.current++; };
    }, [nodeId, db]);

    const load = async () => {
        const current = ++requestId.current;
        setLoading(true); setError(null);
        try {
            const response = await fetch(`${BRIDGE_URL}/api/impact`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ nodeId, db, profile }),
                signal: AbortSignal.timeout(60000),
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
            if (current === requestId.current) setResult(data);
        } catch (err) { if (current === requestId.current) setError(String(err.message || err)); }
        finally { if (current === requestId.current) setLoading(false); }
    };

    if (!result) return (
        <div className="inspector-section">
            <div className="impact-profile-row">
                {['fast', 'balanced', 'deep'].map(name => <button className={`impact-profile-btn${profile === name ? ' active' : ''}`} key={name} onClick={() => setProfile(name)}>{name}</button>)}
            </div>
            <button className="inspector-action-btn" onClick={load} disabled={loading}>
                {loading ? 'Analyzing impact…' : 'Analyze impact'}
            </button>
            {error && <div style={{ color: '#dc2626', fontSize: 11, marginTop: 6 }}>{error}</div>}
        </div>
    );

    const stale = result.graphFreshness?.state !== 'current';
    return (
        <div className="inspector-section">
            <div className="impact-profile-row">
                {['fast', 'balanced', 'deep'].map(name => <button className={`impact-profile-btn${profile === name ? ' active' : ''}`} key={name} onClick={() => { setProfile(name); setResult(null); }}>{name}</button>)}
            </div>
            <h3 className="inspector-heading">Impact · {result.profile} <span className="inspector-count">{result.impacted.length}</span></h3>
            {stale && <p className="impact-freshness">{result.graphFreshness?.state === 'stale' ? 'The saved graph is behind the source code.' : 'Graph freshness could not be verified.'} Affected items are marked Unverified. Check the current code before acting on these results.</p>}
            {result.truncation?.truncated && <div style={{ color: '#b45309', fontSize: 11, marginBottom: 7 }}>Result truncated: {result.truncation.omittedNodes} nodes omitted.</div>}
            {result.analysisQuality && <details className="impact-evidence">
                <summary>Evidence in the saved graph</summary>
                <p>Relationship evidence: {result.analysisQuality.confidence.exact} exact · {result.analysisQuality.confidence.likely} likely · {result.analysisQuality.confidence.possible} possible · {result.analysisQuality.confidence.unknown} unknown.</p>
                <p>These counts describe parsed connections, not confidence in the current code. An exact connection can still be out of date. Static analysis can miss runtime calls.</p>
            </details>}
            {error && <p role="alert">Could not refresh impact: {error}</p>}
            {result.impacted.slice(0, 20).map(node => <Item key={node.id} node={node} suffix={`${node.distance} hop${node.distance === 1 ? '' : 's'}`} />)}
            {result.impacted.length > 20 && <div style={{ fontSize: 11, marginTop: 5 }}>… {result.impacted.length - 20} more</div>}
            <h3 className="inspector-heading" style={{ marginTop: 12 }}>Tests <span className="inspector-count">{result.testSelection?.selected?.length || 0}</span></h3>
            {(result.testSelection?.selected || []).map(node => <Item key={node.id} node={node} />)}
            {!result.testSelection?.selected?.length && <div style={{ fontSize: 11, color: 'var(--muted,#888)' }}>{result.testSelection?.note}</div>}
            <h3 className="inspector-heading" style={{ marginTop: 12 }}>Knowledge to review <span className="inspector-count">{result.knowledgeReview?.candidates?.length || 0}</span></h3>
            {(result.knowledgeReview?.candidates || []).map(node => <Item key={node.id} node={node} />)}
            <button onClick={load} disabled={loading} style={{ marginTop: 10, fontSize: 10, border: 0, background: 'transparent', color: 'var(--muted,#888)', cursor: 'pointer' }}>refresh impact</button>
        </div>
    );
}

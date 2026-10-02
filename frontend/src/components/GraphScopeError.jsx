export default function GraphScopeError({ error, onRetry }) {
    if (!error) return null;
    return (
        <div role="alert" style={{ padding: '8px 12px', border: "1px solid var(--danger)", borderRadius: 6,
            background: "var(--surface)", color: 'var(--text)', fontSize: 12 }}>
            {error} The last loaded graph is still shown.{' '}
            <button type="button" onClick={onRetry}>Retry graph update</button>
        </div>
    );
}

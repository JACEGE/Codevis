export default function GraphScopeError({ error, onRetry }) {
    if (!error) return null;
    return (
        <div role="alert" style={{ padding: '8px 12px', border: '1px solid #ef4444', borderRadius: 6,
            background: 'var(--surface, #fff)', color: 'var(--text)', fontSize: 12 }}>
            {error} The last loaded graph is still shown.{' '}
            <button type="button" onClick={onRetry}>Retry graph update</button>
        </div>
    );
}

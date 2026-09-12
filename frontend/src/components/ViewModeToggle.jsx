const ViewModeToggle = ({ viewMode, onChange }) => {
    const containerStyle = {
        display: 'inline-flex',
        alignItems: 'center',
        border: '1px solid var(--border)',
        borderRadius: '6px',
        overflow: 'hidden',
        background: 'var(--surface)',
        boxShadow: '0 4px 14px var(--shadow)',
    };

    const baseButtonStyle = {
        padding: '5px 14px',
        fontSize: '12px',
        fontWeight: '600',
        fontFamily: 'inherit',
        cursor: 'pointer',
        border: 'none',
        transition: 'background 0.15s, color 0.15s',
        letterSpacing: '0.02em',
    };

    const activeStyle = {
        ...baseButtonStyle,
        background: 'var(--accent-strong)',
        color: '#ffffff',
    };

    const inactiveStyle = {
        ...baseButtonStyle,
        background: 'var(--surface)',
        color: 'var(--muted)',
    };

    return (
        <div style={containerStyle}>
            <button
                type="button" aria-pressed={viewMode === '2d'}
                style={viewMode === '2d' ? activeStyle : inactiveStyle}
                onClick={() => onChange && onChange('2d')}
                title="2D view (faster)"
            >
                2D
            </button>
            <button
                type="button" aria-pressed={viewMode === '3d'}
                style={viewMode === '3d' ? activeStyle : inactiveStyle}
                onClick={() => onChange && onChange('3d')}
                title="3D view"
            >
                3D
            </button>
        </div>
    );
};

export default ViewModeToggle;

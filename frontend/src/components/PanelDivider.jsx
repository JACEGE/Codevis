export default function PanelDivider({ axis = 'vertical', value, onChange, onDrag, dragging, defaultValue = 0.75 }) {
    const horizontal = axis === 'horizontal';
    return <div className={horizontal ? 'graph-divider' : 'split-handle'}
        role="separator" tabIndex={0} aria-orientation={horizontal ? 'vertical' : 'horizontal'}
        aria-label={horizontal ? 'Resize graph and work panel' : 'Resize panel and terminal'}
        aria-valuemin={10} aria-valuemax={90} aria-valuenow={Math.round(value * 100)}
        data-dragging={dragging || undefined}
        onPointerDown={() => onDrag(true)}
        onDoubleClick={() => { onDrag(false); onChange(defaultValue); }}
        onKeyDown={event => {
            const decrease = horizontal ? 'ArrowLeft' : 'ArrowUp';
            const increase = horizontal ? 'ArrowRight' : 'ArrowDown';
            if (event.key === decrease || event.key === increase) {
                event.preventDefault();
                onChange(Math.max(0.1, Math.min(0.9, value + (event.key === decrease ? -0.02 : 0.02))));
            }
            if (event.key === 'Home') { event.preventDefault(); onChange(defaultValue); }
        }} title="Drag or use arrow keys to resize · double-click to reset">
        <span aria-hidden="true">{horizontal ? '⋮' : '···'}</span>
    </div>;
}

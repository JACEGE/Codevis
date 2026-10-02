const ViewModeToggle = ({ viewMode, onChange }) => {
    return (
        <div className="ui-segmented" role="group" aria-label="Graph dimensions">
            <button
                type="button" aria-pressed={viewMode === '2d'}
                className="ui-button"
                onClick={() => onChange && onChange('2d')}
                title="2D view (faster)"
            >
                2D
            </button>
            <button
                type="button" aria-pressed={viewMode === '3d'}
                className="ui-button"
                onClick={() => onChange && onChange('3d')}
                title="3D view"
            >
                3D
            </button>
        </div>
    );
};

export default ViewModeToggle;

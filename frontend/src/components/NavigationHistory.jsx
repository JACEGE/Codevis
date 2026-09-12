export default function NavigationHistory({ canGoBack = false, canGoForward = false, goBack, goForward }) {
    return (
        <div className="navigation-history" role="group" aria-label="Navigation history">
            <button type="button" className="ui-button" aria-label="Go back" title="Previous selection or tab"
                disabled={!canGoBack} onClick={goBack}>
                <span aria-hidden="true">←</span> Back
            </button>
            <button type="button" className="ui-button" aria-label="Go forward" title="Next selection or tab"
                disabled={!canGoForward} onClick={goForward}>
                Forward <span aria-hidden="true">→</span>
            </button>
        </div>
    );
}

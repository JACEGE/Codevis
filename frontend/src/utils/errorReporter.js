/**
 * Global Error Reporter
 * Catches unhandled errors and promises, extracts stack trace hints,
 * and sends them to the bridge server, which tags the offending node in the
 * code graph. The bridge URL is always passed in (see src/bridgeUrl.js) — there
 * is no safe default, since a wrong one reports into another project's graph.
 */

function setupErrorReporter(bridgeUrl) {
    // 1. Catch synchronous runtime errors
    window.addEventListener('error', (event) => {
        const errorMsg = event.error ? event.error.message : event.message;
        const stack = event.error ? event.error.stack : '';
        reportErrorToBridge(errorMsg, stack, bridgeUrl);
    });

    // 2. Catch asynchronous promise rejections
    window.addEventListener('unhandledrejection', (event) => {
        const reason = event.reason;
        const errorMsg = reason instanceof Error ? reason.message : String(reason);
        const stack = reason instanceof Error ? reason.stack : '';
        reportErrorToBridge(`Unhandled Promise: ${errorMsg}`, stack, bridgeUrl);
    });
}

function reportErrorToBridge(message, stack, bridgeUrl) {
    if (!message) return;

    // Fire and forget via fetch
    fetch(`${bridgeUrl}/api/report-error`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, stack })
    }).catch(err => {
        // Silently fail if bridge is down to not cause a loop
        console.warn('[ErrorReporter] Failed to send error to bridge', err);
    });
}

export default setupErrorReporter;

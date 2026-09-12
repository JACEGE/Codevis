const HISTORY_LIMIT = 100;

export function createHistory(workspace, location) {
    return { workspace, entries: [{ ...location }], index: 0 };
}

export function recordLocation(history, location) {
    const current = history.entries[history.index];
    if (current.tab === location.tab && current.nodeId === location.nodeId && current.layout === location.layout) return history;
    const entries = [...history.entries.slice(0, history.index + 1), { ...location }].slice(-HISTORY_LIMIT);
    return { ...history, entries, index: entries.length - 1 };
}

export function moveHistory(history, direction) {
    const index = Math.max(0, Math.min(history.entries.length - 1, history.index + direction));
    return index === history.index ? history : { ...history, index };
}

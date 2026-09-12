import { useCallback, useEffect, useRef, useState } from 'react';
import { createHistory, moveHistory, recordLocation } from '../navigation/historyModel.js';

export default function useNavigationHistory({ workspace, tab, nodeId, layout, onRestore }) {
    const [history, setHistory] = useState(() => createHistory(workspace, { tab, nodeId, layout }));
    const current = useRef(history);

    // Observe the final rendered destination so a single action that selects a
    // node AND opens Inspector creates one entry, including React batched updates.
    useEffect(() => {
        const previous = current.current;
        const next = previous.workspace === workspace
            ? recordLocation(previous, { tab, nodeId, layout })
            : createHistory(workspace, { tab, nodeId: null, layout });
        current.current = next;
        if (next !== previous) setHistory(next);
    }, [workspace, tab, nodeId, layout]);

    const go = useCallback(direction => {
        const previous = current.current;
        if (previous.workspace !== workspace) return;
        const next = moveHistory(previous, direction);
        if (next === previous) return;
        current.current = next;
        setHistory(next);
        onRestore(next.entries[next.index]);
    }, [workspace, onRestore]);

    return {
        canGoBack: history.workspace === workspace && history.index > 0,
        canGoForward: history.workspace === workspace && history.index < history.entries.length - 1,
        goBack: useCallback(() => go(-1), [go]),
        goForward: useCallback(() => go(1), [go]),
    };
}

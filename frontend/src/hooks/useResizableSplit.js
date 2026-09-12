import { useEffect, useRef, useState } from 'react';

import useStoredState from './useStoredState';
import { clampSplit, parseSplit } from '../layout/splitModel';

export default function useResizableSplit({ axis = 'vertical', storageKey = 'codevis.rightSplit', defaultSplit = 0.75, containerRef: externalRef } = {}) {
    const [split, setSplit] = useStoredState(storageKey, defaultSplit, parseSplit);
    const [dragging, setDragging] = useState(false);
    const ownRef = useRef(null);
    const containerRef = externalRef || ownRef;

    useEffect(() => {
        if (!dragging) return undefined;
        const statusBarHeight = 32;
        const handleHeight = 6;
        const onMove = (event) => {
            const box = containerRef.current?.getBoundingClientRect();
            if (!box) return;
            if (axis === 'horizontal') {
                setSplit(clampSplit((event.clientX - box.left - handleHeight / 2) / (box.width - handleHeight)));
                return;
            }
            const headerHeight = containerRef.current.querySelector('.workspace-header')?.getBoundingClientRect().height || 0;
            const usableHeight = box.height - headerHeight - statusBarHeight - handleHeight;
            if (usableHeight <= 0) return;
            const fraction = (event.clientY - box.top - headerHeight - handleHeight / 2) / usableHeight;
            setSplit(clampSplit(fraction));
        };
        const onUp = () => setDragging(false);
        const previousUserSelect = document.body.style.userSelect;
        const previousCursor = document.body.style.cursor;
        document.body.style.userSelect = 'none';
        document.body.style.cursor = axis === 'horizontal' ? 'col-resize' : 'row-resize';
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onUp);
        return () => {
            document.body.style.userSelect = previousUserSelect;
            document.body.style.cursor = previousCursor;
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            window.removeEventListener('pointercancel', onUp);
        };
    }, [dragging, setSplit, axis, containerRef]);

    return { split, setSplit, dragging, setDragging, containerRef };
}

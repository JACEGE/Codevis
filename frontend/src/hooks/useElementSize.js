import { useLayoutEffect, useState } from 'react';

export default function useElementSize(ref) {
    const [size, setSize] = useState({ width: 0, height: 0 });
    useLayoutEffect(() => {
        const element = ref.current;
        if (!element) return undefined;
        const measure = () => {
            const width = Math.floor(element.clientWidth);
            const height = Math.floor(element.clientHeight);
            // Keep the canvas mounted at its last size while the panel is hidden.
            if (!width || !height) return;
            setSize(previous => previous.width === width && previous.height === height
                ? previous : { width, height });
        };
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(element);
        return () => observer.disconnect();
    }, [ref]);
    return size;
}

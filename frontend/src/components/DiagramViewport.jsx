import { controlStyle } from '../theme/tokens';
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

/**
 * DiagramViewport — pan/zoom for a rendered SVG string (Mermaid output).
 *
 * Why not just widen the wrapper: Mermaid's class renderer writes
 * `width="100%"` plus `style="max-width: <natural>px"` onto the SVG (it reads
 * the `state` config, so `class.useMaxWidth:false` is ignored). The SVG can
 * then never grow past its natural size, and a 20 000 px diagram "zoomed" to
 * 400 % of a narrow panel still showed ~20 % of real text size.
 *
 * So the SVG is pinned to its natural size (from the viewBox) and the view is
 * a CSS transform on a wrapper: wheel zooms around the cursor, drag pans, two
 * fingers pinch-zoom (pointer events, so it works on phones too), and the
 * buttons offer −, +, Fit and 1:1. No dependency: a few pointer handlers are
 * less code than configuring a pan/zoom library around a foreign SVG.
 */

const BUTTON = { ...controlStyle, minWidth: 'var(--control-height)' };
const FIT_PADDING = 16;

/** Natural size of a Mermaid SVG, preferring the viewBox over attributes. */
function naturalSize(svg) {
    const vb = svg.viewBox && svg.viewBox.baseVal;
    if (vb && vb.width > 0 && vb.height > 0) return { w: vb.width, h: vb.height };
    const attr = (svg.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number);
    if (attr.length === 4 && attr[2] > 0 && attr[3] > 0) return { w: attr[2], h: attr[3] };
    try {
        const box = svg.getBBox();
        if (box.width > 0 && box.height > 0) return { w: box.width, h: box.height };
    } catch { /* not rendered yet */ }
    return { w: 800, h: 600 };
}

/** Scale limits: at least 400 % real size, and always 8x beyond "fit". */
export function scaleLimits(fitScale) {
    const fit = fitScale > 0 ? fitScale : 1;
    return { min: Math.min(fit, 1) * 0.5, max: Math.max(4, fit * 8) };
}

/** Zoom by `factor` keeping the content point under (px, py) fixed. */
export function zoomAround(view, factor, px, py, limits) {
    const scale = Math.min(limits.max, Math.max(limits.min, view.scale * factor));
    const k = scale / view.scale;
    return { scale, x: px - (px - view.x) * k, y: py - (py - view.y) * k };
}

export default function DiagramViewport({ svg, style, resetKey }) {
    const outerRef = useRef(null);
    const innerRef = useRef(null);
    const view = useRef({ scale: 1, x: 0, y: 0 });
    const size = useRef({ w: 0, h: 0 });
    const fitScale = useRef(1);
    // Until the user pans or zooms, the view follows the panel size.
    const userMoved = useRef(false);
    const pointers = useRef(new Map());
    const gesture = useRef(null);
    const [pct, setPct] = useState(100);

    const apply = useCallback(() => {
        const inner = innerRef.current;
        if (!inner) return;
        const { scale, x, y } = view.current;
        inner.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
        setPct(Math.round(scale * 100));
    }, []);

    const limits = () => scaleLimits(fitScale.current);

    const fit = useCallback(() => {
        const outer = outerRef.current;
        const { w, h } = size.current;
        if (!outer || !w || !h) return;
        const cw = Math.max(1, outer.clientWidth - FIT_PADDING * 2);
        const ch = Math.max(1, outer.clientHeight - FIT_PADDING * 2);
        const scale = Math.min(cw / w, ch / h);
        fitScale.current = scale;
        view.current = {
            scale,
            x: (outer.clientWidth - w * scale) / 2,
            y: Math.max(FIT_PADDING, (outer.clientHeight - h * scale) / 2),
        };
        userMoved.current = false;
        apply();
    }, [apply]);

    /** 1:1 — real text size, centred on the current view centre. */
    const actualSize = useCallback(() => {
        const outer = outerRef.current;
        if (!outer) return;
        const cx = outer.clientWidth / 2;
        const cy = outer.clientHeight / 2;
        view.current = zoomAround(view.current, 1 / view.current.scale, cx, cy, { min: 0, max: Infinity });
        userMoved.current = true;
        apply();
    }, [apply]);

    const zoomBy = useCallback((factor, px, py) => {
        const outer = outerRef.current;
        if (!outer) return;
        const x = px ?? outer.clientWidth / 2;
        const y = py ?? outer.clientHeight / 2;
        view.current = zoomAround(view.current, factor, x, y, scaleLimits(fitScale.current));
        userMoved.current = true;
        apply();
    }, [apply]);

    // Insert and normalise the SVG. Layout effect: the fit must happen before
    // paint, or the unscaled 20 000 px SVG flashes for a frame.
    useLayoutEffect(() => {
        const inner = innerRef.current;
        if (!inner) return;
        inner.innerHTML = svg || '';
        const el = inner.querySelector('svg');
        if (!el) { size.current = { w: 0, h: 0 }; return; }
        const { w, h } = naturalSize(el);
        el.removeAttribute('width');
        el.removeAttribute('height');
        el.style.removeProperty('max-width');
        el.style.removeProperty('width');
        el.style.removeProperty('height');
        el.setAttribute('width', String(w));
        el.setAttribute('height', String(h));
        el.style.display = 'block';
        el.style.maxWidth = 'none';
        size.current = { w, h };
        // A re-render of the same diagram (theme switch) keeps the user's view.
        if (!userMoved.current) fit();
    }, [svg, fit]);

    // A new diagram (different filters) starts fitted again.
    useEffect(() => { userMoved.current = false; fit(); }, [resetKey, fit]);

    // Follow panel resizes while the user has not taken over the view.
    useEffect(() => {
        const outer = outerRef.current;
        if (!outer || typeof ResizeObserver === 'undefined') return undefined;
        const ro = new ResizeObserver(() => { if (!userMoved.current) fit(); });
        ro.observe(outer);
        return () => ro.disconnect();
    }, [fit]);

    // Wheel must be non-passive to stop the page from scrolling; React's
    // onWheel is registered passive, hence the manual listener.
    useEffect(() => {
        const outer = outerRef.current;
        if (!outer) return undefined;
        const onWheel = (e) => {
            e.preventDefault();
            const rect = outer.getBoundingClientRect();
            const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? rect.height : 1;
            // Trackpad pinch arrives as ctrl+wheel with small deltas; scale it up.
            const k = e.ctrlKey ? 0.01 : 0.0015;
            const factor = Math.exp(-e.deltaY * unit * k);
            zoomBy(factor, e.clientX - rect.left, e.clientY - rect.top);
        };
        outer.addEventListener('wheel', onWheel, { passive: false });
        return () => outer.removeEventListener('wheel', onWheel);
    }, [zoomBy]);

    const localPoint = (e) => {
        const rect = outerRef.current.getBoundingClientRect();
        return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };

    const startGesture = () => {
        const pts = [...pointers.current.values()];
        if (pts.length >= 2) {
            const [a, b] = pts;
            gesture.current = {
                kind: 'pinch',
                dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
                mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
            };
        } else if (pts.length === 1) {
            gesture.current = { kind: 'pan', last: pts[0] };
        } else {
            gesture.current = null;
        }
    };

    const onPointerDown = (e) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        if (e.target.closest && e.target.closest('button')) return;
        outerRef.current.setPointerCapture?.(e.pointerId);
        pointers.current.set(e.pointerId, localPoint(e));
        startGesture();
    };

    const onPointerMove = (e) => {
        if (!pointers.current.has(e.pointerId)) return;
        pointers.current.set(e.pointerId, localPoint(e));
        const g = gesture.current;
        if (!g) return;
        const pts = [...pointers.current.values()];
        if (g.kind === 'pan' && pts.length === 1) {
            const p = pts[0];
            view.current = { ...view.current, x: view.current.x + p.x - g.last.x, y: view.current.y + p.y - g.last.y };
            g.last = p;
        } else if (g.kind === 'pinch' && pts.length >= 2) {
            const [a, b] = pts;
            const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
            const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
            const zoomed = zoomAround(view.current, dist / g.dist, g.mid.x, g.mid.y, limits());
            view.current = { ...zoomed, x: zoomed.x + mid.x - g.mid.x, y: zoomed.y + mid.y - g.mid.y };
            g.dist = dist;
            g.mid = mid;
        } else {
            return;
        }
        userMoved.current = true;
        apply();
    };

    const onPointerEnd = (e) => {
        if (!pointers.current.delete(e.pointerId)) return;
        startGesture();
    };

    const onDoubleClick = (e) => {
        if (e.target.closest && e.target.closest('button')) return;
        const p = localPoint(e);
        zoomBy(e.shiftKey ? 0.5 : 2, p.x, p.y);
    };

    return (
        <div
            ref={outerRef}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerEnd}
            onPointerCancel={onPointerEnd}
            onDoubleClick={onDoubleClick}
            style={{
                position: 'relative', overflow: 'hidden', touchAction: 'none',
                userSelect: 'none', WebkitUserSelect: 'none', cursor: 'grab',
                ...style,
            }}
        >
            <div
                ref={innerRef}
                style={{ position: 'absolute', left: 0, top: 0, transformOrigin: '0 0' }}
            />
            <div
                aria-label="Diagram zoom"
                style={{
                    position: 'absolute', right: 8, bottom: 8, display: 'flex', gap: 4,
                    padding: 4, borderRadius: 10, background: "var(--bg)",
                    border: "1px solid var(--border)", opacity: 0.95,
                }}
            >
                <button type="button" style={BUTTON} title="Zoom out" onClick={() => zoomBy(1 / 1.25)}>−</button>
                <span style={{ ...BUTTON, cursor: 'default', minWidth: 52, textAlign: 'center' }}>{pct}%</span>
                <button type="button" style={BUTTON} title="Zoom in" onClick={() => zoomBy(1.25)}>+</button>
                <button type="button" style={BUTTON} title="Fit diagram to panel" onClick={fit}>Fit</button>
                <button type="button" style={BUTTON} title="Actual size (100 % text)" onClick={actualSize}>1:1</button>
            </div>
        </div>
    );
}

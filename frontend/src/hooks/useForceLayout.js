import { useEffect, useRef } from 'react';
import { cameraFrame, forceParameters, shouldResetCamera } from '../graph/forceLayoutModel.js';

export default function useForceLayout({ graphRef, graphData, nodeCount, viewMode, nodeBaseSize, active = true, frozen = false, ready = true }) {
    const rafRef = useRef(0);
    const pendingBufferRef = useRef(null);
    const appliedFramesRef = useRef(0);
    const fitStageRef = useRef(0);
    const lastFitNodeCountRef = useRef(-1);
    const workerRef = useRef(null);
    const drainRef = useRef(null);
    const activityRef = useRef({ active, frozen });
    activityRef.current = { active, frozen };

    useEffect(() => {
        if (!ready || !graphRef.current || !graphData?.nodes?.length) return;
        const forceGraph = graphRef.current;
        if (shouldResetCamera(lastFitNodeCountRef.current, nodeCount)) {
            fitStageRef.current = 0;
            appliedFramesRef.current = 0;
        }
        lastFitNodeCountRef.current = nodeCount;

        try { forceGraph.d3Force('charge')?.strength(0); } catch (_) {}
        try { forceGraph.d3Force('link')?.strength(0); } catch (_) {}
        try { forceGraph.d3Force('center')?.strength?.(0); } catch (_) {}

        const worker = new Worker(new URL('../utils/forceWorker.js', import.meta.url), { type: 'module' });
        workerRef.current = worker;
        const initialNodes = graphData.nodes.map((node) => ({
            id: node.id,
            x: node.x ?? (Math.random() - 0.5) * 200,
            y: node.y ?? (Math.random() - 0.5) * 200,
            z: node.z ?? (Math.random() - 0.5) * 200,
        }));
        const initialLinks = graphData.links.map((link) => ({
            source: link.source?.id ?? link.source,
            target: link.target?.id ?? link.target,
        }));
        worker.postMessage({
            type: 'init', nodes: initialNodes, links: initialLinks,
            ...forceParameters(nodeCount, viewMode, nodeBaseSize),
            paused: !activityRef.current.active || activityRef.current.frozen,
        });
        worker.onmessage = ({ data }) => {
            if (data.type === 'positions') pendingBufferRef.current = new Float32Array(data.buffer);
        };

        const nodesById = new Map(graphData.nodes.map((node) => [node.id, node]));
        const linkedIds = new Set();
        for (const link of initialLinks) {
            linkedIds.add(link.source);
            linkedIds.add(link.target);
        }
        const frameIds = linkedIds.size >= 10
            ? linkedIds
            : new Set(initialNodes.map((node) => node.id));

        const drainAndApply = () => {
            rafRef.current = 0;
            if (!activityRef.current.active) return;
            const buffer = pendingBufferRef.current;
            if (buffer) {
                pendingBufferRef.current = null;
                let offset = 0;
                let applied = 0;
                for (const initialNode of initialNodes) {
                    const node = nodesById.get(initialNode.id);
                    if (node) {
                        node.x = buffer[offset];
                        node.y = buffer[offset + 1];
                        node.z = buffer[offset + 2];
                        applied++;
                    }
                    offset += 3;
                }
                appliedFramesRef.current += 1;
                const shouldFit = (fitStageRef.current === 0 && appliedFramesRef.current >= 25)
                    || (fitStageRef.current === 1 && appliedFramesRef.current >= 180);
                if (shouldFit && applied > 0 && !activityRef.current.frozen) {
                    fitStageRef.current += 1;
                    const frame = cameraFrame(nodesById, frameIds);
                    if (frame) {
                        const { x, y, z, distance } = frame;
                        try {
                            if (viewMode === '2d' && forceGraph.zoomToFit) {
                                // centerAt only moves the viewport; it preserves
                                // whatever zoom the previous 3D/2D switch left
                                // behind. Fit both dimensions so a wide graph
                                // cannot end up occupying the right half while
                                // most of the canvas remains blank.
                                forceGraph.zoomToFit(700, 36, (node) => frameIds.has(node.id));
                            } else if (forceGraph.cameraPosition) {
                                forceGraph.cameraPosition(
                                    { x, y, z: z + distance }, { x, y, z }, 700,
                                );
                            } else {
                                forceGraph.centerAt?.(x, y, 700);
                            }
                        } catch (_) {}
                    }
                }
            }
            rafRef.current = requestAnimationFrame(drainAndApply);
        };
        drainRef.current = drainAndApply;
        if (activityRef.current.active) rafRef.current = requestAnimationFrame(drainAndApply);

        return () => {
            cancelAnimationFrame(rafRef.current);
            rafRef.current = 0;
            try { worker.postMessage({ type: 'stop' }); } catch (_) {}
            worker.terminate();
            workerRef.current = null;
            drainRef.current = null;
            pendingBufferRef.current = null;
        };
    }, [graphRef, graphData, nodeCount, viewMode, nodeBaseSize, ready]);

    // Visibility changes pause existing resources; they never restart layout.
    // Frozen layout still renders so pan, zoom and selection remain usable.
    useEffect(() => {
        const renderer = graphRef.current;
        if (active) renderer?.resumeAnimation?.();
        else renderer?.pauseAnimation?.();
        workerRef.current?.postMessage({ type: active && !frozen ? 'resume' : 'pause' });
        if (active && drainRef.current && !rafRef.current) {
            rafRef.current = requestAnimationFrame(drainRef.current);
        } else if (!active) {
            cancelAnimationFrame(rafRef.current);
            rafRef.current = 0;
        }
    }, [active, frozen, graphRef, graphData, nodeCount, viewMode, nodeBaseSize, ready]);
}

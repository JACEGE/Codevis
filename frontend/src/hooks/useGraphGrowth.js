import { useCallback, useEffect, useRef, useState } from 'react';

import { partitionVisibleLinks } from '../graph/growthModel';

export default function useGraphGrowth({ dashboardRef, setGraphData, setStats }) {
    const [growthMode, setGrowthMode] = useState(false);
    const [growthSpeed, setGrowthSpeed] = useState(6);
    const growthModeRef = useRef(growthMode);
    const growthSpeedRef = useRef(growthSpeed);
    const nodeBufferRef = useRef([]);
    const linkBufferRef = useRef([]);
    const visibleNodeIdsRef = useRef(new Set());
    const intervalRef = useRef(null);

    useEffect(() => { growthModeRef.current = growthMode; }, [growthMode]);
    useEffect(() => { growthSpeedRef.current = growthSpeed; }, [growthSpeed]);
    useEffect(() => () => stopInterval(intervalRef), []);

    const applyGraph = useCallback((data) => {
        stopInterval(intervalRef);
        if (!growthModeRef.current) {
            setGraphData(data);
            setStats((current) => ({
                ...current,
                nodes: data.nodes.length,
                links: data.links.length,
            }));
            return;
        }

        setGraphData({ nodes: [], links: [] });
        nodeBufferRef.current = [...data.nodes];
        linkBufferRef.current = [...data.links];
        visibleNodeIdsRef.current = new Set();
        setStats((current) => ({ ...current, nodes: 0, links: 0 }));
        let placed = 0;

        const finish = () => {
            const remainingNodes = nodeBufferRef.current.splice(0);
            const remainingLinks = linkBufferRef.current.splice(0);
            remainingNodes.forEach((node) => visibleNodeIdsRef.current.add(node.id));
            if (remainingNodes.length || remainingLinks.length) {
                setGraphData((current) => ({
                    nodes: [...current.nodes, ...remainingNodes],
                    links: [...current.links, ...remainingLinks],
                }));
                setStats((current) => ({
                    ...current,
                    nodes: current.nodes + remainingNodes.length,
                    links: current.links + remainingLinks.length,
                }));
            }
            stopInterval(intervalRef);
        };

        intervalRef.current = setInterval(() => {
            if (nodeBufferRef.current.length === 0) {
                finish();
                return;
            }
            const introLimit = dashboardRef.current?.growthIntroNodes ?? 300;
            if (placed >= introLimit) {
                finish();
                return;
            }
            const batch = nodeBufferRef.current.splice(0, Math.max(1, growthSpeedRef.current));
            batch.forEach((node) => visibleNodeIdsRef.current.add(node.id));
            const links = partitionVisibleLinks(linkBufferRef.current, visibleNodeIdsRef.current);
            linkBufferRef.current = links.pending;
            setGraphData((current) => ({
                nodes: [...current.nodes, ...batch],
                links: [...current.links, ...links.visible],
            }));
            placed += batch.length;
            setStats((current) => ({
                ...current,
                nodes: current.nodes + batch.length,
                links: current.links + links.visible.length,
            }));
        }, 100);
    }, [dashboardRef, setGraphData, setStats]);

    return { growthMode, setGrowthMode, growthSpeed, setGrowthSpeed, applyGraph };
}

function stopInterval(intervalRef) {
    if (intervalRef.current) clearInterval(intervalRef.current);
    intervalRef.current = null;
}

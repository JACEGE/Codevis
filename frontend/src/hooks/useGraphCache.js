import { useCallback, useRef } from 'react';
import { indexNodes } from '../graph/graphUpdates';

export default function useGraphCache() {
    const nodeCacheRef = useRef(new Map());
    const linkCacheRef = useRef([]);
    const fullGraphRef = useRef({ nodes: [], links: [] });

    const replaceCachedGraph = useCallback((graph) => {
        fullGraphRef.current = graph;
        nodeCacheRef.current = indexNodes(graph.nodes);
        linkCacheRef.current = [...graph.links];
    }, []);

    const appendCachedGraph = useCallback((graph) => {
        for (const node of graph.nodes) {
            nodeCacheRef.current.set(node.id, node);
        }
        linkCacheRef.current = [...linkCacheRef.current, ...graph.links];
    }, []);

    const getCachedNode = useCallback(
        (nodeId) => nodeCacheRef.current.get(nodeId),
        [],
    );

    return {
        appendCachedGraph,
        fullGraphRef,
        getCachedNode,
        linkCacheRef,
        replaceCachedGraph,
    };
}

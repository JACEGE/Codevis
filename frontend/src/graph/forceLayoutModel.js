export function forceParameters(nodeCount, viewMode, nodeBaseSize) {
    return {
        charge: -220 - Math.min(1200, nodeCount),
        distance: 70 + Math.min(160, nodeCount * 0.09),
        collideRadius: nodeBaseSize * 2.4,
        dimensions: viewMode === '2d' ? 2 : 3,
    };
}

export function shouldResetCamera(previousCount, nodeCount) {
    return previousCount < 0
        || Math.abs(nodeCount - previousCount) / Math.max(previousCount, 1) > 0.25;
}

export function cameraFrame(nodesById, frameIds) {
    let sx = 0, sy = 0, sz = 0, count = 0;
    for (const id of frameIds) {
        const node = nodesById.get(id);
        if (node) { sx += node.x; sy += node.y; sz += node.z; count++; }
    }
    if (!count) return null;
    const x = sx / count, y = sy / count, z = sz / count;
    let distanceSum = 0;
    for (const id of frameIds) {
        const node = nodesById.get(id);
        if (node) distanceSum += Math.sqrt((node.x - x) ** 2 + (node.y - y) ** 2 + (node.z - z) ** 2);
    }
    return { x, y, z, distance: Math.max(300, (distanceSum / count) * 2.2) };
}

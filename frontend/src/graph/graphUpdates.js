export function applyLockChanges(graph, changes) {
    const byId = new Map(changes.map((change) => [change.id, change]));
    return {
        ...graph,
        nodes: graph.nodes.map((node) => {
            const change = byId.get(node.id);
            return change ? {
                ...node,
                locked: change.locked,
                lockedBy: change.lockedBy,
                lockStatus: change.lockStatus,
            } : node;
        }),
    };
}

export function indexNodes(nodes) {
    return new Map(nodes.map((node) => [node.id, node]));
}

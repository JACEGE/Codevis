export function findInTree(tree, nodeId) {
    if (!tree) return null;
    if (tree.id === nodeId) return tree;
    for (const child of tree.children || []) {
        const found = findInTree(child, nodeId);
        if (found) return found;
    }
    return null;
}

function edgeKey(parentId, childId, direction) {
    return direction === 'in' ? `${childId}->${parentId}` : `${parentId}->${childId}`;
}

function buildSequentialSequence(tree, direction) {
    const sequence = [];

    function visit(node, currentPath, currentEdges, currentStack) {
        const path = [...currentPath, node.id];
        const stack = [...currentStack, { id: node.id, name: node.name, file: node.file }];
        sequence.push({
            callStack: stack,
            debugNode: node.id,
            debugPath: path,
            debugEdges: currentEdges,
            debugBranches: (node.children || []).map((child) => child.id),
        });

        for (const child of node.children || []) {
            if (!currentPath.includes(child.id)) {
                visit(child, path, [...currentEdges, edgeKey(node.id, child.id, direction)], stack);
            }
        }
    }

    visit(tree, [], [], []);
    return sequence;
}

function buildParallelSequence(tree, direction) {
    const sequence = [{
        callStack: [{ id: tree.id, name: tree.name }],
        debugNode: tree.id,
        debugPath: [tree.id],
        debugEdges: [],
        debugBranches: (tree.children || []).map((child) => child.id),
    }];
    const nodesSoFar = [tree.id];
    let edgesSoFar = [];
    let currentLevel = [tree];
    const visitedIds = new Set([tree.id]);

    while (currentLevel.length > 0) {
        const nextLevel = [];
        const newBranches = [];
        for (const node of currentLevel) {
            for (const child of node.children || []) {
                if (!visitedIds.has(child.id)) {
                    visitedIds.add(child.id);
                    nextLevel.push(child);
                    nodesSoFar.push(child.id);
                }
                edgesSoFar.push(edgeKey(node.id, child.id, direction));
                newBranches.push(...(child.children || []).map((branch) => branch.id));
            }
        }
        edgesSoFar = [...new Set(edgesSoFar)];
        if (nextLevel.length === 0) break;
        sequence.push({
            callStack: [{ id: tree.id, name: tree.name, file: tree.file }],
            debugNode: tree.id,
            debugPath: [...nodesSoFar],
            debugEdges: [...edgesSoFar],
            debugBranches: [...new Set(newBranches)],
        });
        currentLevel = nextLevel;
    }

    return sequence;
}

export function buildDebugSequence(tree, sequentialMode, direction = 'out') {
    if (!tree) return [];
    return sequentialMode
        ? buildSequentialSequence(tree, direction)
        : buildParallelSequence(tree, direction);
}

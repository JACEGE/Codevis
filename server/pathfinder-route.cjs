'use strict';

// Shared by the dashboard bridge and the MCP server. Route finding deliberately
// happens in JavaScript after one bounded edge read: asking Ladybug to enumerate
// every variable-length path can explode on high-degree call graphs before a
// trailing LIMIT gets a chance to help.

const ALLOWED_RELATIONS = new Set(['CALLS', 'CALLS_CONDITIONALLY', 'RENDERS']);
const DEFAULT_RELATIONS = ['CALLS', 'RENDERS'];
const MAX_HOPS = 12;
const MAX_PATHS = 5;
const MAX_EDGE_ROWS = 250000;
const MAX_SEARCH_STATES = 100000;

function integerInRange(value, fallback, min, max) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.floor(parsed))) : fallback;
}

function normalizeRelations(value) {
    const requested = Array.isArray(value) ? value : DEFAULT_RELATIONS;
    const relations = [...new Set(requested.map(String).filter((type) => ALLOWED_RELATIONS.has(type)))];
    if (relations.length === 0) {
        const error = new Error(`relations must contain at least one of: ${[...ALLOWED_RELATIONS].join(', ')}`);
        error.code = 'INVALID_RELATIONS';
        throw error;
    }
    return relations;
}

function value(record, key) {
    return record.get(key);
}

function nodeFromRecord(record, prefix) {
    const id = value(record, `${prefix}Id`);
    if (id === null || id === undefined) return null;
    return {
        id: String(id),
        name: value(record, `${prefix}Name`) || String(id),
        file: value(record, `${prefix}File`) || null,
        labels: (value(record, `${prefix}Labels`) || []).map(String),
        signature: value(record, `${prefix}Signature`) || null,
    };
}

function addNode(map, node) {
    if (node && !map.has(node.id)) map.set(node.id, node);
}

function routeError(code, message, details) {
    const error = new Error(message);
    error.code = code;
    if (details) Object.assign(error, details);
    return error;
}

function findShortestRoutes(adjacency, startId, targetId, maxHops, maxPaths) {
    if (startId === targetId) return [{ nodeIds: [startId], edges: [] }];

    const queue = [{ nodeIds: [startId], edges: [] }];
    const bestDepth = new Map([[startId, 0]]);
    const routes = [];
    let shortest = null;
    let cursor = 0;

    while (cursor < queue.length && cursor < MAX_SEARCH_STATES) {
        const current = queue[cursor++];
        const depth = current.edges.length;
        if (depth >= maxHops || (shortest !== null && depth >= shortest)) continue;

        const tip = current.nodeIds[current.nodeIds.length - 1];
        for (const edge of adjacency.get(tip) || []) {
            const nextDepth = depth + 1;
            if (current.nodeIds.includes(edge.next)) continue;
            if (shortest !== null && nextDepth > shortest) continue;

            const seenDepth = bestDepth.get(edge.next);
            if (seenDepth !== undefined && seenDepth < nextDepth) continue;
            bestDepth.set(edge.next, nextDepth);

            const next = {
                nodeIds: [...current.nodeIds, edge.next],
                edges: [...current.edges, edge],
            };
            if (edge.next === targetId) {
                shortest = nextDepth;
                routes.push(next);
                if (routes.length >= maxPaths) return routes;
            } else {
                queue.push(next);
            }
        }
    }

    if (cursor >= MAX_SEARCH_STATES) {
        throw routeError('SEARCH_LIMIT', `Route search exceeded ${MAX_SEARCH_STATES.toLocaleString()} states`, {
            visitedStates: cursor,
        });
    }
    return routes;
}

function linearTree(route, nodes) {
    if (!route) return null;
    let child = null;
    for (let i = route.nodeIds.length - 1; i >= 0; i -= 1) {
        const node = nodes.get(route.nodeIds[i]) || { id: route.nodeIds[i], name: route.nodeIds[i], labels: [] };
        child = { ...node, children: child ? [child] : [] };
    }
    return child;
}

async function findPath(session, options = {}) {
    const startId = String(options.startNode || '').trim();
    const targetId = String(options.targetNode || '').trim();
    if (!startId || !targetId) throw routeError('INVALID_ENDPOINTS', 'startNode and targetNode are required');

    const direction = options.direction === 'in' ? 'in' : 'out';
    const relations = normalizeRelations(options.relations);
    const maxHops = integerInRange(options.maxHops, 8, 1, MAX_HOPS);
    const maxPaths = integerInRange(options.maxPaths, 1, 1, MAX_PATHS);
    const nodes = new Map();

    const endpointResult = await session.run(`
        MATCH (n)
        WHERE elementId(n) = $startId OR elementId(n) = $targetId
        RETURN elementId(n) AS nodeId, n.name AS nodeName, n.file AS nodeFile,
               labels(n) AS nodeLabels, n.signature AS nodeSignature
    `, { startId, targetId });
    for (const record of endpointResult.records) addNode(nodes, nodeFromRecord(record, 'node'));

    const missing = [startId, targetId].filter((id) => !nodes.has(id));
    if (missing.length) {
        throw routeError('NODE_NOT_FOUND', `Route endpoint not found: ${missing.join(', ')}`, { missing });
    }

    const relPattern = relations.join('|');
    const edgeResult = await session.run(`
        MATCH (source)-[rel:${relPattern}]->(target)
        RETURN elementId(source) AS sourceId, source.name AS sourceName,
               source.file AS sourceFile, labels(source) AS sourceLabels,
               source.signature AS sourceSignature,
               elementId(target) AS targetId, target.name AS targetName,
               target.file AS targetFile, labels(target) AS targetLabels,
               target.signature AS targetSignature,
               type(rel) AS relType, rel.resolvedBy AS resolvedBy
        LIMIT ${MAX_EDGE_ROWS + 1}
    `);
    if (edgeResult.records.length > MAX_EDGE_ROWS) {
        throw routeError('GRAPH_TOO_LARGE', `Route edge set exceeds the ${MAX_EDGE_ROWS.toLocaleString()} edge safety cap`);
    }

    const adjacency = new Map();
    const push = (from, edge) => {
        if (!adjacency.has(from)) adjacency.set(from, []);
        adjacency.get(from).push(edge);
    };

    for (const record of edgeResult.records) {
        const source = nodeFromRecord(record, 'source');
        const target = nodeFromRecord(record, 'target');
        addNode(nodes, source);
        addNode(nodes, target);
        const relType = String(value(record, 'relType'));
        const base = {
            source: source.id,
            target: target.id,
            relType,
            resolvedBy: value(record, 'resolvedBy') || null,
        };
        if (direction === 'in') push(target.id, { ...base, next: source.id });
        else push(source.id, { ...base, next: target.id });
    }

    const routes = findShortestRoutes(adjacency, startId, targetId, maxHops, maxPaths);
    if (routes.length === 0) {
        return {
            status: 'NO_PATH', startNode: nodes.get(startId), targetNode: nodes.get(targetId),
            direction, relations, maxHops, paths: [], graph: { nodes: [nodes.get(startId), nodes.get(targetId)], links: [] },
            tree: null,
        };
    }

    const routeNodeIds = new Set();
    const linkMap = new Map();
    const paths = routes.map((route) => {
        route.nodeIds.forEach((id) => routeNodeIds.add(id));
        route.edges.forEach((edge) => linkMap.set(`${edge.source}\0${edge.target}\0${edge.relType}`, edge));
        return {
            hops: route.edges.length,
            nodes: route.nodeIds.map((id) => nodes.get(id)),
            edges: route.edges.map(({ next: _next, ...edge }) => edge),
        };
    });

    return {
        status: 'OK', startNode: nodes.get(startId), targetNode: nodes.get(targetId),
        direction, relations, maxHops, paths,
        graph: {
            nodes: [...routeNodeIds].map((id) => nodes.get(id)),
            links: [...linkMap.values()].map(({ next: _next, ...edge }) => edge),
        },
        tree: linearTree(routes[0], nodes),
    };
}

module.exports = {
    ALLOWED_RELATIONS,
    DEFAULT_RELATIONS,
    findPath,
    findShortestRoutes,
    normalizeRelations,
};

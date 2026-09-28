/**
 * Offline demo mode (VITE_DEMO=1).
 *
 * The dashboard normally talks to a live bridge over HTTP and socket.io. The
 * demo build replays responses recorded from a real bridge instead, so the
 * bundle can be hosted as static files and opened anywhere, phones included.
 * Recording and build: scripts/demo/build-demo.mjs (npm run demo:build).
 *
 * Reads are answered from the recording; writes are refused with a readable
 * error, so nothing in the UI pretends a change was saved.
 */

const READ_ONLY_POSTS = new Set(['/api/impact', '/api/graph/query', '/api/graph/subgraph', '/api/pathfinder/route', '/api/graph/scope']);
const READ_ONLY_MESSAGE = 'Read-only demo: changes are not saved.';

// The Queries tab strips `// @expand`-style directives before sending, the
// recorder sends the stored text: compare Cypher without them and whitespace.
function canonicalCypher(query) {
    return String(query).replace(/\/\/[^\n]*@(?:expand|raw|atomic|all|types)[^\n]*/gi, ' ').replace(/\s+/g, ' ').trim();
}

function canonicalBody(body) {
    if (body == null || body === '') return '';
    try {
        const parsed = JSON.parse(body);
        if (parsed && typeof parsed.query === 'string') parsed.query = canonicalCypher(parsed.query);
        return JSON.stringify(sortKeys(parsed));
    } catch { return String(body); }
}

function sortKeys(value) {
    if (Array.isArray(value)) return value.map(sortKeys);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortKeys(value[key])]));
    }
    return value;
}

function canonicalSearch(search) {
    const params = new URLSearchParams(search);
    return [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('&');
}

function jsonResponse(body, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** Everything reachable from the seeds within `hops` undirected steps. */
export function localSubgraph(graph, { uids = [], ipv6s = [], expand = 0 } = {}) {
    const seeds = new Set();
    const byIpv6 = new Map(graph.nodes.map(node => [node.ipv6, node.id]));
    const known = new Set(graph.nodes.map(node => node.id));
    for (const uid of uids) if (known.has(uid)) seeds.add(uid);
    for (const ip of ipv6s) if (byIpv6.has(ip)) seeds.add(byIpv6.get(ip));
    const endpoint = value => (value && typeof value === 'object' ? value.id : value);
    const neighbours = new Map();
    for (const link of graph.links) {
        const source = endpoint(link.source);
        const target = endpoint(link.target);
        if (!neighbours.has(source)) neighbours.set(source, []);
        if (!neighbours.has(target)) neighbours.set(target, []);
        neighbours.get(source).push(target);
        neighbours.get(target).push(source);
    }
    const hops = Math.max(0, Math.min(3, Math.floor(Number(expand) || 0)));
    const included = new Set(seeds);
    let frontier = [...seeds];
    for (let step = 0; step < hops; step++) {
        const next = [];
        for (const id of frontier) {
            for (const other of neighbours.get(id) || []) {
                if (!included.has(other)) { included.add(other); next.push(other); }
            }
        }
        frontier = next;
    }
    const nodes = graph.nodes.filter(node => included.has(node.id)).map(node => ({ ...node }));
    const links = graph.links
        .filter(link => included.has(endpoint(link.source)) && included.has(endpoint(link.target)))
        .map(link => ({ ...link, source: endpoint(link.source), target: endpoint(link.target) }));
    const requested = uids.length + ipv6s.length;
    return {
        nodes, links, requested, accepted: requested, found: seeds.size,
        missing: Math.max(0, requested - seeds.size), seeds: seeds.size,
        expanded: nodes.length - seeds.size, hops, capped: false,
    };
}

/** Shortest undirected path between two nodes, shaped like the bridge's route result. */
function localRoute(graph, body) {
    const endpoint = value => (value && typeof value === 'object' ? value.id : value);
    const start = endpoint(body.startNode?.id ?? body.startNode);
    const goal = endpoint(body.targetNode?.id ?? body.targetNode);
    const previous = new Map([[start, null]]);
    const queue = [start];
    const adjacency = new Map();
    for (const link of graph.links) {
        const s = endpoint(link.source); const t = endpoint(link.target);
        (adjacency.get(s) || adjacency.set(s, []).get(s)).push(t);
        (adjacency.get(t) || adjacency.set(t, []).get(t)).push(s);
    }
    while (queue.length && !previous.has(goal)) {
        const id = queue.shift();
        for (const other of adjacency.get(id) || []) {
            if (!previous.has(other)) { previous.set(other, id); queue.push(other); }
        }
    }
    if (!previous.has(goal)) return { paths: [], nodes: [], links: [] };
    const ids = [];
    for (let id = goal; id != null; id = previous.get(id)) ids.unshift(id);
    const sub = localSubgraph(graph, { uids: ids, expand: 0 });
    const onPath = new Set(ids.slice(1).map((id, i) => `${ids[i]}|${id}`));
    sub.links = sub.links.filter(l => onPath.has(`${l.source}|${l.target}`) || onPath.has(`${l.target}|${l.source}`));
    return { ...sub, paths: [ids] };
}

function createFetch(fixtures, realFetch) {
    const exact = new Map();
    const byPath = new Map();
    for (const entry of fixtures.http) {
        const key = `${entry.method} ${entry.path}?${canonicalSearch(entry.search)} ${canonicalBody(entry.body)}`;
        exact.set(key, entry);
        if (!byPath.has(`${entry.method} ${entry.path}`)) byPath.set(`${entry.method} ${entry.path}`, []);
        byPath.get(`${entry.method} ${entry.path}`).push(entry);
    }
    const graph = () => window.__CODEVIS_DEMO__.graph;
    const replay = entry => new Response(entry.status === 304 ? '{}' : entry.text, {
        status: entry.status === 304 ? 200 : entry.status,
        headers: { 'Content-Type': entry.contentType || 'application/json' },
    });

    return async function demoFetch(input, init = {}) {
        const request = input instanceof Request ? input : null;
        const url = new URL(request ? request.url : String(input), window.location.href);
        if (!url.pathname.includes('/api/')) return realFetch(input, init);
        const path = url.pathname.slice(url.pathname.indexOf('/api/'));
        const method = (init.method || request?.method || 'GET').toUpperCase();
        const body = typeof init.body === 'string' ? init.body : '';

        const hit = exact.get(`${method} ${path}?${canonicalSearch(url.search)} ${canonicalBody(body)}`);
        if (hit) return replay(hit);

        if (path === '/api/graph/subgraph') {
            try { return jsonResponse(localSubgraph(graph(), JSON.parse(body || '{}'))); }
            catch { return jsonResponse({ error: 'Invalid subgraph request' }, 400); }
        }
        if (path === '/api/pathfinder/route') {
            try { return jsonResponse(localRoute(graph(), JSON.parse(body || '{}'))); }
            catch { return jsonResponse({ error: 'Invalid route request' }, 400); }
        }
        if (method !== 'GET' && !READ_ONLY_POSTS.has(path)) {
            return jsonResponse({ error: READ_ONLY_MESSAGE, demo: true }, 403);
        }

        // Same endpoint, different parameters: answer with the recording that
        // shares the most query parameters. Close enough for a walkthrough and
        // far better than an empty panel.
        // Never for POST: a different body is a different question.
        const candidates = method === 'GET' ? byPath.get(`${method} ${path}`) || [] : [];
        if (candidates.length) {
            const wanted = new URLSearchParams(url.search);
            const score = entry => {
                const params = new URLSearchParams(entry.search);
                let shared = 0;
                for (const [k, v] of wanted) if (params.get(k) === v) shared++;
                return shared;
            };
            const best = candidates.reduce((a, b) => (score(b) > score(a) ? b : a));
            // Per-node endpoints must not show another node's data.
            if (!wanted.has('nodeId') || score(best) === wanted.size) return replay(best);
        }
        return jsonResponse({ error: 'Not recorded for this demo — try one of the Quick Scans.', demo: true }, 404);
    };
}

function showBanner() {
    const banner = document.createElement('div');
    banner.textContent = 'Demo · sample project · read-only';
    banner.setAttribute('role', 'status');
    Object.assign(banner.style, {
        position: 'fixed', left: '50%', bottom: '12px', transform: 'translateX(-50%)', zIndex: 99999,
        padding: '6px 14px', borderRadius: '999px', font: '600 12px Inter, system-ui, sans-serif',
        background: 'rgba(99, 102, 241, 0.92)', color: '#fff', pointerEvents: 'none',
        boxShadow: '0 4px 14px rgba(0,0,0,0.25)', whiteSpace: 'nowrap',
    });
    document.body.appendChild(banner);
}

export async function installDemo() {
    const realFetch = window.fetch.bind(window);
    const response = await realFetch(new URL('demo-fixtures.json', document.baseURI));
    const fixtures = await response.json();
    const events = new Map(fixtures.socketIn.map(([event, ...args]) => [event, args]));
    window.__CODEVIS_DEMO__ = { fixtures, events, graph: events.get('graph:init')?.[0] || { nodes: [], links: [] } };
    window.fetch = createFetch(fixtures, realFetch);
    try { if (!localStorage.getItem('codevis.viewMode')) localStorage.setItem('codevis.viewMode', window.innerWidth < 700 ? '2d' : '3d'); } catch {}
    showBanner();
}

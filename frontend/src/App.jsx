import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { io } from 'socket.io-client';
import DocumentationPanel from './components/DocumentationPanel';
import StatusBar from './components/StatusBar';
import TerminalPanel from './components/TerminalPanel';
import BrainTab from './components/BrainTab';
import SpecTab, { DiagramsTab } from './components/SpecTab';
import ClassDiagramTab from './components/ClassDiagramTab';
import RosTab from './components/RosTab';
import { FULL_SCREEN_TABS, FullScreenTabShell } from './components/AppChrome';
import WorkspaceHeader from './components/WorkspaceHeader';
import NodeSearchDialog from './components/NodeSearchDialog';
import useNavigationHistory from './hooks/useNavigationHistory';
import PanelDivider from './components/PanelDivider';
import DashboardSidePanel from './components/DashboardSidePanel';
import GraphPanel from './components/GraphPanel';

import BRIDGE_URL from './bridgeUrl';
import { buildPalette } from './nodePalette';
import useStoredState from './hooks/useStoredState';
import useResizableSplit from './hooks/useResizableSplit';
import useProjectConfig from './hooks/useProjectConfig';
import useTraceActivity from './hooks/useTraceActivity';
import useGraphGrowth from './hooks/useGraphGrowth';
import useGraphCache from './hooks/useGraphCache';
import usePathfinder from './hooks/usePathfinder';
import useGraphScope from './hooks/useGraphScope';
import useGraphRequestGate from './hooks/useGraphRequestGate';
import { applyLockChanges } from './graph/graphUpdates';
import { findInTree } from './pathfinder/treeModel';
const WINDOW_RADIUS = 4; // Hop distance from call stack before nodes get hidden

// The tab registry. Module-level so ids can be referenced symbolically from
// anywhere (a "show this node in …" action needs the id, not a magic string)
// and so the array is not re-allocated on every render.
//
// 'pathfinder' was called 'debug', which suggested breakpoints and stepping
// through a running program. It does neither: it walks the CALLS/RENDERS tree
// outward from one node and lets you step along it. Note it is single-source —
// it does not search for a route BETWEEN two nodes.
const TABS = [
    { key: 'kanban', label: 'Kanban', group: 'Work' },
    { key: 'brain', label: 'Brain', group: 'Work' },
    { key: 'spec', label: 'Spec', group: 'Work' },
    { key: 'context', label: 'Context', group: 'Analyze' },
    { key: 'inspector', label: 'Inspector', group: 'Analyze' },
    { key: 'pathfinder', label: 'Pathfinder', group: 'Analyze' },
    // Explore sits with the other tabs that answer questions about the graph
    // in front of you (Kanban, Knowledge, Inspector, Pathfinder). It used to be
    // parked between ROS 2 and Diagrams, behind the domain and document tabs,
    // where it was reached last despite being the everyday one.
    { key: 'explore', label: 'Explore', group: 'Analyze' },
    { key: 'classes', label: 'Classes', group: 'Model' },
    // Domain tab: only rendered for projects whose ROS extractor is on. It stays
    // in this list rather than being spliced in at render time so the tab order
    // is readable in one place; renderTabBar drops it when the flag is off.
    { key: 'ros', label: 'ROS 2', group: 'Model', requiresExtractor: 'ros' },
    { key: 'diagrams', label: 'Diagrams', group: 'Model' },
    { key: 'documentation', label: 'Docs', group: 'System' },
    { key: 'settings', label: 'Settings', group: 'System' },
];

// Above this visible-node count the 3D renderer (one THREE mesh + sprite per node)
// chokes the main thread and the dropped socket heartbeat shows a false "no
// connection" banner. We transparently fall back to the canvas-based 2D view —
// see effectiveViewMode / the force-2D banner below.
//
// The other branch raised this to 100000 on the grounds that "with InstancedMesh
// the renderer uses 2 draw calls regardless of node count". GraphScene does not
// use InstancedMesh — it still builds one THREE.Mesh plus one label sprite per
// node — so that premise does not hold here and the cap stays where the observed
// freeze put it. Raise it when the renderer is actually instanced, not before.
// The DEFAULT switchover, not the law. It is a Settings field now: the number
// is a property of the machine in front of the graph, and 4000 was measured on
// one of them. Whoever has more headroom should be able to spend it without
// editing this file.
const DEFAULT_MAX_3D_NODES = 4000;

const parseStartupDetailLevel = (value) => Number.parseInt(value, 10) === 2 ? 2 : 1;
const parseMax3dNodes = (value) => {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed >= 100 ? parsed : DEFAULT_MAX_3D_NODES;
};

// Structural / containment relationship types. These encode the file/AST
// hierarchy and clutter the graph into an unreadable hairball, so they are
// hidden by default. Meaningful semantic edges (CALLS, RENDERS, IMPORTS, …)
// are kept.
const HIDDEN_LINK_TYPES = new Set([
    'CONTAINS',
    'CONTAINS_AST',
    'CONTAINS_FLOW',
    'CONTAINS_STMT',
    'DECLARES',
    'RETURNS',
]);

function App() {
    const [graphData, setGraphData] = useState({ nodes: [], links: [] });
    // Null means no response yet; zero is a successfully loaded empty graph.
    const [receivedGraphNodeCount, setReceivedGraphNodeCount] = useState(null);
    // Explore queries can address nodes outside the normally capped dashboard
    // graph. While set, this exact server-provided result subgraph replaces the
    // regular graph without mutating its cached/full state.
    const [exploreGraphData, setExploreGraphData] = useState(null);
    const [connected, setConnected] = useState(null);
    const [socket, setSocket] = useState(null);
    const [stats, setStats] = useState({ nodes: 0, links: 0, activeTraces: 0 });
    const {
        activeLinks,
        traceLog,
        traceDecayMs,
        setTraceDecayMs,
        handleTraceEvent,
        clearActiveLinks,
        replaceActiveLinks,
    } = useTraceActivity({ setStats });
    // Server-side cap info for Level 3 ({ shown, total } or null) — drives the
    // "showing N of M" banner so a capped graph is never silently truncated.
    const [capped, setCapped] = useState(null);
    const socketRef = useRef(null);
    // View-Einstellungen überleben den Reload (localStorage), sonst landet man
    // nach jedem F5 wieder bei den Defaults.
    const [viewMode, setViewMode] = useStoredState('codevis.viewMode', '3d');
    // Which KINDS of node exist for the dashboard at all: 1 architecture,
    // 2 + variables/control flow/statements, 3 + the raw syntax tree. The
    // control for it sits in the Settings tab (GraphDetailSlider).
    //
    // It was pinned to 1 for a while with no control anywhere, on the grounds
    // that a stored 3 would strand someone in a 73k-node graph with no way back
    // out. The node budget is what removed that risk: the level decides what
    // the graph is drawn FROM, the budget decides how much of it arrives, and
    // level 3 at budget 500 is 500 nodes like any other level.
    //
    // Restored from localStorage for the same reason every other view setting
    // is — but level 3 means a cold load over the whole syntax tree, so a
    // stored 3 would make every first paint of the day slow. It opens on the
    // level you left only up to 2; picking 3 again is one click.
    const [detailLevel, setDetailLevel] = useStoredState(
        'codevis.detailLevel', 1, parseStartupDetailLevel,
    );

    // Above this many nodes the 3D view falls back to 2D. Machine-dependent,
    // hence a setting rather than a constant.
    const [max3dNodes, setMax3dNodes] = useStoredState(
        'codevis.max3dNodes', DEFAULT_MAX_3D_NODES, parseMax3dNodes,
    );

    // Cross-panel hover highlight: set of node names to highlight in GraphScene
    const [highlightedNodes, setHighlightedNodes] = useState(new Set());

    // Fly-to: vom Knowledge-Panel gesetzter Knoten, auf den der Graph zoomt.
    const [focusNodeId, setFocusNodeId] = useState(null);

    // Mode & Config state
    const [mode, setMode] = useState('live'); // 'live' | 'debug' | 'brain'
    const [activeDb, setActiveDb] = useState('project_db');
    const [workspaceReady, setWorkspaceReady] = useState(false);
    const { begin: beginGraphRequest, capture: captureGraphRequest, invalidate: invalidateGraphRequests } = useGraphRequestGate(activeDb);
    const [limits, setLimits] = useState({ seed: 20, func: 200, module: 30, endpoint: 20 });

    // THE selection — one node id, shared by every tab and by the graph.
    // There used to be a second copy (`debugNode`) that was set to the same
    // value on every click and cleared on tab switch, so Inspector and
    // Pathfinder could disagree about what was selected. One variable now; the
    // trace state below is derived from it and may be cleared independently.
    const [selectedNode, setSelectedNode] = useState(null);
    const [routeResult, setRouteResult] = useState(null);
    // A deliberate second click on the selected graph node opens actions.  This
    // is separate from selection so Inspector/Context navigation never loses
    // the shared current node.
    const [nodeActionMenu, setNodeActionMenu] = useState(null);
    const [contextRequest, setContextRequest] = useState(null);

    const {
        callStack, debugBranches, debugPath, debugSequence, debugStep,
        dfsTreeRef, sequentialMode, traceDirection,
        setCallStack, setDebugBranches, setDebugPath, setDebugStep,
        setDfsTree, setSequentialMode, setTraceDirection,
    } = usePathfinder({ replaceActiveLinks });

    // Rolling Window state
    const {
        appendCachedGraph,
        fullGraphRef,
        getCachedNode,
        linkCacheRef,
        replaceCachedGraph,
    } = useGraphCache();

    // Physics Engine Freeze
    const [freezeLayout, setFreezeLayout] = useState(false);

    // Right-panel tab selection (Kanban / Inspector / Brain)
    const [rightTab, setRightTab] = useState('kanban');

    // How the right column is split between the panel (Kanban etc.) and the
    // terminal below it: the panel's share of the two rows, 0..1. Draggable via
    // the handle between them, and remembered — a split you had to redo on every
    // reload is worth less than no split at all.
    const {
        split: rightSplit,
        setSplit: setRightSplit,
        dragging: splitDragging,
        setDragging: setSplitDragging,
        containerRef: gridRef,
    } = useResizableSplit();
    const graphPanelRef = useRef(null);
    const [workspaceLayout, setWorkspaceLayout] = useState('split');
    const [searchOpen, setSearchOpen] = useState(false);
    const [terminalOpen, setTerminalOpen] = useState(false);
    const horizontalSplit = useResizableSplit({ axis: 'horizontal', storageKey: 'codevis.graphSplit', defaultSplit: 0.5, containerRef: gridRef });
    // A diagram chosen in the Diagrams tab, to be reopened in the Spec tab.
    const [pendingSpec, setPendingSpec] = useState(null);

    const { dashboard, dashboardRef, extractors, projectRoot, webShellEnabled } = useProjectConfig({ activeDb });
    const terminalVisible = webShellEnabled || terminalOpen;
    const { growthMode, setGrowthMode, growthSpeed, setGrowthSpeed, applyGraph } = useGraphGrowth({
        dashboardRef,
        setGraphData,
        setStats,
    });
    useEffect(() => {
        if (dashboard?.growthSpeed != null) setGrowthSpeed(dashboard.growthSpeed);
    }, [dashboard, setGrowthSpeed]);

    // Connect to the WebSocket bridge
    useEffect(() => {
        const socket = io(BRIDGE_URL, { reconnection: true, reconnectionDelay: 1000 });
        socketRef.current = socket;
        setSocket(socket);

        socket.on('connect', () => {
            console.log('[CodeVis] Connected to bridge');
            setConnected(true);
        });

        socket.on('disconnect', () => {
            console.log('[CodeVis] Disconnected from bridge');
            setConnected(false);
            setReceivedGraphNodeCount(null);
        });
        socket.on('connect_error', () => setConnected(false));


        // Receive initial graph data
        socket.on('graph:init', (data) => {
            console.log(`[CodeVis] Received graph: ${data.nodes.length} nodes, ${data.links.length} links`);
            setReceivedGraphNodeCount(data.nodes.length);

            // Level-3 cap notice from the bridge (null when nothing was dropped).
            setCapped(data.capped || null);
            // What the bridge loaded and what it cut it from. Drives every
            // number the filter and the Settings panel show — they used to
            // measure the graph against itself, which can only ever read 100%.
            if (data.scope) { setGraphScope(data.scope); setScopePending(false); }

            // Populate caches
            replaceCachedGraph(data);
            resetSelection();

            applyGraph(data);
        });

        // Diff-based lock updates — only touch affected nodes
        socket.on('nodes:lock-updated', (changes) => {
            setGraphData((current) => applyLockChanges(current, changes));
        });

        // Receive config status from bridge
        socket.on('config:status', (cfg) => {
            console.log(`[CodeVis] Config: db=${cfg.activeDb}, level=${cfg.detailLevel}, limits=`, cfg.limits);
            setActiveDb(cfg.activeDb);
            setWorkspaceReady(true);
            setLimits(cfg.limits);
            // Die Detailstufe lebt in der Bridge, nicht hier: ein neu geladenes
            // Frontend faengt auf seiner eigenen Vorgabe an und zeigte deshalb
            // 'Architecture' an, während die Bridge noch Stufe 3 geladen hatte.
            // Sichtbar wurde das am Node-Budget — 144265 statt der 3751, die zu
            // der angezeigten Stufe gehören. Wer die Stufe hält, sagt sie auch.
            if (cfg.detailLevel != null) setDetailLevel(cfg.detailLevel);
        });

        // Receive tracing events — only process in Live mode
        socket.on('trace:event', handleTraceEvent);

        return () => {
            setSocket(null);
            socket.disconnect();
        };
    }, [applyGraph, handleTraceEvent, replaceCachedGraph]);

    // ── Debug helpers ────────────────────────────────────────────────

    // Clears the TRACE (path, branches, call stack, edge highlights) but NOT the
    // selection. Switching tabs used to run the whole thing, selection included,
    // so a node picked in one tab was gone in the next — the selection did not
    // "get lost", it was actively thrown away. Selection now survives; only the
    // explicit Reset button drops it (see resetSelection).
    const clearTrace = useCallback(() => {
        invalidateGraphRequests();
        setDebugPath([]);
        setDebugBranches([]);
        clearActiveLinks();
        setDfsTree(null);
        dfsTreeRef.current = null;
        if (fullGraphRef.current.nodes.length > 0) {
            setGraphData(fullGraphRef.current);
        }
        if (routeResult) setExploreGraphData(null);
        setRouteResult(null);
    }, [clearActiveLinks, routeResult]);

    const resetSelection = useCallback(() => {
        setContextRequest(null);
        setExploreGraphData(null);
        setFocusNodeId(null);
        setNodeActionMenu(null);
        setSelectedNode(null);
        setCallStack([]);
        clearTrace();
    }, [clearTrace]);

    useEffect(() => {
        resetSelection();
        // Workspace changes reset temporary views even before graph:init arrives.
        // resetSelection is intentionally not a dependency: changing routes is
        // not a workspace change.
    }, [activeDb]);

    // Get node info from graphData or cache by ID. A query result replaces the
    // graph on screen but not `graphData`, so clicking a node that only exists
    // in the query subgraph used to resolve to "#<id>" with no name and no file.
    const getNodeInfo = useCallback((nodeId) => {
        const node = graphData.nodes.find(n => n.id === nodeId)
            || exploreGraphData?.nodes.find(n => n.id === nodeId);
        if (node) return { id: node.id, name: node.name, file: node.file };
        // Fallback: check node cache (for expanded nodes)
        const cached = getCachedNode(nodeId);
        if (cached) return { id: cached.id, name: cached.name, file: cached.file };
        return { id: nodeId, name: `#${nodeId}`, file: null };
    }, [graphData, exploreGraphData, getCachedNode]);

    // Update debug branches for the current node
    const updateBranches = useCallback((nodeId) => {
        const tree = dfsTreeRef.current;
        const treeNode = findInTree(tree, nodeId);
        const children = treeNode?.children || [];
        setDebugBranches(children.map(c => c.id));
    }, []);

    // ── Rolling Window: expand border nodes ────────────────────────────

    const expandBorderNode = useCallback(async (nodeId) => {
        const current = captureGraphRequest();
        // Check if this node has children in the DFS tree
        const treeNode = findInTree(dfsTreeRef.current, nodeId);
        if (treeNode && treeNode.children && treeNode.children.length > 0) return;

        // Check if node's children are already in the graph
        const existingChildren = graphData.links.filter((l) => {
            const endpoint = traceDirection === 'in' ? l.target : l.source;
            return (endpoint?.id ?? endpoint) === nodeId && l.relType === 'CALLS';
        });
        if (existingChildren.length > 0) return;

        // This is a border node — expand it
        console.log(`[CodeVis] Rolling Window: expanding border node ${nodeId}`);
        try {
            const res = await fetch(`${BRIDGE_URL}/api/expand?nodeId=${encodeURIComponent(nodeId)}&direction=${traceDirection}`);
            const data = await res.json();
            if (!current()) return;
            if (data.nodes && data.nodes.length > 0) {
                // Add new nodes to cache
                appendCachedGraph(data);

                // Inject into graphData
                setGraphData(prev => ({
                    nodes: [...prev.nodes, ...data.nodes.filter(n => !prev.nodes.some(e => e.id === n.id))],
                    links: [...prev.links, ...data.links]
                }));

                // …and into the Explore result when one is active, otherwise
                // expanding inside a query result would silently do nothing:
                // that subgraph is what is on screen, and it is a separate array.
                setExploreGraphData(prev => prev && ({
                    nodes: [...prev.nodes, ...data.nodes.filter(n => !prev.nodes.some(e => e.id === n.id))],
                    links: [...prev.links, ...data.links],
                    expanded: (prev.expanded || 0) + 1,
                }));

                // Also inject into DFS tree for stepping
                if (treeNode) {
                    treeNode.children = data.nodes.map(n => ({
                        id: n.id, name: n.name, file: n.file, children: []
                    }));
                }

                console.log(`[CodeVis] Rolling Window: added ${data.nodes.length} nodes, ${data.links.length} links`);

                // Update branches now that tree has new children
                updateBranches(nodeId);
            }
        } catch (err) {
            console.error('[CodeVis] Rolling Window expand error:', err);
        }
    }, [appendCachedGraph, graphData, traceDirection, updateBranches]);

    // Drill into the atomic parse of a node: load its variables, control-flow and
    // statements on demand and merge them into the graph. This is how the user sees
    // the fine-grained parse without clumping the whole overview.
    const handleExpandAst = useCallback(async (nodeId) => {
        if (nodeId == null) return;
        const current = captureGraphRequest();
        try {
            const res = await fetch(`${BRIDGE_URL}/api/expand-ast?nodeId=${encodeURIComponent(nodeId)}`);
            const data = await res.json();
            if (!current()) return;
            if (!data.nodes || data.nodes.length === 0) {
                console.log(`[CodeVis] AST: node ${nodeId} has no atomic children`);
                return;
            }
            appendCachedGraph(data);
            setGraphData(prev => ({
                nodes: [...prev.nodes, ...data.nodes.filter(n => !prev.nodes.some(e => e.id === n.id))],
                links: [...prev.links, ...data.links],
            }));
            console.log(`[CodeVis] AST: added ${data.nodes.length} atomic node(s), ${data.links.length} link(s)`);
        } catch (err) {
            console.error('[CodeVis] AST expand error:', err);
        }
    }, [appendCachedGraph]);

    // ── Rolling Window: shrink distant nodes ──────────────────────────

    const shrinkDistantNodes = useCallback((currentStack) => {
        if (currentStack.length === 0) return;

        const stackIds = new Set(currentStack.map(s => s.id));

        // BFS from all stack nodes to find nodes within WINDOW_RADIUS
        const nearbyIds = new Set();
        const queue = [...stackIds].map(id => ({ id, depth: 0 }));
        const visited = new Set();

        // Build adjacency from current links
        const adj = new Map();
        for (const link of linkCacheRef.current) {
            const src = link.source?.id ?? link.source;
            const tgt = link.target?.id ?? link.target;
            if (!adj.has(src)) adj.set(src, []);
            if (!adj.has(tgt)) adj.set(tgt, []);
            adj.get(src).push(tgt);
            adj.get(tgt).push(src); // Bidirectional for proximity
        }

        while (queue.length > 0) {
            const { id, depth } = queue.shift();
            if (visited.has(id)) continue;
            visited.add(id);
            nearbyIds.add(id);
            if (depth < WINDOW_RADIUS) {
                for (const neighbor of (adj.get(id) || [])) {
                    if (!visited.has(neighbor)) {
                        queue.push({ id: neighbor, depth: depth + 1 });
                    }
                }
            }
        }

        // Filter graphData to only include nearby nodes
        setGraphData(prev => {
            const filteredNodes = prev.nodes.filter(n => nearbyIds.has(n.id));
            const nodeIdSet = new Set(filteredNodes.map(n => n.id));
            const filteredLinks = prev.links.filter(l => {
                const src = l.source?.id ?? l.source;
                const tgt = l.target?.id ?? l.target;
                return nodeIdSet.has(src) && nodeIdSet.has(tgt);
            });

            // Only update if the count actually changed
            if (filteredNodes.length === prev.nodes.length) return prev;

            console.log(`[CodeVis] Rolling Window: shrunk from ${prev.nodes.length} to ${filteredNodes.length} visible nodes`);
            return { nodes: filteredNodes, links: filteredLinks };
        });
    }, []);

    // ── Generate N-Step Sequence ─────────────────────────────────────
    // ── Event handlers ───────────────────────────────────────────────

    const handleModeChange = (newMode) => {
        setMode(newMode);
    };

    // Unified navigation: selecting a tab sets the right panel + the graph mode.
    // Pathfinder puts the graph into call-tree mode; everything else is the live
    // graph. (brain / documentation render as full-screen views — see below.)
    //
    // Switching tabs deliberately clears NOTHING. It used to reset the whole
    // debug state, which is why a selection never survived a tab switch.
    const selectTab = (key) => {
        setRightTab(key);
        if (workspaceLayout === 'graph') setWorkspaceLayout('split');
        handleModeChange(key === 'pathfinder' ? 'debug' : 'live');
    };

    const handleConfigChange = ({ activeDb: newDb, limits: newLimits, growthMode: newGrowth, growthSpeed: newGrowthSpeed, maxVisibleNodes: newMaxNodes, max3dNodes: newMax3d, freezeLayout: newFreeze, detailLevel: newLevel }) => {
        if (newDb !== undefined) setActiveDb(newDb);
        if (newMax3d !== undefined) setMax3dNodes(newMax3d);
        // The level goes to the BRIDGE, not just into local state: it decides
        // which labels are queried at all, which is a decision only the server
        // can act on. The reply arrives as a normal 'graph:init', so nothing
        // else here has to know a level changed.
        if (newLevel !== undefined && newLevel !== detailLevel) {
            setDetailLevel(newLevel);
            // Same in-flight flag the filter uses. A level change is not a
            // 300ms affair: going to level 2 or 3 the first time reads the whole
            // syntax tree, measured at 25–29 seconds on this project. Without a
            // sign that anything is happening, that is indistinguishable from a
            // control that does nothing — which is how this one got removed the
            // first time. Cleared by the 'graph:init' that answers it.
            setScopePending(true);
            socketRef.current?.emit('graph:setLevel', { level: newLevel });
        }
        if (newLimits) setLimits(newLimits);
        if (newGrowth !== undefined) setGrowthMode(newGrowth);
        if (newGrowthSpeed !== undefined) setGrowthSpeed(newGrowthSpeed);
        // The Settings panel and the filter on the canvas write the SAME number.
        // They used to be two separate caps: this one sliced the node list at an
        // arbitrary position (storage order, no ranking, no edges), the other
        // ranked by degree, and neither told the bridge anything. Infinity here
        // means "no budget" and is stored as 0.
        if (newMaxNodes !== undefined) {
            setNodeBudget(Number.isFinite(newMaxNodes) ? Math.max(1, Math.floor(newMaxNodes)) : 0);
        }
        if (newFreeze !== undefined) setFreezeLayout(newFreeze);
    };

    // Loads the CALLS/RENDERS tree that the Pathfinder steps through. Split out
    // of handleNodeClick so it can also run when the user arrives at the tab
    // with a node already selected — otherwise the stepper rendered with an
    // empty tree and only a fresh click on the same node repaired it.
    const loadTrace = useCallback(async (nodeId) => {
        const current = beginGraphRequest();
        if (routeResult) setExploreGraphData(null);
        setRouteResult(null);
        setDebugPath([nodeId]);
        setDebugBranches([]);
        try {
            // encodeURIComponent, not raw interpolation: node ids are uids like
            // `File||path=src/app.py`, and an unescaped `=`/`|` in a query string
            // turns into a different request than the one intended.
            const res = await fetch(
                `${BRIDGE_URL}/api/debug/paths?startNode=${encodeURIComponent(nodeId)}&direction=${traceDirection}`
            );
            const data = await res.json();
            if (!current()) return;
            if (data.tree) {
                dfsTreeRef.current = data.tree;
                setDfsTree(data.tree);
                setDebugStep(0);
                const children = data.tree.children || [];
                setDebugBranches(children.map(c => c.id));
            } else {
                dfsTreeRef.current = null;
                setDfsTree(null);
            }
        } catch (err) {
            if (!current()) return;
            console.error('[CodeVis] Pathfinder: failed to fetch call tree:', err);
            dfsTreeRef.current = null;
            setDfsTree(null);
        }
    }, [routeResult, traceDirection]);

    const findRoute = useCallback(async ({ targetNode, relations }) => {
        if (selectedNode == null || !targetNode) return null;
        const current = beginGraphRequest();
        const res = await fetch(`${BRIDGE_URL}/api/pathfinder/route`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                startNode: selectedNode,
                targetNode,
                direction: traceDirection,
                relations,
                maxHops: 8,
                maxPaths: 3,
                db: activeDb,
            }),
        });
        const data = await res.json().catch(() => ({}));
        if (!current()) return null;
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

        setRouteResult(data);
        if (data.status === 'OK') {
            setFocusNodeId(null);
            setExploreGraphData(data.graph);
            dfsTreeRef.current = data.tree;
            setDfsTree(data.tree);
            setSequentialMode(true);
            setDebugStep(0);
        } else {
            setExploreGraphData(null);
        }
        return data;
    }, [activeDb, selectedNode, traceDirection]);

    const handleNodeClick = useCallback(async (nodeId, event) => {
        setNodeActionMenu({ nodeId });
        if (selectedNode === nodeId) return;
        setContextRequest(null);
        invalidateGraphRequests();
        const info = getNodeInfo(nodeId);
        setSelectedNode(nodeId);
        setCallStack([info]);

        // The tree walk (CALLS|RENDERS *1..6) can saturate the DB on high-degree
        // nodes and only the Pathfinder uses it — so it stays gated to that tab.
        if (mode !== 'debug') return;
        await loadTrace(nodeId);
    }, [mode, selectedNode, getNodeInfo, loadTrace]);

    const showContextSubgraph = useCallback(async (nodeId, hops = 1) => {
        const current = beginGraphRequest();
        setContextRequest({ nodeId, hops, pending: true, isCurrent: current });
        try {
            const res = await fetch(`${BRIDGE_URL}/api/graph/subgraph`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ uids: [nodeId], ipv6s: [], expand: hops, db: activeDb }),
                signal: AbortSignal.timeout(60000),
            });
            const data = await res.json();
            if (!current()) return;
            if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
            if (!data.nodes?.length) throw new Error('This node is no longer in the graph. Refresh the dashboard.');
            setRouteResult(null);
            setFocusNodeId(null);
            setExploreGraphData(data);
            setSelectedNode(nodeId);
            setCallStack([data.nodes?.find((n) => n.id === nodeId) || getNodeInfo(nodeId)]);
            setNodeActionMenu(null);
            setContextRequest(null);
        } catch (err) {
            if (!current()) return;
            setContextRequest({ nodeId, hops, pending: false, isCurrent: current,
                error: err.name === 'TimeoutError' ? 'Loading connections timed out.' : `Could not load connections: ${err.message}` });
            console.error('[CodeVis] Context subgraph error:', err);
        }
    }, [activeDb, getNodeInfo]);

    const inspectSearchResult = (id) => {
        setSearchOpen(false);
        clearTrace();
        setMode('live');
        setSelectedNode(id);
        setRightTab('inspector');
        setWorkspaceLayout('split');
        showContextSubgraph(id);
    };

    const highlightInspectorRelationship = useCallback(async ({ source, target, relType }) => {
        const current = captureGraphRequest();
        const linkKey = `${source}->${target}`;
        replaceActiveLinks([linkKey]);

        const workingGraph = exploreGraphData || graphData;
        const hasSource = workingGraph.nodes.some((node) => node.id === source);
        const hasTarget = workingGraph.nodes.some((node) => node.id === target);
        const hasLink = workingGraph.links.some((link) =>
            (link.source?.id ?? link.source) === source
            && (link.target?.id ?? link.target) === target
            && (!relType || link.relType === relType)
        );
        if (hasSource && hasTarget && hasLink) return;

        try {
            const res = await fetch(`${BRIDGE_URL}/api/graph/subgraph`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ uids: [source, target], ipv6s: [], expand: 0, db: activeDb }),
            });
            const data = await res.json();
            if (!current()) return;
            if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
            appendCachedGraph(data);
            const merge = (current) => ({
                ...current,
                nodes: [...current.nodes, ...(data.nodes || []).filter((node) => !current.nodes.some((existing) => existing.id === node.id))],
                links: [...current.links, ...(data.links || []).filter((link) => {
                    const from = link.source?.id ?? link.source;
                    const to = link.target?.id ?? link.target;
                    return !current.links.some((existing) =>
                        (existing.source?.id ?? existing.source) === from
                        && (existing.target?.id ?? existing.target) === to
                        && existing.relType === link.relType
                    );
                })],
            });
            if (exploreGraphData) setExploreGraphData(merge);
            else setGraphData(merge);
        } catch (err) {
            console.error('[CodeVis] Inspector relationship load failed:', err);
        }
    }, [activeDb, appendCachedGraph, exploreGraphData, graphData, replaceActiveLinks]);

    // Arriving at the Pathfinder with a selection made elsewhere: fetch the tree
    // it needs. This is what makes a shared selection actually usable across
    // tabs rather than merely preserved.
    useEffect(() => {
        if (rightTab !== 'pathfinder' || selectedNode == null) return;
        if (dfsTreeRef.current) return;
        loadTrace(selectedNode);
    }, [rightTab, selectedNode, loadTrace]);



    const handleStepChange = useCallback((newStep) => {
        setDebugStep(newStep);
    }, []);

    // ── How much graph, and of what ──────────────────────────────────
    // One budget, one type selection, one isolated-node switch — all three live
    // here rather than inside the filter, because the Settings panel offers the
    // same budget and two components each owning a copy is how you end up with
    // two caps that disagree. They are sent to the BRIDGE (POST
    // /api/graph/scope): the budget decides what is loaded, not merely what is
    // drawn, and the bridge spends it along the edges so a smaller number still
    // yields a connected net.
    const {
        graphScope, includeIsolated, nodeBudget, nodeFilter, scopePending, scopeError, retryScope, typeVisibility,
        refreshFromBridge, setGraphScope, setIncludeIsolated, setNodeBudget,
        setScopePending, setTypeVisibility,
    } = useGraphScope({ dashboard, activeDb, detailLevel, setActiveDb, setDetailLevel });
    // Counts per type for the filter's checkboxes. From the bridge's census of
    // the WHOLE database, not from the nodes on screen: a type that was switched
    // off has none loaded, and a checkbox reading "0" next to a type the project
    // has 904 of is worse than showing no number.
    const typeCounts = useMemo(() => {
        const c = { ...(graphScope?.labelCounts || {}) };
        if (!graphScope?.labelCounts) {
            for (const n of graphData.nodes) {
                for (const l of (n.labels || [])) c[l] = (c[l] || 0) + 1;
            }
        }
        // A query result brings its own types, and the bridge's census does not
        // list them: at architecture level it reports six labels, so an atomic
        // result put 6684 ASTNodes on screen with no checkbox to switch them
        // off. Whatever is drawn gets a row in the filter.
        if (exploreGraphData) {
            const inResult = {};
            for (const n of exploreGraphData.nodes) {
                for (const l of (n.labels || [])) inResult[l] = (inResult[l] || 0) + 1;
            }
            for (const [label, n] of Object.entries(inResult)) {
                c[label] = Math.max(c[label] || 0, n);
            }
        }
        return c;
    }, [graphScope, graphData, exploreGraphData]);

    // Which labels the filter offers a row for. `levelLabels` is the bridge's
    // list for the current detail level and takes precedence over the counts —
    // so on architecture level the panel listed six types while the canvas drew
    // eleven, and the 6684 ASTNodes had no switch. A query result's own types
    // are added to that list.
    const filterLabels = useMemo(() => {
        const base = graphScope?.levelLabels;
        if (!exploreGraphData) return base?.length ? base : null;
        const set = new Set(base || []);
        for (const n of exploreGraphData.nodes) {
            for (const l of (n.labels || [])) set.add(l);
        }
        return set.size ? [...set] : null;
    }, [graphScope, exploreGraphData]);

    // Die aufgelöste Farbtabelle. Bekannte Typen behalten ihren Anker — Farben
    // merkt man sich, und ein Umlernen bei jedem Rebuild wäre teurer als jede
    // Optimierung. Alles, was der Builder neu dazubekommt, wird hier eingefärbt,
    // und zwar maximal weit weg von den Typen, mit denen es Kanten teilt.
    const palette = useMemo(
        () => buildPalette(
            Object.keys(typeCounts),
            graphScope?.labelAdjacency || {}
        ),
        [typeCounts, graphScope]
    );

    const visibleGraphData = useMemo(() => {
        // An Explore result is the WORKING SET, not a frozen picture: it replaces
        // what the detail level would have loaded, and from there the ordinary
        // rules apply again — filter, cap, expanding a node. It used to be
        // returned verbatim so that the graph matched the result table exactly.
        // That guarantee held for one instant and cost every interaction after
        // it: no filtering, and expanding did nothing. It now holds for the
        // moment of the query, and the banner says when you have moved on.
        const sourceGraphData = exploreGraphData || graphData;

        // A query result is already a deliberate selection, so the node budget
        // — a browsing aid for "show me some of this database" — does not apply
        // to it: everything the query matched is loaded, and the filter panel
        // is what narrows it down from there. `@raw` additionally keeps the
        // containment edges that the architecture level hides, which is what
        // makes atomic nodes hang together instead of floating.
        //
        // The type filter ALWAYS applies, query result or not. It briefly did
        // not under `@raw`, and the result was a filter panel whose checkboxes
        // did nothing — the one control that is supposed to narrow a result
        // down. Loading everything the query matched and choosing what to look
        // at are two different jobs: the query does the first, the panel does
        // the second.
        const isQueryResult = Boolean(exploreGraphData);
        const rawResult = Boolean(exploreGraphData?.raw);

        // `@types Function,Class` (or `@types *`) in the query overrides the
        // panel for this result — the types you want are part of the question,
        // and hunting for checkboxes after every run is not.
        const queryTypes = exploreGraphData?.types ?? null;

        let nodesToUse = sourceGraphData.nodes;
        let hiddenIds = new Set();

        // Apply type filter (visible flags) + global max-nodes cap
        if (queryTypes === '*') {
            // every type, nothing hidden
        } else if (Array.isArray(queryTypes) && queryTypes.length > 0) {
            const wanted = new Set(queryTypes.map((t) => t.toLowerCase()));
            nodesToUse = nodesToUse.filter((n) => {
                if ((n.labels || []).some((l) => wanted.has(String(l).toLowerCase()))) return true;
                hiddenIds.add(n.id);
                return false;
            });
        } else if (nodeFilter) {
            const visMap = nodeFilter.visible || nodeFilter;
            nodesToUse = nodesToUse.filter(n => {
                const labels = n.labels || [];
                // Find first label that is *known* to the filter (visMap has the key)
                const knownLabel = labels.find(l => l in visMap);
                // Unknown labels (not in visMap at all) default to visible —
                // prevents new node types from being silently hidden.
                if (knownLabel == null) return true;
                if (!visMap[knownLabel]) {
                    hiddenIds.add(n.id);
                    return false;
                }
                return true;
            });

            // At atomic detail levels (2/3) the user explicitly asked for the full
            // parse — bypass the node cap, otherwise the arbitrary slice drops most
            // atomic nodes' parents and the link filter then strips their edges,
            // leaving disconnected floating nodes.
            const cap = (detailLevel > 1 || isQueryResult) ? null : nodeFilter.maxNodes;
            if (cap != null && nodesToUse.length > cap) {
                // Which 500 of 2400 — this used to be slice(0, cap), i.e. the
                // first ones the database happened to return. That query has no
                // ORDER BY, so the order is storage order, and the result was a
                // screen full of Functions with whole node types never appearing
                // at all. Rank by how connected a node is instead: the hubs are
                // what a capped overview should show, and every type that has
                // well-connected members gets in on merit.
                const degree = new Map();
                for (const l of sourceGraphData.links) {
                    const s = l.source?.id ?? l.source;
                    const t = l.target?.id ?? l.target;
                    degree.set(s, (degree.get(s) || 0) + 1);
                    degree.set(t, (degree.get(t) || 0) + 1);
                }
                const ranked = [...nodesToUse].sort(
                    (a, b) => (degree.get(b.id) || 0) - (degree.get(a.id) || 0)
                );
                for (const n of ranked.slice(cap)) hiddenIds.add(n.id);
                nodesToUse = ranked.slice(0, cap);
            }
        }

        // A second, unranked slice(0, maxVisibleNodes) stood here — a different
        // cap, from a different slider, cutting the list wherever it happened to
        // end. Both sliders now write the same budget, and the budget is spent
        // by the bridge along the edges.

        const nodeSet = new Set(nodesToUse.map(n => n.id));

        // Build transitive edges through hidden hub nodes (File, Module).
        // If A→Hidden→B and both A,B are visible, create a virtual A→B edge.
        const transitiveLinks = [];
        if (hiddenIds.size > 0) {
            const inEdges = new Map();  // hiddenId → [sourceId, ...]
            const outEdges = new Map(); // hiddenId → [targetId, ...]
            for (const l of sourceGraphData.links) {
                const src = l.source?.id ?? l.source;
                const tgt = l.target?.id ?? l.target;
                if (hiddenIds.has(src) && nodeSet.has(tgt)) {
                    if (!outEdges.has(src)) outEdges.set(src, []);
                    outEdges.get(src).push(tgt);
                }
                if (hiddenIds.has(tgt) && nodeSet.has(src)) {
                    if (!inEdges.has(tgt)) inEdges.set(tgt, []);
                    inEdges.get(tgt).push(src);
                }
            }
            const seen = new Set();
            for (const hid of hiddenIds) {
                const ins = inEdges.get(hid) || [];
                const outs = outEdges.get(hid) || [];
                for (const a of ins) {
                    for (const b of outs) {
                        if (a === b) continue;
                        const key = `${a}->${b}`;
                        if (!seen.has(key)) {
                            seen.add(key);
                            transitiveLinks.push({ source: a, target: b, relType: 'IMPORTS' });
                        }
                    }
                }
            }
        }

        // Keep direct links where both endpoints are visible AND the relationship
        // type is meaningful (Task A: hide structural/containment edges).
        const safeLinks = sourceGraphData.links
            .filter(l => {
                // Hide structural/containment edges only on the architecture level
                // (level 1). On atomic levels (2/3) CONTAINS is the actual structure —
                // hiding it would leave every variable/AST node disconnected.
                if (detailLevel === 1 && !rawResult && HIDDEN_LINK_TYPES.has(l.relType)) return false;
                const src = l.source?.id ?? l.source;
                const tgt = l.target?.id ?? l.target;
                return nodeSet.has(src) && nodeSet.has(tgt);
            })
            .map(l => ({
                ...l,
                source: l.source?.id ?? l.source,
                target: l.target?.id ?? l.target
            }));

        let outNodes = nodesToUse;
        let outLinks = [...safeLinks, ...transitiveLinks];

        // Task B: Knowledge focus = 1-hop neighbor filter (no camera move).
        // When a focus node is set, show only that node + its directly connected
        // neighbors (via any link), plus the links among that neighborhood.
        // Neighbors are derived from the ORIGINAL graphData.links so that focusing
        // works even on edges that the declutter filter would otherwise hide.
        if (focusNodeId != null) {
            const neighborIds = new Set([focusNodeId]);
            for (const l of sourceGraphData.links) {
                const src = l.source?.id ?? l.source;
                const tgt = l.target?.id ?? l.target;
                if (src === focusNodeId) neighborIds.add(tgt);
                if (tgt === focusNodeId) neighborIds.add(src);
            }
            // ALWAYS apply the focus — a lone focus node is honest feedback
            // ("nothing linked yet"), silently keeping the full graph is not.
            // The focus node itself is pulled from the unfiltered data so it
            // shows even when the type filter or node cap dropped it.
            let focusedNodes = outNodes.filter(n => neighborIds.has(n.id));
            if (!focusedNodes.some(n => n.id === focusNodeId)) {
                const focusNode = sourceGraphData.nodes.find(n => n.id === focusNodeId);
                if (focusNode) focusedNodes = [focusNode, ...focusedNodes];
            }
            if (focusedNodes.length > 0) {
                outNodes = focusedNodes;
                const focusNodeSet = new Set(outNodes.map(n => n.id));
                // Links from the ORIGINAL data, not the declutter-filtered set:
                // the edge that connects knowledge to its code (APPLIES_TO) may
                // be hidden at this detail level, but inside a focus it IS the
                // structure the user asked to see.
                outLinks = sourceGraphData.links
                    .filter(l => {
                        const src = l.source?.id ?? l.source;
                        const tgt = l.target?.id ?? l.target;
                        return focusNodeSet.has(src) && focusNodeSet.has(tgt);
                    })
                    .map(l => ({ ...l, source: l.source?.id ?? l.source, target: l.target?.id ?? l.target }));
            }
        }

        return { nodes: outNodes, links: outLinks };
    }, [graphData, exploreGraphData, nodeFilter, detailLevel, focusNodeId]);

    // How much of a query result the type filter is currently swallowing, and
    // which types to switch on to get it back. Without this the panel reads as
    // broken: the query reports 62 hits, the canvas draws 14, and nothing on
    // screen connects those two numbers to a checkbox.
    const filteredOutResult = useMemo(() => {
        if (!exploreGraphData || focusNodeId != null) return null;
        const total = exploreGraphData.nodes.length;
        const hidden = total - visibleGraphData.nodes.length;
        if (hidden <= 0) return null;
        const shown = new Set(visibleGraphData.nodes.map((n) => n.id));
        const visMap = nodeFilter?.visible || {};
        const byLabel = new Map();
        for (const n of exploreGraphData.nodes) {
            if (shown.has(n.id)) continue;
            const labels = n.labels || [];
            const label = labels.find((l) => l in visMap && !visMap[l]) || labels[0] || 'unknown';
            byLabel.set(label, (byLabel.get(label) || 0) + 1);
        }
        const types = [...byLabel.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 4)
            .map(([label, n]) => `${label} (${n})`);
        return { total, hidden, types };
    }, [exploreGraphData, visibleGraphData, nodeFilter, focusNodeId]);

    // Too many nodes for the 3D mesh-per-node path → transparently render 2D.
    // The toggle keeps showing the user's chosen mode; the force-2D banner
    // explains the override. Falls back to 3D automatically once the node
    // count drops (e.g. detail level lowered).
    const effectiveViewMode =
        (viewMode === '3d' && visibleGraphData.nodes.length > max3dNodes) ? '2d' : viewMode;
    const force2d = effectiveViewMode !== viewMode;

    const restoreNavigation = useCallback(({ tab, nodeId, layout }) => {
        clearTrace();
        setContextRequest(null);
        setExploreGraphData(null);
        setNodeActionMenu(null);
        setSelectedNode(nodeId);
        setRightTab(tab);
        setWorkspaceLayout(layout);
        setMode(tab === 'pathfinder' ? 'debug' : 'live');
        setFocusNodeId(nodeId);
        setCallStack(nodeId == null ? [] : [getNodeInfo(nodeId)]);
        // A previous selection may have come from a temporary Context/Explore
        // graph. Reload its neighborhood rather than storing graph copies in history.
        if (nodeId != null && tab !== 'pathfinder' && !fullGraphRef.current.nodes.some(node => node.id === nodeId)) {
            showContextSubgraph(nodeId);
        }
    }, [clearTrace, getNodeInfo, showContextSubgraph]);
    const navigation = useNavigationHistory({ workspace: activeDb, tab: rightTab, nodeId: selectedNode,
        layout: workspaceLayout, onRestore: restoreNavigation });

    const fullScreen = FULL_SCREEN_TABS.has(rightTab);
    const fullScreenView = fullScreen ? (
            <FullScreenTabShell workspaceReady={workspaceReady} projectRoot={projectRoot} onSearch={() => setSearchOpen(true)} activeDb={activeDb} activeTab={rightTab} bridgeUrl={BRIDGE_URL} connected={connected} extractors={extractors} onSelectTab={selectTab} tabs={TABS} navigation={navigation}
                onLayoutChange={layout => { if (layout !== 'panel') { setRightTab('kanban'); setWorkspaceLayout(layout); } }}>
                {rightTab === 'brain'
                    ? <BrainTab key={activeDb} socket={socket} db={activeDb} />
                    : rightTab === 'spec'
                        ? <SpecTab key={activeDb} socket={socket} db={activeDb} pendingSpecId={pendingSpec} onPendingConsumed={() => setPendingSpec(null)} />
                        : rightTab === 'classes'
                            ? <ClassDiagramTab db={activeDb} />
                            : rightTab === 'ros'
                            ? <RosTab db={activeDb} />
                            : rightTab === 'diagrams'
                                        ? <DiagramsTab db={activeDb} onOpen={(specId) => { setPendingSpec(specId); selectTab('spec'); }} />
                                        : <DocumentationPanel />}
            </FullScreenTabShell>
    ) : null;

    return (
        <>
        <div
            ref={gridRef}
            style={{
                display: fullScreen ? 'none' : 'grid',
                gridTemplateAreas: workspaceLayout === 'split'
                    ? terminalVisible ? '"header header header" "graph divider kanban" "graph divider split" "graph divider terminal" "status status status"' : '"header header header" "graph divider kanban" "status status status"'
                    : workspaceLayout === 'graph' ? '"header" "graph" "status"'
                    : terminalVisible ? '"header" "kanban" "split" "terminal" "status"' : '"header" "kanban" "status"',
                gridTemplateColumns: workspaceLayout === 'split' ? `minmax(0, ${horizontalSplit.split}fr) 6px minmax(0, ${1 - horizontalSplit.split}fr)` : 'minmax(0, 1fr)',
                // Rows 1 and 3 share the column; the 6px strip between them is the
                // drag handle. fr units keep the split proportional when the window
                // is resized, which a px height would not.
                gridTemplateRows: workspaceLayout === 'graph' || !terminalVisible ? 'auto minmax(0, 1fr) 32px' : `auto minmax(0, ${rightSplit}fr) 6px minmax(0, ${1 - rightSplit}fr) 32px`,
                height: '100vh',
                width: '100vw',
                background: 'var(--bg)',
                color: 'var(--text)',
            }}
            className="app-grid"
            data-layout={workspaceLayout}
            data-terminal={terminalVisible ? 'visible' : 'hidden'}
        >
            {/* Bridge connection banner */}
            {connected === false && (
                <div
                    style={{
                        position: 'fixed',
                        top: 0,
                        left: 0,
                        right: 0,
                        zIndex: 2000,
                        padding: '8px 16px',
                        background: '#ef4444',
                        color: '#ffffff',
                        fontSize: 13,
                        fontWeight: 600,
                        textAlign: 'center',
                        boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
                    }}
                >
                    No connection to the bridge ({BRIDGE_URL})
                </div>
            )}

            <WorkspaceHeader workspaceReady={workspaceReady} projectRoot={projectRoot} onSearch={() => setSearchOpen(true)} terminalOpen={terminalVisible}
                onToggleTerminal={!webShellEnabled ? () => setTerminalOpen(value => !value) : undefined}
                activeDb={activeDb} activeTab={rightTab} extractors={extractors}
                tabs={TABS} onSelectTab={selectTab} layout={workspaceLayout} onLayoutChange={setWorkspaceLayout} navigation={navigation} />
            {terminalVisible && <PanelDivider value={rightSplit} onChange={setRightSplit} onDrag={setSplitDragging} dragging={splitDragging} />}
            <PanelDivider axis="horizontal" value={horizontalSplit.split} onChange={horizontalSplit.setSplit}
                onDrag={horizontalSplit.setDragging} dragging={horizontalSplit.dragging} defaultValue={0.5} />

            <GraphPanel
                contextRequest={contextRequest?.isCurrent() ? contextRequest : null}
                active={!fullScreen && workspaceLayout !== 'panel'}
                detailLevel={detailLevel}
                onDetailLevelChange={level => handleConfigChange({ detailLevel: level })}
                onFreezeChange={() => setFreezeLayout(value => !value)}
                activeLinks={activeLinks}
                bridgeUrl={BRIDGE_URL}
                connected={connected}
                debugBranches={debugBranches}
                debugPath={debugPath}
                effectiveViewMode={effectiveViewMode}
                exploreGraphActive={exploreGraphData != null}
                filteredOutResult={filteredOutResult}
                filterLabels={filterLabels}
                focusNodeId={focusNodeId}
                freezeLayout={freezeLayout}
                graphPanelRef={graphPanelRef}
                graphScope={graphScope}
                graphLoadedEmpty={receivedGraphNodeCount === 0}
                highlightedNodes={highlightedNodes}
                includeIsolated={includeIsolated}
                nodeActionMenu={nodeActionMenu}
                nodeBudget={nodeBudget}
                onBudgetChange={setNodeBudget}
                onClearFocus={() => setFocusNodeId(null)}
                onClearQuery={() => { invalidateGraphRequests(); setContextRequest(null); setExploreGraphData(null); setFocusNodeId(null); }}
                onCloseNodeActions={() => setNodeActionMenu(null)}
                onIncludeIsolatedChange={setIncludeIsolated}
                onInspectNode={() => { selectTab('inspector'); setNodeActionMenu(null); }}
                onNodeClick={handleNodeClick}
                onShowContext={showContextSubgraph}
                onTypeVisibilityChange={setTypeVisibility}
                onViewModeChange={setViewMode}
                palette={palette}
                scopePending={scopePending}
                scopeError={scopeError}
                onRetryScope={retryScope}
                selectedNode={selectedNode}
                sequentialMode={sequentialMode}
                sourceGraphEmpty={graphData.nodes.length === 0}
                typeCounts={typeCounts}
                typeVisibility={typeVisibility}
                viewMode={viewMode}
                visibleGraphData={visibleGraphData}
            />


            <DashboardSidePanel
                activeDb={activeDb}
                activeTab={rightTab}
                connected={connected}
                callStack={callStack}
                dbTotal={graphScope?.total || 0}
                debugSequence={debugSequence}
                debugStep={debugStep}
                detailLevel={detailLevel}
                extractors={extractors}
                exploreGraphData={exploreGraphData}
                freezeLayout={freezeLayout}
                graphData={graphData}
                graphLoadable={graphScope?.loadable || 0}
                typeCounts={typeCounts}
                growthMode={growthMode}
                growthSpeed={growthSpeed}
                max3dNodes={max3dNodes}
                nodeBudget={nodeBudget}
                onCardHover={setHighlightedNodes}
                onConfigChange={handleConfigChange}
                onExpandAst={handleExpandAst}
                onSearch={() => setSearchOpen(true)}
                onInspectSearchResult={inspectSearchResult}
                onInspectContextNode={(id) => {
                    invalidateGraphRequests();
                    setSelectedNode(id);
                    setNodeActionMenu(null);
                    setRightTab('inspector');
                }}
                onRefresh={refreshFromBridge}
                onResetPathfinder={resetSelection}
                onResultGraph={(subgraph) => { invalidateGraphRequests(); setContextRequest(null); setFocusNodeId(null); setExploreGraphData(subgraph); }}
                onSelectGraphNode={(id) => { setFocusNodeId(id); handleNodeClick(id); }}
                onSelectInspectorRelationship={highlightInspectorRelationship}
                onSelectTab={selectTab}
                onFindRoute={findRoute}
                onSequentialChange={setSequentialMode}
                onTraceDirectionChange={(direction) => {
                    if (routeResult) setExploreGraphData(null);
                    setRouteResult(null);
                    dfsTreeRef.current = null;
                    setDfsTree(null);
                    setTraceDirection(direction);
                }}
                onShowContext={showContextSubgraph}
                onStepChange={handleStepChange}
                pending={scopePending}
                scopeError={scopeError}
                onRetryScope={retryScope}
                selectedNode={selectedNode}
                sequentialMode={sequentialMode}
                routeResult={routeResult}
                traceDirection={traceDirection}
                tabs={TABS}
                socket={socket}
            />

            {/* Terminal Panel — 40% right bottom */}
            {terminalVisible && <div
                id="terminal-container"
                style={{
                    gridArea: 'terminal',
                    overflow: 'hidden',
                    background: 'var(--surface)',
                    borderTop: '1px solid var(--border)',
                }}
            >
                <TerminalPanel />
            </div>}

            {/* Status Bar — full width bottom, 32px */}
            <div
                id="status-bar"
                style={{
                    gridArea: 'status',
                    height: '32px',
                    display: 'flex',
                    alignItems: 'center',
                    padding: '0 12px',
                    background: 'var(--surface)',
                    borderTop: '1px solid var(--border)',
                    fontSize: '12px',
                    color: 'var(--muted)',
                    gap: '16px',
                }}
            >
                <StatusBar force2d={force2d} capped={capped} db={activeDb} socket={socket} connected={connected} />
            </div>
        </div>
        {fullScreenView}
        {searchOpen && <NodeSearchDialog key={activeDb} db={activeDb} onClose={() => setSearchOpen(false)} onSelect={inspectSearchResult} />}
        </>
    );
}

export default App;

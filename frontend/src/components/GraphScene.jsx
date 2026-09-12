import { useRef, useCallback, useMemo, useEffect, useState } from 'react';
import ForceGraph3D from 'react-force-graph-3d';
import ForceGraph2D from 'react-force-graph-2d';
import * as THREE from 'three';
import { NODE_COLORS, colorForNode } from '../nodePalette';
import { buildLinkLabel, buildNodeLabel, getLinkWidth } from '../graph/presentationModel';
import { clearTextSpriteCache, disposeResourceMap, makeTextSprite } from '../graph/threeResources';
import useForceLayout from '../hooks/useForceLayout';
import useTheme from '../hooks/useTheme';

// Above this node count the 3D path stops minting a text sprite per domain node
// (each sprite is its own canvas texture). Emphasised/hub/conflict nodes keep
// their labels; everything else relies on the hover tooltip. Keeps Full-atomic
// (Level 3) from drowning the renderer in thousands of textures.
const MAX_3D_LABELS = 1500;

/**
 * Node count above which the 2D canvas drops its decorative per-node work.
 *
 * The canvas renderer does not cull: every node and every link is drawn on
 * every frame, and each one runs the callbacks we hand it. Custom shapes, the
 * separate hit-test pass and arrow heads therefore cost three passes over the
 * whole graph per frame — which is what makes it crawl long before the raw
 * node count would.
 */
const BULK_2D_THRESHOLD = 3000;

// Farben leben in ../nodePalette.js — dieselbe Tabelle, aus der auch GraphFilter
// seine Punkte färbt. Zwei Kopien sind auseinandergelaufen (Epic stand nur im
// Filter und wurde hier grau gerendert); eine Tabelle kann das nicht.

const EDGE_COLORS = {
    CALLS: 'rgba(148, 163, 184, 0.52)',
    RENDERS: 'rgba(167, 139, 250, 0.58)',
    PASSES_PROP: 'rgba(52, 211, 153, 0.56)',
    IMPORTS: 'rgba(100, 116, 139, 0.42)',
    HANDLES: 'rgba(251, 191, 36, 0.58)',
    FETCHES: 'rgba(244, 114, 182, 0.58)',
    READS_STATE: 'rgba(52, 211, 153, 0.46)',
    WRITES_STATE: 'rgba(251, 146, 60, 0.52)',
    RETURNS: 'rgba(34, 211, 238, 0.48)',
    default: 'rgba(100, 116, 139, 0.38)'
};

// 3D renders on a dark canvas — edges need lighter, more saturated hues there.
// SOLID hex only: THREE.Color cannot parse rgba() strings (the alpha breaks
// parsing and the lines render black-on-black = invisible). Transparency for
// 3D links is controlled exclusively via the linkOpacity prop.
const EDGE_COLORS_3D = {
    CALLS: '#94a3b8',
    RENDERS: '#a78bfa',
    PASSES_PROP: '#34d399',
    IMPORTS: '#64748b',
    HANDLES: '#fbbf24',
    FETCHES: '#f472b6',
    READS_STATE: '#34d399',
    WRITES_STATE: '#fb923c',
    RETURNS: '#22d3ee',
    AFFECTS: '#818cf8',
    APPLIES_TO: '#2dd4bf',
    REFERENCES: '#60a5fa',
    DERIVES: '#f472b6',
    AWAITS: '#7dd3fc',
    DATA_FLOWS_TO: '#c084fc',
    CALLS_CONDITIONALLY: '#fcd34d',
    // Diagram structure, plus the spec→code link. REALIZED_BY is the brightest
    // of them on purpose: it is the only edge that crosses from the diagram into
    // the code, and it is the thing the whole spec overlay exists to show.
    DECLARES: '#fda4af',
    INHERITS: '#fb7185',
    SPEC_RELATES: '#e879f9',
    REALIZED_BY: '#f43f5e',
    default: '#475569'
};

const EDGE_ACTIVE_COLORS = {
    CALLS: '#ffaa00',
    RENDERS: '#a855f7',
    PASSES_PROP: '#39ff85',
    IMPORTS: '#6b85c4',
    HANDLES: '#ffd700',
    FETCHES: '#ff6b9d',
    READS_STATE: '#39ff85',
    WRITES_STATE: '#ff8c42',
    RETURNS: '#00dcff',
    default: '#ffaa00'
};

const GLOW_INTENSITY = 0.6;
const NODE_BASE_SIZE = 6;
const DEBUG_ACTIVE_COLOR = '#ff8c42';
const DEBUG_TRAIL_COLOR = '#ff6b3d';
const DEBUG_BRANCH_COLOR = '#ffd700';

// HTML-escape for tooltip interpolation. Tooltip content is rendered via
// innerHTML by react-force-graph, and node names / file paths / code
// snippets / braindump text are NOT trusted — a function named
// `</div><img onerror=…>` in a scanned repo must not execute here.
// Text sprite cache — avoids recreating canvases for the same label
const GraphScene = ({ graphData, palette = NODE_COLORS, activeLinks, debugNode, debugPath, debugBranches, debugEdges, freezeLayout, onNodeClick, highlightedNodes, viewMode = '2d', focusNodeId, width, height, fitRequest = 0, active = true }) => {
    const [theme] = useTheme();
    const darkTheme = theme === 'dark';
    const graphBackground = darkTheme ? '#0d1426' : '#edf2f8';
    const fgRef = useRef();
    const fg2dRef = useRef();
    const clockRef = useRef(new THREE.Clock());
    useEffect(() => {
        if (!fitRequest) return;
        const renderer = viewMode === '2d' ? fg2dRef.current : fgRef.current;
        renderer?.zoomToFit(350, 40);
    }, [fitRequest, viewMode]);

    // --- Agent lock color system: Lead = gold, Worker = cyan ---
    const LEAD_COLOR = '#ffd700';
    const WORKER_COLOR = '#84cc16';
    const getAgentColor = useCallback((agentId) => {
        if (!agentId) return WORKER_COLOR;
        if (agentId === 'lead' || agentId.startsWith('lead-')) return LEAD_COLOR;
        return WORKER_COLOR;
    }, []);

    // --- Cached geometries for node shapes (Knowledge=cylinder, Task=octahedron) ---
    const knowledgeGeo = useMemo(() => new THREE.CylinderGeometry(NODE_BASE_SIZE * 0.8, NODE_BASE_SIZE * 0.8, NODE_BASE_SIZE * 0.6, 16), []);
    const taskGeo = useMemo(() => new THREE.OctahedronGeometry(NODE_BASE_SIZE * 0.9), []);
    // Spec nodes: a spiky tetrahedron. Spheres are code, cylinders Knowledge,
    // octahedra Tasks — this reads as "not code" from any angle, which matters
    // because a spec class and its code class share a name. Shared instance:
    // a large class diagram brings many member nodes, and one geometry per node
    // would cost for nothing.
    const specGeo = useMemo(() => new THREE.TetrahedronGeometry(NODE_BASE_SIZE * 1.0), []);
    // Epic: the dual compound of dodecahedron and icosahedron, drawn as two
    // interpenetrating wireframes at the same circumradius. Hollow is the whole
    // point — every other shape here is solid, so a cage reads as "this is a
    // container, the substance is the nodes inside it". The size is not
    // cosmetic: 60 edges shrunk to task scale turn into a smudge, so an Epic is
    // deliberately about twice a Task. Both geometries are shared instances for
    // the same reason specGeo is — 60 edges rebuilt per node would cost real
    // frames.
    const epicDodecaGeo = useMemo(() => new THREE.DodecahedronGeometry(NODE_BASE_SIZE * 2.0), []);
    const epicIcosaGeo = useMemo(() => new THREE.IcosahedronGeometry(NODE_BASE_SIZE * 2.0), []);
    // Die Farbe kommt aus der Palette, nicht aus einer Konstante hier — das war
    // der Fall, in dem Filter und Szene auseinanderliefen. Die Begründung für
    // den Ton selbst steht bei NODE_COLORS.Epic.
    // MeshBasic, not Phong — a wireframe cage should not pick up scene lighting,
    // or the far edges dim out and the compound stops reading as one figure.
    const epicWireMaterial = useMemo(() => new THREE.MeshBasicMaterial({
        color: new THREE.Color(NODE_COLORS.Epic),
        wireframe: true,
        transparent: true,
        opacity: 0.75,
    }), []);
    // Marker for a node with no edge anywhere in the graph. Without it such a
    // node is indistinguishable from one whose neighbours merely did not fit in
    // the budget — and "nothing points at this" is the only interesting thing
    // about it. Neutral grey on purpose: this is a statement about the code, not
    // a warning about it.
    // A shell, not a ring. A torus was tried first and is invisible from most of
    // the orbit: seen edge-on it collapses to a hairline, and in a 3D scene the
    // camera is edge-on to something at all times. A wireframe cage reads the
    // same from every angle, which is the only requirement a marker has.
    const isolatedShellGeo = useMemo(() => new THREE.IcosahedronGeometry(NODE_BASE_SIZE * 1.7, 1), []);
    const isolatedShellMaterial = useMemo(() => new THREE.MeshBasicMaterial({
        color: new THREE.Color('#94a3b8'),
        wireframe: true,
        transparent: true,
        opacity: 0.45,
        depthWrite: false,
    }), []);

    // Force-Simulation läuft im Web Worker (Stufe 1). Hier werden die
    // wrapper-internen Forces deaktiviert; der Worker liefert Positionen
    // pro Tick zurück und wir mutieren node.x/y/z direkt + refresh().
    const nodeCount = graphData?.nodes?.length || 0;
    // Beyond this the 2D canvas switches to bulk drawing: built-in circles, no
    // hit-test repaint, no arrow heads. Chosen at the point where the per-node
    // work starts to dominate the frame rather than the node count itself.
    const bulkMode2d = nodeCount > BULK_2D_THRESHOLD;
    const activeGraphRef = viewMode === '2d' ? fg2dRef : fgRef;
    useForceLayout({ graphRef: activeGraphRef, graphData, nodeCount, viewMode, nodeBaseSize: NODE_BASE_SIZE, active, frozen: freezeLayout, ready: Boolean(width && height) });

    // --- Knowledge focus ---
    // Focusing a node no longer moves the camera ("kein richtiges fly to").
    // Instead, App.jsx filters visibleGraphData down to the focus node + its
    // 1-hop neighborhood, so the focus is expressed purely as a content filter.
    // The camera fly-to that used to live here has been intentionally removed.

    // Primitive, not the graphData object: nodeThreeObject depending on
    // graphData identity would rebuild EVERY node's THREE group + text sprite
    // on each live trickle update from the bridge.
    const smallGraph = (graphData?.nodes?.length || 0) <= 150;
    // Sprite budget: below this, plain domain nodes still get labels; above it
    // only emphasised/hub/conflict nodes do (see MAX_3D_LABELS).
    const labelBudgetOk = (graphData?.nodes?.length || 0) <= MAX_3D_LABELS;

    // Degree per node (in+out) — drives node size so hubs read as hubs and
    // leaf noise stays small. Recomputed only when the dataset changes.
    //
    // The builder's stored `dbDegree` wins where it exists: it counts every edge
    // in the graph, while the lines on screen are only the ones this detail
    // level loaded. Sizing by what is drawn makes a node look like a leaf
    // whenever its neighbours were left out — the size then describes the view
    // instead of the code. Falls back to counting the loaded links on a graph
    // built before the property existed.
    const degreeById = useMemo(() => {
        const d = new Map();
        for (const l of (graphData?.links || [])) {
            const src = l.source?.id ?? l.source;
            const tgt = l.target?.id ?? l.target;
            d.set(src, (d.get(src) || 0) + 1);
            d.set(tgt, (d.get(tgt) || 0) + 1);
        }
        for (const n of (graphData?.nodes || [])) {
            if (typeof n.dbDegree === 'number') d.set(n.id, n.dbDegree);
        }
        return d;
    }, [graphData]);

    // Edges per node THAT ARE ON SCREEN, split by direction. Deliberately kept
    // apart from degreeById above (which prefers the builder's stored total):
    // the difference between the two is exactly how much of a node's
    // neighbourhood the current view is holding back, and that number is the
    // one worth putting in front of the user. Without it a node whose callers
    // fell outside the node budget is indistinguishable from one that has none.
    const visibleDegreeById = useMemo(() => {
        const m = new Map();
        const bump = (id, key) => {
            let e = m.get(id);
            if (!e) { e = { out: 0, in: 0 }; m.set(id, e); }
            e[key]++;
        };
        for (const l of (graphData?.links || [])) {
            bump(l.source?.id ?? l.source, 'out');
            bump(l.target?.id ?? l.target, 'in');
        }
        return m;
    }, [graphData]);

    // ── Hover ────────────────────────────────────────────────────────────
    // Hovering used to do nothing to the picture — you got text next to the
    // cursor and no orientation in the graph itself. Now the hovered node's
    // edges light up, so the tooltip says WHAT and the canvas says WHERE.
    const [hoverNodeId, setHoverNodeId] = useState(null);

    const hoverSets = useMemo(() => {
        if (hoverNodeId == null) return null;
        const neighbours = new Set([hoverNodeId]);
        const edgeKeys = new Set();
        for (const l of (graphData?.links || [])) {
            const src = l.source?.id ?? l.source;
            const tgt = l.target?.id ?? l.target;
            if (src !== hoverNodeId && tgt !== hoverNodeId) continue;
            neighbours.add(src);
            neighbours.add(tgt);
            edgeKeys.add(`${src}->${tgt}`);
        }
        return { neighbours, edgeKeys };
    }, [hoverNodeId, graphData]);

    const handleNodeHover = useCallback((node) => {
        setHoverNodeId(node ? node.id : null);
    }, []);

    // Sets for O(1) lookup
    const debugPathSet = useMemo(() => new Set(debugPath || []), [debugPath]);
    const debugBranchSet = useMemo(() => new Set(debugBranches || []), [debugBranches]);

    // Use passed debug edges directly
    const debugEdgeSet = useMemo(() => new Set(debugEdges || []), [debugEdges]);

    // Determine node color — cross-panel highlight > lock status > type labels
    const getNodeColor = useCallback((node) => {
        // Cross-panel hover highlight (highest priority)
        if (highlightedNodes?.has(node.name)) return '#ffffff';
        // Lock-status coloring
        if (node.lockStatus === 'conflict' || node.lockStatus === 'blocked') return '#ff4444';
        if (node.lockStatus === 'released') return '#39ff85';
        if (node.lockStatus === 'planned') return '#a855f7';
        if (node.locked && node.lockedBy) {
            return getAgentColor(node.lockedBy);
        }

        // Debug overlays
        if (node.id === debugNode) return DEBUG_ACTIVE_COLOR;
        if (debugBranchSet.has(node.id)) return DEBUG_BRANCH_COLOR;
        if (debugPathSet.has(node.id)) return DEBUG_TRAIL_COLOR;

        // Type-based fallback. Ein Label, für das die Palette keinen Eintrag
        // hat, bekommt dort eine aus dem Namen abgeleitete Farbe statt Grau —
        // sonst sind alle neuen Labels des Builders untereinander und vom
        // Default nicht zu unterscheiden.
        return colorForNode(node, palette);
    }, [debugNode, debugPathSet, debugBranchSet, getAgentColor, highlightedNodes, palette]);

    // Get node size based on type + connectivity + debug emphasis
    const getNodeSize = useCallback((node) => {
        if (highlightedNodes?.has(node.name)) return NODE_BASE_SIZE * 1.8;
        if (node.id === debugNode) return NODE_BASE_SIZE * 2.0;
        if (debugBranchSet.has(node.id)) return NODE_BASE_SIZE * 1.4;
        if (debugPathSet.has(node.id)) return NODE_BASE_SIZE * 1.1;

        let base = NODE_BASE_SIZE;
        if (node.labels?.includes('Endpoint')) base = NODE_BASE_SIZE * 1.2;
        else if (node.labels?.includes('Module')) base = NODE_BASE_SIZE * 0.8;
        else if (node.labels?.includes('Component')) base = NODE_BASE_SIZE * 1.1;
        else if (node.labels?.includes('State')) base = NODE_BASE_SIZE * 0.9;
        else if (node.labels?.includes('Variable')) base = NODE_BASE_SIZE * 0.7;
        else if (node.labels?.includes('ReturnValue')) base = NODE_BASE_SIZE * 0.7;
        else if (node.labels?.includes('File')) base = NODE_BASE_SIZE * 0.6;

        // Hubs grow with connectivity (log-scaled, capped at ~2×).
        const degree = degreeById.get(node.id) || 0;
        return base * Math.min(2.0, 1 + Math.log2(1 + degree) * 0.18);
    }, [debugNode, debugPathSet, debugBranchSet, highlightedNodes, degreeById]);

    // --- Performance Caches ---
    const geoCache = useRef({});
    const matCache = useRef({});

    // Clear caches whenever graphData changes so colors are recomputed correctly.
    // The module-level spriteCache (label textures) is also bounded here — it
    // would otherwise grow one CanvasTexture per unique label for the lifetime
    // of the tab, leaking GPU memory as the graph reloads / labels churn.
    useEffect(() => {
        disposeResourceMap(geoCache.current);
        disposeResourceMap(matCache.current);
        geoCache.current = {};
        matCache.current = {};
        clearTextSpriteCache();
        return () => {
            disposeResourceMap(geoCache.current);
            disposeResourceMap(matCache.current);
            geoCache.current = {};
            matCache.current = {};
            clearTextSpriteCache();
        };
    }, [graphData]);

    const getSharedGeometry = useCallback((size, segments) => {
        const key = `${size.toFixed(1)}-${segments}`;
        if (!geoCache.current[key]) {
            geoCache.current[key] = new THREE.SphereGeometry(size, segments, segments);
        }
        return geoCache.current[key];
    }, []);

    const getSharedMaterial = useCallback((color, emissiveInt, opacity, isShell) => {
        const key = `${color}-${emissiveInt.toFixed(1)}-${opacity.toFixed(2)}-${isShell}`;
        if (!matCache.current[key]) {
            if (isShell) {
                matCache.current[key] = new THREE.MeshBasicMaterial({
                    color: new THREE.Color(color),
                    transparent: true,
                    opacity: opacity,
                    side: THREE.BackSide
                });
            } else {
                matCache.current[key] = new THREE.MeshPhongMaterial({
                    color: new THREE.Color(color),
                    emissive: new THREE.Color(color),
                    emissiveIntensity: 0.4,
                    transparent: true,
                    opacity: opacity,
                    shininess: 80
                });
            }
        }
        return matCache.current[key];
    }, []);


    // Custom Three.js node — full debug visuals + lock-status visuals
    const nodeThreeObject = useCallback((node) => {
        const color = getNodeColor(node);
        const size = getNodeSize(node);
        const isDebugActive = node.id === debugNode;
        const isBranch = debugBranchSet.has(node.id);
        const isTrail = debugPathSet.has(node.id) && !isDebugActive;
        const isConflict = node.lockStatus === 'conflict' || node.lockStatus === 'blocked';
        const isLocked = !isConflict && node.locked && node.lockedBy;

        const group = new THREE.Group();

        // Core sphere — for conflict nodes use a fresh (non-cached) material so we
        // can animate emissiveIntensity per-frame without polluting the shared cache.
        const coreOpacity = isTrail ? 0.7 : 0.9;
        const coreEmissive = isDebugActive ? 1.5 : (isBranch ? 0.9 : GLOW_INTENSITY);
        // Geometry by node type: Knowledge=cylinder, Task=octahedron,
        // Spec=tetrahedron, default=sphere. 'Spec' is the synthetic aggregator
        // label the bridge adds to every Spec* node. Epic is handled further
        // down — it is a wireframe compound, not a single solid, so it does not
        // fit this "one geometry, one mesh" shape.
        let geometry;
        if (node.labels?.includes('Knowledge')) {
            geometry = knowledgeGeo;
        } else if (node.labels?.includes('Task')) {
            geometry = taskGeo;
        } else if (node.labels?.includes('Spec')) {
            geometry = specGeo;
        } else {
            geometry = getSharedGeometry(size, 8);
        }

        let coreMaterial;
        if (isConflict) {
            // Dedicated material for animation — do NOT cache this
            coreMaterial = new THREE.MeshPhongMaterial({
                color: new THREE.Color('#ff4444'),
                emissive: new THREE.Color('#ff4444'),
                emissiveIntensity: GLOW_INTENSITY,
                transparent: true,
                opacity: coreOpacity,
                shininess: 100
            });
        } else {
            coreMaterial = getSharedMaterial(color, coreEmissive, coreOpacity, false);
        }

        // The node's body, as a LIST: an Epic is a two-mesh wireframe compound
        // rather than one solid, and the emphasis scaling further down has to
        // reach whichever of the two shapes this node turned out to be. It was
        // briefly a `const sphere` declared inside the else-branch while the
        // scaling line kept referring to `sphere` — block scope meant that line
        // threw "sphere is not defined" on the FIRST node of any graph, Epic or
        // not, and the whole 3D scene died before drawing anything.
        const coreMeshes = [];
        const isEpic = node.labels?.includes('Epic');
        if (isEpic) {
            // The compound REPLACES the solid core instead of restyling it. An
            // Epic carries no substance of its own — its Tasks are the content,
            // and they sit around it. A filled body would hide exactly that.
            coreMeshes.push(new THREE.Mesh(epicDodecaGeo, epicWireMaterial));
            coreMeshes.push(new THREE.Mesh(epicIcosaGeo, epicWireMaterial));
        } else {
            coreMeshes.push(new THREE.Mesh(geometry, coreMaterial));
        }
        for (const mesh of coreMeshes) group.add(mesh);

        // No edges at all — see isolatedShellMaterial above.
        if ((degreeById.get(node.id) || 0) === 0) {
            group.add(new THREE.Mesh(isolatedShellGeo, isolatedShellMaterial));
        }

        // Billboard text label above node — selective. Labelling every node
        // turns a few hundred nodes into unreadable noise; show names only
        // where they carry meaning (domain nodes, hubs, anything emphasised)
        // and rely on the hover tooltip for the rest.
        const labels = node.labels || [];
        const isDomainNode = labels.includes('Task') || labels.includes('Knowledge')
            || labels.includes('Architect') || labels.includes('Endpoint')
            || labels.includes('Module') || labels.includes('Component');
        const isEmphasised = isDebugActive || isBranch || isTrail || isConflict || isLocked
            || node.lockStatus === 'planned' || highlightedNodes?.has(node.name);
        const isHub = (degreeById.get(node.id) || 0) >= 8;
        if (node.name && (isEmphasised || isHub || smallGraph || (isDomainNode && labelBudgetOk))) {
            const label = makeTextSprite(node.name, color);
            label.position.set(0, size + 4, 0);
            group.add(label);
        }

        // Glow shell removed for performance (200+ nodes × 2 meshes was too heavy)

        // Active debug node: animated pulsing ring
        if (isDebugActive) {
            const ringGeo = new THREE.TorusGeometry(size * 2, 0.4, 12, 48);
            const ringMat = new THREE.MeshBasicMaterial({
                color: new THREE.Color(DEBUG_ACTIVE_COLOR),
                transparent: true,
                opacity: 0.6,
                side: THREE.DoubleSide
            });
            const ring = new THREE.Mesh(ringGeo, ringMat);
            ring.rotation.x = Math.PI / 2;
            // Store reference for animation
            ring.userData.isDebugRing = true;
            ring.userData.material = ringMat;
            group.add(ring);

            // Second ring — perpendicular
            const ring2Geo = new THREE.TorusGeometry(size * 2.3, 0.3, 12, 48);
            const ring2Mat = new THREE.MeshBasicMaterial({
                color: new THREE.Color('#ffffff'),
                transparent: true,
                opacity: 0.2,
                side: THREE.DoubleSide
            });
            const ring2 = new THREE.Mesh(ring2Geo, ring2Mat);
            ring2.rotation.y = Math.PI / 2;
            ring2.userData.isDebugRing2 = true;
            ring2.userData.material = ring2Mat;
            group.add(ring2);
        }

        // Branch nodes: outer wireframe shell (blinking)
        if (isBranch) {
            const wireGeo = new THREE.IcosahedronGeometry(size * 1.6, 1);
            const wireMat = new THREE.MeshBasicMaterial({
                color: new THREE.Color(DEBUG_BRANCH_COLOR),
                wireframe: true,
                transparent: true,
                opacity: 0.5
            });
            const wire = new THREE.Mesh(wireGeo, wireMat);
            wire.userData.isBranchWire = true;
            wire.userData.material = wireMat;
            group.add(wire);
        }

        // Conflict/blocked nodes: pulsing red outer ring
        if (isConflict) {
            const conflictRingGeo = new THREE.TorusGeometry(size * 2.4, 0.5, 12, 48);
            const conflictRingMat = new THREE.MeshBasicMaterial({
                color: new THREE.Color('#ff4444'),
                transparent: true,
                opacity: 0.7,
                side: THREE.DoubleSide
            });
            const conflictRing = new THREE.Mesh(conflictRingGeo, conflictRingMat);
            conflictRing.rotation.x = Math.PI / 2;
            conflictRing.userData.isConflictRing = true;
            conflictRing.userData.material = conflictRingMat;
            conflictRing.userData.coreMaterial = coreMaterial;
            group.add(conflictRing);
        }

        // Locked-by-agent: pulsating sphere — lead=gold/slow, worker=cyan/fast
        if (isLocked) {
            const isLead = node.lockedBy === 'lead' || node.lockedBy?.startsWith('lead-');
            const shellGeo = new THREE.SphereGeometry(size * 2.5, 24, 24);
            const shellMat = new THREE.MeshBasicMaterial({
                color: new THREE.Color(color),
                transparent: true,
                opacity: 0.18,
                side: THREE.DoubleSide,
                depthWrite: false,
            });
            const shell = new THREE.Mesh(shellGeo, shellMat);
            shell.userData.isAgentShell = true;
            shell.userData.isLeadAgent = isLead;
            shell.userData.material = shellMat;
            group.add(shell);

            // Inner glow ring for lead agents
            if (isLead) {
                const ringGeo = new THREE.TorusGeometry(size * 1.8, 0.35, 12, 48);
                const ringMat = new THREE.MeshBasicMaterial({
                    color: new THREE.Color(LEAD_COLOR),
                    transparent: true,
                    opacity: 0.4,
                    side: THREE.DoubleSide
                });
                const ring = new THREE.Mesh(ringGeo, ringMat);
                ring.rotation.x = Math.PI / 2;
                ring.userData.isLeadRing = true;
                ring.userData.material = ringMat;
                group.add(ring);
            }
        }

        // Planned lock: dashed edge outline in purple
        if (node.lockStatus === 'planned') {
            const edgesGeo = new THREE.EdgesGeometry(getSharedGeometry(size * 1.2, 12));
            const dashedMat = new THREE.LineDashedMaterial({
                color: new THREE.Color('#a855f7'),
                dashSize: 0.15,
                gapSize: 0.08,
                transparent: true,
                opacity: 0.7
            });
            const lineSegments = new THREE.LineSegments(edgesGeo, dashedMat);
            lineSegments.computeLineDistances();
            group.add(lineSegments);
        }

        // --- Task 3: Active area emphasis (scale + opacity) ---
        const isPlanned = node.lockStatus === 'planned';
        const targetScale = isConflict ? 1.5 : (isLocked ? 1.4 : (isPlanned ? 1.1 : 1.0));
        const targetOpacity = (isLocked || isConflict) ? 1.0 : (isPlanned ? 0.9 : 0.85);
        for (const mesh of coreMeshes) mesh.scale.setScalar(targetScale);
        // An Epic's body is drawn with the shared wireframe material, so its
        // coreMaterial is a cache entry this node never uses — writing to it
        // would restyle every OTHER node that happens to share the same cache
        // key, which is how one Epic could dim a screenful of functions.
        if (!isEpic) coreMaterial.opacity = targetOpacity;



        // Animate the group on each frame
        const needsAnimation = isDebugActive || isBranch || isConflict || isLocked;
        if (needsAnimation) {
            group.onBeforeRender = () => {
                const elapsed = clockRef.current.getElapsedTime();

                group.children.forEach(child => {
                    if (child.userData.isDebugRing) {
                        child.rotation.z = elapsed * 1.5;
                        const pulse = 0.4 + Math.sin(elapsed * 4) * 0.3;
                        child.userData.material.opacity = pulse;
                        const scale = 1.0 + Math.sin(elapsed * 3) * 0.1;
                        child.scale.setScalar(scale);
                    }
                    if (child.userData.isDebugRing2) {
                        child.rotation.x = elapsed * 1.0;
                        child.rotation.z = elapsed * 0.7;
                        const pulse = 0.15 + Math.sin(elapsed * 3 + 1) * 0.1;
                        child.userData.material.opacity = pulse;
                    }
                    if (child.userData.isBranchWire) {
                        child.rotation.x = elapsed * 0.5;
                        child.rotation.y = elapsed * 0.3;
                        // Blink effect
                        const blink = 0.25 + Math.sin(elapsed * 5) * 0.25;
                        child.userData.material.opacity = blink;
                    }
                    if (child.userData.isConflictRing) {
                        // Rotate ring
                        child.rotation.z = elapsed * 2.0;
                        // Pulse ring opacity
                        const ringPulse = 0.4 + Math.sin(elapsed * 6) * 0.35;
                        child.userData.material.opacity = ringPulse;
                        // Pulse core emissiveIntensity (sin-based)
                        if (child.userData.coreMaterial) {
                            child.userData.coreMaterial.emissiveIntensity =
                                0.8 + Math.sin(elapsed * 6) * 0.7;
                        }
                    }
                    if (child.userData.isAgentShell) {
                        // Lead: slow majestic pulse (1.2Hz), Worker: fast active pulse (3.5Hz)
                        const freq = child.userData.isLeadAgent ? 1.2 : 3.5;
                        const scaleAmp = child.userData.isLeadAgent ? 0.25 : 0.15;
                        const opacityBase = child.userData.isLeadAgent ? 0.16 : 0.12;
                        const opacityAmp = child.userData.isLeadAgent ? 0.12 : 0.08;
                        const pulse = 1.0 + Math.sin(elapsed * freq) * scaleAmp;
                        child.scale.setScalar(pulse);
                        child.userData.material.opacity = opacityBase + Math.sin(elapsed * freq) * opacityAmp;
                    }
                    if (child.userData.isLeadRing) {
                        child.rotation.z = elapsed * 0.4;
                        child.userData.material.opacity = 0.25 + Math.sin(elapsed * 1.2) * 0.2;
                    }
                });
            };
        }

        return group;
    }, [getNodeColor, getNodeSize, debugNode, debugBranchSet, debugPathSet, highlightedNodes, degreeById, smallGraph, labelBudgetOk]);



    // Handle node click
    const lastLibClickRef = useRef(0);
    const handleNodeClick = useCallback((node, event) => {
        lastLibClickRef.current = Date.now();
        if (onNodeClick) {
            onNodeClick(node.id, event);
        }
    }, [onNodeClick]);

    // Der hovernde Knoten, auch für Listener außerhalb des Renderzyklus lesbar.
    const hoverNodeIdRef = useRef(null);
    useEffect(() => { hoverNodeIdRef.current = hoverNodeId; }, [hoverNodeId]);

    /**
     * Auffangnetz für Klicks, die three-forcegraph nicht als Klick sieht.
     *
     * Die 3D-Ansicht selektiert über die Raycast-Logik der Bibliothek, und die
     * hängt an einer pointerdown/pointerup-Folge. Ein Klick, der nur als
     * `click`-Ereignis ankommt — Browser-Automatisierung, Testwerkzeuge,
     * Bedienhilfen — bewegt zwar den Mauszeiger (der Hover greift, die Karte
     * erscheint), löst aber keine Auswahl aus: der Graph reagierte sichtbar,
     * der Inspector blieb auf "No node selected".
     *
     * Also: gibt es beim Klick einen gehoverten Knoten, ist er gemeint. Zwei
     * Bedingungen halten das ehrlich — hat die Bibliothek eben selbst
     * ausgelöst, passiert hier nichts (sonst doppelte Auswahl), und ein
     * gezogener Kamera-Schwenk (Zeiger um mehr als ein paar Pixel bewegt) ist
     * kein Klick.
     */
    useEffect(() => {
        if (viewMode === '2d') return;   // 2D hat seinen eigenen Treffertest
        let canvas = null, frames = 0, raf = 0;
        let downX = null, downY = null;

        const onDown = (e) => { downX = e.clientX; downY = e.clientY; };
        const onClick = (e) => {
            if (Date.now() - lastLibClickRef.current < 250) return;
            if (downX != null && Math.hypot(e.clientX - downX, e.clientY - downY) > 6) return;
            const id = hoverNodeIdRef.current;
            if (id != null && onNodeClick) onNodeClick(id, e);
        };

        const attach = () => {
            canvas = fgRef.current?.renderer?.()?.domElement || null;
            if (canvas) {
                canvas.addEventListener('pointerdown', onDown);
                canvas.addEventListener('click', onClick);
                return;
            }
            // Der Renderer steht erst, wenn die Szene aufgebaut ist. Ein paar
            // Frames warten statt aufgeben.
            if (frames++ < 60) raf = requestAnimationFrame(attach);
        };
        attach();

        return () => {
            if (raf) cancelAnimationFrame(raf);
            if (!canvas) return;
            canvas.removeEventListener('pointerdown', onDown);
            canvas.removeEventListener('click', onClick);
        };
    }, [viewMode, onNodeClick]);

    // Edge styling — debug-aware coloring; palette depends on canvas (2D light, 3D dark)
    const linkColor = useCallback((link) => {
        const src = link.source?.id ?? link.source;
        const tgt = link.target?.id ?? link.target;
        const key = `${src}->${tgt}`;

        // Debug edge — call stack trail
        if (debugEdgeSet.has(key)) return DEBUG_ACTIVE_COLOR;

        // Active trace (live mode)
        if (activeLinks.has(key)) {
            return EDGE_ACTIVE_COLORS[link.relType] || EDGE_ACTIVE_COLORS.default;
        }

        // Hovering a node picks its edges out of the mesh, by direction: what it
        // reaches in one colour, what reaches it in another. Everything else
        // fades rather than disappearing, so the surrounding shape stays
        // readable as context.
        if (hoverSets) {
            if (hoverSets.edgeKeys.has(key)) {
                return (src === hoverNodeId) ? '#0ea5e9' : '#a855f7';
            }
            return viewMode === '2d' ? 'rgba(100,116,139,0.13)' : 'rgba(150,160,190,0.05)';
        }

        const palette = viewMode === '2d' ? EDGE_COLORS : EDGE_COLORS_3D;
        return palette[link.relType] || palette.default;
    }, [activeLinks, debugEdgeSet, viewMode, hoverSets, hoverNodeId]);

    const linkWidth = useCallback((link) => {
        return getLinkWidth(link, {
            activeLinks,
            debugEdges: debugEdgeSet,
            hoverEdges: hoverSets?.edgeKeys,
        });
    }, [activeLinks, debugEdgeSet, hoverSets]);

    // linkParticles / linkParticleColor used to live here. Neither was ever
    // handed to the force graph — no linkDirectionalParticles prop exists in
    // this component — so the particle animation the Auto Traffic switch was
    // supposed to drive never rendered anything. Removed together with the
    // switch itself.

    // ── Hover tooltip: three lines, deliberately ──────────────────────────
    //
    // This used to be a card with a code excerpt in it. Two things made that
    // excerpt worthless: it is `bodySnippet`, which the builder stores as the
    // first 120 characters of the body with every newline and every run of
    // whitespace collapsed into single spaces, cut mid-token — unreadable as
    // code; and the tooltip is rendered by float-tooltip with
    // `pointer-events: none`, so it can never be scrolled, selected or clicked.
    // A code viewer you cannot touch and that shows mangled code is worse than
    // no code at all, because it takes up the space where orientation should be.
    //
    // What a hover is good for is deciding whether this is the node you want.
    // So: what it is, where it lives, and how connected it is — including how
    // many of its edges the current view is NOT showing, which is the one fact
    // you cannot get by looking at the picture. The code itself is one click
    // away in the Inspector, where it can be read properly.
    const nodeLabel = useCallback((node) => buildNodeLabel(node, {
        getAgentColor,
        visibleDegree: visibleDegreeById.get(node.id),
    }), [getAgentColor, visibleDegreeById]);

    // Link label on hover
    const linkLabel = useCallback(buildLinkLabel, []);

    // --- 2D canvas painter: labels + type-coded shapes ----------------
    // Task = Diamant (Kristall), Knowledge/Architect = Zylinder, sonst = Kreis.
    // Spiegelt die 3D-Formcodierung (Octahedron/Cylinder) auf 2D-Canvas.
    const nodeCanvasObject = useCallback((node, ctx, globalScale) => {
        const color = getNodeColor(node);
        const r = Math.max(2.5, getNodeSize(node));
        const labels = node.labels || [];
        const isTask = labels.includes('Task');
        const isKnowledge = labels.includes('Knowledge');
        const isArchitect = labels.includes('Architect') || labels.includes('Book');

        ctx.save();
        ctx.fillStyle = color;
        ctx.strokeStyle = darkTheme ? 'rgba(226,232,240,0.34)' : 'rgba(30,41,59,0.28)';
        ctx.lineWidth = 0.6;

        if (isTask) {
            // Diamant / Kristall
            ctx.beginPath();
            ctx.moveTo(node.x, node.y - r);
            ctx.lineTo(node.x + r, node.y);
            ctx.lineTo(node.x, node.y + r);
            ctx.lineTo(node.x - r, node.y);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
        } else if (isKnowledge || isArchitect) {
            // Zylinder-Glyph: Korpus + zwei Ellipsen
            const w = r * 1.6, h = r * 2.0, ry = w * 0.24;
            const cx = node.x, top = node.y - h / 2, bot = node.y + h / 2;
            ctx.fillRect(cx - w / 2, top + ry, w, h - 2 * ry);
            ctx.beginPath(); ctx.ellipse(cx, bot - ry, w / 2, ry, 0, 0, Math.PI * 2); ctx.fill();
            ctx.beginPath(); ctx.ellipse(cx, top + ry, w / 2, ry, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        } else {
            ctx.beginPath();
            ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
            ctx.fill();
        }

        // Label — immer für Task/Knowledge/Architect/Highlight/Debug, sonst nur
        // beim Reinzoomen, damit der Überblick nicht zugepflastert wird.
        const important = isTask || isKnowledge || isArchitect
            || highlightedNodes?.has(node.name) || node.id === debugNode;
        if ((important || globalScale > 2.2) && node.name) {
            const fontSize = Math.max(2.5, 11 / globalScale);
            ctx.font = `600 ${fontSize}px sans-serif`;
            const text = String(node.name);
            const tw = ctx.measureText(text).width;
            const pad = 2 / globalScale;
            const ly = node.y + r + fontSize * 0.95;
            ctx.fillStyle = darkTheme ? 'rgba(17,24,42,0.92)' : 'rgba(255,255,255,0.92)';
            ctx.fillRect(node.x - tw / 2 - pad, ly - fontSize / 2 - pad, tw + 2 * pad, fontSize + 2 * pad);
            ctx.fillStyle = darkTheme ? '#e7edf8' : '#182234';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(text, node.x, ly);
        }
        ctx.restore();
    }, [getNodeColor, getNodeSize, highlightedNodes, debugNode, darkTheme]);

    // Hit-Area für Klicks (umschließt die Custom-Shapes großzügig)
    const nodePointerAreaPaint = useCallback((node, color, ctx, globalScale) => {
        // Keep the click target stable in screen space when zooming out.
        const minScreenRadius = bulkMode2d ? 8 : 7;
        const r = Math.max(
            Math.max(2.5, getNodeSize(node)) + 2,
            minScreenRadius / Math.max(globalScale || 1, 0.01),
        );
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
        ctx.fill();
    }, [getNodeSize, bulkMode2d]);

    // The library identifies nodes through an off-screen colour canvas. In a
    // dense graph enlarged hit circles overlap, so the last painted node can
    // win even when another node is visibly closer to the pointer. Resolve the
    // final target geometrically in screen pixels instead. This also provides a
    // fallback when the colour canvas misses a small node entirely.
    const nearest2dNodeAtEvent = useCallback((event, fallbackNode = null) => {
        const graph = fg2dRef.current;
        const canvas = event?.target;
        if (!graph?.graph2ScreenCoords || !canvas?.getBoundingClientRect) return fallbackNode;

        const rect = canvas.getBoundingClientRect();
        const pointerX = Number.isFinite(event.clientX) ? event.clientX - rect.left : event.offsetX;
        const pointerY = Number.isFinite(event.clientY) ? event.clientY - rect.top : event.offsetY;
        if (!Number.isFinite(pointerX) || !Number.isFinite(pointerY)) return fallbackNode;

        let nearest = null;
        let nearestDistanceSq = Infinity;
        for (const node of graphData.nodes) {
            if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) continue;
            const point = graph.graph2ScreenCoords(node.x, node.y);
            const dx = point.x - pointerX;
            const dy = point.y - pointerY;
            const distanceSq = dx * dx + dy * dy;
            if (distanceSq < nearestDistanceSq) {
                nearest = node;
                nearestDistanceSq = distanceSq;
            }
        }

        // 14 px is forgiving enough for a mouse while still requiring a click
        // that visually belongs to the node. If the library already found a
        // larger custom shape, retain it when no centre is within that radius.
        return nearest && nearestDistanceSq <= 14 * 14 ? nearest : fallbackNode;
    }, [graphData.nodes]);

    // Defensive Check: If no nodes, don't even mount the ForceGraph component.
    if (!graphData || !graphData.nodes || graphData.nodes.length === 0 || !width || !height) {
        return null;
    }

    // 2D renderer — canvas-based, much cheaper for large graphs.
    // Reuses the same getNodeColor / getNodeSize callbacks as the 3D path.
    if (viewMode === '2d') {
        return (
            <ForceGraph2D
                width={width} height={height}
                ref={fg2dRef}
                graphData={graphData}
                backgroundColor={graphBackground}
                nodeVal={getNodeSize}
                // In bulk mode nodeCanvasObject is off, and it was the only
                // thing that ever applied a colour here — so every node came
                // out the same default blue, in the one mode that exists
                // because there are thousands of nodes to tell apart.
                nodeColor={getNodeColor}
                // Above BULK_2D_THRESHOLD the per-node work is what makes the
                // canvas crawl, not the node count itself. Three costs are paid
                // for EVERY node and link on EVERY frame:
                //   nodeCanvasObject     — a custom shape per node
                //   nodePointerAreaPaint — the same nodes drawn a SECOND time
                //                          into the hit-test canvas
                //   arrow heads          — one more path per link
                // At 12k nodes and ~20k links that is over 60k canvas operations
                // per frame. Dropping to the built-in circle renderer and turning
                // the extras off keeps the same graph legible while it stays
                // interactive; the shapes and arrows are detail nobody can make
                // out at that zoom level anyway.
                nodeCanvasObject={bulkMode2d ? undefined : nodeCanvasObject}
                nodePointerAreaPaint={nodePointerAreaPaint}
                nodeLabel={nodeLabel}
                linkColor={linkColor}
                linkWidth={linkWidth}
                linkDirectionalArrowLength={bulkMode2d ? 0 : 3}
                linkDirectionalArrowRelPos={1}
                linkDirectionalArrowColor={linkColor}
                onNodeClick={(node, event) => {
                    const target = nearest2dNodeAtEvent(event, node);
                    if (target && onNodeClick) onNodeClick(target.id, event);
                }}
                onBackgroundClick={(event) => {
                    const target = nearest2dNodeAtEvent(event);
                    if (target && onNodeClick) onNodeClick(target.id, event);
                }}
                onNodeHover={handleNodeHover}
                cooldownTicks={100}
                d3AlphaDecay={0.02}
                d3VelocityDecay={0.3}
            />
        );
    }

    // 3D renderer — existing path, fully preserved.
    return (
        <ForceGraph3D
            width={width} height={height}
            ref={fgRef}
            graphData={graphData}
            nodeThreeObject={nodeThreeObject}
            nodeThreeObjectExtend={false}
            nodeColor={getNodeColor}
            nodeLabel={nodeLabel}
            linkLabel={linkLabel}
            linkColor={linkColor}
            linkWidth={linkWidth}
            linkOpacity={0.55}
            linkDirectionalArrowLength={2}
            linkDirectionalArrowRelPos={1}
            linkDirectionalArrowColor={linkColor}
            backgroundColor={graphBackground}
            showNavInfo={false}
            enableNodeDrag={!freezeLayout}
            onNodeClick={handleNodeClick}
            onNodeHover={handleNodeHover}
            // Die Wrapper-Sim läuft ENDLOS mit auf 0 gestellten Kräften (siehe
            // Worker-Effect oben): nur ihr Tick überträgt node.x/y/z auf die
            // Three-Objekte. Stoppt sie (cooldownTicks/alphaDecay), frieren die
            // gerenderten Positionen ein und das Worker-Layout läuft ins Leere.
            cooldownTime={Infinity}
            d3AlphaDecay={0}
            d3AlphaMin={0}
            d3VelocityDecay={0.3}
        />
    );
}

export default GraphScene;

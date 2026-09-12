/**
 * CodeVis WebSocket Bridge Server
 * 
 * Connects to the code graph in the embedded Ladybug DB,
 * loads a manageable subset of it
 * (including all node types and relationship types),
 * and pushes it to the 3D frontend via Socket.io.
 * Also relays trace:event messages from the pulse simulator.
 * 
 * Phase 1: Express REST layer, dynamic DB switching, debugger API.
 */

const express = require('express');
const cors = require('cors');
const { createServer } = require('http');
const { Server } = require('socket.io');
const { normalizeWorkspaceName, publicWorkspaceName } = require('../lib/workspace-names.cjs');
const { subscribeWorkspace, emitWorkspace } = require('./workspace-events.cjs');
// DB backend: embedded Ladybug through the
// Compat-Client, der den Daemon selbst spawnt. Es gibt kein zweites Backend
// mehr — der frühere CODEVIS_DB=neo4j-Opt-in ist entfernt.
// The variable stays `ladybug` because it IS the driver API surface the compat
// client implements; renaming it is a separate mechanical pass.
const BACKEND_NAME = 'Ladybug';
const ladybug = require('./ladybug-driver.cjs');
const { spawn } = require('child_process');
const path = require('path');
const crypto = require('crypto');
// Config and ports come from the analysed *project*, not from this package —
// installed as a dependency there is no config next to this file, and a fixed
// port would collide with any other project's dashboard. See codevis-paths.cjs.
const paths = require('./codevis-paths.cjs');
const config = paths.loadConfig();
const { isLockingEnabled, lockingStatus } = require('../lib/locking-config.cjs');
const LOCKING_ENABLED = isLockingEnabled(config);
const specDb = require('../scripts/spec/spec_db.cjs');
const { saveSpecSource } = require('./spec-save.cjs');
const classDiagram = require('../scripts/diagram/class_diagram.cjs');
const { resolveExtractors } = require('../scripts/extractors.cjs');
const rosDb = require('../scripts/ros/ros_db.cjs');
const { runImpactRequest } = require('./impact-api.cjs');
const { inspectGraphFreshness } = require('../scripts/impact/graph_freshness.cjs');
const { registerLogRoutes } = require('./log-routes.cjs');
const { findPath } = require('./pathfinder-route.cjs');
const annotationDb = require('../scripts/annotations/annotation_db.cjs');
const { updateKnowledge } = require('./knowledge-edit.cjs');
const { reserveUniqueTaskId, generateWorkItemId } = require('../tools/lib/task-id.cjs');
const {
    TASK_PRIORITIES,
    TASK_STATUSES,
    deriveEpicStatus,
    codeTargetPredicate,
    mergeTaskSpec,
    taskSpecProblems,
    transitionTaskLocks,
} = require('../tools/lib/task-rules.cjs');

const PROJECT_ROOT = paths.PROJECT_ROOT;
const PORT = paths.BRIDGE_PORT;
const BRIDGE_HOST = '127.0.0.1';
const WEB_SHELL_ENABLED = process.env.CODEVIS_WEB_SHELL === '1';
const WORKSPACE_FINGERPRINT = crypto.createHash('sha256')
    .update(`${path.resolve(PROJECT_ROOT).toLowerCase()}\0${path.resolve(paths.DATA_DIR).toLowerCase()}`)
    .digest('hex').slice(0, 16);

// ── Express app ──────────────────────────────────────────────────────
// Created HERE, before anything else, on purpose. `const` is not hoisted the
// way `function` is: a route registered above its declaration throws
// "Cannot access 'app' before initialization" at load time and the bridge does
// not start at all. That happened three times in one day, each time when
// someone added a route next to the code it belongs to rather than at the
// bottom of a 2500-line file. With the app declared first, there is no "above"
// left to get wrong.
const app = express();

const { isAllowedBrowserOrigin, requireLocalOrigin, allowLocalSocketRequest } = require('./browser-origin.cjs');

const localCors = {
    origin(origin, callback) {
        callback(null, isAllowedBrowserOrigin(origin));
    },
};
app.use(requireLocalOrigin);
app.use(cors(localCors));
// Express defaults to a 100 kB JSON body. /api/graph/subgraph posts one ipv6
// per result node — around 40 bytes each — so a query matching a few thousand
// nodes blew past it and came back as PayloadTooLargeError, which the dashboard
// could only report as "the graph could not be shown".
app.use(express.json({ limit: '32mb' }));

app.post('/api/impact', async (req, res) => {
    let dbKey;
    try {
        dbKey = normalizeWorkspaceName(req.body?.db, activeDb);
        const selectedDriver = drivers[dbKey] || (drivers[dbKey] = createDriver(dbKey));
        const session = selectedDriver.session();
        try {
            const result = await runImpactRequest(session, req.body, {
                projectRoot: PROJECT_ROOT,
                sourceDirs: config.workspaces?.[dbKey]?.sourceDir || [],
                exclude: config.workspaces?.[dbKey]?.exclude || [],
            });
            res.json({ status: 'OK', db: publicWorkspaceName(dbKey), ...result });
        } finally {
            await session.close();
        }
    } catch (error) {
        const status = error.code === 'AMBIGUOUS_SEED' ? 409 : error.code === 'SEED_NOT_FOUND' ? 404 : 400;
        res.status(status).json({ status: 'ERROR', code: error.code || 'INVALID_IMPACT_REQUEST', error: error.message,
            candidates: error.candidates || undefined });
    }
});

// Node labels produced by the diagram importer (scripts/spec/spec_db.cjs).
// Kept in one place: this list is both the graph query's allowlist and the
// source of the synthetic 'Spec' aggregator label the UI filters on.
const SPEC_LABELS = [
    'SpecClassDiagram', 'SpecClass', 'SpecMethod', 'SpecField', 'SpecRelation',
    'SpecSequence', 'SpecParticipant', 'SpecMessage',
    'SpecUseCaseDiagram', 'SpecUseCase', 'SpecActor', 'SpecAssoc',
    'SpecActivityDiagram', 'SpecProcess', 'SpecAction',
];
const SPEC_LABEL_SET = new Set(SPEC_LABELS);

/**
 * What a node is called on screen.
 *
 * Two things this has to work around, both consequences of the Ladybug
 * migration and both measured on the PSE database:
 *
 *   - A node now carries exactly ONE label. All 47 139 of them. The old code
 *     looked for "the first label that is not ASTNode" to recover an AST
 *     node's subtype — a search that can no longer succeed, so all 37 073 of
 *     them fell through to null and drew as unnamed dots. The subtype still
 *     exists, in `elementId` ("StringLiteral:2:0:3"), so that is where it
 *     comes from now.
 *   - File nodes keep their path in `path`, never in `name`. The fallback
 *     chain never looked there, so all 100 files in the graph were labelled
 *     with the bare word "File". Same for the 55 ImportedSymbols.
 */
function displayNameFor({ name, title, kind, preview, value, path, elementId, label, uid, content }) {
    // `title` steht ausschließlich auf Planungsknoten (Task, Epic) — Code
    // kennt die Spalte nicht. Wer einen Titel hat, wird darüber gelesen.
    // Vorher hing das an einem isTask-Flag, und Epics fielen durch die ganze
    // Kette bis auf `label`: die Karte hiess "Epic", so wie ihr Typ, und der
    // eingetippte Titel stand nirgends.
    if (title) return title;
    // Eine Idee heißt wie ihre ID (`idea-1786103666578`) — ihr Text steht in
    // `content`. Ohne diesen Fall trägt jede Idee im Graphen einen
    // Zeitstempel als Namen, und Ideen sind der eine Knotentyp, bei dem der
    // Text ALLES ist, was es über ihn zu wissen gibt.
    // Nur für Idea: Knowledge hat ebenfalls `content`, aber sein `name` ist
    // gewählt und damit die bessere Überschrift.
    if (label === 'Idea' && content) {
        const firstLine = String(content).split(/\r?\n/)[0].trim();
        return firstLine.length > 60 ? `${firstLine.slice(0, 57)}…` : (firstLine || name);
    }
    if (name) return name;
    if (path) return String(path);
    if (kind) return kind;

    // AST subtype out of elementId: "StringLiteral:2:0:3" → "StringLiteral"
    const subtype = elementId && String(elementId).includes(':')
        ? String(elementId).split(':')[0]
        : null;
    const snippet = preview || value;
    if (subtype && snippet) return `${subtype}: ${String(snippet).slice(0, 24)}`;
    if (subtype) return subtype;
    if (label && label !== 'ASTNode' && snippet) return `${label}: ${String(snippet).slice(0, 24)}`;
    if (snippet) return String(snippet).slice(0, 24);

    // Last resort: the uid. ImportedSymbol carries its name nowhere else —
    // every property is null and the only readable thing about the node is the
    // `localName=…` segment of its key, so all 55 of them drew as the word
    // "ImportedSymbol". The `file=` segment is skipped; it names the container,
    // not the node.
    if (uid && String(uid).includes('||')) {
        const segments = String(uid).split('||').slice(1)
            .filter((s) => s.includes('=') && !s.startsWith('file='));
        const last = segments[segments.length - 1];
        if (last) return last.slice(last.indexOf('=') + 1);
    }
    return label || null;
}

// ── Configurable limits ──────────────────────────────────────────────
let currentLevel = 1; // Graph detail level: 1 = architectural, 2 = +atomic, 3 = +full AST
let limits = {
    seed: 20,
    func: 200,
    module: 30,
    endpoint: 20
};

// Level 3 (full AST) can return ~50k nodes — far past what the client can
// render. Cap it: keep ALL structural nodes, sample raw ASTNodes up to the
// budget, and report { shown, total } so the UI can say so (no silent cut).
// Raised from 12 000 to 100 000: InstancedMesh can handle the full meta-graph.
const LEVEL3_NODE_CAP = 100000;

// Whether that cap applies at all. Switchable from the dashboard, because
// watching the entire graph assemble itself is a thing people want to do and
// the cap is the only thing standing in the way. Off means the client receives
// every node the level asks for — that is the viewer's decision to make, and
// the honest failure mode (a slow tab) beats a silently truncated graph that
// looks complete.
let nodeCapEnabled = true;

// ── Dynamic DB connection ────────────────────────────────────────────
// Which graph the dashboard opens on. Defaults to the target project (the
// common case — you're analyzing your own codebase). Set CODEVIS_DEFAULT_DB=meta
// to open on CodeVis' own graph instead. The UI toggle / POST /api/switch-db
// still switches at runtime. Deliberately NOT tied to which graph was last
// parsed — that would flip the default unexpectedly on a rebuild.
const DEFAULT_DB = config.workspaces[process.env.CODEVIS_DEFAULT_DB || '']
    ? process.env.CODEVIS_DEFAULT_DB
    : (config.workspaces.target ? 'target' : Object.keys(config.workspaces)[0]);
let activeDb = DEFAULT_DB; // 'target' | 'meta'

// Drivers for all configured workspaces (tasks can live in any DB).
// The active `driver` is ALWAYS one of these shared instances — never a
// separate connection. That lets switchDb() repoint `driver` without closing a
// driver that in-flight loadGraphData/expandNode sessions may still be using.
const drivers = {};
for (const key of Object.keys(config.workspaces)) {
    drivers[key] = createDriver(key);
}
let driver = drivers[activeDb] || (drivers[activeDb] = createDriver(activeDb));
require('./node-search.cjs').registerNodeSearch(app, {
    getActiveDb: () => activeDb,
    getDriver: key => drivers[key] || (drivers[key] = createDriver(key)),
});

function getTaskDriver(dbKey) {
    const key = normalizeWorkspaceName(dbKey, activeDb);
    const d = drivers[key] || drivers['meta'];
    if (!d) {
        // Used to return undefined here, so the caller blew up on `.session()`
        // deep inside a timer — with a config missing the 'meta' workspace (which
        // is where tasks, knowledge and specs live) the dashboard died ~60s after
        // start with an unrelated-looking TypeError. Fail where the cause is.
        throw new Error(
            `No driver for workspace '${key}'. Configured workspaces: ` +
            `${Object.keys(drivers).join(', ') || '(none)'}. ` +
            `Tasks/knowledge/specs need a 'meta' workspace — add one to your codevis config ` +
            `(re-running 'npx codevis init' regenerates it).`
        );
    }
    return d;
}

// ── Candidate cache state ────────────────────────────────────────────
// Declared HERE, above switchDb, and not next to the loader that uses it: the
// module calls switchDb(DEFAULT_DB) at load time, switchDb drops the cache, and
// `let` is not hoisted. With the declaration further down, that startup call died
// with "Cannot access 'candidateCache' before initialization" — caught by the
// .catch() next to it, so the bridge came up anyway and the only trace was one
// warning line in the log. The behaviour is documented at loadCandidateSet.
const CANDIDATE_TTL_MS = 10_000;
let candidateCache = null;      // { key, at, nodes, links, census, totalInDb }
let candidateInFlight = null;   // { key, promise } — a load others can wait on

function invalidateCandidateCache(why) {
    if (!candidateCache) return;
    candidateCache = null;
    if (why) console.log(`[Bridge] Candidate cache dropped (${why})`);
}

// The MCP change detector's baseline (see "MCP Change Detector" further down).
// Declared up here for the same reason as the cache above: switchDb clears it,
// and switchDb runs at module load, where a `let` further down is still in the
// temporal dead zone.
let lastTaskSnapshot = null;
let lastLockCount = null;
let lastLockState = new Map(); // nodeId -> { locked, lockedBy, lockStatus, lockGroup }

function resetChangeDetectorSnapshots() {
    lastTaskSnapshot = null;
    lastLockCount = null;
    lastLockState = new Map();
}

function createDriver(dbKey) {
    const ws = config.workspaces[dbKey];
    if (!ws) throw new Error(`Unknown workspace: ${dbKey}`);
    return ladybug.driver((ws.dbUri || ws.neo4jUri), ladybug.auth.basic(ws.auth.user, ws.auth.pass));
}

async function switchDb(dbKey) {
    dbKey = normalizeWorkspaceName(dbKey, activeDb);
    const validKeys = Object.keys(config.workspaces);
    if (!validKeys.includes(dbKey)) {
        throw new Error(`Invalid db key: ${dbKey}. Must be one of: ${validKeys.join(', ')}.`);
    }
    // Repoint the active driver to the shared per-workspace driver. Do NOT close
    // the previous one: loadGraphData/expandNode may hold an in-flight session on
    // it, and closing under them makes the running query throw (the client would
    // get a partial/empty graph). Per-workspace drivers live for the whole
    // process and are closed together on shutdown (SIGINT/SIGTERM).
    activeDb = dbKey;
    driver = drivers[dbKey] || (drivers[dbKey] = createDriver(dbKey));
    // The cache is keyed by workspace and would miss anyway; dropping it here
    // keeps the other workspace's node set from sitting in memory for the ten
    // seconds nobody is going to look at it.
    invalidateCandidateCache(`switched to ${dbKey}`);
    // The change detector's snapshots describe the workspace it last polled.
    // Kept across a switch, the next poll diffs the new database against the old
    // one and reports every task in both as changed. Null means "take a fresh
    // baseline and emit nothing", which is what a switch should look like.
    resetChangeDetectorSnapshots();
    console.log(`[Bridge] Switched to ${publicWorkspaceName(dbKey)} database`);
}

// ── Default DB on startup ────────────────────────────────────────────
// Opens on DEFAULT_DB (target unless CODEVIS_DEFAULT_DB overrides), so no
// manual POST /api/switch-db is needed for the common case.
switchDb(DEFAULT_DB).catch(err => console.warn('[Bridge] Startup DB switch failed:', err.message));


// ── What the dashboard asks the bridge to LOAD ───────────────────────
// Distinct from what it then draws: the filter in the canvas decides what is
// visible, this decides what ever arrives. `budget` is a number of NODES, and
// loadGraphData spends it ALONG THE EDGES (selectConnectedBudget below) so the
// result is a network rather than a sample.
//
// The opening value comes from the project's config (dashboard.visibleNodeCap)
// — the same knob the slider in the filter writes, deliberately not a second
// configuration path.
let graphScope = {
    budget: Number(config?.dashboard?.visibleNodeCap) > 0
        ? Number(config.dashboard.visibleNodeCap)
        : 500,
    // Display types the filter has switched OFF. Expressed as what is hidden,
    // not as an allowlist: a label nobody has a checkbox for (BraindumpSession,
    // Service, …) then stays loaded instead of silently vanishing the moment
    // the frontend sends its first, necessarily incomplete, type list.
    //
    // Starts with the imported-diagram layer off, matching GraphFilter's own
    // default. The duplication is deliberate: with the two sides disagreeing,
    // every page load would spend a full reload correcting the server — and a
    // reload of this graph is seconds, not milliseconds.
    //
    // Muss mit DEFAULT_OFF in frontend/src/nodePalette.js übereinstimmen,
    // sortiert verglichen. ASTNode taucht erst ab Stufe 3 überhaupt auf und
    // wäre dort auf einen Schlag das Zehnfache des restlichen Graphen.
    hiddenTypes: ['ASTNode', 'Spec'],
    // Nodes without a single edge are unreachable for a walk along edges, by
    // definition. They get their own way in, or they are simply never seen.
    includeIsolated: false,
};

// Labels the level asks for, expressed as bare label names (no `n:` prefix) so
// they can be matched against a census and against the filter's hidden list.
function levelLabels(level) {
    const labels = [
        'Function', 'Component', 'Class', 'State',
        'Module', 'Endpoint', 'File', 'Task', 'Epic', 'Knowledge', 'Annotation',
        'Effect', 'DOMElement', 'Topic', 'Service', 'Action',
        'BraindumpSession',
        // Ideen gehören zur Planungsebene wie Task, Epic und Knowledge — sie
        // fehlten hier als einzige, obwohl die Palette im Frontend längst eine
        // Farbe und einen Filtereintrag für sie hat. Im Graphen kamen sie
        // damit überhaupt nicht vor.
        'Idea',
        // Imported diagrams. Without these the spec layer exists in the DB but
        // never reaches the main graph, so DERIVES/REALIZED_BY edges have no
        // endpoints and drop out — spec and code look like separate worlds.
        // The frontend hides the layer by default (GraphFilter 'Spec').
        ...SPEC_LABELS,
    ];
    if (level >= 2) {
        // Level 2 — meaningful atomic nodes.
        // Intentionally EXCLUDES raw ASTNode (~21k): force layout collapses
        // them into a clump. See memory: "Render-Kollision".
        labels.push(
            'Variable', 'ReturnValue', 'ControlFlow', 'ReturnStatement',
            'ContinueStatement', 'BreakStatement', 'ThrowStatement'
        );
    }
    // Level 3 — full AST parse (noise tier; use with caution).
    if (level >= 3) labels.push('ASTNode');
    return labels;
}

function levelEdgeTypes(level) {
    const edgeTypes = [
        'CALLS', 'RENDERS', 'IMPORTS', 'HANDLES', 'FETCHES', 'CONTAINS',
        'READS_STATE', 'WRITES_STATE', 'RETURNS', 'AFFECTS', 'APPLIES_TO', 'ANNOTATES', 'REFERENCES',
        'AWAITS', 'HAS_EFFECT', 'DATA_FLOWS_TO', 'CALLS_CONDITIONALLY',
        'BELONGS_TO', 'USES_TOPIC', 'PUBLISHES_TOPIC', 'SUBSCRIBES_TOPIC',
        'PROVIDES_SERVICE', 'CALLS_SERVICE', 'PROVIDES_ACTION', 'USES_ACTION',
        'WATCHES', 'ON_EVENT', 'PASSES_CALLBACK',
        'DECLARES', 'CONTAINS_FLOW', 'CONTAINS_STMT', 'DERIVES', 'INSTANTIATES',
        // Diagram structure, and the one edge that ties a diagram to the code
        // that implements it.
        'INHERITS', 'SPEC_RELATES', 'REALIZED_BY',
        // Epic → Task. Without it an Epic loads as a node nothing points at,
        // which is the one thing an Epic never is.
        'FULFILLED_BY',
    ];
    if (level >= 3) edgeTypes.push('CONTAINS_AST');
    return edgeTypes;
}

/**
 * Whether this workspace's database carries the builder's stored `degree`.
 *
 * Probed once per workspace, never guessed: Ladybug's single-table model
 * resolves properties against the schema, so reading a column that is not there
 * is a binder error that takes the WHOLE node query down with it — and the node
 * query is the graph. A database built before scripts/ladybug_schema.cjs grew
 * the column simply reports false and the graph goes on without it.
 */
const storedDegreeByDb = new Map();
async function hasStoredDegree(session, dbKey) {
    if (storedDegreeByDb.has(dbKey)) return storedDegreeByDb.get(dbKey);
    let available = false;
    try {
        await session.run(`MATCH (n) RETURN n.degree AS degree LIMIT 1`);
        available = true;
    } catch (err) {
        console.warn(`[Bridge] '${dbKey}' has no stored node degree yet (${err.message.split('\n')[0]}). ` +
            `Rebuild the graph to get it — the dashboard falls back to counting the edges it loaded.`);
    }
    storedDegreeByDb.set(dbKey, available);
    return available;
}

/**
 * Count nodes per label across the whole database.
 *
 * The shape of this query is not a matter of taste. Without the `WITH
 * labels(n) AS lbls` step it comes back EMPTY, and a WHERE clause built from an
 * empty census selects nothing — a graph with zero nodes, which on screen is
 * indistinguishable from a broken build. Keep it identical to the one in
 * /api/graph/stats.
 */
async function labelCensus(session) {
    const result = await session.run(
        `MATCH (n) WITH labels(n) AS lbls UNWIND lbls AS lbl
         RETURN lbl AS label, count(*) AS cnt ORDER BY cnt DESC`
    );
    const counts = new Map();
    for (const r of result.records) {
        const c = r.get('cnt');
        counts.set(String(r.get('label')), typeof c?.toNumber === 'function' ? c.toNumber() : Number(c));
    }
    return counts;
}

/**
 * Welche Knotentypen im Graphen aneinandergrenzen, und über wie viele Kanten.
 *
 * Das Frontend färbt neue Labels danach ein: ein Typ muss sich von seinen
 * NACHBARN unterscheiden, nicht von allen 26 Labels der Datenbank. Zwei Typen,
 * die nie eine Kante teilen, liegen im Layout auch nie nebeneinander und dürfen
 * sich deshalb ähnlich sehen. Ohne diese Zahlen bliebe dem Frontend nur, alle
 * gegen alle zu trennen — was jenseits von etwa acht Farben niemand kann.
 *
 * Pro Datenbank einmal berechnet. Das ist ein voller Kantenscan, und die Antwort
 * ändert sich nur mit einem Rebuild, nicht mit dem Zoomen im Dashboard.
 */
const adjacencyByDb = new Map();
async function labelAdjacency(session, dbKey) {
    if (adjacencyByDb.has(dbKey)) return adjacencyByDb.get(dbKey);
    const adjacency = {};
    try {
        const result = await session.run(
            `MATCH (a)-[r]->(b) RETURN labels(a)[0] AS from, labels(b)[0] AS to, count(*) AS cnt`
        );
        for (const rec of result.records) {
            const from = String(rec.get('from')), to = String(rec.get('to'));
            if (from === to) continue;   // Selbstbezug trennt keine Farben
            const raw = rec.get('cnt');
            const cnt = typeof raw?.toNumber === 'function' ? raw.toNumber() : Number(raw);
            (adjacency[from] ||= {})[to] = (adjacency[from][to] || 0) + cnt;
            (adjacency[to] ||= {})[from] = (adjacency[to][from] || 0) + cnt;
        }
    } catch (err) {
        // Rein kosmetisch. Fällt das hier aus, färbt das Frontend neue Labels
        // aus dem Namen — schlechter, aber kein Grund, den Graphen zu verlieren.
        console.warn(`[Bridge] label adjacency unavailable (${err.message.split('\n')[0]})`);
    }
    adjacencyByDb.set(dbKey, adjacency);
    return adjacency;
}

/**
 * Spend a node budget ALONG THE EDGES.
 *
 * The version this replaces handed each label its own `LIMIT quota` and glued
 * the results together. 494 nodes came back with 101 edges between them,
 * because a sample drawn per type has no reason to be about the same code. A
 * force layout with almost no edges has nothing holding it together: the
 * repulsion threw everything off screen and the canvas was empty. So:
 *
 *   - start at the best-connected node,
 *   - walk outward along real edges,
 *   - and use the type quotas only to decide WHICH neighbour goes next.
 *
 * A quota is therefore a preference, never a partition. When a type has nothing
 * left within reach its share goes to whoever does — keeping the graph
 * connected matters more than hitting a per-type number exactly.
 *
 * Several components are fine: when a walk runs out of frontier, it re-seeds at
 * the best-connected node it has not reached. Isolated nodes are never seeds —
 * they are precisely what a walk along edges cannot use, and they have their
 * own way in (see `includeIsolated`).
 *
 * @returns {{ keep: Set<number>, degree: Map<number, number>, isolated: number[] }}
 */
function selectConnectedBudget({ nodes, links, budget, quotas, typeOf }) {
    const adjacency = new Map();
    const degree = new Map();
    for (const n of nodes) { adjacency.set(n.id, []); degree.set(n.id, 0); }
    for (const l of links) {
        const s = l.source, t = l.target;
        if (s === t || !adjacency.has(s) || !adjacency.has(t)) continue;
        adjacency.get(s).push(t);
        adjacency.get(t).push(s);
        degree.set(s, degree.get(s) + 1);
        degree.set(t, degree.get(t) + 1);
    }
    // Meet the hubs first: with neighbours visited in descending degree the
    // budget buys a readable core instead of a fringe of leaves hanging off it.
    for (const list of adjacency.values()) {
        list.sort((a, b) => (degree.get(b) || 0) - (degree.get(a) || 0));
    }

    const isolated = nodes.filter((n) => (degree.get(n.id) || 0) === 0).map((n) => n.id);

    const byId = new Map(nodes.map((n) => [n.id, n]));
    const seeds = nodes
        .filter((n) => (degree.get(n.id) || 0) > 0)
        .sort((a, b) => (degree.get(b.id) || 0) - (degree.get(a.id) || 0));
    let seedCursor = 0;

    const keep = new Set();
    const takenPerType = new Map();
    const queued = new Set();
    // One FIFO per type, so "which type next" is a choice between queue heads
    // rather than a scan of the whole frontier.
    const frontier = new Map();

    const enqueue = (id) => {
        if (queued.has(id) || keep.has(id)) return;
        queued.add(id);
        const type = typeOf(byId.get(id));
        let queue = frontier.get(type);
        if (!queue) { queue = { items: [], head: 0 }; frontier.set(type, queue); }
        queue.items.push(id);
    };

    const take = (id) => {
        keep.add(id);
        const type = typeOf(byId.get(id));
        takenPerType.set(type, (takenPerType.get(type) || 0) + 1);
        for (const neighbour of adjacency.get(id) || []) enqueue(neighbour);
    };

    while (keep.size < budget) {
        let chosen = null;
        let bestDeficit = -Infinity;
        for (const [type, queue] of frontier) {
            if (queue.head >= queue.items.length) continue;
            const deficit = (quotas.get(type) || 0) - (takenPerType.get(type) || 0);
            if (deficit > bestDeficit) { bestDeficit = deficit; chosen = queue; }
        }
        if (!chosen) {
            // This component is exhausted. Open the next one at its hub — but
            // never at a node with no edges at all, or the budget would drain
            // into exactly the scattered dust this function exists to avoid.
            while (seedCursor < seeds.length && keep.has(seeds[seedCursor].id)) seedCursor++;
            if (seedCursor >= seeds.length) break;
            enqueue(seeds[seedCursor++].id);
            continue;
        }
        take(chosen.items[chosen.head++]);
    }

    return { keep, degree, isolated };
}

// ── Candidate cache ──────────────────────────────────────────────────
// Everything a detail level can offer, before any type filter and before the
// budget: all its nodes, all edges between them, the label census, the database
// size.
//
// It is cached because the filter is a rapid-fire control and the answer to it
// does not need the database. Every checkbox click used to cost a full re-read
// — census, node query and three dozen edge queries — measured at 2.5 to 4.3
// seconds each on a 122 000-node graph, for rows that had not changed in
// between. Switching a type back on now costs a walk over memory.
//
// A TTL rather than pure event invalidation, because the graph also changes
// from OUTSIDE this process: a build started in a terminal, an MCP agent
// writing nodes. Ten seconds is short enough that no stale picture survives
// a glance, and long enough that a run of filter clicks is free. Lock changes
// do not wait for it — the MCP change detector drops the cache outright, since
// a lock is exactly the kind of thing you are watching in real time.
// The cache's state and its two helpers live further up, right above switchDb —
// see "Candidate cache state". They have to be declared before the module-level
// switchDb(DEFAULT_DB) call runs, or the startup switch dies in the temporal
// dead zone.

/**
 * The full candidate set for a level — from cache when it is fresh.
 *
 * Note what is deliberately NOT a parameter: the hidden types. The node query
 * asks for every label the level knows, always. Filtering here would make the
 * cache key depend on the filter, which is precisely the thing that changes
 * often — and the un-filtered set is the superset of every filtered one, so it
 * is loaded once and cut in memory afterwards.
 */
async function loadCandidateSet(session, level) {
    const key = `${activeDb}::${level}`;
    if (candidateCache && candidateCache.key === key && (Date.now() - candidateCache.at) < CANDIDATE_TTL_MS) {
        return candidateCache;
    }
    if (candidateInFlight && candidateInFlight.key === key) {
        return candidateInFlight.promise;
    }
    const promise = readCandidateSet(session, level, key)
        .finally(() => { if (candidateInFlight?.promise === promise) candidateInFlight = null; });
    candidateInFlight = { key, promise };
    return promise;
}

async function readCandidateSet(session, level, key) {
    const allLabels = levelLabels(level);
    const edgeTypes = levelEdgeTypes(level);
    // Every label of the level, so this can never be empty. The older version
    // built this from the SELECTED types, where switching everything off
    // produced an empty WHERE — and an empty WHERE produces a graph with zero
    // nodes, which on screen is indistinguishable from a build that failed.
    const whereClause = allLabels.map((l) => `n:${l}`).join(' OR ');
    const nodes = [];
    const nodeIds = new Set();
    const links = [];

        // --- Step 1b: Census. Two jobs: the quotas below, and honest totals for
        // the UI — a filter that says "500 / 500" while the database holds 92 000
        // is telling you nothing you can act on.
        const census = await labelCensus(session);
        const totalNodesResult = await session.run(`MATCH (n) RETURN count(n) AS cnt`);
        const totalRaw = totalNodesResult.records[0]?.get('cnt');
        const totalInDb = typeof totalRaw?.toNumber === 'function' ? totalRaw.toNumber() : Number(totalRaw || 0);

        // --- Step 2: Load nodes matching the requested level ---
        // Intentionally EXCLUDES AST-level nodes at level 1 (Variable, ControlFlow, etc.):
        // there are ~11k+ of them, the force layout collapses them into a clump, and
        // they aren't reachable via /api/expand (which follows CALLS only). AST detail
        // belongs to drill-down, not the overview. See memory: "Render-Kollision".
        const storedDegree = await hasStoredDegree(session, activeDb);
        // elementId(n), not id(n) — see CLAUDE.md, "Knotenidentität". id()
        // resolves to n.seq, and the builder writes AST nodes in UNWIND chunks
        // of 500 that all receive the SAME seq. The dedup a few lines below then
        // keys on it: measured on the PSE database, 47 139 nodes arrived here as
        // 10 730 and the other 36 409 were dropped as duplicates of each other.
        const allNodesResult = await session.run(`
            MATCH (n)
            WHERE ${whereClause}
            RETURN elementId(n) AS id, n.name AS name, n.title AS title,
                   ${storedDegree ? 'n.degree' : 'null'} AS dbDegree,
                   n.file AS file, n.path AS path, n.elementId AS astElementId,
                   n.ipv6 AS ipv6, labels(n) AS labels,
                   n.params AS params, n.signature AS signature,
                   n.startLine AS startLine, n.endLine AS endLine,
                   n.bodySnippet AS bodySnippet,
                   n.status AS status, n.priority AS priority, n.taskId AS taskId,
                   n.locked AS locked, n.lockedBy AS lockedBy, n.lockStatus AS lockStatus,
                   n.category AS category, n.method AS method,
                   n.kind AS kind, n.preview AS preview, n.value AS value,
                   n.content AS content, n.description AS description,
                   n.layoutX AS layoutX, n.layoutY AS layoutY, n.layoutZ AS layoutZ
        `);

        for (const r of allNodesResult.records) {
            const id = String(r.get('id'));
            const labels = (r.get('labels') || []).map(String);
            // Every Spec* node also carries a synthetic 'Spec' label. The graph
            // filter matches on label keys, so this one aggregator key switches
            // the whole diagram layer on and off — instead of fifteen checkboxes
            // for SpecClass, SpecMethod, SpecField and the rest, which is a
            // distinction nobody wants to make in a filter list.
            if (labels.some((l) => SPEC_LABEL_SET.has(l))) labels.push('Spec');
            // A node carrying two labels comes back from two of the per-label
            // queries above. First one wins; without this the same node would be
            // pushed twice and the force layout would tear it in half.
            if (nodeIds.has(id)) continue;

            // Display name. Atomic/AST nodes (Variable, ControlFlow, ASTNode,
            // statements) often have no .name — fall back to .kind, the AST
            // sub-label + a code preview, or the label itself, so the graph
            // never shows bare ID numbers.
            const displayName = displayNameFor({
                name: r.get('name'), title: r.get('title'), kind: r.get('kind'),
                preview: r.get('preview'), value: r.get('value'),
                path: r.get('path'), elementId: r.get('astElementId'),
                label: labels[0], uid: id, content: r.get('content'),
            });

            nodes.push({
                id,
                name: displayName,
                file: r.get('file') || r.get('path'),
                ipv6: r.get('ipv6'),
                labels,
                params: r.get('params'),
                signature: r.get('signature'),
                startLine: r.get('startLine')?.toNumber?.() ?? null,
                endLine: r.get('endLine')?.toNumber?.() ?? null,
                bodySnippet: r.get('bodySnippet'),
                status: r.get('status'),
                priority: r.get('priority'),
                taskId: r.get('taskId'),
                locked: r.get('locked'),
                lockedBy: r.get('lockedBy'),
                lockStatus: r.get('lockStatus'),
                category: r.get('category'),
                method: r.get('method'),
                // Knowledge nodes carry their text in .content; Tasks in .description.
                // The inspector reads/edits these (see PATCH /api/knowledge).
                content: r.get('content'),
                description: r.get('description'),
                // Edge count across the WHOLE graph, from the builder — not just
                // the edges this level happens to load. A function that only
                // ever declares variables has zero architectural edges and
                // still is not dead code; this is the number that tells the
                // difference. Null on a database built before the property
                // existed; the renderer falls back to the loaded degree.
                dbDegree: r.get('dbDegree')?.toNumber?.() ?? (r.get('dbDegree') ?? null),
                // Layout positions from a previous force simulation run (null = not yet computed).
                // Used by GraphScene to skip the simulation and position nodes immediately.
                layoutX: r.get('layoutX') ?? null,
                layoutY: r.get('layoutY') ?? null,
                layoutZ: r.get('layoutZ') ?? null
            });
            nodeIds.add(id);
        }

        console.log(`[Bridge] Loaded ${nodeIds.size} candidate nodes (level ${level})`);

        // --- Step 2b: Cap level 3 BEFORE loading edges, so edges are only
        // fetched between kept nodes (no orphaned nodes/links). Structural
        // nodes are always kept; only raw ASTNodes are sampled to the budget.
        //
        // This is a property of the LEVEL, not of the filter, which is why it
        // belongs to the cached candidate set: a budget on top of it only ever
        // cuts further (the cap is 100 000, any budget is orders below), so
        // applying it here changes nothing about the result and keeps the cached
        // set from being the entire abstract syntax tree.
        let capped = null;
        if (nodeCapEnabled && level >= 3 && nodes.length > LEVEL3_NODE_CAP) {
            const total = nodes.length;
            const structural = nodes.filter(n => !n.labels.includes('ASTNode'));
            const ast = nodes.filter(n => n.labels.includes('ASTNode'));
            const astBudget = Math.max(0, LEVEL3_NODE_CAP - structural.length);
            const kept = structural.concat(ast.slice(0, astBudget));
            nodes.length = 0;
            nodes.push(...kept);
            nodeIds.clear();
            for (const n of kept) nodeIds.add(n.id);
            capped = { shown: nodes.length, total };
            console.log(`[Bridge] Level 3 capped: ${nodes.length}/${total} nodes (budget ${LEVEL3_NODE_CAP})`);
        }

        // --- Step 3: Load ALL edges between loaded nodes ---
        // Same identity as the nodes: 36 993 of 50 611 edges in the PSE database
        // have at least one endpoint whose seq is shared with another node, so
        // keying edges on id() attached them to whichever of those was written
        // last.
        // Filtered in JS, not in the WHERE clause. `elementId(a) IN $ids` with
        // 47 060 uid strings, run once per relationship type, did not finish in
        // three minutes — a list scan per row per query. Every edge of the
        // requested types is at most ~50k rows, which fetches in one pass; the
        // set lookup that decides which to keep is free.
        for (const relType of edgeTypes) {
            const linksResult = await session.run(`
                MATCH (a)-[r:${relType}]->(b)
                RETURN elementId(a) AS source, elementId(b) AS target, type(r) AS relType
            `);

            for (const r of linksResult.records) {
                const source = String(r.get('source'));
                const target = String(r.get('target'));
                if (!nodeIds.has(source) || !nodeIds.has(target)) continue;
                links.push({
                    source,
                    target,
                    relType: r.get('relType'),
                    propName: null
                });
            }
        }

        // PASSES_PROP separately (has properties)
        const propResult = await session.run(`
            MATCH (a)-[r:PASSES_PROP]->(b)
            RETURN elementId(a) AS source, elementId(b) AS target, r.name AS propName
        `);

        for (const r of propResult.records) {
            const source = String(r.get('source'));
            const target = String(r.get('target'));
            if (!nodeIds.has(source) || !nodeIds.has(target)) continue;
            links.push({
                source,
                target,
                relType: 'PASSES_PROP',
                propName: r.get('propName')
            });
        }

    candidateCache = { key, at: Date.now(), nodes, links, census, totalInDb, capped, allLabels };
    return candidateCache;
}

// ── Graph loader (budget spent along the edges) ──────────────────────
// level 1 (default): architectural nodes only — same set as before.
// level 2: + Variable, ControlFlow, ReturnStatement, ContinueStatement,
//            BreakStatement, ThrowStatement (meaningful atomic nodes).
// level 3: + ASTNode (full parse — ~21k extra nodes, very dense).
async function loadGraphData(level = 1, scope = graphScope) {
    const session = driver.session();
    try {
        const candidates = await loadCandidateSet(session, level);
        const { census, totalInDb, capped, allLabels } = candidates;

        // --- Step 1: Which of the candidates this filter selection asks for ---
        const hidden = new Set(scope?.hiddenTypes || []);
        // 'Spec' is the synthetic aggregator the UI filters on — one checkbox
        // for the whole imported-diagram layer. Switching it off has to reach
        // the fifteen real labels behind it.
        if (hidden.has('Spec')) for (const l of SPEC_LABELS) hidden.add(l);
        let activeLabels = allLabels.filter((l) => !hidden.has(l));
        // Everything switched off would leave nothing to walk — a graph with
        // zero nodes, on screen not distinguishable from a build that failed.
        // Fall back to the level's full list instead.
        if (activeLabels.length === 0) activeLabels = allLabels;
        const activeLabelSet = new Set(activeLabels);

        // Copies, not the cached objects: the budget pass writes `degree` onto
        // each node, and the next request must not inherit the last one's
        // numbers. The `labels` array is shared — nothing mutates it after the
        // candidate set is built.
        const nodes = [];
        const nodeIds = new Set();
        for (const n of candidates.nodes) {
            if (!n.labels.some((l) => activeLabelSet.has(l))) continue;
            nodes.push({ ...n });
            nodeIds.add(n.id);
        }
        const links = candidates.links
            .filter((l) => nodeIds.has(l.source) && nodeIds.has(l.target))
            .map((l) => ({ ...l }));

        const budget = Number(scope?.budget) > 0 ? Math.floor(Number(scope.budget)) : null;

        // --- Step 2: Spend the budget along the edges -------------------------
        // Everything above is the CANDIDATE set: every node of the selected
        // types and every edge between them. The cut happens here, on a graph
        // whose adjacency is fully known — which is the whole reason edges are
        // loaded before the cut and not after it.
        const available = nodes.length;
        const isolatedTotal = [];
        let connectedShown = nodes.length;

        if (budget != null && nodes.length > budget) {
            // Quotas proportional to how common a type is among the candidates.
            // Switching a type off removes it from the candidate set entirely,
            // so the remaining types' shares grow by themselves — that IS the
            // redistribution, no bookkeeping required.
            const candidatesPerType = new Map();
            const typeOf = (node) => {
                const labels = node?.labels || [];
                return labels.find((l) => activeLabels.includes(l)) || labels[0] || 'Unknown';
            };
            for (const n of nodes) {
                const t = typeOf(n);
                candidatesPerType.set(t, (candidatesPerType.get(t) || 0) + 1);
            }
            const quotas = new Map();
            for (const [t, count] of candidatesPerType) {
                quotas.set(t, (budget * count) / nodes.length);
            }

            const { keep, isolated } = selectConnectedBudget({
                nodes, links, budget, quotas, typeOf,
            });
            isolatedTotal.push(...isolated);

            // Nodes without edges: unreachable for a walk, and exactly the ones
            // worth finding (dead code). They come in only when asked for, and
            // never take more than a quarter of the budget — a block of loose
            // dots crowding out the network would undo the point of all of the
            // above. The count of what exists travels with the graph, so the
            // filter chip can say how many are being held back.
            if (scope?.includeIsolated && isolated.length > 0) {
                const share = Math.max(1, Math.floor(budget * 0.25));
                const isolatedTake = isolated.slice(0, share);
                // Make room rather than overshoot the budget: the whole promise
                // is that n stays n.
                const room = Math.max(0, budget - keep.size);
                let overflow = isolatedTake.length - room;
                if (overflow > 0) {
                    // Give back the LAST nodes the walk took — the outermost
                    // ones. Dropping hubs instead would tear holes in the middle
                    // of the very network the walk was built to produce.
                    const walked = Array.from(keep).reverse();
                    for (const id of walked) {
                        if (overflow <= 0) break;
                        keep.delete(id);
                        overflow--;
                    }
                }
                for (const id of isolatedTake) keep.add(id);
            }

            const kept = nodes.filter((n) => keep.has(n.id));
            nodes.length = 0;
            nodes.push(...kept);
            nodeIds.clear();
            for (const n of kept) nodeIds.add(n.id);

            const trimmed = links.filter((l) => keep.has(l.source) && keep.has(l.target));
            links.length = 0;
            links.push(...trimmed);
        } else {
            const degree = new Map(nodes.map((n) => [n.id, 0]));
            for (const l of links) {
                if (l.source === l.target) continue;
                if (degree.has(l.source)) degree.set(l.source, degree.get(l.source) + 1);
                if (degree.has(l.target)) degree.set(l.target, degree.get(l.target) + 1);
            }
            for (const [id, d] of degree) if (d === 0) isolatedTotal.push(id);
        }

        // How the delivered graph splits: the walk's network, and whatever
        // edgeless nodes were let in on top of it. Counted from the result, not
        // predicted before it, so the two always add up to what was shipped.
        const isolatedSet = new Set(isolatedTotal);
        const isolatedShown = nodes.reduce((sum, n) => sum + (isolatedSet.has(n.id) ? 1 : 0), 0);
        connectedShown = nodes.length - isolatedShown;

        // Per-node degree WITHIN the delivered graph. This is the number the
        // renderer can act on — it is what decides whether a line is drawn to a
        // node at all — so it travels with the node instead of being recomputed
        // in three places in the frontend.
        const finalDegree = new Map(nodes.map((n) => [n.id, 0]));
        for (const l of links) {
            if (l.source === l.target) continue;
            if (finalDegree.has(l.source)) finalDegree.set(l.source, finalDegree.get(l.source) + 1);
            if (finalDegree.has(l.target)) finalDegree.set(l.target, finalDegree.get(l.target) + 1);
        }
        for (const n of nodes) n.degree = finalDegree.get(n.id) || 0;

        // What the UI needs in order to describe the graph truthfully: what it
        // is showing, what it could have shown, and how big the database is.
        const scopeReport = {
            budget,
            available,                      // candidates of the selected types
            total: totalInDb,               // every node in the database
            shown: nodes.length,
            connected: connectedShown,
            isolated: isolatedTotal.length,   // how many exist, not how many are shown
            isolatedShown,
            includeIsolated: Boolean(scope?.includeIsolated),
            // Echoed back exactly as REQUESTED, not as expanded internally: the
            // frontend compares this against what it wants in order to skip a
            // reload that would change nothing, and 'Spec' unfolded into fifteen
            // real labels would never compare equal to the 'Spec' it sent.
            hiddenTypes: Array.from(new Set(scope?.hiddenTypes || [])),
            // Per-label counts across the whole DB, so a type's checkbox keeps
            // showing how many exist even after the filter stopped loading it.
            //
            // Der GANZE Census, nicht nur die Labels dieser Stufe. Der Filter
            // baut seine Typenliste daraus, und was hier nicht durchkommt, hat
            // dort keine Checkbox — genau so sind 'Idea', 'ImportedSymbol' und
            // 'Service' jahrelang im Graphen sichtbar, aber nicht abschaltbar
            // gewesen. Was die Stufe davon tatsächlich lädt, steht in
            // levelLabels; das Filtern ist Sache der Anzeige, nicht des Servers.
            labelCounts: Object.fromEntries(census),
            // Die Labels, die diese Detailstufe überhaupt anfasst. Ohne diese
            // Liste könnte der Filter nicht zwischen "gibt es hier nicht" und
            // "lädt diese Stufe nicht" unterscheiden — auf Level 1 stünde sonst
            // eine ASTNode-Checkbox mit 96.000 daneben, die nichts tut.
            levelLabels: allLabels,
            // Welche Typen aneinandergrenzen. Das Frontend leitet daraus die
            // Farbe jedes Labels ab, für das es keinen Anker gibt.
            labelAdjacency: await labelAdjacency(session, activeDb),
        };
        // How many nodes this level could load with NOTHING switched off. The
        // budget slider needs a fixed ceiling — `available` shrinks as soon as a
        // type is unchecked, and a slider whose maximum moves while you use it
        // is a slider you cannot aim.
        scopeReport.loadable = allLabels.reduce((sum, l) => sum + (census.get(l) || 0), 0);
        // The Spec aggregator has no row of its own in the census.
        scopeReport.labelCounts.Spec = SPEC_LABELS.reduce((sum, l) => sum + (census.get(l) || 0), 0);

        console.log(
            `[Bridge] Loaded ${nodes.length} nodes, ${links.length} links from ${BACKEND_NAME} ` +
            `(${activeDb}, level ${level}, budget ${budget ?? 'off'}, ` +
            `${available} candidates, ${isolatedTotal.length} isolated)`
        );
        return { nodes, links, capped, scope: scopeReport };
    } finally {
        await session.close();
    }
}

// ── Terminal WebSocket (node-pty) ────────────────────────────────────
// Provides a real shell via WebSocket at ws://<host>:<BRIDGE_PORT>/terminal
// (the port is derived per project — see server/codevis-paths.cjs).
// Each connection spawns a separate pty process (bash).
// Requires: npm install node-pty ws (ws is bundled with socket.io already via engine.io)

function setupTerminalWebSocket(httpServer) {
    let pty;
    try {
        pty = require('node-pty');
    } catch (_) {
        console.warn('[Terminal] node-pty not installed — terminal WebSocket disabled.');
        console.warn('[Terminal] Run: npm install node-pty');
        return;
    }

    // Use the raw ws server that socket.io attaches to, but register a separate
    // upgrade handler for the /terminal path so socket.io still owns its own path.
    const { WebSocketServer } = require('ws');
    const wss = new WebSocketServer({ noServer: true });

    // Intercept upgrade BEFORE socket.io gets it — only claim /terminal path.
    // We must prepend our listener so it runs first, then prevent socket.io
    // from also handling the same socket by destroying it if we claimed it.
    const listeners = httpServer.listeners('upgrade').slice();
    httpServer.removeAllListeners('upgrade');

    httpServer.on('upgrade', (request, socket, head) => {
        const url = new URL(request.url, `http://${request.headers.host}`);
        if (url.pathname === '/terminal') {
            const origin = request.headers.origin;
            if (origin) {
                if (!isAllowedBrowserOrigin(origin)) {
                    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
                    socket.destroy();
                    return;
                }
            }
            wss.handleUpgrade(request, socket, head, (ws) => {
                wss.emit('connection', ws, request);
            });
            return; // Don't pass to socket.io
        }
        // Pass to original listeners (socket.io)
        for (const fn of listeners) {
            fn.call(httpServer, request, socket, head);
        }
    });

    wss.on('connection', (ws) => {
        console.log('[Terminal] New terminal session');

        const shell = process.env.SHELL || (process.platform === 'win32' ? 'cmd.exe' : 'bash');
        const ptyProcess = pty.spawn(shell, [], {
            name: 'xterm-256color',
            cols: 80,
            rows: 24,
            cwd: process.cwd(),
            env: { ...process.env, TERM: 'xterm-256color' },
        });

        // pty → WebSocket
        ptyProcess.onData((data) => {
            if (ws.readyState === ws.OPEN) {
                ws.send(data);
            }
        });

        ptyProcess.onExit(({ exitCode }) => {
            console.log(`[Terminal] pty exited (code ${exitCode})`);
            if (ws.readyState === ws.OPEN) {
                ws.send(`\r\n\x1b[33m[Terminal] Shell exited (code ${exitCode})\x1b[0m\r\n`);
                ws.close();
            }
        });

        // WebSocket → pty
        ws.on('message', (rawData) => {
            const str = rawData.toString();
            try {
                const msg = JSON.parse(str);
                if (msg.type === 'resize' && msg.cols && msg.rows) {
                    ptyProcess.resize(
                        Math.max(1, Math.min(500, msg.cols)),
                        Math.max(1, Math.min(200, msg.rows))
                    );
                }
                // All JSON messages are control messages — never forward to pty
                return;
            } catch (_) {
                // Not JSON — treat as raw terminal input
            }
            ptyProcess.write(str);
        });

        ws.on('close', () => {
            console.log('[Terminal] WebSocket closed — killing pty');
            try { ptyProcess.kill(); } catch (_) { /* already dead */ }
        });

        ws.on('error', (err) => {
            console.error('[Terminal] WebSocket error:', err.message);
            try { ptyProcess.kill(); } catch (_) { /* ignore */ }
        });
    });

    // The port is derived per project — printing a hardcoded 4000 sent people to
    // a port this bridge is not listening on.
    console.log(`[Bridge] Terminal WebSocket registered at ws://localhost:${PORT}/terminal`);
}
// setupTerminalWebSocket is called after httpServer is created (see below)




// ── Debugger: DFS call tree from a start node ────────────────────────
async function getDebugPaths(startNodeId, direction = 'out') {
    const session = driver.session();
    try {
        // Reachable-set form (Kuzu + Neo4j): collect every node within 6 hops of
        // the start, plus each node's DIRECT CALLS/RENDERS child as (node→childId)
        // rows; the tree is then assembled in JS below. Avoids path-chain array
        // indexing (Kuzu lists are 1-based / variable indices unsupported) and the
        // `MATCH p=…` named-path syntax, and sidesteps the path-enumeration blow-up
        // of the old `*1..6` decomposition.
        const traversal = direction === 'in'
            ? `OPTIONAL MATCH (node)-[:CALLS|RENDERS*0..6]->(start)
               WITH DISTINCT node
               OPTIONAL MATCH (child)-[:CALLS|RENDERS]->(node)`
            : `OPTIONAL MATCH (start)-[:CALLS|RENDERS*0..6]->(node)
               WITH DISTINCT node
               OPTIONAL MATCH (node)-[:CALLS|RENDERS]->(child)`;
        const result = await session.run(`
            MATCH (start) WHERE elementId(start) = $startId
            ${traversal}
            RETURN elementId(node) AS id, node.name AS name, node.file AS file,
                   labels(node) AS labels, node.signature AS signature,
                   elementId(child) AS childId
        `, { startId: String(startNodeId) });

        // Build a tree structure from the flat results
        const nodesMap = new Map();
        const childrenMap = new Map(); // parentId -> Set<childId>

        for (const r of result.records) {
            const id = String(r.get('id'));
            const rawChild = r.get('childId');
            const childId = rawChild === null || rawChild === undefined ? null : String(rawChild);

            if (!nodesMap.has(id)) {
                nodesMap.set(id, {
                    id,
                    name: r.get('name'),
                    file: r.get('file'),
                    labels: r.get('labels'),
                    signature: r.get('signature'),
                    children: []
                });
            }

            if (childId !== null) {
                if (!childrenMap.has(id)) childrenMap.set(id, new Set());
                childrenMap.get(id).add(childId);
            }
        }

        // Wire up children
        for (const [parentId, childIds] of childrenMap) {
            const parent = nodesMap.get(parentId);
            if (parent) {
                parent.children = [...childIds]
                    .map(cid => nodesMap.get(cid))
                    .filter(Boolean);
            }
        }

        const root = nodesMap.get(String(startNodeId));
        return root || null;
    } finally {
        await session.close();
    }
}



// ── Debugger: Expand a border node (load its immediate children) ─────
async function expandNode(nodeId, direction = 'out') {
    const session = driver.session();
    try {
        // Get child nodes
        const match = direction === 'in'
            ? 'MATCH (child)-[:CALLS]->(parent)'
            : 'MATCH (parent)-[:CALLS]->(child)';
        const childResult = await session.run(`
            ${match}
            WHERE elementId(parent) = $nodeId
            RETURN elementId(child) AS id, child.name AS name, child.file AS file,
                   child.ipv6 AS ipv6, labels(child) AS labels, child.params AS params,
                   child.signature AS signature,
                   child.startLine AS startLine, child.endLine AS endLine,
                   child.bodySnippet AS bodySnippet
        `, { nodeId: String(nodeId) });

        const nodes = [];
        const links = [];

        for (const r of childResult.records) {
            const childId = String(r.get('id'));
            nodes.push({
                id: childId,
                name: r.get('name'),
                file: r.get('file'),
                ipv6: r.get('ipv6'),
                labels: r.get('labels'),
                params: r.get('params'),
                signature: r.get('signature'),
                startLine: r.get('startLine')?.toNumber?.() ?? null,
                endLine: r.get('endLine')?.toNumber?.() ?? null,
                bodySnippet: r.get('bodySnippet')
            });
            links.push({
                source: direction === 'in' ? childId : nodeId,
                target: direction === 'in' ? nodeId : childId,
                relType: 'CALLS',
                propName: null
            });
        }

        return { nodes, links };
    } finally {
        await session.close();
    }
}

// Load the ATOMIC level of a node on demand: the variables it declares, its
// control-flow blocks and its statements. This is how the user inspects the
// fine-grained parse without dumping all ~21k AST nodes into the overview (which
// would re-create the clump). Raw CONTAINS_AST/ASTNode tokens are excluded by
// default — they are noise; pass ?includeAst=1 to include them too.
async function expandAstNode(nodeId, includeAst = false) {
    const session = driver.session();
    try {
        const relTypes = includeAst
            ? 'DECLARES|CONTAINS_FLOW|CONTAINS_STMT|RETURNS|CONTAINS_AST'
            : 'DECLARES|CONTAINS_FLOW|CONTAINS_STMT|RETURNS';
        // The LIMIT was 400, silently. Five nodes in the PSE database have more
        // children than that, the largest 2923 — expanding one of them showed a
        // fraction of its body with nothing saying so. The cap is now high
        // enough not to bite in practice and the caller is told when it does.
        const EXPAND_AST_LIMIT = 5000;
        const result = await session.run(`
            MATCH (parent)-[r:${relTypes}]->(child)
            WHERE elementId(parent) = $nodeId
            RETURN elementId(child) AS id, child.name AS name, child.file AS file,
                   child.path AS path, child.elementId AS astElementId,
                   child.ipv6 AS ipv6, labels(child) AS labels, child.kind AS kind,
                   child.preview AS preview, child.value AS value,
                   child.signature AS signature, child.bodySnippet AS bodySnippet,
                   child.startLine AS startLine, child.endLine AS endLine,
                   type(r) AS relType
            LIMIT ${EXPAND_AST_LIMIT}
        `, { nodeId: String(nodeId) });

        const nodes = [];
        const links = [];
        for (const r of result.records) {
            const childId = String(r.get('id'));
            const labels = r.get('labels') || [];
            const display = displayNameFor({
                name: r.get('name'), kind: r.get('kind'),
                preview: r.get('preview'), value: r.get('value'),
                path: r.get('path'), elementId: r.get('astElementId'),
                label: labels[0], uid: childId,
            }) || `#${childId}`;
            nodes.push({
                id: childId,
                name: display,
                file: r.get('file') || r.get('path'),
                ipv6: r.get('ipv6'),
                labels: r.get('labels'),
                signature: r.get('signature'),
                bodySnippet: r.get('bodySnippet'),
                startLine: r.get('startLine')?.toNumber?.() ?? null,
                endLine: r.get('endLine')?.toNumber?.() ?? null,
            });
            links.push({ source: nodeId, target: childId, relType: r.get('relType'), propName: null });
        }
        return { nodes, links };
    } finally {
        await session.close();
    }
}

// ── Layout persistence ───────────────────────────────────────────────
// Receives { positions: { "<nodeId>": { x, y, z }, ... } } from the frontend
// after the force simulation converges, and writes layoutX/Y/Z back to the
// graph so the next page load can skip the simulation entirely.
// Batched with UNWIND to avoid N round-trips for large graphs.
app.post('/api/layout', async (req, res) => {
    const { positions } = req.body || {};
    if (!positions || typeof positions !== 'object') {
        return res.status(400).json({ error: 'positions object required' });
    }
    const entries = Object.entries(positions);
    if (entries.length === 0) return res.json({ ok: true, updated: 0 });

    const session = driver.session();
    try {
        const BATCH = 500;
        let updated = 0;
        for (let i = 0; i < entries.length; i += BATCH) {
            // Keyed by uid. Under id() a single saved position was written to
            // every node sharing that seq — up to 500 of them — so the stored
            // layout described a graph that never existed.
            const batch = entries.slice(i, i + BATCH).map(([id, pos]) => ({
                id: String(id),
                x: Number(pos.x) || 0,
                y: Number(pos.y) || 0,
                z: Number(pos.z) || 0,
            }));
            await session.run(
                `UNWIND $items AS item
                 MATCH (n) WHERE elementId(n) = item.id
                 SET n.layoutX = item.x, n.layoutY = item.y, n.layoutZ = item.z`,
                { items: batch }
            );
            updated += batch.length;
        }
        console.log(`[Bridge] Layout saved for ${updated} nodes (db: ${activeDb})`);
        res.json({ ok: true, updated });
    } catch (err) {
        console.error('[Bridge] /api/layout error:', err.message);
        res.status(500).json({ error: err.message });
    } finally {
        await session.close();
    }
});


// ── Pulse (AutoTraffic) process management ───────────────────────────
let pulseProcess = null;

function isPulseRunning() {
    return pulseProcess !== null && !pulseProcess.killed;
}

function startPulse() {
    if (isPulseRunning()) return;
    const pulsePath = path.join(__dirname, '..', 'scripts', 'pulse.js');
    pulseProcess = spawn('node', [pulsePath], { stdio: 'inherit' });
    pulseProcess.on('exit', (code) => {
        console.log(`[Bridge] Pulse process exited (code ${code})`);
        pulseProcess = null;
        io.emit('pulse:status', { running: false });
    });
    console.log('[Bridge] Pulse simulator started');
}

function stopPulse() {
    if (!isPulseRunning()) return;
    pulseProcess.kill('SIGINT');
    pulseProcess = null;
    console.log('[Bridge] Pulse simulator stopped');
}

// ── Stale Lock Cleanup Job ───────────────────────────────────────────
// Runs every 60s across ALL configured databases.
// 1. Releases locks whose lockExpires has passed.
// 2. Resets editInProgress flags older than 5 minutes, attempts file rollback from backup.
const STALE_EDIT_TTL_MS = 300000; // 5 minutes
const LOCK_CLEANUP_INTERVAL_MS = 60000; // 1 minute

async function runStaleLockCleanup() {
    const results = { expired: 0, staleEdits: 0, recovered: 0 };
    const staleAgents = new Set();

    for (const [dbKey, dbDriver] of Object.entries(drivers)) {
        const session = dbDriver.session();
        try {
            // 1. Expire TTL-based locks — active AND planned, and clear every
            // lock property. The MCP sweep (tools/lib/locks.ts) already did
            // both; this one only expired locked=true and left lockGroup on
            // planned nodes, so an abandoned backlog task kept blocking
            // create_task's planning guard whenever the dashboard swept first.
            const expireResult = await session.run(
                `MATCH (n) WHERE (n.locked = true OR n.lockStatus = 'planned')
                   AND n.lockExpires IS NOT NULL AND n.lockExpires <= timestamp()
                 SET n.locked = null, n.lockedBy = null, n.lockGroup = null,
                     n.lockExpires = null, n.lockOrigin = null, n.lockStatus = null,
                     n.plannedBy = null
                 RETURN count(n) AS expired`
            );
            const expired = expireResult.records[0]?.get('expired')?.toNumber?.() ?? 0;
            results.expired += expired;

            // 2. Find stale editInProgress flags (> 5 min old)
            const staleEditsResult = await session.run(
                `MATCH (n) WHERE n.editInProgress = true
                   AND n.editInProgressSince IS NOT NULL
                   AND n.editInProgressSince < (timestamp() - $ttl)
                 RETURN n.name AS name, n.file AS file, n.lockedBy AS lockedBy,
                        n.editInProgressSince AS since`,
                { ttl: STALE_EDIT_TTL_MS }
            );

            for (const rec of staleEditsResult.records) {
                const nodeName = rec.get('name');
                const nodeFile = rec.get('file');
                const lockedBy = rec.get('lockedBy');
                const sinceMs = rec.get('since')?.toNumber?.() ?? 0;
                const ageSeconds = Math.round((Date.now() - sinceMs) / 1000);

                console.warn(`[cleanup] Stale editInProgress on '${nodeName}' (${nodeFile}), agent: ${lockedBy}, age: ${ageSeconds}s`);
                staleAgents.add(lockedBy);
                results.staleEdits++;

                // Attempt file rollback from latest backup for this file + agent
                let recovered = false;
                if (nodeFile) {
                    try {
                        const fs = require('fs');
                        const backupDir = path.resolve(__dirname, '..', '.claude', 'backups');
                        if (fs.existsSync(backupDir)) {
                            const escapedFile = nodeFile.replace(/[^a-zA-Z0-9._-]/g, '_');
                            // Find most recent backup for this agent + file
                            const allBackups = fs.readdirSync(backupDir)
                                .filter(f => f.endsWith('.bak') && f.includes(lockedBy || '') && f.includes(escapedFile))
                                .sort()
                                .reverse();

                            if (allBackups.length > 0) {
                                const backupPath = path.join(backupDir, allBackups[0]);
                                const absoluteFilePath = path.resolve(PROJECT_ROOT, nodeFile);
                                // Defense-in-depth: nodeFile comes from the graph
                                // (parser output), not a trusted constant. Refuse
                                // to write outside the project — a stray '../…'
                                // path must not let stale-lock recovery clobber an
                                // arbitrary file on disk.
                                const normFile = absoluteFilePath.replace(/\\/g, '/');
                                const normRoot = path.resolve(PROJECT_ROOT).replace(/\\/g, '/');
                                if (normFile !== normRoot && !normFile.startsWith(normRoot + '/')) {
                                    console.warn(`[recovery] SKIP: node file '${nodeFile}' resolves outside the project root — not restoring`);
                                    continue;
                                }
                                const backupContent = fs.readFileSync(backupPath, 'utf-8');

                                // Write atomically
                                const tmpPath = absoluteFilePath + '.cleanup_tmp';
                                fs.writeFileSync(tmpPath, backupContent, 'utf-8');
                                fs.renameSync(tmpPath, absoluteFilePath);
                                recovered = true;
                                results.recovered++;
                                console.log(`[recovery] Agent ${lockedBy} crashed with edit on node '${nodeName}' — backup restored from ${allBackups[0]}, lock released`);
                            }
                        }
                    } catch (recoveryErr) {
                        console.warn(`[cleanup] Backup restore failed for '${nodeName}': ${recoveryErr.message}`);
                    }
                }

                // Reset the editInProgress flag regardless of recovery success
                await session.run(
                    `MATCH (n {name: $name, file: $file})
                     SET n.editInProgress = null, n.editInProgressSince = null`,
                    { name: nodeName, file: nodeFile }
                );

                // If agent's task is in_progress, flag it as needs_info
                if (lockedBy) {
                    await session.run(
                        `MATCH (t:Task {assignedTo: $agentId, status: 'in_progress'})
                         SET t.lastComment = $comment, t.updatedBy = 'cleanup-job'`,
                        {
                            agentId: lockedBy,
                            comment: recovered
                                ? `Auto-recovered from crashed worker: backup restored for '${nodeName}'`
                                : `Stale editInProgress detected for '${nodeName}' — no backup found, manual recovery may be needed`
                        }
                    );
                }
            }

        } catch (err) {
            if (!err.message?.includes('connection')) {
                console.error(`[cleanup] Error in db '${dbKey}': ${err.message}`);
            }
        } finally {
            await session.close();
        }
    }

    if (results.expired > 0 || results.staleEdits > 0) {
        console.log(`[cleanup] Expired locks: ${results.expired}, Stale editInProgress: ${results.staleEdits}, Recovered: ${results.recovered}${staleAgents.size > 0 ? `, agents: [${[...staleAgents].join(', ')}]` : ''}`);
    }
}

/**
 * Der Wechsel auf den Selbst-Graphen: Rückfrage statt Zugangsdaten.
 *
 * Die Gefahr ist real — `meta` enthält CodeVis' eigenen Code und sein eigenes
 * Kanban, und wer versehentlich dort landet, plant und editiert gegen CodeVis
 * statt gegen sein Projekt. Nur war das Mittel falsch gewählt.
 *
 * Vorher verlangte der Wechsel ein Geheimnis aus CODEVIS_META_UNLOCK_SECRET,
 * und ohne gesetzte Variable war er GAR NICHT möglich: die Route antwortete mit
 * 503 und dem Hinweis, eine Umgebungsvariable zu setzen und die Bridge neu zu
 * starten. Für jemanden, der nur seinen eigenen Graphen ansehen will, ist das
 * eine Wand ohne Tür — und beim Weitergeben an andere Nutzer reine Reibung.
 *
 * Als Schutz taugte es ohnehin nicht. Die Begründung lautete, die Bridge könne
 * über localhost hinaus erreichbar sein; trifft das zu, liegt der PROJEKT-Graph
 * mitsamt Kanban, Edit- und Task-Endpunkten völlig ungeschützt daneben. Ein
 * Geheimnis nur für den Selbst-Graphen sichert das Unwichtigere. Trifft es
 * nicht zu, schützt es vor niemandem.
 *
 * Gegen ein Versehen hilft eine Rückfrage, und die gehört ins Frontend. Das
 * Geheimnis bleibt deshalb OPTIONAL: wer die Bridge tatsächlich exponiert, kann
 * es setzen und bekommt die alte Strenge zurück. Ist es nicht gesetzt — der
 * Normalfall auf einem Arbeitsplatz — ist der Wechsel erlaubt, und /api/status
 * sagt der Oberfläche, welcher der beiden Fälle gilt.
 */
const META_UNLOCK_SECRET = String(process.env.CODEVIS_META_UNLOCK_SECRET || '').trim() || null;

// Switch database
app.post('/api/switch-db', async (req, res) => {
    try {
        const { db, unlockSecret } = req.body || {};
        const normalizedDb = normalizeWorkspaceName(db, activeDb);
        // Nur prüfen, wenn ein Geheimnis überhaupt konfiguriert ist. Ohne
        // Konfiguration ist der Wechsel erlaubt; die Rückfrage steht im
        // Frontend, wo ein Versehen auch entsteht.
        if (normalizedDb === 'meta' && activeDb !== 'meta' && META_UNLOCK_SECRET && unlockSecret !== META_UNLOCK_SECRET) {
            return res.status(403).json({
                error: 'Meta database is locked.',
                code: 'META_LOCKED',
            });
        }
        await switchDb(normalizedDb);
        // Reload graph and push to all connected clients.
        //
        // MIT currentLevel, nicht ohne: der Default-Parameter ist Level 1, die
        // Bridge-Variable blieb aber auf der zuletzt gewählten Stufe stehen.
        // Ein DB-Wechsel auf Stufe 3 lieferte damit einen Level-1-Graphen,
        // während currentLevel weiter 3 sagte — und der nächste Client-Connect
        // (loadGraphData(currentLevel)) holte Stufe 3 zurück, obwohl der Knopf
        // im Frontend unverändert 'Architecture' anzeigte. So kam der Node-
        // Budget-Regler auf 144265 statt der 3751 seiner angezeigten Stufe.
        cachedGraph = await loadGraphData(currentLevel);
        io.emit('graph:init', cachedGraph);
        io.emit('graph:nodeIds', cachedGraph.nodes.map(n => n.id));
        // Der Wechsel ist erst dann für alle wahr, wenn auch die Konfiguration
        // nachgezogen ist: ein Client, der während des Umschaltens gerade
        // reconnectet, hat sein config:status aus dem Connect-Handler noch mit
        // der ALTEN Datenbank bekommen und stellt sonst dauerhaft die falsche
        // um. Das Broadcast hier kommt garantiert danach.
        const activeWorkspace = publicWorkspaceName(activeDb);
        io.emit('config:status', { activeDb: activeWorkspace, limits, detailLevel: currentLevel });
        res.json({ ok: true, activeDb: activeWorkspace, workspace: activeWorkspace, nodes: cachedGraph.nodes.length, links: cachedGraph.links.length });
    } catch (err) {
        console.error('[Bridge] DB switch error:', err.message);
        res.status(400).json({ error: err.message });
    }
});

// Update graph loading config.
//
// The four *Limit values are INERT and have been for a long time: loadGraphData
// builds its node query from labels and the detail level only — it never reads
// `limits`. Setting func=200 while the bridge serves 2000 nodes is the usual
// result. They are still accepted here because set_bridge_config (the MCP tool)
// posts them, and rejecting them would break that caller for no gain. They are
// no longer offered in the dashboard: a control that does nothing costs more
// time than a missing one.
//
// What genuinely bounds the graph is the detail level, and at level 3 the node
// cap — which `nodeCap` switches off.
app.post('/api/config', async (req, res) => {
    try {
        const { seedLimit, funcLimit, moduleLimit, endpointLimit, nodeCap } = req.body;
        if (seedLimit != null) limits.seed = Math.max(1, Math.min(100, Number(seedLimit)));
        if (funcLimit != null) limits.func = Math.max(1, Math.min(2000, Number(funcLimit)));
        if (moduleLimit != null) limits.module = Math.max(0, Math.min(500, Number(moduleLimit)));
        if (endpointLimit != null) limits.endpoint = Math.max(0, Math.min(200, Number(endpointLimit)));
        if (nodeCap != null) {
            nodeCapEnabled = Boolean(nodeCap);
            console.log(`[Bridge] Level-3 node cap ${nodeCapEnabled ? `on (${LEVEL3_NODE_CAP})` : 'OFF — the client gets every node'}`);
        }
        // Reload so the change is visible immediately.
        cachedGraph = await loadGraphData(currentLevel);
        io.emit('graph:init', cachedGraph);
        io.emit('graph:nodeIds', cachedGraph.nodes.map(n => n.id));
        res.json({ ok: true, limits, nodeCap: nodeCapEnabled });
    } catch (err) {
        console.error('[Bridge] Config error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── Graph scope: how much graph, and of which types ──────────────────────────
// The one control that decides what the bridge LOADS. `budget` is a node count
// spent along the edges, `hiddenTypes` are the filter's unchecked boxes, and
// `includeIsolated` lets the edgeless nodes in — the ones a walk along edges
// can never reach.
//
// Deselecting a type does not leave a hole: it drops out of the candidate set,
// so the proportional quotas of everything else grow and the walk simply goes
// further. The total stays at `budget`.
app.post('/api/graph/scope', async (req, res) => {
    try {
        const { budget, hiddenTypes, includeIsolated } = req.body || {};
        if (budget !== undefined) {
            const n = Number(budget);
            // null/0 means "no budget" — load every candidate the level allows.
            graphScope.budget = Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
        }
        if (Array.isArray(hiddenTypes)) {
            graphScope.hiddenTypes = hiddenTypes.map(String);
        }
        if (includeIsolated !== undefined) {
            graphScope.includeIsolated = Boolean(includeIsolated);
        }
        cachedGraph = await loadGraphData(currentLevel, graphScope);
        io.emit('graph:init', cachedGraph);
        io.emit('graph:nodeIds', cachedGraph.nodes.map(n => n.id));
        res.json({
            ok: true,
            scope: cachedGraph.scope,
            nodes: cachedGraph.nodes.length,
            links: cachedGraph.links.length,
        });
    } catch (err) {
        console.error('[Bridge] /api/graph/scope error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Get current status
// ── Explore Tab: Graph Stats ─────────────────────────────────────────────────
// Returns a summary of what is in the currently-active graph database:
// node counts per label, edge counts per relationship type, file count,
// last-parsed timestamp, and which optional extractors are active.
// Read-only: no writes happen here, the query only aggregates existing data.
app.get('/api/graph/stats', async (req, res) => {
    const dbKey = req.query.db || activeDb;
    const d = drivers[dbKey] || driver;
    const session = d.session();
    try {
        // Node counts per label — UNWIND labels so multi-label nodes are counted once per label.
        const nodeLabelResult = await session.run(
            `MATCH (n) WITH labels(n) AS lbls UNWIND lbls AS lbl RETURN lbl AS label, count(*) AS cnt ORDER BY cnt DESC`
        );
        const nodesByLabel = {};
        for (const r of nodeLabelResult.records) {
            nodesByLabel[r.get('label')] = r.get('cnt').toNumber ? r.get('cnt').toNumber() : Number(r.get('cnt'));
        }

        // Edge counts per relationship type.
        const edgeTypeResult = await session.run(
            `MATCH ()-[r]->() RETURN type(r) AS relType, count(*) AS cnt ORDER BY cnt DESC`
        );
        const edgesByType = {};
        for (const r of edgeTypeResult.records) {
            edgesByType[r.get('relType')] = r.get('cnt').toNumber ? r.get('cnt').toNumber() : Number(r.get('cnt'));
        }

        // Two different timestamps that are easy to confuse, so both are returned
        // under names that say which is which:
        //
        //   lastParsed  — the newest SOURCE FILE mtime the builder saw. The
        //                 builder stores fs.statSync(file).mtimeMs here, because
        //                 that is what an incremental build compares against.
        //   lastBuilt   — when the builder actually ran (Date.now() at parse).
        //
        // The Explore tab labelled lastParsed "last build", which is wrong
        // whenever the two differ — and they differ exactly when it matters. A
        // graph built today from code last edited in June reported "last build:
        // 25.6.", which reads as "this graph is six weeks old" when it is
        // minutes old. The reverse is worse: a graph nobody has rebuilt looks
        // fresh as soon as you touch a source file.
        const fileResult = await session.run(
            `MATCH (f:File) RETURN count(f) AS fileCount, max(f.lastParsed) AS lastParsed,
                    max(f.updatedAt) AS lastBuilt`
        );
        const fileRow = fileResult.records[0];
        const num = (v) => (v == null ? null : (typeof v.toNumber === 'function' ? v.toNumber() : Number(v)));
        const fileCount = fileRow ? (num(fileRow.get('fileCount')) || 0) : 0;
        const lastParsed = fileRow ? num(fileRow.get('lastParsed')) : null;
        const lastBuilt = fileRow ? num(fileRow.get('lastBuilt')) : null;

        // Active extractors come from the in-memory config (same source as /api/status).
        const extractors = resolveExtractors(config, dbKey).enabled;
        const freshness = await graphFreshness(session, dbKey);

        res.json({
            db: dbKey,
            nodesByLabel,
            edgesByType,
            fileCount,
            lastParsed,  // epoch-ms: newest source mtime, or null if never parsed
            lastBuilt,   // epoch-ms: when the builder ran, or null if never built
            extractors,
            ...freshness,
        });
    } catch (err) {
        console.error('[Bridge] /api/graph/stats error:', err.message);
        res.status(500).json({ error: err.message });
    } finally {
        await session.close();
    }
});

// ── Explore Tab: Free-text Cypher Query ──────────────────────────────────────
// Executes a user-supplied Cypher query from the browser.
//
// The shared lexical guard rejects mutations and unapproved procedures.
// The daemon additionally executes the query inside a read-only transaction,
// under its connection mutex. Dedicated write routes use separate sessions.
// There is deliberately NO row cap here. There was one — 500, then 25000 — and
// both were the same mistake: a number nobody chose, silently answering a
// narrower question than the one that was asked, and outliving everyone's
// memory of it being there. The query says how much it wants; `LIMIT` is a
// Cypher clause and belongs to whoever writes the query. The dashboard pages
// the table on its own side, where the reader can see it happening.

const { executeExploreQuery } = require('./explore-routes.cjs');
const { isWriteQuery } = require('./query-security.cjs');

app.post('/api/graph/query', async (req, res) => {
    const { query, db: reqDb } = req.body || {};
    if (!query || typeof query !== 'string' || !query.trim()) {
        return res.status(400).json({ error: 'query is required' });
    }

    // Reject any query that would modify the graph.
    if (isWriteQuery(query)) {
        return res.status(400).json({
            error: 'Only a single read-only query with approved read procedures is allowed from the Explore tab.',
        });
    }

    const dbKey = reqDb || activeDb;
    const d = drivers[dbKey] || driver;
    try {
        res.json(await executeExploreQuery(d, query));
    } catch (err) {
        // Surface the Cypher error to the user so they can fix the query.
        console.error('[Bridge] /api/graph/query error:', err.message);
        res.status(400).json({ error: err.message });
    }
});

// GET /api/graph/predefined-queries — list of named queries for the scan buttons.
// The same list lives in tools/lib/queries.ts (for the MCP tool), both imported
// from the shared scripts/predefined-queries.cjs so they never diverge.
app.get('/api/graph/predefined-queries', (req, res) => {
    const { PREDEFINED_QUERIES } = require('../scripts/predefined-queries.cjs');
    res.json({ queries: PREDEFINED_QUERIES });
});

// The property list every subgraph node carries. Written once because the
// result set and its expanded neighbourhood are loaded by two different WHERE
// clauses and must produce structurally identical rows.
// Identity is `elementId(n)` (= n.uid, the primary key), NOT `id(n)`.
// `id(n)` translates to `n.seq`, and seq is not unique: the PSE database has
// 47139 nodes and 10730 distinct seq values. Everything downstream keys nodes
// by this id — the dashboard's node map, both ends of every link — so keying on
// seq silently collapsed four nodes into one and hung edges off whichever of
// them was written last. A query for 9352 nodes arrived as 2948.
const SUBGRAPH_NODE_RETURN = `
    RETURN elementId(n) AS id, n.name AS name, n.title AS title,
           n.file AS file, n.path AS path, n.elementId AS astElementId,
           n.ipv6 AS ipv6, labels(n) AS labels,
           n.params AS params, n.signature AS signature,
           n.startLine AS startLine, n.endLine AS endLine,
           n.bodySnippet AS bodySnippet,
           n.status AS status, n.priority AS priority, n.taskId AS taskId,
           n.locked AS locked, n.lockedBy AS lockedBy, n.lockStatus AS lockStatus,
           n.category AS category, n.method AS method,
           n.kind AS kind, n.preview AS preview, n.value AS value,
           n.content AS content, n.description AS description,
           n.layoutX AS layoutX, n.layoutY AS layoutY, n.layoutZ AS layoutZ
`;

function subgraphRecordToNode(r) {
    const labels = (r.get('labels') || []).map(String);
    if (labels.some((label) => SPEC_LABEL_SET.has(label))) labels.push('Spec');
    const displayName = displayNameFor({
        name: r.get('name'), title: r.get('title'), kind: r.get('kind'),
        preview: r.get('preview'), value: r.get('value'),
        path: r.get('path'), elementId: r.get('astElementId'),
        label: labels[0], uid: String(r.get('id')), content: r.get('content'),
    });
    return {
        id: String(r.get('id')),
        name: displayName,
        file: r.get('file') || r.get('path'),
        ipv6: r.get('ipv6'),
        labels,
        params: r.get('params'),
        signature: r.get('signature'),
        startLine: r.get('startLine')?.toNumber?.() ?? null,
        endLine: r.get('endLine')?.toNumber?.() ?? null,
        bodySnippet: r.get('bodySnippet'),
        status: r.get('status'),
        priority: r.get('priority'),
        taskId: r.get('taskId'),
        locked: r.get('locked'),
        lockedBy: r.get('lockedBy'),
        lockStatus: r.get('lockStatus'),
        category: r.get('category'),
        method: r.get('method'),
        content: r.get('content'),
        description: r.get('description'),
        layoutX: r.get('layoutX') ?? null,
        layoutY: r.get('layoutY') ?? null,
        layoutZ: r.get('layoutZ') ?? null,
    };
}

// How far `expand` may reach and how many nodes it may drag in. A query that
// names 500 files and expands two hops would otherwise pull the whole database
// into one payload. When the cap bites, the response says so — a silently
// truncated neighbourhood reads exactly like a sparse one.
const SUBGRAPH_MAX_HOPS = 3;
const SUBGRAPH_EXPAND_CAP = 100000;

// A query result may identify far more nodes than the dashboard's normal graph
// slice contains. Fetch exactly that result set (plus every edge among it) by
// stable IPv6 identity. Deliberately do not impose another cap here: the query
// controls its result size and /api/graph/query already reports truncation.
//
// `expand` (0–3, default 0) additionally pulls in the neighbourhood. Most
// queries return one end of a relationship — the dead functions, the endpoints,
// the writers of a state — and drawing only those is a field of unconnected
// dots, because every edge they have leads to something the query never
// selected. One hop is usually the difference between dots and structure.
app.post('/api/graph/subgraph', async (req, res) => {
    const rawIpv6s = req.body?.ipv6s;
    if (!Array.isArray(rawIpv6s)) {
        return res.status(400).json({ error: 'ipv6s must be an array of strings' });
    }
    if (rawIpv6s.some((value) => typeof value !== 'string' || !value.trim())) {
        return res.status(400).json({ error: 'every ipv6s entry must be a non-empty string' });
    }

    // `uids` is the exact address; ipv6 is not. ipv6 is a derived, human-sized
    // label and can collide across unrelated nodes. A query that returns
    // `elementId(n) AS uid` gets back precisely its own rows; one that returns
    // ipv6 can also include collisions.
    const rawUids = req.body?.uids;
    if (rawUids !== undefined && !Array.isArray(rawUids)) {
        return res.status(400).json({ error: 'uids must be an array of strings' });
    }
    // Not trimmed. A uid can carry a node name that legitimately ends in a
    // space. Trimming would produce a different key that matches nothing.
    // Blank-only entries are still dropped.
    const uniqueUids = [...new Set((rawUids || [])
        .filter((v) => typeof v === 'string' && v.trim()))];

    const requestedHops = Number(req.body?.expand);
    const hops = Number.isFinite(requestedHops)
        ? Math.max(0, Math.min(SUBGRAPH_MAX_HOPS, Math.floor(requestedHops)))
        : 0;

    const uniqueIpv6s = [...new Set(rawIpv6s.map((value) => value.trim()))];
    const dbKey = req.body?.db || activeDb;
    const d = drivers[dbKey] || driver;
    const session = d.session();

    try {
        if (uniqueIpv6s.length === 0 && uniqueUids.length === 0) {
            return res.json({
                nodes: [], links: [], requested: 0, accepted: 0,
                found: 0, missing: 0, seeds: 0, expanded: 0, hops, capped: false,
            });
        }

        const nodesById = new Map();

        // uids win: when the query supplied them, ipv6 would only add the
        // collisions back in.
        if (uniqueUids.length > 0) {
            const uidResult = await session.run(
                `MATCH (n) WHERE elementId(n) IN $uids ${SUBGRAPH_NODE_RETURN}`,
                { uids: uniqueUids }
            );
            for (const r of uidResult.records) {
                const node = subgraphRecordToNode(r);
                nodesById.set(node.id, node);
            }
        } else if (uniqueIpv6s.length > 0) {
            const seedResult = await session.run(
                `MATCH (n) WHERE n.ipv6 IN $ipv6s ${SUBGRAPH_NODE_RETURN}`,
                { ipv6s: uniqueIpv6s }
            );
            for (const r of seedResult.records) {
                const node = subgraphRecordToNode(r);
                nodesById.set(node.id, node);
            }
        }
        const seedCount = nodesById.size;

        // Breadth-first neighbourhood walk. Undirected in effect, run as two
        // directed queries per hop because that is the pattern the translator
        // is known to handle for `id(x) IN $ids`.
        let capped = false;
        let frontier = [...nodesById.keys()];
        for (let hop = 0; hop < hops && frontier.length > 0 && !capped; hop++) {
            const ids = frontier;
            const [outgoing, incoming] = await Promise.all([
                session.run(`MATCH (a)-[r]->(b) WHERE elementId(a) IN $ids RETURN DISTINCT elementId(b) AS id`, { ids }),
                session.run(`MATCH (b)-[r]->(a) WHERE elementId(a) IN $ids RETURN DISTINCT elementId(b) AS id`, { ids }),
            ]);

            const seenThisHop = new Set();
            const nextIds = [];
            for (const rec of [...outgoing.records, ...incoming.records]) {
                const id = String(rec.get('id'));
                if (nodesById.has(id) || seenThisHop.has(id)) continue;
                if (nodesById.size + nextIds.length >= SUBGRAPH_EXPAND_CAP) { capped = true; break; }
                seenThisHop.add(id);
                nextIds.push(id);
            }
            if (nextIds.length === 0) break;

            const neighbourResult = await session.run(
                `MATCH (n) WHERE elementId(n) IN $ids ${SUBGRAPH_NODE_RETURN}`,
                { ids: nextIds }
            );
            for (const r of neighbourResult.records) {
                const node = subgraphRecordToNode(r);
                nodesById.set(node.id, node);
            }
            frontier = nextIds;
        }

        const nodes = [...nodesById.values()];
        const nodeIds = [...nodesById.keys()];

        const links = [];
        if (nodeIds.length > 0) {
            const linkResult = await session.run(`
                MATCH (a)-[r]->(b)
                WHERE elementId(a) IN $ids AND elementId(b) IN $ids
                RETURN elementId(a) AS source, elementId(b) AS target, type(r) AS relType
            `, { ids: nodeIds });
            for (const r of linkResult.records) {
                links.push({
                    source: String(r.get('source')),
                    target: String(r.get('target')),
                    relType: r.get('relType'),
                    propName: null,
                });
            }
        }

        const requested = uniqueUids.length > 0 ? uniqueUids.length : uniqueIpv6s.length;
        res.json({
            nodes,
            links,
            requested,
            accepted: requested,
            found: seedCount,
            missing: requested - seedCount,
            keyedBy: uniqueUids.length > 0 ? 'uid' : 'ipv6',
            seeds: seedCount,
            expanded: nodes.length - seedCount,
            hops,
            capped,
        });
    } catch (err) {
        console.error('[Bridge] /api/graph/subgraph error:', err.message);
        res.status(500).json({ error: err.message });
    } finally {
        await session.close();
    }
});


// Which directories the active graph was built from, and whether they are still
// there. Worth reporting because nothing else in a running system shows it: the
// 'target' workspace takes its paths from CODEVIS_TARGET_SRC, so they live in
// the daemon's environment and nowhere in the UI. A workspace pointing at a
// directory that no longer exists produces an empty graph — which looks exactly
// like a broken parser, and gets debugged as one.
function activeSourceDirs(dbKey) {
    const fs = require('fs');
    const dirs = config?.workspaces?.[dbKey]?.sourceDir || [];
    return dirs.map((dir) => {
        // Relative entries ('./scripts') resolve against the project, absolute
        // ones (what CODEVIS_TARGET_SRC usually holds) pass through unchanged.
        const resolved = path.resolve(PROJECT_ROOT, dir);
        return { path: dir, resolved, exists: fs.existsSync(resolved) };
    });
}

async function graphFreshness(session, dbKey) {
    const workspace = config.workspaces?.[dbKey];
    const freshness = await inspectGraphFreshness(session, {
        projectRoot: PROJECT_ROOT, sourceDirs: workspace?.sourceDir || [], exclude: workspace?.exclude || [],
    });
    return {
        graphState: freshness.state,
        staleFileCount: freshness.staleFileCount,
        staleFiles: freshness.staleFiles,
        staleFilesTruncated: freshness.truncated,
        analysisConfidence: freshness.state === 'current' ? 'eligible' : 'unknown',
    };
}

app.get('/api/status', (req, res) => {
    res.json({
        projectRoot: PROJECT_ROOT,
        dataDir: paths.DATA_DIR,
        workspaceFingerprint: WORKSPACE_FINGERPRINT,
        databaseIdentity: paths.workspaceIdentityStatus(config, activeDb),
        usingLegacyDataDir: paths.USING_LEGACY_DATA_DIR,
        pid: process.pid,
        bridgePort: PORT,
        activeDb: publicWorkspaceName(activeDb),
        workspace: publicWorkspaceName(activeDb),
        webShellEnabled: WEB_SHELL_ENABLED,
        // Verlangt der Wechsel auf den Selbst-Graphen ein Geheimnis? Nur wahr,
        // wenn CODEVIS_META_UNLOCK_SECRET gesetzt ist. Die Oberfläche
        // entscheidet daran, ob sie ein Passwortfeld oder eine Rückfrage zeigt
        // -- vorher musste sie es raten und bekam im Fehlerfall eine Meldung
        // über eine Umgebungsvariable, mit der ein Benutzer nichts anfangen kann.
        metaUnlockRequired: Boolean(META_UNLOCK_SECRET),
        limits,
        // Die geladene Detailstufe. Sie bestimmt, wie viele Knoten überhaupt
        // ladbar sind — wer den scope-Bericht hier abholt, braucht sie dazu,
        // sonst zeigt er eine Obergrenze zu einer Stufe, die er nicht kennt.
        detailLevel: currentLevel,
        // Which optional verticals this project builds with. The frontend uses it
        // to hide domain tabs that would otherwise sit there permanently empty
        // and look broken rather than switched off.
        extractors: resolveExtractors(config, activeDb).enabled,
        locking: lockingStatus(config),
        // Planning mode belongs to the project workspace. The CodeVis self-graph
        // remains a normal code graph even while a new project is only planned.
        workMode: activeDb === 'target' && config.workMode === 'planning' ? 'planning' : 'code',
        sourceDirs: activeSourceDirs(activeDb),
        // Whether the level-3 node cap is in force, so the dashboard shows the
        // switch in the state the bridge is actually in rather than its own guess.
        nodeCap: nodeCapEnabled,
        nodeCapSize: LEVEL3_NODE_CAP,
        // Opening values for the dashboard, from the project's config. Shipped
        // here rather than hardcoded in the frontend because the sensible first
        // screen depends on the size of the project being analysed.
        dashboard: {
            visibleNodeCap: config?.dashboard?.visibleNodeCap ?? 500,
            growthIntroNodes: config?.dashboard?.growthIntroNodes ?? 300,
            growthSpeed: config?.dashboard?.growthSpeed ?? 6,
        },
        // What the currently-loaded graph actually is, next to what it was cut
        // from. Reported here as well as on the graph payload so a tool (or a
        // human with curl) can check the acceptance question — "are there about
        // as many links as nodes?" — without opening a browser.
        scope: cachedGraph?.scope ?? null,
        nodes: cachedGraph?.nodes?.length ?? 0,
        links: cachedGraph?.links?.length ?? 0
    });
});

// ── Shutdown over loopback ───────────────────────────────────────────
// So `codevis stop` can stop the dashboard, not only the database daemon.
//
// Why an HTTP route rather than a pidfile: Windows cannot deliver SIGTERM to a
// detached process, so the CLI has no portable way to ask a bridge it did not
// spawn to leave — taskkill is a hard kill, which strands the pty children and
// skips closing the drivers. Asking over loopback is the same mechanism the
// daemon already uses (stopDaemon), and it runs the same graceful shutdown()
// that Ctrl+C runs.
//
// Unauthenticated on purpose, and no worse than the rest of this surface: the
// server binds loopback and already accepts POSTs that rewrite the graph.
// Anyone who can reach this port can do far more than stop it.
app.post('/api/shutdown', (req, res) => {
    console.log('[Bridge] Shutdown requested over HTTP.');
    // Answer FIRST. Exiting inside the handler drops the connection, and the
    // caller cannot tell "stopped" from "was never listening" — which is
    // exactly the ambiguity this route exists to remove.
    res.json({ ok: true, pid: process.pid, activeDb });
    res.on('finish', () => shutdown('HTTP /api/shutdown'));
});

// Debug: Get DFS call tree from a start node
app.get('/api/debug/paths', async (req, res) => {
    try {
        // uid, not integer — see /api/node/source for the same change.
        const startNode = String(req.query.startNode || '').trim();
        if (!startNode) {
            return res.status(400).json({ error: 'startNode query param required' });
        }
        const direction = req.query.direction === 'in' ? 'in' : 'out';
        const tree = await getDebugPaths(startNode, direction);
        if (!tree) {
            return res.status(404).json({
                error: `Node ${startNode} not found or has no ${direction === 'in' ? 'incoming' : 'outgoing'} calls`,
            });
        }
        res.json({ tree });
    } catch (err) {
        console.error('[Bridge] Debug paths error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Pathfinder: a bounded shortest route between two exact graph identities.
// The shared implementation is also exposed through MCP, so the dashboard and
// agents receive the same path, limits and error semantics.
app.post('/api/pathfinder/route', async (req, res) => {
    const session = getTaskDriver(req.body?.db || activeDb).session();
    try {
        const result = await findPath(session, req.body || {});
        res.json(result);
    } catch (err) {
        const clientError = ['INVALID_ENDPOINTS', 'INVALID_RELATIONS', 'NODE_NOT_FOUND'].includes(err.code);
        const status = err.code === 'NODE_NOT_FOUND' ? 404 : clientError ? 400 : 422;
        res.status(status).json({ status: 'ERROR', code: err.code || 'ROUTE_FAILED', error: err.message,
            missing: err.missing || undefined });
    } finally {
        await session.close();
    }
});

app.get('/api/pathfinder/nodes', async (req, res) => {
    const query = String(req.query.q || '').trim().toLowerCase();
    const limit = Math.max(1, Math.min(100, Math.floor(Number(req.query.limit) || 30)));
    const session = getTaskDriver(req.query.db || activeDb).session();
    try {
        const result = await session.run(`
            MATCH (n)
            WHERE (n:Function OR n:Component)
              AND ($query = '' OR toLower(n.name) CONTAINS $query OR toLower(n.file) CONTAINS $query)
            RETURN elementId(n) AS id, n.name AS name, n.file AS file,
                   labels(n) AS labels, n.signature AS signature
            ORDER BY n.name, n.file
            LIMIT ${limit}
        `, { query });
        res.json({ nodes: result.records.map((record) => ({
            id: String(record.get('id')),
            name: record.get('name') || String(record.get('id')),
            file: record.get('file') || null,
            labels: (record.get('labels') || []).map(String),
            signature: record.get('signature') || null,
        })) });
    } catch (err) {
        res.status(400).json({ error: err.message });
    } finally {
        await session.close();
    }
});

// Debug: Expand a border node (load missing children)
app.get('/api/expand', async (req, res) => {
    try {
        const nodeId = String(req.query.nodeId || '').trim();
        if (!nodeId) {
            return res.status(400).json({ error: 'nodeId query param required' });
        }
        const direction = req.query.direction === 'in' ? 'in' : 'out';
        const expansion = await expandNode(nodeId, direction);
        res.json(expansion);
    } catch (err) {
        console.error('[Bridge] Expand error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Drill into the atomic parse of a single node (variables, control-flow, statements).
app.get('/api/expand-ast', async (req, res) => {
    try {
        const nodeId = String(req.query.nodeId || '').trim();
        if (!nodeId) {
            return res.status(400).json({ error: 'nodeId query param required' });
        }
        const expansion = await expandAstNode(nodeId, req.query.includeAst === '1');
        res.json(expansion);
    } catch (err) {
        console.error('[Bridge] Expand-AST error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── Node dossier: everything the graph knows about ONE node ──────────
//
// The Inspector used to derive its neighbour lists by filtering the graph data
// already in the browser. That only ever showed CALLS edges, and only among the
// nodes that survived the view's node budget — a function with twelve callers
// displayed three, with nothing to indicate the other nine existed. This asks
// the database instead, so the panel describes the code rather than the view.
//
// Every relationship type is returned, in both directions, with its properties:
// the condition on a CALLS_CONDITIONALLY, the prop names on a PASSES_PROP, the
// variable a DATA_FLOWS_TO travels through. Those are already in the graph and
// were never shown anywhere.
//
// Rel properties are read generically. That is only safe because every rel
// table carries the full REL_PROP_UNION (see scripts/ladybug_schema.cjs) — on a
// strict Kuzu read, `r.condition` against a table without the column is a binder
// error, not a null.
const NODE_DETAIL_EDGE_CAP = 1200;

// Raw AST tokens are excluded from the dossier's rows. On a component like
// GraphScene they are 281 of ~600 edges, next to 3 CALLS and 1 RENDERS — a flat
// row cap fills up with them and drops exactly the edges somebody opened the
// panel to see. They are still COUNTED (the counts query below runs unfiltered),
// so the panel can say they exist, and the AST button loads them on request —
// the same call expandAstNode already makes about this layer.
//
// Listed positively rather than as an exclusion: Kuzu has no "all types except"
// syntax in a rel pattern, and an allowlist also fixes the order in which the
// row cap is spent.
const DETAIL_REL_TYPES = [
    'CALLS', 'CALLS_CONDITIONALLY', 'RENDERS', 'INHERITS', 'INSTANTIATES',
    'USES_TYPE', 'DECORATED_BY', 'PASSES_PROP', 'PASSES_CALLBACK', 'DATA_FLOWS_TO',
    'RETURNS', 'AWAITS', 'ASYNC_CHAIN', 'FETCHES', 'HANDLES', 'ON_EVENT',
    'READS_STATE', 'WRITES_STATE', 'HAS_EFFECT', 'CONSUMES_CONTEXT', 'WATCHES',
    'IMPORTS', 'IMPORTS_SYMBOL', 'EXPORTS_SYMBOL', 'RESOLVES_TO', 'ALIAS_OF',
    'WRAPS', 'BELONGS_TO', 'CONTAINS', 'DECLARES', 'CONTAINS_FLOW', 'CONTAINS_STMT',
    'AFFECTS', 'TOUCHED', 'CREATED', 'REMOVED', 'APPLIES_TO', 'ANNOTATES', 'REFERENCES', 'DEPENDS_ON',
    'FULFILLED_BY', 'DERIVES', 'REALIZED_BY', 'SPEC_RELATES', 'PROMOTED_TO',
    'USES_TOPIC', 'PUBLISHES_TOPIC', 'SUBSCRIBES_TOPIC', 'PROVIDES_SERVICE',
    'CALLS_SERVICE', 'PROVIDES_ACTION', 'USES_ACTION',
    'TRIGGERS', 'TRIGGERS_LEAF', 'TRIGGERS_RENDER', 'CLICKS_ON', 'CLICKED_ELEMENT',
    'RUNTIME_RENDERS', 'EXECUTION_STEP', 'EXECUTION_NEXT', 'MAPS_TO', 'MAPS_TO_STATIC',
    'SHOWS', 'HAS_CHILD', 'LOG_OF',
].join('|');

// Rel properties worth surfacing, with the label the UI puts in front of them.
// Anything null on a given edge is dropped, so an edge type that does not carry
// a property simply has none listed.
const REL_PROP_LABELS = {
    condition: 'when', branch: 'branch', via: 'via', inFunc: 'in',
    event: 'event', resolvedBy: 'resolved via', method: 'method',
    props: 'props', hasSpread: 'spread', spreadVars: 'spread vars',
    count: 'count', role: 'role', msgType: 'type', callback: 'callback',
    qos: 'QoS', kind: 'kind', confidence: 'confidence', name: 'name',
    // TOUCHED carries when the edit landed; the task section reads it.
    at: 'at', lastSeen: 'last seen', lastClicked: 'last clicked',
};

function relProps(record) {
    const out = {};
    for (const key of Object.keys(REL_PROP_LABELS)) {
        let v;
        try { v = record.get(key); } catch { continue; }
        if (v == null) continue;
        if (typeof v?.toNumber === 'function') v = v.toNumber();
        if (Array.isArray(v) && v.length === 0) continue;
        if (v === false || v === '') continue;
        out[key] = v;
    }
    return out;
}

function neighbourFrom(record, prefix) {
    const labels = (record.get(`${prefix}Labels`) || []).map(String);
    // Same display-name fallback the graph loader uses: atomic nodes
    // (statements, control flow, AST tokens) carry no .name, and a list of
    // "#182304" tells the reader nothing about what is in it.
    // File nodes are keyed on `path`, not `name` — without it a "liegt in"
    // row read "File" instead of naming the file.
    let name = record.get(`${prefix}Name`) || record.get(`${prefix}Title`)
        || record.get(`${prefix}Path`) || null;
    if (!name) {
        const subLabel = labels.find((l) => l !== 'ASTNode');
        const snippet = record.get(`${prefix}Preview`) || record.get(`${prefix}Value`);
        name = record.get(`${prefix}Kind`)
            || (subLabel && snippet ? `${subLabel}: ${String(snippet).slice(0, 40)}` : null)
            || subLabel
            || (snippet ? String(snippet).slice(0, 40) : null);
    }
    return {
        id: String(record.get(`${prefix}Id`)),
        name,
        file: record.get(`${prefix}File`) || null,
        labels,
        signature: record.get(`${prefix}Signature`) || null,
        startLine: record.get(`${prefix}StartLine`)?.toNumber?.() ?? null,
        taskId: record.get(`${prefix}TaskId`) || null,
        status: record.get(`${prefix}Status`) || null,
        category: record.get(`${prefix}Category`) || null,
        content: record.get(`${prefix}Content`) || null,
    };
}

const NEIGHBOUR_RETURN = (v) => `
    elementId(${v}) AS oId, ${v}.name AS oName, ${v}.title AS oTitle, ${v}.file AS oFile,
    labels(${v}) AS oLabels, ${v}.signature AS oSignature, ${v}.startLine AS oStartLine,
    ${v}.taskId AS oTaskId, ${v}.status AS oStatus, ${v}.category AS oCategory,
    ${v}.content AS oContent, ${v}.kind AS oKind, ${v}.preview AS oPreview,
    ${v}.value AS oValue, ${v}.path AS oPath`;

const EDGE_PROP_RETURN = Object.keys(REL_PROP_LABELS)
    .map((k) => `r.${k} AS ${k}`)
    .join(', ');

/**
 * Was der Inspector über einen Diagramm-Knoten sagen kann.
 *
 * Ein Spec-Knoten hat nichts von dem, was das Panel sonst zeigt: keine Datei,
 * keine Zeilen, keinen Quelltext. Deshalb stand dort bisher praktisch nichts —
 * bei `flat_obs` der Name, das Label und zwei Kanten. Alles, was die Frage
 * "was ist das und was heißt das für den Code" beantwortet, liegt aber im
 * Graphen: das Diagramm, aus dem er stammt, die Klasse, zu der er gehört, und
 * ob dahinter schon Code steht.
 *
 * Gibt null für alles, was kein Spec-Knoten ist — das Panel rendert den Block
 * dann gar nicht.
 */
async function specDetail(session, node) {
    if (!node?.labels?.some((l) => SPEC_LABEL_SET.has(l))) return null;
    const uid = node.uid || node.id;

    // Das Diagramm: bei einem Kind über DERIVES, beim Container er selbst.
    const container = await session.run(
        `MATCH (s)-[:DERIVES]->(p) WHERE p.uid = $uid
         RETURN s.name AS specId, s.title AS title, s.sourceFile AS sourceFile,
                s.label AS label, s.category AS kind
         UNION
         MATCH (s) WHERE s.uid = $uid AND s.label IN
           ['SpecSequence','SpecClassDiagram','SpecUseCaseDiagram','SpecActivityDiagram']
         RETURN s.name AS specId, s.title AS title, s.sourceFile AS sourceFile,
                s.label AS label, s.category AS kind`,
        { uid });
    const c = container.records[0];

    // Steht schon Code dahinter? Die Kante, nicht die value-Eigenschaft — siehe
    // linkRealization in scripts/spec/spec_db.cjs.
    const realized = await session.run(
        `MATCH (p)-[r:REALIZED_BY]->(code) WHERE p.uid = $uid
         RETURN code.name AS name, code.label AS label,
                code.file AS file, code.uid AS uid, r.confidence AS confidence`,
        { uid });
    const rz = realized.records[0];

    // Mitglieder (SpecClass) bzw. der Eigentümer (SpecMethod/SpecField).
    const members = await session.run(
        `MATCH (p)-[:DECLARES]->(m) WHERE p.uid = $uid
         RETURN m.label AS label, m.name AS name, m.signature AS signature,
                m.kind AS visibility`,
        { uid });

    // Gebunden wird nur, was einen Code-Knoten haben KANN: eine Klasse, ein
    // Teilnehmer, ein Use Case, ein Prozess. Eine Methode gehört dagegen zu
    // ihrer Klasse — ihre Frage lautet nicht "bist du gebunden", sondern
    // "gibt es dich in der Klasse schon". Und ein Feld hat im Code-Graphen
    // überhaupt keine Entsprechung; dort etwas zu behaupten wäre geraten.
    const bindable = node.labels.some((l) =>
        ['SpecClass', 'SpecParticipant', 'SpecUseCase', 'SpecProcess'].includes(l));
    let memberStatus = null;
    if (node.labels.includes('SpecMethod')) {
        const owner = await session.run(
            `MATCH (o)-[:DECLARES]->(m) WHERE m.uid = $uid
             OPTIONAL MATCH (o)-[:REALIZED_BY]->(code)
             RETURN o.name AS owner, code.name AS codeName, code.uid AS codeUid`,
            { uid });
        const o = owner.records[0];
        if (o) {
            const codeUid = o.get('codeUid');
            let fn = null;
            if (codeUid) {
                const hit = await session.run(
                    `MATCH (code)-[:CONTAINS]->(fn)
                     WHERE code.uid = $codeUid AND fn.name = $name AND fn.label = 'Function'
                     RETURN fn.name AS name, fn.uid AS uid, fn.file AS file`,
                    { codeUid, name: node.name });
                fn = hit.records[0] || null;
            }
            memberStatus = {
                owner: o.get('owner'),
                ownerRealized: o.get('codeName') || null,
                implemented: !!fn,
                fn: fn ? { name: fn.get('name'), uid: fn.get('uid'), file: fn.get('file') } : null,
            };
        }
    }

    return {
        bindable,
        memberStatus,
        diagram: c ? { specId: c.get('specId'), title: c.get('title'),
                       sourceFile: c.get('sourceFile'), label: c.get('label'),
                       kind: c.get('kind') } : null,
        // `scope` trägt bei Membern den Namen der Klasse, bei Participants den
        // Anzeigenamen — beides ist genau das, was der Leser hier sucht.
        owner: node.scope || null,
        visibility: node.kind || null,
        signature: node.signature || null,
        params: node.params || null,
        returns: node.returnType || node.declaredType || null,
        binding: node.status || null,
        realizedBy: rz ? { name: rz.get('name'), label: rz.get('label'),
                           file: rz.get('file'), uid: rz.get('uid'),
                           confidence: rz.get('confidence') } : null,
        members: members.records.map((m) => ({
            kind: m.get('label') === 'SpecField' ? 'field' : 'method',
            name: m.get('name'),
            signature: m.get('signature') || m.get('name'),
            visibility: m.get('visibility') || null,
        })),
    };
}

async function nodeDetail(dbKey, nodeId) {
    const d = drivers[dbKey] || driver;
    const session = d.session();
    try {
        // Keyed by uid. `id(n) = $nodeId` matched up to 500 nodes and returned
        // whichever came first — clicking a node could open a different node's
        // detail, from a different file, with no sign that it had happened.
        const nodeResult = await session.run(`
            MATCH (n) WHERE elementId(n) = $nodeId
            RETURN elementId(n) AS id, labels(n) AS labels, n.name AS name, n.title AS title,
                   n.file AS file, n.path AS path, n.ipv6 AS ipv6, n.uid AS uid,
                   n.signature AS signature, n.params AS params, n.return_type AS returnType,
                   n.startLine AS startLine, n.endLine AS endLine, n.bodySnippet AS bodySnippet,
                   n.acceptsProps AS acceptsProps, n.decorators AS decorators, n.deps AS deps,
                   n.hookType AS hookType, n.isComponent AS isComponent, n.isHook AS isHook,
                   n.isAsync AS isAsync, n.isHttpHandler AS isHttpHandler,
                   n.url AS url, n.method AS method, n.language AS language,
                   n.callSites AS callSites, n.callsResolved AS callsResolved,
                   n.degree AS degree, n.kind AS kind, n.value AS value, n.preview AS preview,
                   n.declaredType AS declaredType, n.scope AS scope,
                   n.locked AS locked, n.lockedBy AS lockedBy, n.lockStatus AS lockStatus,
                   n.lockGroup AS lockGroup,
                   n.lastError AS lastError, n.lastErrorStack AS lastErrorStack,
                   n.lastErrorTimestamp AS lastErrorTimestamp,
                   n.renamedFrom AS renamedFrom, n.renamedAt AS renamedAt,
                   n.movedFrom AS movedFrom, n.movedAt AS movedAt,
                   n.status AS status, n.priority AS priority, n.taskId AS taskId,
                   n.title AS taskTitle, n.description AS description,
                   n.workInstructions AS workInstructions,
                   n.assignedTo AS assignedTo, n.summary AS summary,
                   n.category AS category, n.content AS content, n.sourcePath AS sourcePath,
                   n.msgType AS msgType, n.rosKind AS rosKind, n.rosNodeName AS rosNodeName
        `, { nodeId: String(nodeId) });

        if (nodeResult.records.length === 0) return null;
        const r = nodeResult.records[0];
        const num = (k) => r.get(k)?.toNumber?.() ?? (typeof r.get(k) === 'number' ? r.get(k) : null);
        const labels = (r.get('labels') || []).map(String);
        const node = {
            id: String(r.get('id')),
            labels,
            name: (labels.includes('Task') || labels.includes('Epic'))
                ? (r.get('title') || r.get('name'))
                : r.get('name'),
            file: r.get('file') || r.get('path') || null,
            ipv6: r.get('ipv6'), uid: r.get('uid'),
            signature: r.get('signature'), params: r.get('params'),
            returnType: r.get('returnType'),
            startLine: num('startLine'), endLine: num('endLine'),
            bodySnippet: r.get('bodySnippet'),
            acceptsProps: r.get('acceptsProps') || null,
            decorators: r.get('decorators') || null,
            deps: r.get('deps') || null,
            hookType: r.get('hookType'),
            isComponent: r.get('isComponent'), isHook: r.get('isHook'),
            isAsync: r.get('isAsync'), isHttpHandler: r.get('isHttpHandler'),
            url: r.get('url'), method: r.get('method'), language: r.get('language'),
            callSites: num('callSites'), callsResolved: num('callsResolved'),
            degree: num('degree'), kind: r.get('kind'),
            value: r.get('value'), preview: r.get('preview'),
            declaredType: r.get('declaredType'), scope: r.get('scope'),
            locked: r.get('locked'), lockedBy: r.get('lockedBy'),
            lockStatus: r.get('lockStatus'), lockGroup: r.get('lockGroup'),
            lastError: r.get('lastError'), lastErrorStack: r.get('lastErrorStack'),
            lastErrorTimestamp: num('lastErrorTimestamp'),
            renamedFrom: r.get('renamedFrom'), renamedAt: num('renamedAt'),
            movedFrom: r.get('movedFrom'), movedAt: num('movedAt'),
            status: r.get('status'), priority: r.get('priority'),
            taskId: r.get('taskId'), description: r.get('description'),
            workInstructions: r.get('workInstructions'),
            assignedTo: r.get('assignedTo'), summary: r.get('summary'),
            category: r.get('category'), content: r.get('content'), sourcePath: r.get('sourcePath'),
            msgType: r.get('msgType'), rosKind: r.get('rosKind'),
            rosNodeName: r.get('rosNodeName'),
        };

        // Both directions in two queries rather than one undirected match: the
        // direction of an edge is half its meaning ("calls" vs "called by") and
        // an undirected match loses it.
        //
        // Counted before they are fetched, and counted WITHOUT the row cap, so
        // the panel can state a node's real connectivity even where it only
        // shows the first slice of it. A count is one aggregate; it costs
        // nothing next to shipping the rows.
        const counts = {};
        for (const dir of ['out', 'in']) {
            const pattern = dir === 'out'
                ? 'MATCH (n)-[r]->(o) WHERE elementId(n) = $nodeId'
                : 'MATCH (o)-[r]->(n) WHERE elementId(n) = $nodeId';
            const result = await session.run(
                `${pattern} RETURN type(r) AS relType, count(*) AS cnt`,
                { nodeId: String(nodeId) },
            );
            for (const rec of result.records) {
                counts[`${dir}:${rec.get('relType')}`] =
                    rec.get('cnt')?.toNumber?.() ?? Number(rec.get('cnt'));
            }
        }

        const edges = [];
        let truncated = false;
        for (const dir of ['out', 'in']) {
            const pattern = dir === 'out'
                ? 'MATCH (n)-[r:' + DETAIL_REL_TYPES + ']->(o) WHERE elementId(n) = $nodeId'
                : 'MATCH (o)-[r:' + DETAIL_REL_TYPES + ']->(n) WHERE elementId(n) = $nodeId';
            const result = await session.run(`
                ${pattern}
                RETURN type(r) AS relType, ${EDGE_PROP_RETURN}, ${NEIGHBOUR_RETURN('o')}
                LIMIT ${NODE_DETAIL_EDGE_CAP + 1}
            `, { nodeId: String(nodeId) });
            const records = result.records.slice(0, NODE_DETAIL_EDGE_CAP);
            if (result.records.length > NODE_DETAIL_EDGE_CAP) truncated = true;
            for (const rec of records) {
                edges.push({
                    direction: dir,
                    relType: rec.get('relType'),
                    props: relProps(rec),
                    other: neighbourFrom(rec, 'o'),
                });
            }
        }

        // Knowledge and task history are edges too, but they answer a different
        // question than "what does this call", so they get their own sections
        // instead of being buried among forty CONTAINS rows.
        const knowledge = edges
            .filter((e) => e.direction === 'in' && e.relType === 'APPLIES_TO'
                && e.other.labels.includes('Knowledge'))
            .map((e) => ({
                id: e.other.id, name: e.other.name,
                category: e.other.category, content: e.other.content,
            }));

        const TASK_RELS = new Set(['AFFECTS', 'TOUCHED', 'CREATED', 'REMOVED']);
        const tasks = edges
            .filter((e) => e.direction === 'in' && TASK_RELS.has(e.relType)
                && e.other.labels.includes('Task'))
            .map((e) => ({
                id: e.other.id, taskId: e.other.taskId, title: e.other.name,
                status: e.other.status, relType: e.relType,
                at: e.props.at ?? null, kind: e.props.kind ?? null,
            }));

        // What is left after those two are pulled out — the structural picture.
        const SECTIONED = new Set(['APPLIES_TO', ...TASK_RELS]);
        const relations = {};
        for (const e of edges) {
            if (SECTIONED.has(e.relType) && (e.other.labels.includes('Knowledge')
                || e.other.labels.includes('Task'))) continue;
            const key = `${e.direction}:${e.relType}`;
            (relations[key] = relations[key] || []).push({
                other: e.other, props: e.props,
            });
        }

        return {
            node, relations, knowledge, tasks,
            spec: await specDetail(session, node),
            // `counts` is the truth about this node's connectivity (every type,
            // unfiltered, uncapped). `relations` is what was actually shipped.
            // Where the two differ the panel says so rather than presenting a
            // capped list as complete.
            counts,
            edgeCount: edges.length,
            totalEdges: Object.values(counts).reduce((a, b) => a + b, 0),
            truncated,
        };
    } finally {
        await session.close();
    }
}

app.get('/api/node/detail', async (req, res) => {
    try {
        const nodeId = String(req.query.nodeId || '').trim();
        if (!nodeId) {
            return res.status(400).json({ error: 'nodeId query param required' });
        }
        const detail = await nodeDetail(req.query.db || activeDb, nodeId);
        if (!detail) return res.status(404).json({ error: `No node with id ${nodeId}` });
        res.json(detail);
    } catch (err) {
        console.error('[Bridge] Node detail error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── Real source, read from disk ──────────────────────────────────────
//
// Not `bodySnippet`. That property is the first 120 characters of the body with
// every newline and every run of whitespace collapsed to single spaces
// (graph_builder.js) — a one-line mush, cut mid-token, that cannot be read as
// code. It is also only as current as the last build.
//
// Reading the file gives indentation, structure, and the code as it is right
// now. Same approach the MCP task tools already take (tools/handlers/task-tools.ts).
app.get('/api/node/source', async (req, res) => {
    try {
        // A uid, not an integer: parseInt('File||path=a.py') is NaN, so this
        // endpoint rejected every node id the rest of the system now uses.
        const nodeId = String(req.query.nodeId || '').trim();
        if (!nodeId) {
            return res.status(400).json({ error: 'nodeId query param required' });
        }
        const context = Math.min(20, Math.max(0, parseInt(req.query.context, 10) || 0));
        const fullFile = req.query.full === '1' || req.query.full === 'true';
        const dbKey = req.query.db || activeDb;
        const d = drivers[dbKey] || driver;
        const session = d.session();
        let file, startLine, endLine, snippet;
        try {
            const result = await session.run(`
                MATCH (n) WHERE elementId(n) = $nodeId
                RETURN n.file AS file, n.path AS path, n.startLine AS startLine,
                       n.endLine AS endLine, n.bodySnippet AS bodySnippet
            `, { nodeId: String(nodeId) });
            if (result.records.length === 0) {
                return res.status(404).json({ error: `No node with id ${nodeId}` });
            }
            const r = result.records[0];
            file = r.get('file') || r.get('path');
            startLine = r.get('startLine')?.toNumber?.() ?? null;
            endLine = r.get('endLine')?.toNumber?.() ?? null;
            snippet = r.get('bodySnippet');
        } finally {
            await session.close();
        }

        if (!file) {
            return res.json({ source: null, fallback: snippet || null, reason: 'no file on node' });
        }

        const fsLocal = require('fs');
        // path.resolve leaves an already-absolute path alone, which is what the
        // target workspace stores (CODEVIS_TARGET_SRC is absolute) while the meta
        // workspace stores project-relative paths.
        const absolute = path.resolve(PROJECT_ROOT, file);
        let content;
        try {
            content = fsLocal.readFileSync(absolute, 'utf8');
        } catch (err) {
            return res.json({
                source: null, fallback: snippet || null,
                reason: `cannot read ${absolute}: ${err.code || err.message}`,
                file, startLine, endLine,
            });
        }

        const lines = content.split('\n');
        // A File node has no line range — show its head rather than nothing.
        const from = startLine != null ? Math.max(1, startLine - context) : 1;
        const to = endLine != null
            ? Math.min(lines.length, endLine + context)
            : fullFile ? lines.length : Math.min(lines.length, 60);

        res.json({
            source: lines.slice(from - 1, to).join('\n'),
            firstLine: from,
            startLine, endLine,
            file, absolute,
            totalLines: lines.length,
            truncatedTail: endLine == null && lines.length > to,
        });
    } catch (err) {
        console.error('[Bridge] Node source error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// README image paths are relative to the package root. Serve only this fixed
// directory so a missing PNG cannot fall through to index.html as text/html.
app.use('/docs/screenshots', express.static(
    path.resolve(__dirname, '..', 'docs', 'screenshots'),
));
app.use('/docs/screenshots', (_req, res) => res.status(404).type('text').send('Not found'));

// Serve only the documentation that ships in the package. Keeping the allowlist
// outside the route makes path traversal impossible and independently testable.
app.get('/api/docs', (req, res) => {
    try {
        const { readDocumentationFile } = require('./documentation-files.cjs');
        const document = readDocumentationFile(path.resolve(__dirname, '..'), req.query.file);
        res.set('X-CodeVis-Document', document.relative);
        res.type('text/markdown').send(document.markdown);
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message });
    }
});

// Pulse control
app.post('/api/pulse/start', (req, res) => {
    startPulse();
    io.emit('pulse:status', { running: true });
    res.json({ ok: true, running: true });
});

app.post('/api/pulse/stop', (req, res) => {
    stopPulse();
    io.emit('pulse:status', { running: false });
    res.json({ ok: true, running: false });
});

app.get('/api/pulse/status', (req, res) => {
    res.json({ running: isPulseRunning() });
});

// Telemetry: Catch errors from frontend and tag the Graph
app.post('/api/report-error', async (req, res) => {
    try {
        const { message, stack } = req.body;
        if (!stack) return res.send({ ok: false });

        // Simple heuristic to extract the function name from stack trace
        // e.g. "at handleConfigChange (App.jsx:45)" -> "handleConfigChange"
        const match = stack.match(/at\s+([^\s]+)\s+\(/);
        let funcName = match ? match[1] : null;

        // If it starts with a React component trace like "at App (..."
        if (!funcName) {
            const reactMatch = stack.match(/at\s+([A-Z]\w+)\s+\(/);
            funcName = reactMatch ? reactMatch[1] : null;
        }

        if (funcName) {
            const session = driver.session();
            try {
                // Update graph setting property `lastError` and `lastErrorStack`
                const result = await session.run(`
                    MATCH (n)
                    WHERE (n:Function OR n:Component) AND n.name = $funcName
                    SET n.lastError = $message, 
                        n.lastErrorStack = $stack, 
                        n.lastErrorTimestamp = timestamp()
                    RETURN elementId(n) AS id, labels(n)[0] AS type
                `, { funcName, message, stack });

                if (result.records.length > 0) {
                    console.log(`[Bridge] Labeled error on function: ${funcName}`);

                    // Optional: broadcast directly to all UI clients that an error occurred here
                    // io.emit('graph:error', { nodeId: result.records[0].get('id').toNumber(), error: message });
                }
            } finally {
                await session.close();
            }
        }
        res.send({ ok: true, found: !!funcName, funcName });
    } catch (err) {
        console.error('[Bridge] Report-Error failed:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── Brain Channel Endpoints ─────────────────────────────────────────

// In-Memory-Registry der laufenden Claude-Instanzen, die den codevis-brain-Channel
// geladen haben. Jede meldet sich per Heartbeat (alle 10s); TTL räumt tote auf.
const brainInstances = new Map(); // sessionId -> { sessionId, title, port, lastSeen }
const BRAIN_TTL_MS = 30_000;

function liveBrainInstances() {
    const now = Date.now();
    for (const [id, inst] of brainInstances) {
        if (now - inst.lastSeen > BRAIN_TTL_MS) brainInstances.delete(id);
    }
    return [...brainInstances.values()];
}

app.post('/api/brain/register', (req, res) => {
    const { sessionId, title, port } = req.body || {};
    if (!sessionId || !port) return res.status(400).json({ error: 'sessionId and port required' });
    brainInstances.set(sessionId, { sessionId, title: title || sessionId.slice(0, 8), port, lastSeen: Date.now() });
    res.json({ ok: true });
});

app.post('/api/brain/deregister', (req, res) => {
    const { sessionId } = req.body || {};
    if (sessionId) brainInstances.delete(sessionId);
    res.json({ ok: true });
});

// Füttert das "Send to ▾"-Dropdown im Frontend.
app.get('/api/brain/instances', (req, res) => {
    res.json({ instances: liveBrainInstances().map(({ sessionId, title }) => ({ sessionId, title })) });
});

// ── Headless Braindump Worker ───────────────────────────────────────
// Spawnt pro Braindump einen einmaligen `claude -p`-Prozess. Er nutzt die
// vorhandene Claude-Auth des Users (kein separater API-Key), schreibt Task-/
// Knowledge-Knoten via codevis_graph-MCP in die meta-DB, verlinkt sie und gibt
// am Ende ein JSON {summary, nodeIds} aus. Das parsen wir → publishBrainResult.
// Resolve the Claude CLI binary. On Windows, `claude` on PATH is a shim
// (claude / claude.cmd) that Node's spawn() cannot launch as a bare name —
// spawn does NOT apply PATHEXT, so it fails with ENOENT. The braindump/spec
// workers then never start ("Worker konnte nicht gestartet werden" /
// "Worker-Ausgabe konnte nicht geparst werden"). Resolve the real claude.exe
// so we can spawn it directly (no shell → no quoting issues with the multi-line
// prompt / JSON mcp-config args). POSIX: the shim is an exec'able script, so a
// bare 'claude' works there.
function resolveClaudeBin() {
    if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
    if (process.platform !== 'win32') return 'claude';
    try {
        const { execSync } = require('child_process');
        const fsl = require('fs');
        const lines = execSync('where claude', { encoding: 'utf8' })
            .split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
        const exe = lines.find((l) => l.toLowerCase().endsWith('.exe'));
        if (exe) return exe;
        // The npm shim sits next to node_modules/@anthropic-ai/claude-code/bin/claude.exe.
        for (const l of lines) {
            const guess = path.join(path.dirname(l),
                'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
            if (fsl.existsSync(guess)) return guess;
        }
    } catch { /* fall through to bare name */ }
    return 'claude';
}
const CLAUDE_BIN = resolveClaudeBin();
// Built inline from __dirname (not a static file) so the mcp_server path resolves
// correctly wherever CodeVis runs, independent of the current working directory
// image. Passed to `claude -p --mcp-config` as a JSON string.
const BRAIN_MCP_CONFIG = JSON.stringify({
    mcpServers: {
        codevis_graph: {
            command: 'npx',
            args: ['--yes', 'tsx', path.join(__dirname, '..', 'tools', 'mcp_server.ts')],
            // The *script* is package-relative (it ships with us), but the project
            // dir must be the analysed project — otherwise the braindump agent
            // runs against node_modules/codevis and writes into the wrong graph.
            env: { CODEVIS_PROJECT_DIR: PROJECT_ROOT },
        },
    },
});
const BRAIN_CWD = PROJECT_ROOT;
const BRAIN_MODEL = process.env.BRAIN_MODEL || 'claude-sonnet-4-6';

// ── Headless worker management (braindump + spec build) ─────────────
// Headless `claude -p` children were unbounded: no timeout (a hung child lives
// forever), no concurrency cap (repeated 202 requests pile up processes), no
// references and no kill() on shutdown. Track every child, kill it after a
// timeout, cap how many run at once, and kill them all on SIGINT/SIGTERM.
const MAX_HEADLESS_WORKERS = Number(process.env.CODEVIS_MAX_WORKERS) || 4;
const HEADLESS_WORKER_TIMEOUT_MS = Number(process.env.CODEVIS_WORKER_TIMEOUT_MS) || 300000; // 5 min
const activeWorkers = new Set(); // Set<ChildProcess>

// Spawns a tracked `claude -p` worker. Throws (status 429) when the cap is hit
// so the route can reject instead of piling on. A per-child timer SIGKILLs a
// worker that outlives the budget; both the timer and the registry entry are
// cleaned up on close/error.
function spawnHeadlessWorker(args, { cwd, env, label }) {
    if (activeWorkers.size >= MAX_HEADLESS_WORKERS) {
        const e = new Error(
            `Too many headless workers running (${activeWorkers.size}/${MAX_HEADLESS_WORKERS}). Try again shortly.`);
        e.status = 429;
        throw e;
    }
    const child = spawn(CLAUDE_BIN, args, { cwd, env });
    activeWorkers.add(child);
    const timer = setTimeout(() => {
        console.warn(`[Worker] ${label} timed out after ${HEADLESS_WORKER_TIMEOUT_MS}ms — killing`);
        try { child.kill('SIGKILL'); } catch (_) { /* already dead */ }
    }, HEADLESS_WORKER_TIMEOUT_MS);
    if (timer.unref) timer.unref(); // don't keep the event loop alive on this timer
    const cleanup = () => { clearTimeout(timer); activeWorkers.delete(child); };
    child.once('close', cleanup);
    child.once('error', cleanup); // spawn failure (e.g. ENOENT) may skip 'close'
    return child;
}

// The braindump worker writes into whichever DB is active when the user hits
// "Send to Claude": mcpDb 'meta' = CodeVis' own graph, 'tool' = the target
// project. Built per-request so knowledge lands in the graph the user is on.
function brainSystemPrompt(mcpDb) {
    const dbLabel = mcpDb === 'meta' ? 'meta' : 'target project';
    return `You are the CodeVis braindump worker. The user message is a raw braindump in any language (notes, ideas, decisions, open questions). Turn it into a LINKED subgraph in the ${dbLabel} DB. Use ONLY the codevis_graph MCP tools with db='${mcpDb}' and createdBy='brain-worker'. Write node contents in the language of the braindump.

1. create_knowledge for descriptive content. Valid categories ONLY: framework|architecture|domain|design|testing|security|performance|general. Architecture/modules/subsystems -> category='architecture'. Decisions ("X because Y") -> category='architecture' or 'general', content as "Decision: ... Rationale: ...". Conventions -> 'general'. There is NO 'decision' or 'question' category.
2. create_task for actionable items (verb-oriented: title, description, workInstructions, priority). SPECIFICATION GATE: title >= 8 chars, description >= 80 chars (problem + desired outcome + constraints), workInstructions >= 50 chars (exact steps + acceptance criteria) — shorter tasks are REJECTED with UNDERSPECIFIED. Open questions -> create_task with priority='low', title='Clarify: ...' and a description that captures the context of the question and what an answer unblocks.
3. LINK them: create the knowledge FIRST, then create_task with knowledgeLinks=['<knowledge name>', ...] (draws Knowledge-[:APPLIES_TO]->Task in one call). Link knowledge to existing code nodes via link_knowledge(knowledgeName, targetNodes=[...]). No isolated nodes.

Collect ALL created taskIds and knowledge names. Your FINAL message must be NOTHING BUT a JSON object, no markdown and no extra prose: {"summary":"... incl. which edges were drawn","nodeIds":["<taskId or knowledge name>", ...]}`;
}

// Extrahiert das erste balancierte JSON-Objekt aus beliebigem Text (das Modell
// könnte es in Prosa oder ```json-Fences einbetten).
function extractJsonObject(s) {
    if (!s) return null;
    const start = s.indexOf('{');
    if (start === -1) return null;
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < s.length; i++) {
        const c = s[i];
        if (esc) { esc = false; continue; }
        if (c === '\\') { esc = true; continue; }
        if (c === '"') { inStr = !inStr; continue; }
        if (inStr) continue;
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) { try { return JSON.parse(s.slice(start, i + 1)); } catch { return null; } } }
    }
    return null;
}

function runHeadlessBraindump({ text, sessionId, chat_id, runId, db = 'meta' }) {
    // db is the bridge workspace key ('meta' | 'target'); the MCP tools expect
    // 'meta' | 'tool'. Worker, session bookkeeping and result query all use the
    // same DB so the generated subgraph is found where it was written.
    const mcpDb = db === 'meta' ? 'meta' : 'tool';
    const args = [
        '-p', text,
        '--output-format', 'json',
        '--model', BRAIN_MODEL,
        '--strict-mcp-config',
        '--mcp-config', BRAIN_MCP_CONFIG,
        '--append-system-prompt', brainSystemPrompt(mcpDb),
        // acceptEdits (nicht bypassPermissions): nur unser eigener Graph-Server
        // ist vorab erlaubt. --strict-mcp-config laedt ohnehin NUR codevis_graph,
        // also kann der Worker keine fremden/gefaehrlichen Tools aufrufen.
        '--permission-mode', 'acceptEdits',
        '--allowedTools', 'mcp__codevis_graph',
    ];
    console.log(`[Brain] spawning headless worker (session ${sessionId}, chat_id ${chat_id}, model ${BRAIN_MODEL})`);
    const child = spawnHeadlessWorker(args, { cwd: BRAIN_CWD, env: process.env, label: `brain ${sessionId}` });
    let stdout = '', stderr = '';
    let settled = false;
    const fail = (message) => {
        io.emit('brain:result', { chat_id, runId, db: publicWorkspaceName(db), summary: message, nodes: [], edges: [], error: true });
    };
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', (e) => {
        if (settled) return;
        settled = true;
        console.error('[Brain] headless spawn error:', e.message);
        fail(`Worker could not be started: ${e.message}`);
    });
    child.on('close', async (code) => {
        if (settled) return;
        settled = true;
        if (code !== 0) {
            console.error(`[Brain] headless worker exited ${code}:`, stderr.slice(0, 800));
            fail(`Worker exited unsuccessfully (${code ?? 'terminated'}). See the bridge log for details.`);
            return;
        }
        // Erst das --output-format json Envelope parsen, dann das finale JSON des Modells.
        let summary = '', nodeIds = [];
        try {
            const envelope = JSON.parse(stdout);
            if (envelope.is_error) throw new Error('Worker reported a failed run.');
            const resultText = typeof envelope.result === 'string' ? envelope.result : '';
            const parsed = extractJsonObject(resultText);
            if (!parsed || typeof parsed.summary !== 'string' || !Array.isArray(parsed.nodeIds)) {
                throw new Error('Worker returned no valid JSON result.');
            }
            summary = parsed.summary;
            nodeIds = parsed.nodeIds;
        } catch (e) {
            console.error('[Brain] failed to parse worker output:', e.message, stdout.slice(0, 400));
            fail('Worker output could not be parsed. See the bridge log for details.');
            return;
        }
        try {
            const n = await publishBrainResult({ chat_id, runId, summary, nodeIds, db });
            try {
                const session = getTaskDriver(db).session();
                try {
                    await session.run(`MATCH (s:BraindumpSession {sessionId:$sessionId}) SET s.status='done'`, { sessionId });
                } finally { await session.close(); }
            } catch (e) {
                console.error('[Brain] result delivered but session status update failed:', e.message);
            }
            console.log(`[Brain] headless worker done: ${n} nodes for chat_id ${chat_id}`);
        } catch (e) {
            console.error('[Brain] publishBrainResult failed:', e.message);
            fail(`Could not finish the generated subgraph: ${e.message}`);
        }
    });
}

app.post('/api/brain/save', async (req, res) => {
    const { text, push, sessionId: existingSessionId, target, db: requestedDb, runId: requestedRunId } = req.body || {};
    if (!text && !existingSessionId) return res.status(400).json({ error: 'text or sessionId required' });
    const sessionId = existingSessionId || `brain-${crypto.randomUUID()}`;
    const wantsPush = push === true;
    // Write into the active DB (so braindump knowledge lands in the project the
    // user is viewing), unless the caller explicitly names one.
    let db;
    try { db = normalizeWorkspaceName(requestedDb ?? target, activeDb); }
    catch (e) { return res.status(400).json({ error: e.message }); }
    if (requestedRunId != null && (typeof requestedRunId !== 'string' || !requestedRunId.trim())) {
        return res.status(400).json({ error: 'runId must be a non-empty string' });
    }
    const runId = requestedRunId || crypto.randomUUID();

    // Persist (or update) the session
    if (text) {
        const session = getTaskDriver(db).session();
        try {
            await session.run(
                `MERGE (s:BraindumpSession { sessionId: $sessionId })
                 ON CREATE SET s.ts = timestamp(), s.status = 'pending'
                 SET s.text = $text`,
                { sessionId, text }
            );
        } finally {
            await session.close();
        }
    }

    // Push only if explicitly requested
    if (!wantsPush) {
        return res.status(200).json({ ok: true, sessionId, pushed: false });
    }

    // Headless: ein eigener `claude -p`-Prozess verarbeitet den Braindump
    // asynchron. Kein laufender Channel/keine registrierte Instanz nötig — das
    // Ergebnis kommt per Socket-Event 'brain:result' zurück, sobald der Worker
    // fertig ist. Wir antworten sofort mit 202.
    if (!text) {
        return res.status(400).json({ error: 'text required to send to Claude', sessionId, pushed: false });
    }
    const chat_id = sessionId;
    try {
        runHeadlessBraindump({ text, sessionId, chat_id, runId, db });
    } catch (e) {
        console.error('[Brain] failed to launch headless worker:', e.message);
        return res.status(e.status || 500).json({ error: `Worker could not be started: ${e.message}`, sessionId, pushed: false });
    }
    res.status(202).json({ ok: true, sessionId, runId, db: publicWorkspaceName(db), pushed: true, mode: 'headless' });
});

// ── Spec overlay (Spec tab) ─────────────────────────────────────────────────
// Takes a pasted PlantUML/.wsd diagram + optional architect instructions,
// imports it into the graph, overlays it against the code (conforms/missing/
// extra), optionally emits backlog Tasks for the missing region (folding the
// instructions into their workInstructions), and returns the overlay + a
// subgraph for the Spec tab. Uses the shared spec_db.cjs — same logic as the
// import_spec/reconcile_spec MCP tools.
// db resolution shared by the spec endpoints + worker: explicit > env > 'tool'.
// Maps the MCP-style key ('tool'|'meta') onto the bridge workspace key
// ('target'|'meta') that getTaskDriver expects.
/**
 * Welche Datenbank ein Request meint.
 *
 * Vorher stand hier `db === 'meta' ? 'meta' : 'target'` — nur die exakte
 * Zeichenkette `meta` traf. Die öffentlichen Namen, die das Frontend, die
 * MCP-Werkzeuge und die Dokumentation verwenden, fielen alle stillschweigend
 * auf `target`: `codevis_db`, `codevis`, und jede abweichende Schreibweise wie
 * `Meta`. Ein Aufruf von /api/diagram/class?db=codevis_db lieferte damit ein
 * leeres Diagramm aus der falschen Datenbank — ohne Fehler, ohne Hinweis, und
 * nicht von "da sind wirklich keine Klassen" zu unterscheiden.
 *
 * Die Zuordnung steht seit je in lib/workspace-names.cjs und kennt alle
 * Schreibweisen samt Kleinschreibung. Sie wird hier nur endlich benutzt.
 *
 * Bewusst ohne Wurf: normalizeWorkspaceName wirft bei unbekannten Namen, aber
 * von den neun Aufrufern rufen mehrere resolveSpecDb VOR ihrem try-Block auf.
 * Ein Wurf landete dort in Express' Standardbehandlung, die HTML ausliefert --
 * genau der Fall, den /api/brain/result heute schon hatte. Ein unbekannter Name
 * fällt deshalb auf `target` zurück, aber nicht mehr lautlos.
 */
function resolveSpecDb(reqDb) {
    const requested = reqDb ?? process.env.CODEVIS_SPEC_DB ?? 'project_db';
    let ws;
    try {
        ws = normalizeWorkspaceName(requested);
    } catch {
        console.warn(`[bridge] Unbekannter Workspace '${requested}' — verwende project_db. Gültig: project_db, codevis_db.`);
        ws = 'target';
    }
    return { mcp: ws === 'meta' ? 'meta' : 'tool', ws };
}

app.post('/api/spec/import', async (req, res) => {
    const { diagram, instructions, kind, specId: reqId, emitTasks, priority, db } = req.body || {};
    if (!diagram || !diagram.trim()) return res.status(400).json({ error: 'diagram required' });
    const specId = reqId || `spec-ui-${Date.now()}`;
    const session = getTaskDriver(resolveSpecDb(db).ws).session();
    try {
        const imported = await specDb.importSpec(session, { text: diagram, specId, kind, sourceFile: specId });
        // Retain the architect instructions on the spec container even when there
        // is nothing to emit, so they are never lost.
        if (instructions && instructions.trim()) {
            await session.run(
                `MATCH (s) WHERE s.name = $specId AND s.label IN ['SpecSequence','SpecClassDiagram']
                 SET s.content = $instructions`,
                { specId, instructions });
        }
        const reconciled = await specDb.reconcileSpec(session, specId, {
            emitTasks: emitTasks === true, instructions, priority: priority || 'medium' });
        const subgraph = await specDb.getSpecSubgraph(session, specId);
        const result = { ok: true, specId, imported, reconciled, subgraph };
        // Deterministic path is synchronous — the caller gets the result in the
        // HTTP response, so no socket broadcast (that would push one user's
        // import to every connected client).
        console.log(`[Spec] imported ${specId} (${imported.kind}); ` +
            `overlay ${JSON.stringify(reconciled.summary)}; emitted ${reconciled.emitted.length} task(s)`);
        res.status(200).json(result);
    } catch (e) {
        console.error('[Spec] import failed:', e.message);
        res.status(500).json({ error: e.message, specId });
    } finally {
        await session.close();
    }
});

// ── Spec build worker (hybrid: deterministic facts + LLM judgment) ──────────
// Like the braindump worker, but for diagrams. The headless `claude -p` worker
// uses the deterministic spec tools for FACTS (import_spec/reconcile_spec give
// ground-truth conformance) and adds JUDGMENT on top: fuzzy-binding unbound
// nodes, interpreting relations the deterministic overlay ignores, and turning
// the missing region + architect instructions into well-formed Tasks/Knowledge.
const SPEC_SYSTEM_PROMPT = `You are the CodeVis spec-overlay worker. The user message contains a PlantUML/.wsd diagram (sequence or class), optional architect instructions, a specId, and a db value. Build a conformance overlay against the code graph using ONLY codevis_graph MCP tools, passing db=<the db value from the message> on EVERY tool call. Be deterministic about FACTS, smart about JUDGMENT. Write node contents in the language of the instructions.

STEPS (use the db value from the message everywhere it says db=DB):
1. import_spec({ text:<the diagram>, specId:<the specId>, db:DB }). It parses the diagram and auto-binds exact name matches. Read the 'needsBinding' list.
2. BIND the unbound nodes using judgment. For each unbound alias, query the graph (project_db or codevis_db matching DB) with "MATCH (n) WHERE n.label IN ['Class','Function','Module'] AND toLower(n.name) CONTAINS toLower('<alias>') RETURN n.name, n.uid LIMIT 5" to find the best code match, then bind_spec({ specId, bindings:[{alias, target:<uid or name>}], db:DB }). If there is no plausible match, LEAVE IT UNBOUND — a wrong binding is worse than none.
3. reconcile_spec({ specId, db:DB }) to get the conformance facts (conforms / missing / extra). These are GROUND TRUTH from the graph — never override or invent them.
4. PLAN from the gaps + instructions:
   - create_knowledge (db=DB) for design rules in the instructions. Categories ONLY: framework|architecture|domain|design|testing|security|performance|general.
   - For each item in the 'missing' region (and any class-diagram association/composition the overlay does not check but that implies code), create_task (db=DB): verb title >= 8 chars, description >= 80 chars (problem + desired outcome + constraints), workInstructions >= 50 chars (exact steps + acceptance criteria) with the architect instructions folded in. Link knowledge via knowledgeLinks=[...] and link to the bound code node via targetNodes=[...].
   - Do NOT create tasks for the 'extra' region — mention those in the summary as possible undocumented behaviour or a stale diagram.

Your FINAL message must be NOTHING BUT a JSON object, no markdown: {"summary":"... incl. binding decisions, conforms/missing/extra counts, and drift notes","nodeIds":["<taskId or knowledge name>", ...]}`;

function runHeadlessSpecBuild({ diagram, instructions, specId, chat_id, db }) {
    const emitResult = result => io.emit('spec:result', { ...result, db: publicWorkspaceName(db) });
    const mcpDb = db === 'meta' ? 'meta' : 'tool';
    const userMsg = `specId: ${specId}\ndb: ${mcpDb}\n\n=== DIAGRAM ===\n${diagram}\n\n=== INSTRUCTIONS ===\n${(instructions && instructions.trim()) || '(none)'}`;
    const args = [
        '-p', userMsg,
        '--output-format', 'json',
        '--model', BRAIN_MODEL,
        '--strict-mcp-config',
        '--mcp-config', BRAIN_MCP_CONFIG,
        '--append-system-prompt', SPEC_SYSTEM_PROMPT,
        '--permission-mode', 'acceptEdits',
        '--allowedTools', 'mcp__codevis_graph',
    ];
    console.log(`[Spec] spawning headless build worker (specId ${specId}, model ${BRAIN_MODEL})`);
    const child = spawnHeadlessWorker(args, { cwd: BRAIN_CWD, env: process.env, label: `spec ${specId}` });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', (e) => {
        console.error('[Spec] headless spawn error:', e.message);
        emitResult({ ok: false, specId, error: `Worker konnte nicht gestartet werden: ${e.message}` });
    });
    child.on('close', async (code) => {
        if (code !== 0) console.error(`[Spec] worker exited ${code}:`, stderr.slice(0, 800));
        let summary = '', nodeIds = [];
        try {
            const envelope = JSON.parse(stdout);
            const resultText = typeof envelope.result === 'string' ? envelope.result : '';
            const parsed = extractJsonObject(resultText);
            if (parsed) { summary = parsed.summary || ''; nodeIds = Array.isArray(parsed.nodeIds) ? parsed.nodeIds : []; }
            else summary = resultText.slice(0, 400) || 'Worker lieferte kein JSON-Ergebnis.';
        } catch (e) {
            summary = 'Worker-Ausgabe konnte nicht geparst werden.';
        }
        // Re-read the now-populated overlay so the Spec tab shows ground truth +
        // the worker's planning summary.
        const session = getTaskDriver(mcpDb === 'meta' ? 'meta' : 'target').session();
        try {
            const reconciled = await specDb.reconcileSpec(session, specId, {});
            const subgraph = await specDb.getSpecSubgraph(session, specId);
            emitResult({
                ok: true, specId, mode: 'claude', workerSummary: summary, nodeIds,
                imported: { kind: reconciled.kind }, reconciled, subgraph,
            });
            console.log(`[Spec] build worker done for ${specId}: ${nodeIds.length} node(s)`);
        } catch (e) {
            console.error('[Spec] post-build overlay read failed:', e.message);
            emitResult({ ok: false, specId, error: e.message, workerSummary: summary });
        } finally {
            await session.close();
        }
    });
}

// Hybrid build: spawn the LLM worker. Responds 202 immediately; the result
// arrives via the 'spec:result' socket event (same channel as /api/spec/import).
app.post('/api/spec/build', async (req, res) => {
    const { diagram, instructions, specId: reqId, db } = req.body || {};
    if (!diagram || !diagram.trim()) return res.status(400).json({ error: 'diagram required' });
    const specId = reqId || `spec-ui-${Date.now()}`;
    try {
        runHeadlessSpecBuild({ diagram, instructions, specId, chat_id: specId, db: resolveSpecDb(db).mcp });
    } catch (e) {
        console.error('[Spec] failed to launch worker:', e.message);
        return res.status(e.status || 500).json({ error: `Worker konnte nicht gestartet werden: ${e.message}`, specId });
    }
    res.status(202).json({ ok: true, specId, mode: 'claude' });
});

// ── Spec library ────────────────────────────────────────────────────────────
// List all stored diagrams (newest first) for the diagram-library panel.
app.get('/api/spec/list', async (req, res) => {
    const session = getTaskDriver(resolveSpecDb(req.query.db).ws).session();
    try {
        res.json({ ok: true, specs: await specDb.listSpecs(session) });
    } catch (e) {
        console.error('[Spec] list failed:', e.message);
        res.status(500).json({ error: e.message });
    } finally {
        await session.close();
    }
});

// Reopen one stored diagram: its raw text + current overlay + subgraph, so the
// UI can re-view it without re-running the importer or the Claude worker.
app.get('/api/spec/get', async (req, res) => {
    const { specId } = req.query;
    if (!specId) return res.status(400).json({ error: 'specId required' });
    const session = getTaskDriver(resolveSpecDb(req.query.db).ws).session();
    try {
        const meta = await specDb.getSpecSource(session, specId);
        if (!meta) return res.status(404).json({ error: `No spec '${specId}' found` });
        const reconciled = await specDb.reconcileSpec(session, specId, {});
        const subgraph = await specDb.getSpecSubgraph(session, specId);
        res.json({ ok: true, specId, source: meta.source, kind: meta.kind, title: meta.title,
            // Damit die UI sagen kann, WOHIN ein Sync zurückschreibt — und ob
            // überhaupt eine Datei dahintersteht.
            sourceFile: meta.sourceFile,
            imported: { kind: reconciled.kind }, reconciled, subgraph });
    } catch (e) {
        console.error('[Spec] get failed:', e.message);
        res.status(500).json({ error: e.message });
    } finally {
        await session.close();
    }
});

// ── Ein bestehendes Diagramm bearbeiten und löschen ────────────────────────
//
// Beides gehört dem User. Ein Diagramm ist seine Absicht, nicht abgeleiteter
// Zustand: die KI darf es neu einlesen (import_spec ist idempotent auf der
// specId), aber wegwerfen darf es nur jemand, der hier klickt. Deshalb gibt es
// für DELETE bewusst KEIN MCP-Tool, und der Aufruf muss die specId woertlich
// bestätigen — ein versehentlicher Aufruf ohne dieses Wissen läuft ins Leere.

// Wo die Quelldatei eines Diagramms auf der Platte liegt. Der gespeicherte
// `sourceFile` ist relativ zu dem Projekt, aus dem importiert wurde — dieselbe
// Wurzel, die tools/handlers/spec-tools.ts benutzt. Gibt null, wenn sich daraus
// keine existierende Datei ergibt; dann wird auch keine geschrieben.
function resolveSpecFile(sourceFile, wsKey) {
    if (!sourceFile || typeof sourceFile !== 'string') return null;
    if (!/\.(puml|wsd|plantuml|iuml)$/i.test(sourceFile)) return null;   // specId, kein Pfad
    const ws = config.workspaces?.[wsKey] || {};
    const roots = [
        process.env.CODEVIS_PROJECT_DIR,
        ...(Array.isArray(ws.sourceDir) ? ws.sourceDir : (ws.sourceDir ? [ws.sourceDir] : [])),
        paths.PROJECT_ROOT,
    ].filter(Boolean);
    for (const root of roots) {
        const candidate = pathLib.resolve(root, sourceFile);
        if (fs.existsSync(candidate)) return candidate;
    }
    return null;
}

/**
 * Dasselbe, aber mit dem Graphen als letzter Auskunft.
 *
 * Ein Workspace muss keinen `sourceDir` in der Konfiguration stehen haben — der
 * Graph weiß trotzdem, wo das Zielprojekt liegt: seine File-Knoten tragen ihre
 * Pfade relativ zum Projektverzeichnis (`../sample-project/src/app.py`). Aus
 * deren führenden Segmenten ergeben sich die Wurzeln, unter denen eine
 * .puml-Datei überhaupt liegen kann.
 */
async function resolveSpecFileVia(session, sourceFile, wsKey) {
    const direct = resolveSpecFile(sourceFile, wsKey);
    if (direct) return direct;
    if (!sourceFile || !/\.(puml|wsd|plantuml|iuml)$/i.test(sourceFile)) return null;
    let records = [];
    try {
        const res = await session.run(
            `MATCH (f) WHERE f.label = 'File' AND f.path IS NOT NULL RETURN f.path AS path LIMIT 25`);
        records = res.records;
    } catch { return null; }
    const roots = new Set();
    for (const r of records) {
        const segs = String(r.get('path')).split(/[\\/]/);
        for (let i = 1; i <= Math.min(3, segs.length - 1); i++) {
            roots.add(pathLib.resolve(paths.PROJECT_ROOT, segs.slice(0, i).join('/')));
        }
    }
    for (const root of roots) {
        const candidate = pathLib.resolve(root, sourceFile);
        if (fs.existsSync(candidate)) return candidate;
    }
    return null;
}

// Geänderten Diagrammtext zurückspielen: derselbe specId, also ersetzt der
// Import seine eigenen Knoten (DETACH DELETE im Importer) statt ein zweites
// Diagramm daneben anzulegen. Existiert die Quelldatei, wird sie mitgeschrieben
// — sonst hätte der nächste Import aus der Datei die Änderung wieder
// zurückgedreht, ohne dass irgendwo steht warum.
app.put('/api/spec/:specId', async (req, res) => {
    const { specId } = req.params;
    const { diagram, db, writeFile } = req.body || {};
    if (typeof diagram !== 'string' || !diagram.trim()) return res.status(400).json({ error: 'diagram required' });
    const wsKey = resolveSpecDb(db).ws;
    const session = getTaskDriver(wsKey).session();
    try {
        const existing = await specDb.getSpecSource(session, specId);
        if (!existing) return res.status(404).json({ error: `No spec '${specId}' found` });

        const filePath = writeFile === false ? null : await resolveSpecFileVia(session, existing.sourceFile, wsKey);
        const imported = await saveSpecSource({
            filePath, text: diagram, lockDirectory: path.join(paths.DATA_DIR, 'spec-file-locks'),
            importSpec: () => specDb.importSpec(session, {
                text: diagram, specId, sourceFile: existing.sourceFile || specId }),
        });
        const fileWritten = Boolean(filePath);
        let reconciled = null, subgraph = null, warning = null;
        try {
            reconciled = await specDb.reconcileSpec(session, specId, {});
            subgraph = await specDb.getSpecSubgraph(session, specId);
        } catch (error) {
            warning = `Diagram saved, but its preview could not be refreshed: ${error.message}`;
        }
        console.log(`[Spec] synced ${specId} (${imported.kind})${fileWritten ? ` → ${filePath}` : ''}`);
        res.json({ ok: true, specId, imported, reconciled, subgraph,
            fileWritten, filePath, sourceFile: existing.sourceFile || null, warning });
    } catch (e) {
        console.error('[Spec] sync failed:', e.message);
        res.status(500).json({ error: e.message, specId, recoveryPath: e.recoveryPath, fileRestored: e.fileRestored });
    } finally {
        await session.close();
    }
});

app.delete('/api/spec/:specId', async (req, res) => {
    const { specId } = req.params;
    const confirm = (req.body && req.body.confirm) || req.query.confirm;
    if (confirm !== specId) {
        return res.status(400).json({
            error: 'confirm must repeat the specId — deleting a diagram is a user decision',
        });
    }
    const session = getTaskDriver(resolveSpecDb(req.body?.db || req.query.db).ws).session();
    try {
        const removed = await specDb.deleteSpec(session, specId);
        if (!removed) return res.status(404).json({ error: `No spec '${specId}' found` });
        // Die Quelldatei bleibt liegen. Sie gehört dem Projekt, nicht dem
        // Graphen — und ein Klick im Dashboard soll keine Datei löschen, die
        // per Hand geschrieben und versioniert wurde.
        console.log(`[Spec] deleted ${specId} (${removed.removed} node(s))`);
        res.json({ ok: true, ...removed, note: 'Source file on disk was kept.' });
    } catch (e) {
        console.error('[Spec] delete failed:', e.message);
        res.status(500).json({ error: e.message, specId });
    } finally {
        await session.close();
    }
});

// ── ROS 2 architecture ──────────────────────────────────────────────────────
// Reads the ROS layer out of the code graph and returns BOTH renderings in one
// response: PlantUML (the round-trip format import_spec accepts) and Mermaid
// (what the browser can render without a server).
//
// Answers 409 when the ROS extractor is switched off for this workspace. That
// distinction matters: an empty diagram because nothing was extracted looks
// exactly like an empty diagram because the project has no ROS in it, and the
// user would go looking for the wrong problem.
app.get('/api/ros/diagram', async (req, res) => {
    const ws = resolveSpecDb(req.query.db).ws;
    if (!resolveExtractors(config, ws).enabled.ros) {
        return res.status(409).json({
            error: `The ROS extractor is disabled for workspace '${ws}'. `
                + `Set extractors: { ros: true } in codevis.config.cjs and rebuild the graph.`,
            extractorDisabled: 'ros',
        });
    }
    const session = getTaskDriver(ws).session();
    try {
        const opts = {
            pathPrefix: req.query.pathPrefix || null,
            includeUnowned: req.query.includeUnowned !== 'false',
            showInheritance: req.query.showInheritance !== 'false',
            onlyConnected: req.query.onlyConnected === 'true',
            title: req.query.title || 'ROS 2 Architecture',
        };
        const model = await rosDb.readRosModel(session, opts);
        res.json({
            ok: true,
            stats: model.stats,
            plantuml: rosDb.renderModel(model, { ...opts, format: 'plantuml' }),
            mermaid: rosDb.renderModel(model, { ...opts, format: 'mermaid' }),
            nodes: model.nodes,
            interfaces: model.interfaces,
            edges: model.edges,
        });
    } catch (e) {
        console.error('[ROS] diagram failed:', e.message);
        res.status(500).json({ error: e.message });
    } finally {
        await session.close();
    }
});

// ── Class diagram from the code graph ───────────────────────────────────────
// Returns BOTH renderings in one response: PlantUML (the round-trip format
// import_spec accepts) and Mermaid (what the browser can render without a
// server), plus the raw model so a client can lay it out itself. One request
// covers every view; the model is read once, not once per format.
app.get('/api/diagram/class', async (req, res) => {
    const session = getTaskDriver(resolveSpecDb(req.query.db).ws).session();
    try {
        const opts = {
            pathPrefix: req.query.pathPrefix || null,
            includeMethods: req.query.includeMethods !== 'false',
            maxMethods: req.query.maxMethods ? parseInt(req.query.maxMethods, 10) : 12,
            includeUses: req.query.includeUses !== 'false',
            includeTests: req.query.includeTests !== 'false',
            onlyConnected: req.query.onlyConnected === 'true',
            title: req.query.title || 'Class Diagram',
        };
        const model = await classDiagram.readClassModel(session, opts);
        res.json({
            ok: true,
            stats: model.stats,
            plantuml: classDiagram.renderClassDiagram(model, { ...opts, format: 'plantuml' }),
            mermaid: classDiagram.renderClassDiagram(model, { ...opts, format: 'mermaid' }),
            classes: model.classes,
            relations: model.relations,
        });
    } catch (e) {
        console.error('[Diagram] class diagram failed:', e.message);
        res.status(500).json({ error: e.message });
    } finally {
        await session.close();
    }
});

// Queries the meta graph for the just-created nodes (by taskId or name) plus the
// edges between them, then emits 'brain:result' so the BrainTab renders the
// generated subgraph. Reused by the legacy reply_brain endpoint AND the headless
// worker completion handler. Returns the node count.
async function publishBrainResult({ chat_id, runId, summary, nodeIds, db = 'meta' }) {
    const ids = Array.isArray(nodeIds) ? nodeIds : [];
    const session = getTaskDriver(db).session();
    let nodes = [], edges = [];
    try {
        // Step 1 — nodes (match by taskId for Tasks, by name for Knowledge etc.).
        // Top-level id()/labels()/type() mirror loadGraphData's proven Ladybug
        // idiom — NOT startNode()/endNode() (Neo4j-only, missing in Kuzu).
        const nodeRes = await session.run(
            `MATCH (n) WHERE n.taskId IN $ids OR n.name IN $ids
             RETURN elementId(n) AS id, n.title AS title, n.name AS name, labels(n) AS labels,
                    n.taskId AS taskId, n.file AS file, n.category AS category,
                    n.description AS description, n.content AS content,
                    n.workInstructions AS workInstructions,
                    n.priority AS priority, n.status AS status`,
            { ids }
        );
        const internalIds = [];
        for (const r of nodeRes.records) {
            const id = String(r.get('id'));
            internalIds.push(id);
            nodes.push({
                id,
                name: r.get('title') || r.get('name'),
                labels: (r.get('labels') || []).map(String),
                taskId: r.get('taskId'),
                file: r.get('file'),
                category: r.get('category'),
                // Full text for the detail view in the BrainTab subgraph panel.
                description: r.get('description'),
                content: r.get('content'),
                workInstructions: r.get('workInstructions'),
                priority: r.get('priority'),
                status: r.get('status'),
            });
        }
        // Step 1b — provenance: the BraindumpSession is the "book" every
        // generated node derives from. DERIVES edges make the whole session
        // queryable as one linked subgraph (session -> knowledge/tasks ->
        // code). Deliberately NOT a lock-traversal edge type.
        if (internalIds.length && chat_id) {
            await session.run(
                `MATCH (s:BraindumpSession {sessionId: $sessionId})
                 MATCH (n) WHERE elementId(n) IN $ids
                 MERGE (s)-[:DERIVES]->(n)`,
                { sessionId: String(chat_id), ids: internalIds }
            );
        }

        // Step 2 — edges between exactly those nodes (directed pattern binding).
        if (internalIds.length) {
            const edgeRes = await session.run(
                `MATCH (a)-[r]->(b) WHERE elementId(a) IN $ids AND elementId(b) IN $ids
                 RETURN elementId(a) AS src, elementId(b) AS tgt, type(r) AS type`,
                { ids: internalIds }
            );
            for (const r of edgeRes.records) {
                edges.push({ src: String(r.get('src')), tgt: String(r.get('tgt')), type: r.get('type') });
            }
        }
    } finally {
        await session.close();
    }
    io.emit('brain:result', { chat_id, runId, db: publicWorkspaceName(db), summary, nodes, edges });
    return nodes.length;
}

app.post('/api/brain/result', async (req, res) => {
    const { chat_id, summary, nodeIds } = req.body || {};
    if (!Array.isArray(nodeIds)) return res.status(400).json({ error: 'nodeIds must be array' });
    // Als einzige der 59 Routen lief diese ohne try/catch, und eine
    // Error-Middleware gibt es in dieser Datei nicht. Ein Fehler in
    // publishBrainResult landete deshalb in Express' Standardbehandlung, die
    // HTML ausliefert -- das Frontend liest daraus kein `error`-Feld mehr
    // (frontend/src/api/http.js) und zeigt bloss "HTTP 500". Die Ursache stand
    // nur im Serverlog, und auch nur, wenn jemand hinsah.
    try {
        const nodeCount = await publishBrainResult({ chat_id, summary, nodeIds });
        res.json({ ok: true, nodeCount });
    } catch (e) {
        console.error('[bridge] POST /api/brain/result failed:', e);
        res.status(500).json({ error: e.message || String(e) });
    }
});

// ── Task / Kanban REST API ───────────────────────────────────────────

const KANBAN_STATUSES = TASK_STATUSES;

const KNOWLEDGE_CATEGORIES = ['framework', 'architecture', 'domain', 'design', 'testing', 'security', 'performance', 'general'];

app.get('/api/annotations', async (req, res) => {
    const session = getTaskDriver(req.query.db || activeDb).session();
    try {
        const annotations = await annotationDb.listAnnotations(session, {
            targetNode: req.query.nodeId,
            status: req.query.status,
            limit: req.query.limit,
        });
        res.json({ status: 'OK', annotations });
    } catch (err) {
        res.status(400).json({ status: 'ERROR', code: err.code || 'ANNOTATION_FAILED', error: err.message });
    } finally {
        await session.close();
    }
});

app.post('/api/annotations', async (req, res) => {
    const session = getTaskDriver(req.body?.db || activeDb).session();
    try {
        const annotation = await annotationDb.createAnnotation(session, req.body || {});
        try { io.emit('annotation:updated', annotation); } catch (_) {}
        res.status(201).json({ status: 'OK', annotation });
    } catch (err) {
        const status = err.code === 'NODE_NOT_FOUND' ? 404 : 400;
        res.status(status).json({ status: 'ERROR', code: err.code || 'ANNOTATION_FAILED', error: err.message });
    } finally {
        await session.close();
    }
});

app.patch('/api/annotations/:annotationId/status', async (req, res) => {
    const session = getTaskDriver(req.body?.db || activeDb).session();
    try {
        const annotation = await annotationDb.updateAnnotationStatus(
            session, req.params.annotationId, req.body?.status, req.body?.updatedBy || 'user',
        );
        try { io.emit('annotation:updated', annotation); } catch (_) {}
        res.json({ status: 'OK', annotation });
    } catch (err) {
        const status = err.code === 'ANNOTATION_NOT_FOUND' ? 404 : 400;
        res.status(status).json({ status: 'ERROR', code: err.code || 'ANNOTATION_FAILED', error: err.message });
    } finally {
        await session.close();
    }
});

// Update a Knowledge node's content (and optionally category) from the inspector.
// Identified by elementId; legacy names must resolve uniquely. Uses the DB the caller names
// (?db / body.db), defaulting to the active one — same workspace model as tasks.
app.patch('/api/knowledge', async (req, res) => {
    const { category, db } = req.body || {};
    if (category && !KNOWLEDGE_CATEGORIES.includes(category)) {
        return res.status(400).json({ error: `category must be one of: ${KNOWLEDGE_CATEGORIES.join(', ')}` });
    }
    const session = getTaskDriver(db || req.query.db || activeDb).session();
    try {
        const updated = await updateKnowledge(session, req.body || {});
        try { emitWorkspace(io, session.workspace, 'knowledge:updated', updated); } catch (_) {}
        res.json({ status: 'OK', ...updated });
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message });
    } finally {
        await session.close();
    }
});

// Epic REST API. These are intentionally thin graph wrappers; all rows remain
// in CodeNode and all schema changes are additive.
/**
 * LADYBUG: OPTIONAL MATCH und Aggregation über dieselbe Variable gehen nicht
 * zusammen.
 *
 * `MATCH (e:Epic) OPTIONAL MATCH (e)-[:FULFILLED_BY]->(t) RETURN e.title,
 * count(t)` scheitert hart mit "Binder exception: Variable e is not in scope" —
 * die Zeile stand hier und in list_epics, und beide Aufrufe waren dadurch
 * unbenutzbar. get_epic funktionierte immer, weil es zwei getrennte Abfragen
 * absetzt. Genau das ist das Muster: einzeln abfragen, in JS zusammenfuegen.
 * Wer hier eine Abfrage "aufräumt", indem er sie wieder zusammenzieht, baut
 * den Fehler zurück.
 */
async function readEpicRows(session, status) {
    return session.run(
        `MATCH (e:Epic) WHERE $status IS NULL OR $status='all' OR e.status=$status
         RETURN e.taskId AS epicId, e.title AS title, e.description AS description,
                e.workInstructions AS workInstructions, e.status AS status, e.priority AS priority,
                e.createdBy AS createdBy, e.createdAt AS createdAt, e.updatedAt AS updatedAt,
                e.updatedBy AS updatedBy, e.summary AS summary
         ORDER BY e.createdAt`, { status: status || null });
}

/**
 * Ein Daemon, der vor einer additiven Schema-Revision geöffnet wurde, kennt
 * die Tabelle noch nicht und antwortet mit einem Binder-Fehler statt mit einer
 * leeren Menge. Das darf nicht die ganze Task-Liste scheitern lassen — ohne
 * Tabelle gibt es eben keine Epics. reconcileSchema legt sie beim nächsten
 * Daemon-Start an.
 */
function isMissingTable(err, table) {
    return new RegExp(`${table}.*does not exist`, 'i').test(String(err && err.message));
}

/**
 * Epic-Zugehörigkeit und Position in der Sequenz für ALLE Tasks auf einmal.
 *
 * Die Reihenfolge wird nicht gespeichert, sondern aus der DEPENDS_ON-Kette
 * abgeleitet: Kopf ist das Mitglied ohne manuellen Vorgänger IM SELBEN Epic,
 * danach folgt die Kette. Nur kind='manual' zählt — 'derived' stammt aus
 * plan_task_waves und beschreibt keine vom Menschen gesetzte Ordnung.
 *
 * Rückgabe: Map taskId -> { epicId, epicTitle, seqIndex } (1-basiert).
 */
async function readEpicMembership(session) {
    const byTask = new Map();
    const membersOf = new Map();

    let memberRows;
    try {
        memberRows = await session.run(
            `MATCH (e:Epic)-[:FULFILLED_BY]->(t:Task)
             RETURN e.taskId AS epicId, e.title AS epicTitle, t.taskId AS taskId`);
    } catch (err) {
        if (isMissingTable(err, 'FULFILLED_BY')) return byTask;
        throw err;
    }
    for (const r of memberRows.records) {
        const epicId = r.get('epicId');
        if (!membersOf.has(epicId)) membersOf.set(epicId, { title: r.get('epicTitle'), taskIds: [] });
        membersOf.get(epicId).taskIds.push(r.get('taskId'));
    }
    if (membersOf.size === 0) return byTask;

    const deps = [];
    try {
        const depRows = await session.run(
            `MATCH (a:Task)-[d:DEPENDS_ON]->(b:Task) WHERE d.kind = 'manual'
             RETURN a.taskId AS from, b.taskId AS to`);
        for (const r of depRows.records) deps.push([r.get('from'), r.get('to')]);
    } catch (err) {
        if (!isMissingTable(err, 'DEPENDS_ON')) throw err;
    }

    for (const [epicId, { title, taskIds }] of membersOf) {
        const mine = new Set(taskIds);
        // Kanten, die BEIDE Enden in diesem Epic haben. Eine Kette darf nicht
        // über Epic-Grenzen laufen, sonst zählt ein fremder Vorgänger als
        // Kopf-Ausschluss und das Epic hätte gar keinen Anfang.
        const next = new Map();
        const hasPred = new Set();
        for (const [from, to] of deps) {
            if (!mine.has(from) || !mine.has(to)) continue;
            next.set(from, to);
            hasPred.add(to);
        }
        const ordered = [];
        const seen = new Set();
        // Sortiert, damit ein Epic ohne Kette nicht bei jedem Aufruf anders
        // herum erscheint.
        for (const head of taskIds.slice().sort().filter(id => !hasPred.has(id))) {
            let cur = head;
            while (cur && mine.has(cur) && !seen.has(cur)) {
                seen.add(cur);
                ordered.push(cur);
                cur = next.get(cur);
            }
        }
        // Was die Kette nicht erreicht hat — Zyklus oder verwaiste Kante — kommt
        // hinten dran. Eine vollständige Liste mit fragwuerdiger Ordnung ist
        // brauchbarer als eine Liste, in der Tasks fehlen.
        for (const id of taskIds.slice().sort()) {
            if (!seen.has(id)) { seen.add(id); ordered.push(id); }
        }
        ordered.forEach((id, i) => byTask.set(id, { epicId, epicTitle: title, seqIndex: i + 1 }));
    }
    return byTask;
}

// Unified catalogue for the dashboard's Context tab.  Work items are queried
// from the selected project database, not inferred from the currently capped
// graph payload; otherwise a perfectly valid task disappears from the UI just
// because its node fell outside the rendering budget.
app.get('/api/context', async (req, res) => {
    const session = getTaskDriver(req.query.db).session();
    try {
        const result = await session.run(`
            MATCH (n)
            WHERE n:Knowledge OR n:Epic OR n:Task
            RETURN elementId(n) AS id, labels(n) AS labels,
                   n.name AS name, n.title AS title, n.taskId AS taskId,
                   n.category AS category, n.content AS content,
                   n.description AS description, n.status AS status,
                   n.priority AS priority, n.createdAt AS createdAt,
                   n.updatedAt AS updatedAt
        `);
        const items = result.records.map((r) => ({
            id: String(r.get('id')),
            labels: (r.get('labels') || []).map(String),
            name: r.get('title') || r.get('name') || r.get('taskId') || String(r.get('id')),
            taskId: r.get('taskId'),
            category: r.get('category'),
            content: r.get('content'),
            description: r.get('description'),
            status: r.get('status'),
            priority: r.get('priority'),
            createdAt: r.get('createdAt')?.toNumber?.() ?? r.get('createdAt') ?? null,
            updatedAt: r.get('updatedAt')?.toNumber?.() ?? r.get('updatedAt') ?? null,
        }));
        res.json({
            knowledge: items.filter((item) => item.labels.includes('Knowledge')),
            epics: items.filter((item) => item.labels.includes('Epic')),
            tasks: items.filter((item) => item.labels.includes('Task')),
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally {
        await session.close();
    }
});

app.get('/api/epics', async (req, res) => {
    const session = getTaskDriver(req.query.db).session();
    try {
        const epicRows = await readEpicRows(session, req.query.status);
        // Zählen in JS statt in Cypher — siehe readEpicRows.
        const counts = new Map();
        const statusesOf = new Map();
        try {
            const memberRows = await session.run(
                `MATCH (e:Epic)-[:FULFILLED_BY]->(t:Task)
                 RETURN e.taskId AS epicId, t.status AS status`);
            for (const r of memberRows.records) {
                const id = r.get('epicId');
                if (!counts.has(id)) { counts.set(id, { total: 0, done: 0, in_progress: 0 }); statusesOf.set(id, []); }
                const c = counts.get(id);
                c.total++;
                statusesOf.get(id).push(r.get('status'));
                if (r.get('status') === 'done') c.done++;
                else if (r.get('status') === 'in_progress') c.in_progress++;
            }
        } catch (err) {
            if (!isMissingTable(err, 'FULFILLED_BY')) throw err;
        }
        res.json(epicRows.records.map(r => {
            const id = r.get('epicId');
            return {
                epicId: id, title: r.get('title'), description: r.get('description'),
                workInstructions: r.get('workInstructions'),
                // Abgeleitet, siehe deriveEpicStatus. Der gespeicherte Wert
                // bleibt als storedStatus sichtbar, damit ein Auseinanderlaufen
                // nachvollziehbar ist statt nur zu verschwinden.
                status: deriveEpicStatus(statusesOf.get(id) || []),
                storedStatus: r.get('status'),
                priority: r.get('priority'),
                createdBy: r.get('createdBy'), createdAt: r.get('createdAt'), updatedAt: r.get('updatedAt'),
                updatedBy: r.get('updatedBy'), summary: r.get('summary'),
                progress: counts.get(id) || { total: 0, done: 0, in_progress: 0 },
            };
        }));
    } catch (err) { res.status(500).json({ error: err.message }); }
    finally { await session.close(); }
});

app.get('/api/work-items/:taskId/scope-policy', async (req, res) => {
    const session = getTaskDriver(req.query.db).session();
    try {
        const policy = await require('./task-scope-policy.cjs').readScopePolicy(session, req.params.taskId);
        if (!policy) return res.status(404).json({ error: 'Work item not found' });
        res.json({ ...policy, lockingEnabled: LOCKING_ENABLED });
    } catch (error) { res.status(500).json({ error: error.message }); }
    finally { await session.close(); }
});

app.patch('/api/work-items/:taskId/scope-policy', async (req, res) => {
    try { require('./task-scope-policy.cjs').validateScopeMode(req.body?.scopeMode); }
    catch (error) { return res.status(400).json({ error: error.message }); }
    const session = getTaskDriver(req.body?.db).session();
    try {
        const result = await session.taskClaimAtomic({ operation: 'set_policy',
            taskId: req.params.taskId, agentId: 'user', scopeMode: req.body.scopeMode });
        if (result.status !== 'OK') return res.status(result.status === 'NOT_FOUND' ? 404 : 409).json({ error: result.message || result.status });
        res.json({ ...result.policy, lockingEnabled: LOCKING_ENABLED });
    } catch (error) { res.status(500).json({ error: error.message }); }
    finally { await session.close(); }
});

app.post('/api/epics', async (req, res) => {
    const { title, description, workInstructions, priority, createdBy } = req.body || {};
    if (priority && !TASK_PRIORITIES.includes(priority)) {
        return res.status(400).json({ error: 'priority must be one of: critical, high, medium, low' });
    }
    const problems = process.env.CODEVIS_TASK_GATE === 'off'
        ? []
        : taskSpecProblems({ title, description, workInstructions }, { subject: 'epic' });
    if (problems.length) return res.status(400).json({ status: 'UNDERSPECIFIED', problems });
    const session = getTaskDriver(req.body.db).session();
    try {
        const epicId = generateWorkItemId('epic');
        await session.run(
            `CREATE (e:Epic {taskId:$epicId,title:$title,description:$description,workInstructions:$workInstructions,
             status:'backlog',priority:$priority,createdBy:$createdBy,createdAt:timestamp(),updatedAt:timestamp(),updatedBy:$createdBy,summary:null})`,
            { epicId, title, description, workInstructions, priority: priority || 'medium', createdBy: createdBy || 'user' });
        res.json({ epicId, title, description, workInstructions, status: 'backlog', priority: priority || 'medium' });
    } catch (err) { res.status(500).json({ error: err.message }); }
    finally { await session.close(); }
});

app.get('/api/epics/:epicId', async (req, res) => {
    const session = getTaskDriver(req.query.db).session();
    try {
        const er = await session.run(`MATCH (e:Epic {taskId:$epicId}) RETURN e.taskId AS epicId,e.title AS title,e.description AS description,e.workInstructions AS workInstructions,e.status AS status,e.priority AS priority,e.summary AS summary`, req.params);
        if (!er.records.length) return res.status(404).json({ error: 'Epic not found' });
        const tr = await session.run(
            `MATCH (e:Epic {taskId:$epicId})-[:FULFILLED_BY]->(t:Task)
             OPTIONAL MATCH (pre:Task)-[d:DEPENDS_ON]->(t) WHERE EXISTS { MATCH (e)-[:FULFILLED_BY]->(pre) }
             RETURN t.taskId AS taskId,t.title AS title,t.status AS status,t.priority AS priority,
                    collect(CASE WHEN pre IS NULL THEN null ELSE {from:pre.taskId,to:t.taskId,kind:d.kind} END) AS dependencies`, req.params);
        const r = er.records[0];
        const tasks = tr.records.map(x => ({ taskId:x.get('taskId'), title:x.get('title'), status:x.get('status'), priority:x.get('priority'), dependsOn:(x.get('dependencies') || []).filter(Boolean) }));
        // Abgeleiteter Status, identisch zur Listen-Route — sonst zeigt die
        // Detailansicht einen anderen als die Karte daneben.
        res.json({ epicId:r.get('epicId'), title:r.get('title'), description:r.get('description'),
            workInstructions:r.get('workInstructions'),
            status: deriveEpicStatus(tasks.map(t => t.status)), storedStatus: r.get('status'),
            priority:r.get('priority'), summary:r.get('summary'), tasks,
            dependencies:tasks.flatMap(t => t.dependsOn) });
    } catch (err) { res.status(500).json({ error: err.message }); }
    finally { await session.close(); }
});

app.patch('/api/epics/:epicId', async (req, res) => {
    const { title, description, workInstructions, priority, status } = req.body || {};
    if (priority && !TASK_PRIORITIES.includes(priority)) {
        return res.status(400).json({ error: 'priority must be one of: critical, high, medium, low' });
    }
    if (status && !TASK_STATUSES.includes(status)) {
        return res.status(400).json({ error: `status must be one of: ${TASK_STATUSES.join(', ')}` });
    }
    const session = getTaskDriver(req.query.db).session();
    try {
        const stored = await session.run(
            `MATCH (e:Epic {taskId: $epicId})
             RETURN e.title AS title, e.description AS description,
                    e.workInstructions AS workInstructions`,
            { epicId: req.params.epicId }
        );
        if (stored.records.length === 0) {
            return res.status(404).json({ error: 'Epic not found' });
        }
        if (process.env.CODEVIS_TASK_GATE !== 'off') {
            const record = stored.records[0];
            const candidate = mergeTaskSpec({
                title: record.get('title'),
                description: record.get('description'),
                workInstructions: record.get('workInstructions'),
            }, { title, description, workInstructions });
            const problems = taskSpecProblems(candidate, { subject: 'epic' });
            if (problems.length > 0) {
                return res.status(400).json({
                    status: 'UNDERSPECIFIED',
                    error: 'Epic update rejected by the specification gate.',
                    problems,
                });
            }
        }

        const result = await session.run(
            `MATCH (e:Epic {taskId:$epicId}) SET e.title=COALESCE($title,e.title),e.description=COALESCE($description,e.description),
             e.workInstructions=COALESCE($workInstructions,e.workInstructions),e.priority=COALESCE($priority,e.priority),
             e.status=COALESCE($status,e.status),e.updatedAt=timestamp(),e.updatedBy='user'
             RETURN e.taskId AS epicId,e.title AS title,e.description AS description,e.workInstructions AS workInstructions,e.priority AS priority,e.status AS status`,
            { epicId:req.params.epicId, title:title ?? null, description:description ?? null, workInstructions:workInstructions ?? null, priority:priority ?? null, status:status ?? null });
        if (!result.records.length) return res.status(404).json({ error:'Epic not found' });
        const r=result.records[0]; res.json({ epicId:r.get('epicId'),title:r.get('title'),description:r.get('description'),workInstructions:r.get('workInstructions'),priority:r.get('priority'),status:r.get('status') });
    } catch (err) { res.status(500).json({ error:err.message }); }
    finally { await session.close(); }
});

// Epic membership and ordering share one daemon transaction with MCP callers.
app.put('/api/epics/:epicId/tasks/:taskId', async (req, res) => {
    const session = getTaskDriver(req.query.db).session();
    try {
        const result = await session.epicMembershipAtomic({ operation: 'add', epicId: req.params.epicId, taskId: req.params.taskId, taskIds: req.body?.taskIds });
        if (result.status !== 'OK') return res.status(result.status === 'NOT_FOUND' ? 404 : 400).json(result);
        res.json({ ok: true, ...result });
    } catch (err) { res.status(500).json({ error: err.message }); }
    finally { await session.close(); }
});

app.put('/api/epics/:epicId/order', async (req, res) => {
    const session = getTaskDriver(req.query.db).session();
    try {
        const result = await session.epicMembershipAtomic({ operation: 'order', epicId: req.params.epicId, taskId: req.params.taskId, taskIds: req.body?.taskIds });
        if (result.status !== 'OK') return res.status(result.status === 'NOT_FOUND' ? 404 : 400).json(result);
        if (io) emitWorkspace(io, session.workspace, 'epic:order-changed', { epicId: result.epicId, taskIds: result.taskIds });
        res.json({ ok: true, ...result });
    } catch (err) { res.status(500).json({ error: err.message }); }
    finally { await session.close(); }
});

app.delete('/api/epics/:epicId/tasks/:taskId', async (req, res) => {
    const session = getTaskDriver(req.query.db).session();
    try {
        const result = await session.epicMembershipAtomic({ operation: 'remove', epicId: req.params.epicId, taskId: req.params.taskId, taskIds: req.body?.taskIds });
        if (result.status !== 'OK') return res.status(result.status === 'NOT_FOUND' ? 404 : 400).json(result);
        res.json({ ok: true, ...result });
    } catch (err) { res.status(500).json({ error: err.message }); }
    finally { await session.close(); }
});

app.get('/api/tasks', async (req, res) => {
    const session = getTaskDriver(req.query.db).session();
    try {
        const statusFilter = req.query.status && req.query.status !== 'all'
            ? 'WHERE t.status = $status' : '';
        const result = await session.run(
            `MATCH (t:Task) ${statusFilter}
             OPTIONAL MATCH (t)-[:AFFECTS]->(n)
             RETURN t.taskId AS taskId, t.title AS title, t.description AS description,
                    t.status AS status, t.priority AS priority, t.category AS category,
                    t.createdBy AS createdBy, t.assignedTo AS assignedTo,
                    t.summary AS summary, t.lastComment AS lastComment,
                    t.updatedBy AS updatedBy,
                    t.wave AS wave, t.waveStatus AS waveStatus,
                    collect(CASE WHEN n IS NOT NULL THEN {id: elementId(n), name: coalesce(n.name, n.path, elementId(n)), ipv6: n.ipv6} ELSE null END) AS affectedNodes
             ORDER BY CASE status
               WHEN 'in_progress' THEN 0 WHEN 'blocked' THEN 1 WHEN 'needs_info' THEN 2
               WHEN 'review' THEN 3 WHEN 'todo' THEN 4 WHEN 'backlog' THEN 5
               WHEN 'done' THEN 6 ELSE 7 END,
             CASE priority
               WHEN 'critical' THEN 0 WHEN 'high' THEN 1
               WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END`,
            { status: req.query.status }
        );
        // Epic-Zugehörigkeit EINMAL für alle Tasks holen, nicht pro Task eine
        // Abfrage. Das Kanban-Board braucht sie für jede Karte; ein N+1 wäre
        // bei knapp hundert Tasks direkt spuerbar.
        const membership = await readEpicMembership(session);
        const tasks = result.records.map(r => {
            const out = {};
            r.keys.forEach(k => { out[k] = r.get(k); });
            out.affectedNodes = (out.affectedNodes || []).filter(n => n?.id != null);
            const m = membership.get(out.taskId);
            out.epicId = m ? m.epicId : null;
            out.epicTitle = m ? m.epicTitle : null;
            out.seqIndex = m ? m.seqIndex : null;
            return out;
        });
        res.json(tasks);
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally {
        await session.close();
    }
});

app.get('/api/tasks/:taskId', async (req, res) => {
    const { taskId } = req.params;
    const session = getTaskDriver(req.query.db).session();
    try {
        const result = await session.run(
            `MATCH (t:Task {taskId: $taskId})
             OPTIONAL MATCH (t)-[:AFFECTS]->(n)
             RETURN t.taskId AS taskId, t.title AS title, t.description AS description,
                    t.workInstructions AS workInstructions,
                    t.status AS status, t.priority AS priority, t.category AS category,
                    t.createdBy AS createdBy, t.assignedTo AS assignedTo,
                    t.summary AS summary, t.lastComment AS lastComment,
                    t.updatedBy AS updatedBy, t.createdAt AS createdAt,
                    t.updatedAt AS updatedAt, t.completedAt AS completedAt,
                    t.comments AS comments,
                    collect(CASE WHEN n IS NOT NULL THEN {
                        id: elementId(n), name: coalesce(n.name, n.path, elementId(n)),
                        ipv6: n.ipv6, file: coalesce(n.file, n.path),
                        label: labels(n)[0], locked: n.locked,
                        lockedBy: n.lockedBy, lockGroup: n.lockGroup
                    } ELSE null END) AS affectedNodes`,
            { taskId }
        );

        if (result.records.length === 0) {
            return res.status(404).json({ error: 'Task not found' });
        }

        const r = result.records[0];
        const task = {};
        r.keys.forEach(k => { task[k] = r.get(k); });
        // Dieselben Epic-Felder wie in der Listen-Route. Die Detailansicht darf
        // die Zugehörigkeit nicht aus der Liste raten müssen — sonst zeigt sie
        // beim Direktaufruf eines Tasks gar keine.
        const membership = (await readEpicMembership(session)).get(taskId);
        task.epicId = membership ? membership.epicId : null;
        task.epicTitle = membership ? membership.epicTitle : null;
        task.seqIndex = membership ? membership.seqIndex : null;
        // Filter out null entries from affectedNodes (Kuzu returns null — not [null] —
        // when a task has no AFFECTS, so guard against a null collect result).
        task.affectedNodes = (task.affectedNodes || []).filter(n => n?.id != null);
        task.comments = (task.comments || []).map(s => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean);
        res.json(task);
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally {
        await session.close();
    }
});

app.patch('/api/tasks/:taskId/status', async (req, res) => {
    const { taskId } = req.params;
    const { status, comment, updatedBy } = req.body;

    if (!KANBAN_STATUSES.includes(status)) {
        return res.status(400).json({ error: `Invalid status. Must be one of: ${KANBAN_STATUSES.join(', ')}` });
    }

    const session = getTaskDriver(req.query.db).session();
    try {
        const current = await session.run(
            `MATCH (t:Task {taskId: $taskId}) RETURN t.status AS status`,
            { taskId }
        );
        if (current.records.length === 0) {
            return res.status(404).json({ error: 'Task not found' });
        }
        const oldStatus = current.records[0].get('status');
        const lockTransition = await transitionTaskLocks(
            session, taskId, oldStatus, status, updatedBy || 'user', LOCKING_ENABLED, { comment },
        );
        if (!['OK', 'NOOP', 'DISABLED'].includes(lockTransition.status)) {
            return res.status(409).json({
                error: lockTransition.message || `Task transition rejected: ${lockTransition.status}`,
                code: lockTransition.status,
                action: lockTransition.action,
                conflicts: lockTransition.conflicts,
                conflictNode: lockTransition.conflictNode,
                conflictAgent: lockTransition.conflictAgent,
                conflictGroup: lockTransition.conflictGroup,
            });
        }

        const result = await session.run(
            `MATCH (t:Task {taskId: $taskId})
             RETURN t.taskId AS taskId, t.title AS title, t.status AS status`,
            { taskId, status, comment: comment || null, updatedBy: updatedBy || 'user' }
        );

        if (result.records.length === 0) {
            return res.status(404).json({ error: 'Task not found' });
        }

        // Ownership and status changed atomically through the same daemon
        // operation used by MCP. Everything below is only the Epic roll-up after a
        // completed move; an old daemon may not know the additive Epic schema,
        // so that follow-up becomes a warning instead of lying that the move
        // itself failed.
        let followUpError = null;
        if (status === 'done') {
            try {
                await session.run(
                    `MATCH (e:Epic)-[:FULFILLED_BY]->(t:Task {taskId:$taskId})
                     WHERE NOT EXISTS { MATCH (e)-[:FULFILLED_BY]->(open:Task) WHERE open.status <> 'done' }
                     SET e.status='review', e.updatedAt=timestamp(), e.updatedBy=$updatedBy`,
                    { taskId, updatedBy: updatedBy || 'user' }
                );
            } catch (err) {
                followUpError = err.message;
                console.error(`[Tasks] ${taskId} is done, but the follow-up failed: ${err.message}`);
            }
        }

        const task = { taskId, title: result.records[0].get('title'), status, comment, updatedBy };

        // Broadcast to all connected Kanban clients
        if (io) emitWorkspace(io, session.workspace, 'task:status-changed', task);

        res.json(followUpError ? { ...task, warning: followUpError } : task);
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally {
        await session.close();
    }
});

// Edit a task's CONTENT (title / description / workInstructions / priority).
// Status changes go through /status (they drive lock transitions); this is the
// pure-content edit that CodeVis previously had no way to do after creation.
app.patch('/api/tasks/:taskId', async (req, res) => {
    const { taskId } = req.params;
    const { title, description, workInstructions, priority, updatedBy } = req.body || {};
    if (priority && !TASK_PRIORITIES.includes(priority)) {
        return res.status(400).json({ error: 'priority must be one of: critical, high, medium, low' });
    }
    if (title === undefined && description === undefined && workInstructions === undefined && priority === undefined) {
        return res.status(400).json({ error: 'Provide at least one of: title, description, workInstructions, priority' });
    }
    const session = getTaskDriver(req.query.db).session();
    try {
        const stored = await session.run(
            `MATCH (t:Task {taskId: $taskId})
             RETURN t.title AS title, t.description AS description,
                    t.workInstructions AS workInstructions`,
            { taskId }
        );
        if (stored.records.length === 0) {
            return res.status(404).json({ error: 'Task not found' });
        }
        if (process.env.CODEVIS_TASK_GATE !== 'off') {
            const record = stored.records[0];
            const candidate = mergeTaskSpec({
                title: record.get('title'),
                description: record.get('description'),
                workInstructions: record.get('workInstructions'),
            }, { title, description, workInstructions });
            const problems = taskSpecProblems(candidate, { subject: 'task' });
            if (problems.length > 0) {
                return res.status(400).json({
                    status: 'UNDERSPECIFIED',
                    error: 'Task update rejected by the specification gate.',
                    problems,
                });
            }
        }

        const result = await session.run(
            `MATCH (t:Task {taskId: $taskId})
             SET t.title = COALESCE($title, t.title),
                 t.description = COALESCE($description, t.description),
                 t.workInstructions = COALESCE($workInstructions, t.workInstructions),
                 t.priority = COALESCE($priority, t.priority),
                 t.updatedAt = timestamp(),
                 t.updatedBy = $updatedBy
             RETURN t.taskId AS taskId, t.title AS title, t.description AS description,
                    t.workInstructions AS workInstructions, t.priority AS priority, t.status AS status`,
            {
                taskId,
                title: title ?? null,
                description: description ?? null,
                workInstructions: workInstructions ?? null,
                priority: priority ?? null,
                updatedBy: updatedBy || 'user',
            }
        );
        if (result.records.length === 0) {
            return res.status(404).json({ error: 'Task not found' });
        }
        const r = result.records[0];
        const task = {
            taskId,
            title: r.get('title'),
            description: r.get('description'),
            workInstructions: r.get('workInstructions'),
            priority: r.get('priority'),
            status: r.get('status'),
        };
        // Kanban clients merge by taskId on this event, so the card updates live.
        if (io) emitWorkspace(io, session.workspace, 'task:status-changed', task);
        res.json(task);
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally {
        await session.close();
    }
});

// ── Task Comments ────────────────────────────────────────────────────
const { appendTaskComment, editTaskComment, deleteTaskComment } = require('../tools/lib/task-comments.cjs');

app.post('/api/tasks/:taskId/comments', async (req, res) => {
    const { taskId } = req.params;
    const { text, author } = req.body;
    if (!text || !text.trim()) return res.status(400).json({ error: 'text required' });
    try {
        const comment = await (async () => {
            const session = getTaskDriver(req.query.db).session();
            try {
                const { value: comment, comments } = await appendTaskComment(session, taskId, { text, author: author || 'user' });
                if (io) emitWorkspace(io, session.workspace, 'task:comments-changed', { taskId, comments });
                return comment;
            } finally { await session.close(); }
        })();
        res.json(comment);
    } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

app.patch('/api/tasks/:taskId/comments/:commentId', async (req, res) => {
    const { taskId, commentId } = req.params;
    const { text } = req.body;
    if (!text || !text.trim()) return res.status(400).json({ error: 'text required' });
    try {
        const updated = await (async () => {
            const session = getTaskDriver(req.query.db).session();
            try {
                const { value: comment, comments } = await editTaskComment(session, taskId, commentId, text);
                if (io) emitWorkspace(io, session.workspace, 'task:comments-changed', { taskId, comments });
                return comment;
            } finally { await session.close(); }
        })();
        res.json(updated);
    } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

app.delete('/api/tasks/:taskId/comments/:commentId', async (req, res) => {
    const { taskId, commentId } = req.params;
    try {
        await (async () => {
            const session = getTaskDriver(req.query.db).session();
            try {
                const { comments } = await deleteTaskComment(session, taskId, commentId);
                if (io) emitWorkspace(io, session.workspace, 'task:comments-changed', { taskId, comments });
            } finally { await session.close(); }
        })();
        res.json({ ok: true });
    } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

// Current lock state. The StatusBar asks for this once on mount and then keeps
// itself current from the `locks:changed` socket event.
//
// This route did not exist. The fetch 404'd, the caller's `r.ok ? … : null`
// swallowed it, and the counter sat at its useState(0) initial value — so a
// freshly loaded dashboard reported "0 locks" no matter how many were held, and
// only became truthful once some lock happened to change. Zero-because-unknown
// rendered exactly like zero-because-empty.
//
// The predicate is deliberately identical to the socket poller's below: it
// counts planned locks (lockStatus set, not yet active) as well as active ones.
// Anything narrower and the number would visibly jump on the first event.
app.get('/api/locks', async (req, res) => {
    const session = getTaskDriver(req.query.db).session();
    try {
        const result = await session.run(
            `MATCH (n) WHERE n.locked = true OR n.lockStatus IS NOT NULL
             RETURN elementId(n) AS id, n.name AS name, n.file AS file, n.locked AS locked,
                    n.lockedBy AS lockedBy, n.lockStatus AS lockStatus,
                    n.lockGroup AS lockGroup`
        );
        res.json(result.records.map((r) => ({
            id: String(r.get('id')),
            name: r.get('name'),
            file: r.get('file'),
            locked: r.get('locked'),
            lockedBy: r.get('lockedBy'),
            lockStatus: r.get('lockStatus'),
            lockGroup: r.get('lockGroup'),
        })));
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally {
        await session.close();
    }
});

// Delete a task for good. Only `done` tasks may go: a task that is still open
// is the only record that the work exists, so losing it loses the work. A done
// task has already served its purpose, which makes it the one safe thing to
// remove. The status is re-read inside this handler rather than trusted from
// the client — the Kanban only offers the button on done cards, but the
// endpoint must hold that rule on its own.
app.delete('/api/tasks/:taskId', async (req, res) => {
    const { taskId } = req.params;
    const session = getTaskDriver(req.query.db).session();
    try {
        const found = await session.run(
            `MATCH (t:Task {taskId: $taskId}) RETURN t.status AS status, t.title AS title`,
            { taskId }
        );
        if (found.records.length === 0) {
            return res.status(404).json({ error: 'Task not found' });
        }
        const status = found.records[0].get('status');
        const title = found.records[0].get('title');
        if (status !== 'done') {
            return res.status(409).json({
                error: `Only tasks in 'done' can be deleted (this one is '${status}'). Move it to done first.`,
                status,
            });
        }

        // Locks are keyed by lockGroup, not by an edge, so deleting the node
        // alone would strand them on the code nodes forever. Moving to done
        // already releases them, but a lock armed after that transition would
        // survive — clear them here too rather than rely on the earlier step.
        await session.run(
            `MATCH (n) WHERE n.lockGroup = $taskId
             SET n.locked = null, n.lockedBy = null, n.lockGroup = null, n.lockExpires = null, n.lockOrigin = null`,
            { taskId }
        );
        // DETACH removes AFFECTS / APPLIES_TO and anything else attached.
        await session.run(`MATCH (t:Task {taskId: $taskId}) DETACH DELETE t`, { taskId });

        if (io) emitWorkspace(io, session.workspace, 'task:deleted', { taskId });
        res.json({ ok: true, taskId, title });
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally {
        await session.close();
    }
});

app.post('/api/tasks', async (req, res) => {
    const { title, description, workInstructions, priority, category, targetNodes, createdBy } = req.body || {};
    if (priority && !TASK_PRIORITIES.includes(priority)) {
        return res.status(400).json({ error: 'priority must be one of: critical, high, medium, low' });
    }
    if (process.env.CODEVIS_TASK_GATE !== 'off') {
        const problems = taskSpecProblems({ title, description, workInstructions }, { subject: 'task' });
        if (problems.length > 0) {
            return res.status(400).json({
                status: 'UNDERSPECIFIED',
                error: 'Task rejected by the specification gate.',
                problems,
            });
        }
    }
    const session = getTaskDriver((req.body || {}).db).session();
    try {
        const taskId = await reserveUniqueTaskId(session);
        await session.run(
            `CREATE (t:Task {
                taskId: $taskId, title: $title, description: $description,
                workInstructions: $workInstructions,
                status: 'backlog', priority: $priority, category: $category,
                createdBy: $createdBy, createdAt: timestamp(), assignedTo: null
            })`,
            { taskId, title, description, workInstructions, priority: priority || 'medium', category: category || null, createdBy: createdBy || 'user' }
        );

        // Link to target nodes if specified
        if (targetNodes && targetNodes.length > 0) {
            await session.run(
                `MATCH (t:Task {taskId: $taskId})
                 UNWIND $names AS name
                 MATCH (n)
                 WHERE ${codeTargetPredicate('n', 'name')}
                 MERGE (t)-[:AFFECTS]->(n)`,
                { taskId, names: targetNodes }
            );
        }

        const task = { taskId, title, description, workInstructions, status: 'backlog', priority: priority || 'medium', category };
        if (io) emitWorkspace(io, session.workspace, 'task:created', task);
        res.json(task);
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally {
        await session.close();
    }
});


// ── Idea Dump REST API ───────────────────────────────────────────────
// Ideas bypass the Task spec gate: they are captured as raw text and live in
// the same meta graph. The `taskId` column doubles as the ideaId
// (idea-TIMESTAMP). Status: 'open' | 'promoted'.

// Every one of these takes the workspace from the request, exactly like
// /api/tasks does. They used to be nailed to 'meta'. On a dashboard switched to
// 'target' the Kanban then showed target's Tasks next to meta's Ideas — one
// board, two databases, and no way to tell which column came from where.
// Writing was worse: an idea jotted down while looking at 'target' landed in
// 'meta', and promoting it to a task moved it across the workspace boundary.
// Was aus einer Idee werden soll ("intent") und wie dringend. Beides sind
// Notizen an der Idee, keine Umwandlung: die passiert weiterhin bewusst über
// promote_idea_to_task. Gespeichert wird auf vorhandenen Spalten — `category`
// trägt die Intent-Liste (kommagetrennt, bei Ideen sonst leer), `priority` die
// Stufe. Eine neue Spalte hätte eine Schema-Migration der CodeNode-Tabelle
// bedeutet, und die Liste ist bei Ideen kurz genug für einen String.
const IDEA_INTENTS = ['task', 'epic', 'knowledge'];
const IDEA_PRIORITIES = ['critical', 'high', 'medium', 'low'];

function normalizeIntent(value) {
    if (value == null) return null;
    const list = Array.isArray(value) ? value : String(value).split(',');
    const clean = [...new Set(list
        .map(v => String(v).trim().toLowerCase())
        .filter(v => IDEA_INTENTS.includes(v)))];
    return clean.join(',');   // '' loescht die Auswahl wieder
}

function normalizePriority(value) {
    if (value == null) return null;
    const p = String(value).trim().toLowerCase();
    if (p === '') return '';   // '' hebt die Priorisierung auf
    return IDEA_PRIORITIES.includes(p) ? p : null;
}

function intentToList(stored) {
    if (!stored) return [];
    return String(stored).split(',').map(s => s.trim()).filter(s => IDEA_INTENTS.includes(s));
}

app.get('/api/ideas', async (req, res) => {
    const showAll = req.query.status === 'all';
    const session = getTaskDriver(req.query.db).session();
    try {
        const result = await session.run(
            showAll
                ? `MATCH (i:Idea)
                   RETURN i.taskId AS ideaId, i.content AS content,
                          i.status AS status, i.createdBy AS createdBy,
                          i.category AS intent, i.priority AS priority,
                          i.createdAt AS createdAt
                   ORDER BY i.createdAt`
                : `MATCH (i:Idea) WHERE i.status = 'open'
                   RETURN i.taskId AS ideaId, i.content AS content,
                          i.status AS status, i.createdBy AS createdBy,
                          i.category AS intent, i.priority AS priority,
                          i.createdAt AS createdAt
                   ORDER BY i.createdAt`
        );
        const ideas = result.records.map(r => {
            const out = {};
            r.keys.forEach(k => { out[k] = r.get(k); });
            out.intent = intentToList(out.intent);
            out.priority = out.priority || '';
            return out;
        });
        res.json(ideas);
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally {
        await session.close();
    }
});

app.post('/api/ideas', async (req, res) => {
    const { content, createdBy, intent, priority } = req.body || {};
    if (!content || !content.trim()) return res.status(400).json({ error: 'content required' });
    const storedIntent = normalizeIntent(intent) || '';
    const storedPriority = normalizePriority(priority) || '';
    const ideaId = generateWorkItemId('idea');
    const session = getTaskDriver(req.query.db).session();
    try {
        await session.run(
            `CREATE (i:Idea {
                taskId: $ideaId, name: $ideaId,
                content: $content, status: 'open',
                createdBy: $createdBy,
                category: $intent, priority: $priority,
                createdAt: timestamp(), updatedAt: timestamp()
            })`,
            {
                ideaId, content: content.trim(), createdBy: createdBy || 'user',
                intent: storedIntent, priority: storedPriority,
            }
        );
        const idea = {
            ideaId, content: content.trim(), status: 'open', createdBy: createdBy || 'user',
            intent: intentToList(storedIntent), priority: storedPriority,
        };
        if (io) emitWorkspace(io, session.workspace, 'idea:created', idea);
        res.json(idea);
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally {
        await session.close();
    }
});

// Teil-Update: wer nur den Intent oder die Prio umstellt, schickt keinen Text
// mit. Frueher war `content` Pflicht — ein Klick auf eine Chip hätte den Text
// mitschicken müssen, den die Karte gerade gar nicht im Zustand hat.
app.patch('/api/ideas/:ideaId', async (req, res) => {
    const { ideaId } = req.params;
    const { content, intent, priority } = req.body || {};
    const hasContent = typeof content === 'string' && content.trim() !== '';
    const storedIntent = normalizeIntent(intent);
    const storedPriority = normalizePriority(priority);
    if (!hasContent && storedIntent === null && storedPriority === null) {
        return res.status(400).json({ error: 'content, intent or priority required' });
    }
    const session = getTaskDriver(req.query.db).session();
    try {
        const result = await session.run(
            `MATCH (i:Idea {taskId: $ideaId})
             SET i.content = COALESCE($content, i.content),
                 i.category = COALESCE($intent, i.category),
                 i.priority = COALESCE($priority, i.priority),
                 i.updatedAt = timestamp()
             RETURN i.taskId AS ideaId, i.content AS content,
                    i.category AS intent, i.priority AS priority`,
            {
                ideaId,
                content: hasContent ? content.trim() : null,
                intent: storedIntent,
                priority: storedPriority,
            }
        );
        if (result.records.length === 0) return res.status(404).json({ error: 'Idea not found' });
        const r = result.records[0];
        const idea = {
            ideaId,
            content: r.get('content'),
            intent: intentToList(r.get('intent')),
            priority: r.get('priority') || '',
        };
        if (io) emitWorkspace(io, session.workspace, 'idea:updated', idea);
        res.json(idea);
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally {
        await session.close();
    }
});

app.delete('/api/ideas/:ideaId', async (req, res) => {
    const { ideaId } = req.params;
    const session = getTaskDriver(req.query.db).session();
    try {
        await session.run(`MATCH (i:Idea {taskId: $ideaId}) DETACH DELETE i`, { ideaId });
        if (io) emitWorkspace(io, session.workspace, 'idea:deleted', { ideaId });
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally {
        await session.close();
    }
});

// Serves JSON-Lines written by tools/lib/logger.ts.
registerLogRoutes(app, { logDir: path.resolve(__dirname, '..', '.claude', 'logs') });


// ── HTTP + Socket.io server ──────────────────────────────────────────
const httpServer = createServer(app);
const io = new Server(httpServer, {
    allowRequest: allowLocalSocketRequest,
    cors: {
        origin: localCors.origin,
        methods: ['GET', 'POST']
    }
});

let cachedGraph = null;

io.on('connection', (socket) => {
    console.log(`[Bridge] Client connected: ${socket.id}`);

    // NOTE: register ALL socket.on(...) listeners SYNCHRONOUSLY before any await.
    // Socket.io drops events that arrive before a listener exists. The frontend
    // emits 'tasks:request' immediately on connect; if we awaited loadGraphData()
    // first, that request would be lost and the Kanban would show 0 tasks until
    // the 10s poll recovered it. So the graph load is fired at the END (below).

    // Relay trace events from pulse simulator to all frontends
    socket.on('trace:event', (event) => {
        socket.broadcast.emit('trace:event', event);
    });

    // Kanban: client requests task list
    socket.on('tasks:request', async (data) => {
        let session;
        try {
            const db = subscribeWorkspace(socket, normalizeWorkspaceName(data?.db, activeDb));
            session = getTaskDriver(db).session();
            const result = await session.run(
                `MATCH (t:Task)
                 OPTIONAL MATCH (t)-[:AFFECTS]->(n)
                 RETURN t.taskId AS taskId, t.title AS title, t.description AS description,
                        t.status AS status, t.priority AS priority, t.category AS category,
                        t.createdBy AS createdBy, t.assignedTo AS assignedTo,
                        t.lastComment AS lastComment,
                        collect(CASE WHEN n IS NOT NULL THEN {id: elementId(n), name: coalesce(n.name, n.path, elementId(n)), ipv6: n.ipv6} ELSE null END) AS affectedNodes
                 ORDER BY CASE priority
                   WHEN 'critical' THEN 0 WHEN 'high' THEN 1
                   WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END`
            );
            // Dies ist der Pfad, den das Kanban-Board tatsaechlich nutzt — die
            // REST-Route /api/tasks ist die zweite Quelle. Beide müssen die
            // Epic-Felder führen, sonst hängt die Anzeige davon ab, ob die
            // Daten per Socket oder per Poll kamen.
            const membership = await readEpicMembership(session);
            const tasks = result.records.map(r => {
                const out = {};
                r.keys.forEach(k => { out[k] = r.get(k); });
                out.affectedNodes = (out.affectedNodes || []).filter(n => n?.id != null);
                const m = membership.get(out.taskId);
                out.epicId = m ? m.epicId : null;
                out.epicTitle = m ? m.epicTitle : null;
                out.seqIndex = m ? m.seqIndex : null;
                return out;
            });
            socket.emit('tasks:init', tasks, { db, requestId: data?.requestId });
        } catch (err) {
            socket.emit('tasks:error', { error: err.message });
        } finally {
            await session?.close();
        }
    });

    // Kanban: Idea Dump — client requests open ideas.
    // Takes the workspace from the request the same way 'tasks:request' does.
    // This is the path the board actually loads through, so nailing it to 'meta'
    // was what put meta's ideas on a target board.
    socket.on('ideas:request', async (data) => {
        let session;
        try {
            const db = subscribeWorkspace(socket, normalizeWorkspaceName(data?.db, activeDb));
            session = getTaskDriver(db).session();
            const result = await session.run(
                `MATCH (i:Idea) WHERE i.status = 'open'
                 RETURN i.taskId AS ideaId, i.content AS content,
                        i.status AS status, i.createdBy AS createdBy,
                        i.category AS intent, i.priority AS priority,
                        i.createdAt AS createdAt
                 ORDER BY i.createdAt`
            );
            const ideas = result.records.map(r => {
                const out = {};
                r.keys.forEach(k => { out[k] = r.get(k); });
                out.intent = intentToList(out.intent);
                out.priority = out.priority || '';
                return out;
            });
            socket.emit('ideas:init', ideas, { db, requestId: data?.requestId });
        } catch (err) {
            socket.emit('ideas:error', { error: err.message });
        } finally {
            await session?.close();
        }
    });

    // Kanban: client drags card to new column
    socket.on('task:update-status', async ({ taskId, status, comment, db } = {}) => {
        let session;
        try {
            if (!TASK_STATUSES.includes(status)) throw new Error('Invalid task status');
            session = getTaskDriver(db).session();
            await session.run(
                `MATCH (t:Task {taskId: $taskId})
                 SET t.status = $status, t.updatedAt = timestamp(),
                     t.lastComment = $comment, t.updatedBy = 'user'`,
                { taskId, status, comment: comment || null }
            );
            if (status === 'done') {
                await session.run(
                    `MATCH (n) WHERE n.lockGroup = $taskId AND n.locked = true
                     SET n.locked = null, n.lockedBy = null, n.lockGroup = null, n.lockExpires = null, n.lockOrigin = null`,
                    { taskId }
                );
            }
            emitWorkspace(io, session.workspace, 'task:status-changed', { taskId, status, comment, updatedBy: 'user' });
        } catch (err) {
            socket.emit('tasks:error', { error: err.message });
        } finally {
            await session?.close();
        }
    });

    // Graph detail level control: client requests a different level (1/2/3).
    // Reloads the graph and broadcasts to ALL clients so every open tab stays in sync.
    socket.on('graph:setLevel', async ({ level } = {}) => {
        const lvl = [1, 2, 3].includes(level) ? level : 1;
        currentLevel = lvl;
        try {
            cachedGraph = await loadGraphData(lvl);
            io.emit('graph:init', cachedGraph);
            io.emit('graph:nodeIds', cachedGraph.nodes.map(n => n.id));
            console.log(`[Bridge] graph level -> ${lvl} (${cachedGraph.nodes.length} nodes)`);
        } catch (err) {
            console.error('[Bridge] setLevel error:', err.message);
        }
    });

    socket.on('disconnect', () => {
        console.log(`[Bridge] Client disconnected: ${socket.id}`);
    });

    // Listeners are now registered — load and push the initial graph.
    // Always fetch fresh — otherwise stale locks linger in cache.
    (async () => {
        try {
            cachedGraph = await loadGraphData(currentLevel);
            socket.emit('graph:init', cachedGraph);
            socket.emit('graph:nodeIds', cachedGraph.nodes.map(n => n.id));
            // detailLevel gehört mit in die Statusmeldung: die Stufe lebt in der
            // Bridge, ein frisch geladenes Frontend startet aber auf seiner
            // eigenen Vorgabe. Ohne diesen Wert zeigte der Umschalter nach jedem
            // Reload 'Architecture', während tatsaechlich Stufe 3 geladen war.
            socket.emit('config:status', { activeDb: publicWorkspaceName(activeDb), limits, detailLevel: currentLevel });
        } catch (err) {
            console.error('[Bridge] Error loading graph:', err.message);
        }
    })();
});

// ── MCP Change Detector — polls the graph for task/lock changes ─────
// Catches changes made by MCP agents (create_task, complete_task, lock_subgraph, etc.)
// and pushes them to the browser in real-time via Socket.io.

// Its state (lastTaskSnapshot / lastLockCount / lastLockState) is declared near
// switchDb, which has to be able to clear it before this point in the file is
// reached. resetChangeDetectorSnapshots() there is the only writer besides this
// function.

async function pollForMcpChanges() {
    if (!io || io.engine.clientsCount === 0) return; // No clients = don't poll

    // The workspace on screen, not a fixed 'meta'. Nailed to meta, this pushed
    // meta's task and lock changes onto a board showing 'target' — so the board
    // both started with the wrong rows and got corrected towards the wrong ones
    // every two seconds. The snapshots below are per-workspace state; switchDb
    // clears them, or the first poll after a switch reports the entire other
    // database as "changed".
    const pollDb = activeDb;
    const session = getTaskDriver(pollDb).session();
    try {
        // Fetch current task states
        const taskResult = await session.run(
            `MATCH (t:Task)
             RETURN t.taskId AS taskId, t.status AS status, t.assignedTo AS assignedTo,
                    t.title AS title, t.priority AS priority, t.summary AS summary,
                    t.lastComment AS lastComment, t.updatedBy AS updatedBy`
        );
        if (activeDb !== pollDb) return;
        const currentTasks = {};
        for (const r of taskResult.records) {
            const id = r.get('taskId');
            currentTasks[id] = {
                taskId: id,
                status: r.get('status'),
                assignedTo: r.get('assignedTo'),
                title: r.get('title'),
                priority: r.get('priority'),
                summary: r.get('summary'),
                lastComment: r.get('lastComment'),
                updatedBy: r.get('updatedBy'),
            };
        }

        if (lastTaskSnapshot) {
            // Detect new tasks
            for (const [id, task] of Object.entries(currentTasks)) {
                if (!lastTaskSnapshot[id]) {
                    console.log(`[MCP-Sync] New task detected: ${id} "${task.title}"`);
                    emitWorkspace(io, session.workspace, 'task:created', task);
                }
            }
            // Detect status changes
            for (const [id, task] of Object.entries(currentTasks)) {
                const prev = lastTaskSnapshot[id];
                if (prev && (prev.status !== task.status || prev.assignedTo !== task.assignedTo)) {
                    console.log(`[MCP-Sync] Task ${id}: ${prev.status} → ${task.status} (by ${task.updatedBy || task.assignedTo || 'mcp'})`);
                    emitWorkspace(io, session.workspace, 'task:status-changed', task);
                }
            }
        }
        lastTaskSnapshot = currentTasks;

        // Diff-based lock tracking: emit only changed nodes
        const lockResult = await session.run(
            `MATCH (n) WHERE n.locked = true OR n.lockStatus IS NOT NULL
             RETURN elementId(n) AS id, n.name AS name, n.locked AS locked,
                    n.lockedBy AS lockedBy, n.lockStatus AS lockStatus,
                    n.lockGroup AS lockGroup`
        );
        if (activeDb !== pollDb) return;
        const currentLocks = new Map();
        for (const r of lockResult.records) {
            const id = String(r.get('id'));
            currentLocks.set(id, {
                id,
                name: r.get('name'),
                locked: r.get('locked'),
                lockedBy: r.get('lockedBy'),
                lockStatus: r.get('lockStatus'),
                lockGroup: r.get('lockGroup'),
            });
        }

        const changes = [];
        // Newly locked / changed
        for (const [id, cur] of currentLocks) {
            const prev = lastLockState.get(id);
            if (!prev || prev.locked !== cur.locked || prev.lockedBy !== cur.lockedBy || prev.lockStatus !== cur.lockStatus) {
                changes.push(cur);
            }
        }
        // Released (in prev but gone from current) → emit with locked=false
        for (const [id, prev] of lastLockState) {
            if (!currentLocks.has(id)) {
                changes.push({ id, name: prev.name, locked: false, lockedBy: null, lockStatus: null, lockGroup: null });
            }
        }

        if (changes.length > 0 && lastLockState.size > 0 || (lastLockState.size === 0 && currentLocks.size > 0)) {
            // Only emit after first snapshot is established
            if (lastLockCount !== null) {
                console.log(`[MCP-Sync] Lock diff: ${changes.length} node(s) changed`);
                // A lock is exactly what someone is watching in real time, so it
                // does not get to wait out the candidate cache's TTL. The cached
                // nodes are copies — patching cachedGraph below would not reach
                // them, and the next filter click would hand back yesterday's
                // lock colours.
                invalidateCandidateCache('locks changed');
                io.emit('nodes:lock-updated', changes);
                emitWorkspace(io, session.workspace, 'locks:changed', { count: currentLocks.size });
                // Update cachedGraph in place so new clients get fresh data
                if (cachedGraph) {
                    const byId = new Map(cachedGraph.nodes.map(n => [n.id, n]));
                    for (const c of changes) {
                        const n = byId.get(c.id);
                        if (n) {
                            n.locked = c.locked;
                            n.lockedBy = c.lockedBy;
                            n.lockStatus = c.lockStatus;
                        }
                    }
                }
            }
        }

        lastLockState = currentLocks;
        lastLockCount = currentLocks.size;

    } catch (err) {
        // Silent — don't crash the server for polling errors
        if (!err.message.includes('connection')) {
            console.error(`[MCP-Sync] Poll error: ${err.message}`);
        }
    } finally {
        await session.close();
    }
}

// Terminal WebSocket is set up by setupTerminalWebSocket() defined above (line ~171).
// Called here after httpServer and io are created.
if (WEB_SHELL_ENABLED) setupTerminalWebSocket(httpServer);
else console.log('[Bridge] Browser shell disabled (start with --web-shell to enable it for this run)');

// Serve the built production frontend: the bridge serves the SPA on
// the same port as the API, so there's no separate Vite server to run. Only
// active when a build exists (in dev, Vite serves on :5173 and this is skipped).
{
    const distPath = path.join(__dirname, '..', 'frontend', 'dist');
    const indexHtml = path.join(distPath, 'index.html');
    const fsLocal = require('fs');
    // dist verschwindet kurzzeitig während `vite build` (Agents bauen im
    // Hintergrund neu). Statt rohem ENOENT-Stacktrace: 503 mit Auto-Refresh,
    // bis der Build wieder da ist. Routen werden deshalb auch registriert,
    // wenn dist beim Start (noch) fehlt.
    // Bewusst wortlos: nur ein Spinner. Der erklärende Text hier ("Frontend wird
    // gerade neu gebaut") beantwortete eine Frage, die sich niemand gestellt hat,
    // und las sich wie ein Fehler. Ein Ladekreis sagt das Nötige — die Seite ist
    // gleich wieder da — und verschwindet von selbst, sobald der Build steht.
    const rebuildingPage = `<!doctype html><html lang="en"><head><meta charset="utf-8">
        <meta http-equiv="refresh" content="1"><title>CodeVis</title>
        <style>
          body{display:grid;place-items:center;height:100vh;margin:0;background:#f5f5f0}
          .s{width:34px;height:34px;border:3px solid #dcdcd6;border-top-color:#6b7394;
             border-radius:50%;animation:r .8s linear infinite}
          @keyframes r{to{transform:rotate(360deg)}}
          @media (prefers-color-scheme:dark){
            body{background:#0d1220}.s{border-color:#232a3d;border-top-color:#6b7394}}
        </style></head><body><div class="s"></div></body></html>`;
    const sendRebuilding = (res) => {
        if (!res.headersSent) res.status(503).set('Retry-After', '2').type('html').send(rebuildingPage);
    };
    app.use(express.static(distPath));
    // SPA fallback for everything that isn't an API/socket/terminal route.
    app.get(/^\/(?!api\/|socket\.io\/|terminal).*/, (req, res) => {
        if (!fsLocal.existsSync(indexHtml)) return sendRebuilding(res);
        res.sendFile(indexHtml, (err) => {
            // Race: index.html kann zwischen existsSync und sendFile verschwinden.
            if (err) sendRebuilding(res);
        });
    });
    console.log(fsLocal.existsSync(distPath)
        ? '[Bridge] Serving built frontend from frontend/dist'
        : '[Bridge] frontend/dist missing — serving rebuild placeholder until a build exists');
}

// Poll every 2 seconds — fast enough for live feel, light enough for the graph
const MCP_POLL_INTERVAL = 2000;
let mcpPollTimer = null;
let lockCleanupTimer = null;

// A port that is already taken is the single most likely startup failure — the
// dashboard for this project is usually just already running. Node's default
// for an unhandled 'error' event is a stack trace, which says nothing about
// that, so name the situation and the way out instead.
httpServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`[Bridge] Port ${PORT} is already in use.`);
        console.error(`[Bridge] A dashboard for this project is probably already running — open`);
        console.error(`[Bridge] http://localhost:${PORT} , or start this one elsewhere with --port <n>.`);
        console.error(`[Bridge] 'codevis info' shows what is listening.`);
    } else {
        console.error(`[Bridge] Could not start on port ${PORT}: ${err.message}`);
    }
    process.exit(1);
});

httpServer.listen(PORT, BRIDGE_HOST, () => {
    console.log(`[Bridge] WebSocket bridge running on http://${BRIDGE_HOST}:${PORT}`);
    console.log(`[Bridge] Active DB: ${publicWorkspaceName(activeDb)} | Limits: func=${limits.func}, module=${limits.module}, endpoint=${limits.endpoint}`);
    console.log(`[Bridge] MCP change detector: polling every ${MCP_POLL_INTERVAL / 1000}s`);
    console.log(`[Bridge] REST endpoints:`);
    console.log(`  POST /api/switch-db   — Switch between project_db/codevis_db`);
    console.log(`  POST /api/config      — Update node limits`);
    console.log(`  GET  /api/status      — Current configuration`);
    console.log(`  GET  /api/debug/paths — DFS call tree from a node`);
    console.log(`  GET  /api/expand      — Load children of a border node`);
    console.log(`  GET  /api/logs        — MCP tool log stream (filter: date, agent, taskId, op)`);
    console.log(`  GET  /api/logs/dates  — List available log dates`);
    console.log(`  GET  /?view=kanban    — Kanban Board (via frontend)`);

    mcpPollTimer = setInterval(pollForMcpChanges, MCP_POLL_INTERVAL);
    // Stale lock cleanup: runs independently of client connections (safety net).
    // Keep the handle so shutdown can clear it (see shutdown()).
    lockCleanupTimer = setInterval(runStaleLockCleanup, LOCK_CLEANUP_INTERVAL_MS);
    runStaleLockCleanup(); // Run once immediately on startup
    console.log(`[Bridge] Stale lock cleanup: running every ${LOCK_CLEANUP_INTERVAL_MS / 1000}s`);
});

// Graceful shutdown — clear timers, kill child processes, close DB drivers.
let shuttingDown = false;
async function shutdown(signal) {
    if (shuttingDown) return; // ignore a second signal while already tearing down
    shuttingDown = true;
    console.log(`\n[Bridge] Shutting down (${signal})...`);
    // Stop the periodic timers so nothing schedules new work mid-shutdown.
    if (mcpPollTimer) clearInterval(mcpPollTimer);
    if (lockCleanupTimer) clearInterval(lockCleanupTimer);
    // Kill child processes so they don't outlive the bridge: the pulse simulator
    // and any in-flight headless `claude -p` workers.
    try { stopPulse(); } catch (_) { /* not running */ }
    for (const child of activeWorkers) { try { child.kill('SIGKILL'); } catch (_) { /* already dead */ } }
    activeWorkers.clear();
    // Close DB drivers. `driver` is one of the entries in `drivers`, so iterating
    // the map covers the active one too (no double close).
    for (const d of Object.values(drivers)) { try { await d.close(); } catch (_) { /* ignore */ } }
    process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

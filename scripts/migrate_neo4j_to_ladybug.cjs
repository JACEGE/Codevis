/**
 * migrate_neo4j_to_ladybug.cjs
 * ----------------------------------------------------------------------------
 * One-shot migration of the CodeVis META graph from Neo4j -> Ladybug (KuzuDB
 * fork, embedded). PURE SINGLE-TABLE target:
 *   - EVERY node (code, workflow, runtime) goes into the one `CodeNode` table.
 *   - `label` = the primary semantic Neo4j label (Function/Class/Task/
 *     Knowledge/ASTNode/...). Multi-labels are folded into columns
 *     (astType, kind, isComponent, isHttpHandler, isRuntime).
 *   - `seq` = a globally-unique numeric id (0,1,2,...) assigned in ingest order.
 *   - `uid` = stable primary key; synthesized where the Neo4j node lacks one
 *     (Knowledge -> "knowledge:"+name, BraindumpSession -> "braindump:"+sessionId,
 *      User -> "user:"+name, anything else -> "<label>:_id_"+neo4jId).
 *   - EVERY relationship is FROM CodeNode TO CodeNode; endpoints matched by uid.
 *
 * Strategy
 *   1. Apply the fixed single-table schema (scripts/ladybug_schema.cjs).
 *   2. Stream all nodes from Neo4j. For each node: classify (primary label +
 *      folds), assign uid + seq, record neo4jElementId -> uid, insert one
 *      CodeNode row mapping every relevant property into the unified columns.
 *   3. Stream all relationships; look up FROM/TO uids via the map and insert
 *      into the matching rel table (always CodeNode -> CodeNode).
 *   4. Verify: per-label node counts (Neo4j primary label vs ladybug n.label)
 *      and per-type rel counts, as a diff; seq uniqueness; clean reopen.
 *
 * Bulk-insert API (verified, @ladybugdb/core 0.17.x, Node 18):
 *   const ps = await conn.prepare(cypherWithDollarParams);
 *   await conn.execute(ps, { paramName: value });   // nulls + STRING[] OK
 * We cache one PreparedStatement per (node-insert | rel-table) and reuse it for
 * every row -> this is the fast path and the pattern the driver layer should use.
 * ----------------------------------------------------------------------------
 */

"use strict";

const path = require("path");
const fs = require("fs");
// `neo4j-driver` is no longer a CodeVis dependency — Ladybug is the only
// backend. This one-shot migration is the sole remaining reader of an external
// Neo4j, so it loads the driver lazily and says what to install if it is
// missing, rather than making every install carry a package nothing else uses.
let neo4j;
try {
  neo4j = require("neo4j-driver");
} catch {
  console.error(
    "This migration needs the Neo4j driver, which CodeVis no longer depends on.\n" +
    "Install it just for this run:  npm install --no-save neo4j-driver"
  );
  process.exit(1);
}
const lbug = require("@ladybugdb/core");
const schema = require("./ladybug_schema.cjs");

// ----------------------------------------------------------------------------
// Config
// ----------------------------------------------------------------------------
// The SOURCE connection comes from the environment only. It used to be read
// from codevis.config.cjs workspaces.meta, but that block no longer describes a
// Neo4j server: its `dbUri` is the embedded DB's synthetic address and its
// credentials are unused. Taking the source from there would silently point the
// migration at the destination.
const NEO4J_URI = process.env.NEO4J_META_URI || "bolt://localhost:7688";
const NEO4J_USER = process.env.NEO4J_META_USER || "neo4j";
const NEO4J_PASS = process.env.NEO4J_META_PASS;
if (!NEO4J_PASS) {
  console.error("[migrate] No Neo4j password — set NEO4J_META_PASS (source Neo4j to migrate FROM)");
  process.exit(1);
}

const LBUG_DIR = path.resolve(__dirname, "../data");
const LBUG_PATH = path.join(LBUG_DIR, "ladybug-meta");

// ----------------------------------------------------------------------------
// Label routing — in the single-table model EVERY node becomes a CodeNode.
// We only need the *primary semantic label* (stored in CodeNode.label) plus
// the multi-label folds. CODE_LABELS drives primary-label selection for nodes
// that carry several structural code labels.
// ----------------------------------------------------------------------------
const CODE_LABELS = new Set([
  "File", "Function", "Class", "Component", "State", "Variable",
  "ControlFlow", "ASTNode", "Effect", "DOMElement", "Endpoint", "Module",
  "Topic", "ImportedSymbol", "ExportedSymbol", "Alias", "Context",
  "ExternalBase", "HTTPHandler",
  // statement labels
  "ReturnStatement", "ThrowStatement", "BreakStatement", "ContinueStatement",
  // ControlFlow subtypes (in case they ever appear primary)
  "IfStatement", "ForLoop", "WhileLoop", "SwitchStatement", "TryStatement",
]);

// Workflow / runtime labels that used to map to their own tables. They now all
// land in CodeNode; this set just marks them as "primary takes precedence".
const WORKFLOW_RUNTIME_LABELS = new Set([
  "Task", "Knowledge", "BraindumpSession",
  "User", "UserEvent", "RouteEvent", "VisibleComponent", "LogEntry",
]);

/**
 * Determine the primary semantic label + folded-in secondary attributes.
 * Neo4j `labels` is an array; we pick the structural primary and fold the rest.
 * Result `.primary` becomes CodeNode.label.
 */
function classifyNode(labels) {
  const set = new Set(labels);

  // Workflow / runtime labels take precedence as the primary label.
  for (const l of labels) {
    if (WORKFLOW_RUNTIME_LABELS.has(l)) {
      return { primary: l, isComponent: false, isHttpHandler: false, isRuntime: false, astType: null };
    }
  }

  // Code node. Decide primary + folds.
  let primary = null;
  let astType = null;
  const isRuntime = set.has("RuntimeDOM");
  const isComponent = set.has("Component");
  const isHttpHandler = set.has("HTTPHandler");

  if (set.has("ASTNode")) {
    primary = "ASTNode";
    astType = labels.find((l) => l !== "ASTNode") || null;
  } else if (set.has("ControlFlow")) {
    primary = "ControlFlow";
    astType = null; // ControlFlow subtype lives in `kind` prop already
  } else if (set.has("DOMElement")) {
    primary = "DOMElement";
  } else {
    // first label that is a recognized code label (excluding the fold labels)
    primary =
      labels.find((l) => CODE_LABELS.has(l) && !["Component", "HTTPHandler", "RuntimeDOM"].includes(l)) ||
      labels[0] ||
      "Unknown";
  }

  return { primary, isComponent, isHttpHandler, isRuntime, astType };
}

// ----------------------------------------------------------------------------
// Neo4j value coercion -> plain JS for Ladybug params.
// neo4j Integer -> JS number (safe for our ranges); null preserved; arrays kept.
// ----------------------------------------------------------------------------
function coerce(v) {
  if (v === null || v === undefined) return null;
  if (neo4j.isInt(v)) return v.toNumber();
  if (Array.isArray(v)) return v.map(coerce);
  if (typeof v === "object" && v !== null && "low" in v && "high" in v) {
    // defensive: integer-like object
    return neo4j.int(v).toNumber();
  }
  return v;
}

// Helpers to read a coerced prop with a default.
function pStr(props, k) { const v = coerce(props[k]); return v === undefined ? null : v; }
function pInt(props, k) { const v = coerce(props[k]); return v === null || v === undefined ? null : (typeof v === "number" ? v : Number(v)); }
function pBool(props, k) {
  const v = coerce(props[k]);
  if (v === null || v === undefined) return null;
  return Boolean(v);
}
function pArr(props, k) {
  const v = coerce(props[k]);
  if (v === null || v === undefined) return [];
  return Array.isArray(v) ? v.map((x) => (x === null || x === undefined ? "" : String(x))) : [String(v)];
}

// ----------------------------------------------------------------------------
// CodeNode column list + param builder. Column order defines the prepared
// INSERT column list. This is the UNION of all former tables' columns, so a
// single builder handles code, workflow (Task/Knowledge/BraindumpSession) and
// runtime (User/UserEvent/RouteEvent/VisibleComponent/LogEntry) nodes; columns
// that do not apply to a given node are simply null.
// ----------------------------------------------------------------------------

const CODENODE_COLUMNS = [
  "uid", "seq", "label", "name", "file", "path",
  "startLine", "endLine", "col", "signature", "bodySnippet", "params",
  "return_type", "acceptsProps", "preview", "value", "scope", "elementId",
  "kind", "astType", "isComponent", "isHttpHandler", "isRuntime",
  "hookType", "deps",
  "tagName", "testId", "eventHandlers", "className", "xpath", "textSnippet", "snapshotAt",
  "localName", "originalName", "sourceFile", "publicName", "reexportFrom", "enclosingFunc", "wrappedBy",
  "url", "method",
  "language", "lastParsed", "updatedAt", "lastSeenMtime",
  "ipv6", "ipv6mask",
  "nodeId", "createdAt",
  "renamedFrom", "renamedAt", "movedFrom", "movedAt",
  "locked", "lockedBy", "lockGroup", "lockStatus", "lockExpires", "lockOrigin", "editInProgress", "editInProgressSince",
  "pendingRelease", "releaseSummary", "releaseRequestedAt", "releaseRequestedBy",
  "releasedAt", "releasedBy", "releaseRejectedReason", "releaseRejectedAt",
  "lastError", "lastErrorStack", "lastErrorTimestamp",
  "removedFromDisk", "removedBy", "removedAt",
  // ---- Task ----
  "taskId", "title", "description", "workInstructions", "status", "priority",
  "category", "createdBy", "assignedTo", "completedAt", "summary", "claimedAt",
  "lastComment", "updatedBy", "comments", "wave", "waveStatus",
  // ---- Knowledge ----
  "content",
  // ---- BraindumpSession ----
  "sessionId", "text", "ts",
  // ---- UserEvent ----
  "eventType", "timestamp", "targetTestId", "targetTagName", "componentName",
  "componentNameLeaf", "executionPathHex", "executionPathUids",
  "executionPathNames", "executionPathNamesUser",
  // ---- RouteEvent ----
  "fromRoute", "toRoute",
  // ---- VisibleComponent ----
  "isVisible", "boundingBox", "capturedAt",
  // ---- LogEntry ----
  "agent", "operation", "result", "durationMs", "error",
];

/**
 * Build the full CodeNode param object for one Neo4j node.
 * @param uid  stable uid (existing or synthesized)
 * @param seq  globally-unique numeric id
 * @param cls  result of classifyNode()
 * @param props Neo4j node properties
 */
function codeNodeParams(uid, seq, cls, props) {
  return {
    uid,
    seq,
    label: cls.primary,
    name: pStr(props, "name"),
    file: pStr(props, "file"),
    path: pStr(props, "path"),
    startLine: pInt(props, "startLine"),
    endLine: pInt(props, "endLine"),
    col: pInt(props, "col"),
    signature: pStr(props, "signature"),
    bodySnippet: pStr(props, "bodySnippet"),
    params: pStr(props, "params"),
    return_type: pStr(props, "return_type"),
    acceptsProps: props.acceptsProps === undefined || props.acceptsProps === null ? null : String(coerce(props.acceptsProps)),
    preview: pStr(props, "preview"),
    value: pStr(props, "value"),
    scope: pStr(props, "scope"),
    elementId: pStr(props, "elementId"),
    kind: pStr(props, "kind"),
    astType: cls.astType,
    isComponent: cls.isComponent,
    isHttpHandler: cls.isHttpHandler,
    isRuntime: cls.isRuntime,
    hookType: pStr(props, "hookType"),
    deps: pArr(props, "deps"),
    tagName: pStr(props, "tagName"),
    testId: pStr(props, "testId"),
    eventHandlers: pArr(props, "eventHandlers"),
    className: pStr(props, "className"),
    xpath: pStr(props, "xpath"),
    textSnippet: pStr(props, "textSnippet"),
    snapshotAt: pInt(props, "snapshotAt"),
    localName: pStr(props, "localName"),
    originalName: pStr(props, "originalName"),
    sourceFile: pStr(props, "sourceFile"),
    publicName: pStr(props, "publicName"),
    reexportFrom: pStr(props, "reexportFrom"),
    enclosingFunc: pStr(props, "enclosingFunc"),
    wrappedBy: pStr(props, "wrappedBy"),
    url: pStr(props, "url"),
    method: pStr(props, "method"),
    language: pStr(props, "language"),
    lastParsed: pInt(props, "lastParsed"),
    updatedAt: pInt(props, "updatedAt"),
    lastSeenMtime: pInt(props, "lastSeenMtime"),
    ipv6: pStr(props, "ipv6"),
    ipv6mask: pInt(props, "ipv6mask"),
    nodeId: pStr(props, "nodeId"),
    createdAt: pInt(props, "createdAt"),
    renamedFrom: pStr(props, "renamedFrom"),
    renamedAt: pInt(props, "renamedAt"),
    movedFrom: pStr(props, "movedFrom"),
    movedAt: pInt(props, "movedAt"),
    locked: pBool(props, "locked"),
    lockedBy: pStr(props, "lockedBy"),
    lockGroup: pStr(props, "lockGroup"),
    lockStatus: pStr(props, "lockStatus"),
    lockExpires: pInt(props, "lockExpires"),
    lockOrigin: pStr(props, "lockOrigin"),
    editInProgress: pBool(props, "editInProgress"),
    editInProgressSince: pInt(props, "editInProgressSince"),
    pendingRelease: pBool(props, "pendingRelease"),
    releaseSummary: pStr(props, "releaseSummary"),
    releaseRequestedAt: pInt(props, "releaseRequestedAt"),
    releaseRequestedBy: pStr(props, "releaseRequestedBy"),
    releasedAt: pInt(props, "releasedAt"),
    releasedBy: pStr(props, "releasedBy"),
    releaseRejectedReason: pStr(props, "releaseRejectedReason"),
    releaseRejectedAt: pInt(props, "releaseRejectedAt"),
    lastError: pStr(props, "lastError"),
    lastErrorStack: pStr(props, "lastErrorStack"),
    lastErrorTimestamp: pInt(props, "lastErrorTimestamp"),
    removedFromDisk: pBool(props, "removedFromDisk"),
    removedBy: pStr(props, "removedBy"),
    removedAt: pInt(props, "removedAt"),

    // ---- Task (folded in) ----
    taskId: pStr(props, "taskId"),
    title: pStr(props, "title"),
    description: pStr(props, "description"),
    workInstructions: pStr(props, "workInstructions"),
    status: pStr(props, "status"),
    priority: pStr(props, "priority"),
    category: pStr(props, "category"),
    createdBy: pStr(props, "createdBy"),
    assignedTo: pStr(props, "assignedTo"),
    completedAt: pInt(props, "completedAt"),
    summary: pStr(props, "summary"),
    claimedAt: pInt(props, "claimedAt"),
    lastComment: pStr(props, "lastComment"),
    updatedBy: pStr(props, "updatedBy"),
    comments: pArr(props, "comments"),
    wave: props.wave === undefined || props.wave === null ? null : String(coerce(props.wave)),
    waveStatus: pStr(props, "waveStatus"),

    // ---- Knowledge (folded in) ----
    content: pStr(props, "content"),

    // ---- BraindumpSession (folded in) ----
    sessionId: pStr(props, "sessionId"),
    text: pStr(props, "text"),
    ts: pInt(props, "ts"),

    // ---- UserEvent (folded in) ----
    eventType: pStr(props, "eventType"),
    timestamp: pInt(props, "timestamp"),
    targetTestId: pStr(props, "targetTestId"),
    targetTagName: pStr(props, "targetTagName"),
    componentName: pStr(props, "componentName"),
    componentNameLeaf: pStr(props, "componentNameLeaf"),
    executionPathHex: pStr(props, "executionPathHex"),
    executionPathUids: pArr(props, "executionPathUids"),
    executionPathNames: pArr(props, "executionPathNames"),
    executionPathNamesUser: pArr(props, "executionPathNamesUser"),

    // ---- RouteEvent (folded in) ----
    fromRoute: pStr(props, "fromRoute"),
    toRoute: pStr(props, "toRoute"),

    // ---- VisibleComponent (folded in) ----
    isVisible: pBool(props, "isVisible"),
    boundingBox: props.boundingBox === undefined || props.boundingBox === null
      ? null
      : (typeof props.boundingBox === "string" ? props.boundingBox : JSON.stringify(coerce(props.boundingBox))),
    capturedAt: pInt(props, "capturedAt"),

    // ---- LogEntry (folded in) ----
    agent: pStr(props, "agent"),
    operation: pStr(props, "operation"),
    result: pStr(props, "result"),
    durationMs: pInt(props, "durationMs"),
    error: pStr(props, "error"),
  };
}

// Columns that are reserved keywords -> must be backtick-quoted in Cypher.
const RESERVED_COLS = new Set(["order"]);
function quoteCol(c) {
  return RESERVED_COLS.has(c) ? "`" + c + "`" : c;
}

/** Build the single parameterized CREATE for CodeNode from its column list. */
function buildNodeInsert(columns) {
  const assigns = columns.map((c) => `${quoteCol(c)}: $${c}`).join(", ");
  return `CREATE (:CodeNode {${assigns}})`;
}

// ----------------------------------------------------------------------------
// uid synthesis — every node MUST get a unique non-null uid.
//   Knowledge        -> "knowledge:" + name
//   BraindumpSession -> "braindump:" + sessionId
//   User             -> "user:" + name
//   Task             -> "task:" + taskId
//   anything else lacking uid -> "<primaryLabel>:_id_" + neo4jId
//
// `naturalKeyUid` returns a uid derived from the node's own natural key when one
// exists. For these labels the natural-key uid is AUTHORITATIVE and overrides
// any `uid` property: in the live meta DB all 136 Task nodes share a single junk
// `uid` value (and Knowledge/BraindumpSession/User have their own real keys), so
// trusting `props.uid` there would collapse 136 tasks into 1 on the PK. taskId
// (and name/sessionId) are unique, so we key on those instead.
// ----------------------------------------------------------------------------
function naturalKeyUid(labels, props) {
  if (labels.includes("Knowledge") && props.name) return "knowledge:" + props.name;
  if (labels.includes("BraindumpSession") && props.sessionId) return "braindump:" + props.sessionId;
  if (labels.includes("Task") && props.taskId) return "task:" + props.taskId;
  if (labels.includes("User")) return "user:" + (props.name || "DefaultUser");
  return null;
}

function synthUid(labels, props, neoId, primary) {
  const nk = naturalKeyUid(labels, props);
  if (nk) return nk;
  // generic deterministic fallback keyed by neo4j internal id
  return `${primary || labels[0] || "Node"}:_id_${neoId}`;
}

// ----------------------------------------------------------------------------
// Main migration
// ----------------------------------------------------------------------------
async function main() {
  // Fresh DB dir.
  if (!fs.existsSync(LBUG_DIR)) fs.mkdirSync(LBUG_DIR, { recursive: true });
  // Wipe any previous DB so counts are clean.
  for (const suffix of ["", ".wal", ".shadow", ".lock"]) {
    const p = LBUG_PATH + suffix;
    if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
  }

  console.log(`[migrate] Neo4j  : ${NEO4J_URI}`);
  console.log(`[migrate] Ladybug: ${LBUG_PATH}`);

  const driver = neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USER, NEO4J_PASS));
  const db = new lbug.Database(LBUG_PATH);
  if (db.init) await db.init();
  const conn = new lbug.Connection(db);
  if (conn.init) await conn.init();

  // 1) schema
  await schema.applySchema(conn);

  // Prepared-statement cache.
  const psCache = new Map();
  async function getPS(key, sql) {
    if (!psCache.has(key)) psCache.set(key, await conn.prepare(sql));
    return psCache.get(key);
  }

  // ----- 2) NODES ----------------------------------------------------------
  const idToUid = new Map();       // neo4j elementId -> migration uid
  const neoByPrimary = new Map();  // primary label -> count (routing source-of-truth)
  let lbugNodeInserted = 0;        // rows actually inserted into CodeNode
  let seqCounter = 0;              // global unique numeric id

  // One prepared statement for every node — single-table.
  const nodeSql = buildNodeInsert(CODENODE_COLUMNS);
  const nodePS = await getPS("N:CodeNode", nodeSql);

  const session = driver.session({ defaultAccessMode: neo4j.session.READ });
  const PAGE = 2000;
  let skip = 0;
  let totalNodes = 0;

  // Pull total for progress.
  {
    const r = await session.run("MATCH (n) RETURN count(n) AS c");
    totalNodes = r.records[0].get("c").toNumber();
  }
  console.log(`[migrate] migrating ${totalNodes} nodes...`);

  while (true) {
    const res = await session.run(
      "MATCH (n) RETURN elementId(n) AS eid, labels(n) AS labels, properties(n) AS props " +
        "ORDER BY elementId(n) SKIP $skip LIMIT $limit",
      { skip: neo4j.int(skip), limit: neo4j.int(PAGE) }
    );
    if (res.records.length === 0) break;

    for (const rec of res.records) {
      const eid = rec.get("eid");
      const labels = rec.get("labels");
      const props = rec.get("props");

      const cls = classifyNode(labels);
      // Prefer a reliable natural-key uid (Task/Knowledge/BraindumpSession/User)
      // over the raw `uid` property, because in this DB Task.uid is a shared junk
      // value. For all other nodes the real `uid` property is authoritative; only
      // truly uid-less nodes fall back to the deterministic neo4j-id synthesis.
      const uid =
        naturalKeyUid(labels, props) ||
        (props.uid && String(props.uid)) ||
        synthUid(labels, props, eid, cls.primary);
      const seq = seqCounter++;

      idToUid.set(eid, uid);

      // routing count keyed by primary semantic label (mirrors ladybug n.label)
      neoByPrimary.set(cls.primary, (neoByPrimary.get(cls.primary) || 0) + 1);

      const params = codeNodeParams(uid, seq, cls, props);
      try {
        await conn.execute(nodePS, params);
        lbugNodeInserted++;
      } catch (e) {
        // Duplicate PK (e.g. two nodes sharing a synthesized/real uid) — skip but log.
        if (/primary key|already exists|duplicat/i.test(e.message)) {
          console.warn(`[migrate] dup uid skipped: ${uid} (${cls.primary}) :: ${e.message.split("\n")[0]}`);
        } else {
          throw e;
        }
      }
    }
    skip += res.records.length;
    process.stdout.write(`\r[migrate] nodes ${skip}/${totalNodes}`);
  }
  process.stdout.write("\n");
  console.log(`[migrate] inserted ${lbugNodeInserted} CodeNode rows (seq 0..${seqCounter - 1})`);

  // ----- 3) RELATIONSHIPS --------------------------------------------------
  // Single-table: every rel is CodeNode -> CodeNode. Endpoints matched by uid.
  const neoRelCounts = new Map();
  const lbugRelInserted = new Map();
  let relSkip = 0;
  let totalRels = 0;
  {
    const r = await session.run("MATCH ()-[r]->() RETURN count(r) AS c");
    totalRels = r.records[0].get("c").toNumber();
  }
  console.log(`[migrate] migrating ${totalRels} relationships...`);

  while (true) {
    const res = await session.run(
      "MATCH (a)-[r]->(b) RETURN elementId(a) AS aid, elementId(b) AS bid, type(r) AS t, properties(r) AS props " +
        "ORDER BY elementId(r) SKIP $skip LIMIT $limit",
      { skip: neo4j.int(relSkip), limit: neo4j.int(PAGE) }
    );
    if (res.records.length === 0) break;

    for (const rec of res.records) {
      const aid = rec.get("aid");
      const bid = rec.get("bid");
      const type = rec.get("t");
      const props = rec.get("props");

      neoRelCounts.set(type, (neoRelCounts.get(type) || 0) + 1);

      const aUid = idToUid.get(aid);
      const bUid = idToUid.get(bid);
      if (!aUid || !bUid) {
        console.warn(`[migrate] rel ${type}: missing endpoint uid (a=${aid} b=${bid}) — skipped`);
        continue;
      }

      const spec = schema.REL_SPECS[type];
      if (!spec) {
        console.warn(`[migrate] rel type ${type} not in schema — skipped`);
        continue;
      }

      // Target column list (as declared in schema). Some props are renamed
      // (e.g. Neo4j `order` -> Kuzu `stepOrder`) to dodge reserved keywords.
      const targetCols = spec.props
        ? spec.props.split(",").map((s) => s.trim().split(/\s+/)[0].replace(/`/g, ""))
        : [];
      const rename = spec.renamedProps || {};
      const srcForTarget = {}; // targetCol -> neo4j source prop name
      for (const tc of targetCols) {
        const src = Object.keys(rename).find((k) => rename[k] === tc);
        srcForTarget[tc] = src || tc;
      }

      const setClause = targetCols.length
        ? " {" + targetCols.map((c) => `${c}: $${c}`).join(", ") + "}"
        : "";
      // Single-table: both endpoints are CodeNode, matched by uid.
      const sql =
        `MATCH (a:CodeNode {uid: $aUid}), (b:CodeNode {uid: $bUid}) ` +
        `CREATE (a)-[:${type}${setClause}]->(b)`;
      const ps = await getPS(`R:${type}`, sql);

      const params = { aUid, bUid };
      for (const c of targetCols) {
        const srcKey = srcForTarget[c];
        const v = coerce(props[srcKey]);
        if (c === "props" || c === "spreadVars") params[c] = pArr(props, srcKey);
        else if (["count", "stepOrder", "lastSeen", "firstSeen", "lastClicked"].includes(c)) params[c] = v === null ? null : Number(v);
        else if (c === "hasSpread") params[c] = v === null ? null : Boolean(v);
        else params[c] = v === undefined ? null : v;
      }

      try {
        await conn.execute(ps, params);
        lbugRelInserted.set(type, (lbugRelInserted.get(type) || 0) + 1);
      } catch (e) {
        console.warn(`[migrate] rel ${type} insert failed: ${e.message.split("\n")[0]}`);
      }
    }
    relSkip += res.records.length;
    process.stdout.write(`\r[migrate] rels ${relSkip}/${totalRels}`);
  }
  process.stdout.write("\n");

  await session.close();

  // ----- 4) VERIFICATION ---------------------------------------------------
  console.log("\n========== VERIFICATION ==========");

  // Neo4j node counts by primary semantic label (same classify routing).
  const verifySession = driver.session({ defaultAccessMode: neo4j.session.READ });
  const neoByLabel = new Map();
  {
    const r = await verifySession.run("MATCH (n) RETURN labels(n) AS labels, count(n) AS c");
    for (const rec of r.records) {
      const cls = classifyNode(rec.get("labels"));
      neoByLabel.set(cls.primary, (neoByLabel.get(cls.primary) || 0) + rec.get("c").toNumber());
    }
  }

  // Ladybug node counts grouped by n.label (single table).
  const lbugByLabel = new Map();
  {
    const r = await conn.query("MATCH (n:CodeNode) RETURN n.label AS label, count(n) AS c");
    for (const row of await r.getAll()) {
      lbugByLabel.set(row.label, Number(row.c));
    }
  }

  console.log("\n--- NODES (Neo4j primary label vs Ladybug n.label) ---");
  const allNodeKeys = new Set([...neoByLabel.keys(), ...lbugByLabel.keys()]);
  let nodeMismatch = 0;
  console.log("label".padEnd(28) + "neo4j".padStart(8) + "ladybug".padStart(10) + "  diff");
  for (const k of [...allNodeKeys].sort()) {
    const a = neoByLabel.get(k) || 0;
    const b = lbugByLabel.get(k) || 0;
    const d = b - a;
    if (d !== 0) nodeMismatch++;
    console.log(String(k).padEnd(28) + String(a).padStart(8) + String(b).padStart(10) + "  " + (d === 0 ? "ok" : `MISMATCH ${d > 0 ? "+" : ""}${d}`));
  }

  console.log("\n--- RELATIONSHIPS (Neo4j vs Ladybug) ---");
  const lbugRelCounts = new Map();
  for (const type of Object.keys(schema.REL_SPECS)) {
    const r = await conn.query(`MATCH ()-[e:${type}]->() RETURN count(e) AS c`);
    const rows = await r.getAll();
    lbugRelCounts.set(type, Number(rows[0].c));
  }
  const allRelKeys = new Set([...neoRelCounts.keys(), ...lbugRelCounts.keys()]);
  let relMismatch = 0;
  console.log("relType".padEnd(24) + "neo4j".padStart(8) + "ladybug".padStart(10) + "  diff");
  for (const k of [...allRelKeys].sort()) {
    const a = neoRelCounts.get(k) || 0;
    const b = lbugRelCounts.get(k) || 0;
    const d = b - a;
    if (d !== 0) relMismatch++;
    console.log(k.padEnd(24) + String(a).padStart(8) + String(b).padStart(10) + "  " + (d === 0 ? "ok" : `MISMATCH ${d > 0 ? "+" : ""}${d}`));
  }

  // Critical guarantees.
  const taskNeo = neoByLabel.get("Task") || 0;
  const taskLbug = lbugByLabel.get("Task") || 0;
  const knowNeo = neoByLabel.get("Knowledge") || 0;
  const knowLbug = lbugByLabel.get("Knowledge") || 0;
  console.log("\n--- CRITICAL ---");
  console.log(`Task     : neo4j=${taskNeo} ladybug=${taskLbug} -> ${taskNeo === taskLbug ? "MATCH" : "MISMATCH"}`);
  console.log(`Knowledge: neo4j=${knowNeo} ladybug=${knowLbug} -> ${knowNeo === knowLbug ? "MATCH" : "MISMATCH"}`);

  const nTotalNeo = [...neoByLabel.values()].reduce((a, b) => a + b, 0);
  const nTotalLbug = [...lbugByLabel.values()].reduce((a, b) => a + b, 0);
  const rTotalNeo = [...neoRelCounts.values()].reduce((a, b) => a + b, 0);
  const rTotalLbug = [...lbugRelCounts.values()].reduce((a, b) => a + b, 0);
  console.log(`\nNODE TOTAL : neo4j=${nTotalNeo} ladybug=${nTotalLbug} (${nodeMismatch} label mismatches)`);
  console.log(`REL  TOTAL : neo4j=${rTotalNeo} ladybug=${rTotalLbug} (${relMismatch} type mismatches)`);

  // seq uniqueness: total rows, distinct seq, and null seq must all align.
  {
    const r = await conn.query(
      "MATCH (n:CodeNode) RETURN count(n) AS total, count(DISTINCT n.seq) AS distinctSeq, " +
      "min(n.seq) AS minSeq, max(n.seq) AS maxSeq"
    );
    const row = (await r.getAll())[0];
    const total = Number(row.total);
    const distinctSeq = Number(row.distinctSeq);
    console.log(
      `\nSEQ        : total=${total} distinct=${distinctSeq} min=${Number(row.minSeq)} max=${Number(row.maxSeq)} -> ` +
      (total === distinctSeq ? "UNIQUE" : "NOT UNIQUE")
    );
  }

  await verifySession.close();
  await driver.close();
  if (conn.close) await conn.close();
  // WICHTIG: db.close() triggert den WAL-Checkpoint (WAL -> Hauptdatei).
  // Ohne das bleibt eine dirty .wal liegen und das nächste Öffnen wirft eine
  // WAL-Assertion. Das war die Ursache der korrupten ersten Migration.
  if (db.close) await db.close();

  console.log("\n[migrate] DONE.");
}

main().catch((e) => {
  console.error("\n[migrate] FATAL:", e.stack || e.message);
  process.exit(1);
});

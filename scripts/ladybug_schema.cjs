/**
 * ladybug_schema.cjs
 * ----------------------------------------------------------------------------
 * Fixed-schema DDL for the CodeVis graph on Ladybug (KuzuDB fork, embedded).
 *
 * Architecture: PURE SINGLE-TABLE model.
 *   - ONE node table `CodeNode` holds EVERY node — parsed code/graph nodes
 *     (Function, Class, Component, ... ASTNode, File, Endpoint, ...) AND the
 *     workflow/runtime nodes that used to live in their own tables (Task,
 *     Knowledge, BraindumpSession, User, UserEvent, RouteEvent,
 *     VisibleComponent, LogEntry).
 *   - The semantic Neo4j primary label is stored in the `label` STRING column.
 *     `label(n)` in Kuzu returns the TABLE name (always "CodeNode"), so it
 *     cannot distinguish Function from Variable — hence the dedicated `label`
 *     column.
 *   - Every column from every former table is present here (nullable). A column
 *     missing on a given row is simply NULL, so untyped property predicates
 *     (`MATCH (n) WHERE n.foo = ...`) never hit a non-existent column.
 *   - Multi-labels are folded into columns:
 *        ControlFlow subtype   -> `kind`        (already a real prop)
 *        ASTNode subtype       -> `astType`
 *        :Component            -> `isComponent`  BOOLEAN
 *        :HTTPHandler          -> `isHttpHandler` BOOLEAN
 *        DOMElement:RuntimeDOM -> `isRuntime`     BOOLEAN
 *
 *   WHY single-table: Kuzu/Ladybug does NOT support the `WHERE n:Label`
 *   predicate (parser error), which the app uses heavily (e.g.
 *   `WHERE n:Function OR n:Task`). Untyped `MATCH (n)` spans all node tables,
 *   and `MATCH (n:CodeNode) WHERE n.label='Function'` works. With a single
 *   table, query translation is uniform:
 *        n:Label    -> n.label = 'Label'
 *        labels(n)  -> [n.label]
 *     and untyped property predicates can never reference a missing column.
 *
 *   - `uid` is the stable primary key used to join edges.
 *   - `seq` is a globally-unique INT64 (0,1,2,...) assigned at migration time —
 *     the numeric node id the driver/frontend uses in place of Neo4j `id(n)`.
 *
 *   - Rel tables: one table per Neo4j rel type, ALL declared
 *     `FROM CodeNode TO CodeNode` (every endpoint now lives in CodeNode).
 *     Property columns are preserved.
 *
 * Ladybug API used (verified, v0.17.x, Node 18 — see scripts/_lbug_smoke.cjs):
 *   const lbug = require('@ladybugdb/core');
 *   const db = new lbug.Database(path);  await db.init?.();
 *   const conn = new lbug.Connection(db); await conn.init?.();
 *   await conn.query(sql);                       // DDL + ad-hoc
 *   const ps = await conn.prepare(sql);          // PreparedStatement
 *   await conn.execute(ps, { param: value });    // bulk insert w/ params
 *   const rows = await res.getAll();
 *   await db.close();   // MUST run at end -> checkpoints the WAL into the
 *                       // main file; otherwise a dirty .wal triggers a WAL
 *                       // assertion on the next open.
 *
 * Notes on types:
 *   - All time values are epoch-millis INT64 (Kuzu has no timestamp()).
 *   - Every column is nullable except the PRIMARY KEY(uid) (Kuzu columns are
 *     nullable by default unless they are the primary key).
 *   - String arrays -> STRING[].
 *   - On a name collision between former tables we keep one column; on a type
 *     conflict we prefer the looser type (STRING). (In practice the only
 *     overlaps — name, file, status, category, createdAt, updatedAt, taskId,
 *     timestamp, textSnippet — all already agree in type.)
 * ----------------------------------------------------------------------------
 */

"use strict";

// ============================================================================
// NODE TABLE — the one and only node table.
// Columns are the UNION of every column that previously lived on CodeNode,
// Task, Knowledge, BraindumpSession, User, UserEvent, RouteEvent,
// VisibleComponent and LogEntry. Grouped by origin for readability.
// ============================================================================

const NODE_TABLES = [
  `CREATE NODE TABLE CodeNode(
      uid STRING,
      seq INT64,               -- globally-unique numeric id (0,1,2,...), assigned at migration
      label STRING,            -- original Neo4j primary semantic label (Function, File, Task, Knowledge, ASTNode, ...)

      -- ===== shared / code identity =====
      name STRING,
      file STRING,
      path STRING,             -- File nodes are keyed on path in Neo4j

      -- ===== position / source (code nodes) =====
      startLine INT64,
      endLine INT64,
      col INT64,
      signature STRING,
      -- Die besitzende Klasse einer Methode; leerer String fuer freie
      -- Funktionen. Teil des Schluessels, unter dem ein Function-Knoten
      -- gemergt wird: ohne sie fielen ein Java-Interface und seine drei
      -- Implementierungen in derselben Datei auf einen einzigen Knoten
      -- zusammen. Leerer String und nicht NULL, weil MERGE NULL nie als gleich
      -- vergleicht und jeder Aufruf sonst einen neuen Knoten anlegte.
      owner STRING,
      bodySnippet STRING,
      params STRING,
      return_type STRING,
      acceptsProps STRING[],   -- list of destructured prop names (parseDestructuredProps → array)
      decorators STRING[],     -- Python decorators on a function/class (@property, @app.route, ...)
      callSites INT64,         -- File: call sites found by the parser
      callsResolved INT64,     -- File: how many of those resolved to a function in the graph
      internalCallSites INT64, -- sites whose target could be project code
      externalCallSites INT64, -- library/dynamic sites excluded from coverage
      preview STRING,
      value STRING,
      scope STRING,
      declaredType STRING,     -- Variable: the type the source writes down in an annotation; null where none is written

      -- How many edges the node has, in and out, over every relationship type.
      -- Written by the builder at the end of a run (stampNodeDegrees). Zero is
      -- the interesting value: nothing calls it, nothing contains it, nothing
      -- routes to it — which is either dead code or a gap in the parser, and
      -- both are worth seeing. It is also the only honest basis for drawing a
      -- node bigger than its neighbours.
      degree INT64,

      -- ===== layout positions (force-simulation result, persisted for stable views) =====
      layoutX DOUBLE,
      layoutY DOUBLE,
      layoutZ DOUBLE,

      elementId STRING,        -- AST/DOM/ControlFlow local id (NOT neo4j elementId())

      -- ===== multi-label fold-ins =====
      kind STRING,             -- ControlFlow subtype (if/for/while/try/switch/...)
      astType STRING,          -- ASTNode subtype (StringLiteral, MemberExpression, ...)
      isComponent BOOLEAN,
      isHook BOOLEAN,
      isAsync BOOLEAN,
      isOverride BOOLEAN,      -- Kotlin/Java: method overrides a framework/interface contract
      isFrameworkEntrypoint BOOLEAN, -- called by Android/framework rather than a static CALLS edge
      entryPointKind STRING,   -- android-lifecycle | callback | manifest-component | ...
      visibility STRING,       -- public/protected/internal/private where statically known
      isAbstract BOOLEAN,      -- interface/protocol/abstract contract, not executable dead code
      isPlannedStub BOOLEAN,   -- strong source/spec/task evidence of planned implementation
      parameterCount INT64,
      isHttpHandler BOOLEAN,
      isRuntime BOOLEAN,       -- DOMElement:RuntimeDOM

      -- ===== Effect =====
      hookType STRING,
      deps STRING[],

      -- ===== DOMElement =====
      tagName STRING,
      testId STRING,
      eventHandlers STRING[],
      className STRING,
      xpath STRING,
      textSnippet STRING,      -- shared with VisibleComponent
      snapshotAt INT64,

      -- ===== Import/Export symbols =====
      localName STRING,
      originalName STRING,
      sourceFile STRING,
      publicName STRING,
      reexportFrom STRING,
      enclosingFunc STRING,    -- Alias / symbols
      wrappedBy STRING,        -- React wrapper (memo/forwardRef/...)

      -- ===== Endpoint =====
      url STRING,
      method STRING,

      -- ===== ROS 2 (optional extractor) =====
      -- On Topic/Service/Action nodes: the interface type and which kind it is.
      -- On Class nodes: whether the class derives from a ROS node base, plus the
      -- runtime node name passed to that base constructor.
      -- NOTE: no backticks in these comments — the DDL lexer picks up a
      -- backtick-quoted identifier before it strips the -- comment, which turns
      -- an innocent comment into a parse error.
      msgType STRING,          -- canonical pkg/msg/Type
      rosKind STRING,          -- 'topic' | 'service' | 'action'
      rosDynamic BOOLEAN,      -- name is computed at runtime, not a literal
      isRosNode BOOLEAN,       -- Class derives from rclpy/rclcpp Node
      rosBase STRING,          -- the ROS base class it derives from
      rosNodeName STRING,      -- name given to super().__init__() / Node(...)

      -- ===== File =====
      language STRING,
      lastParsed INT64,
      sourceMtime INT64,       -- source mtime observed by the successful parse
      parsedAt INT64,          -- wall-clock time when parsing completed
      contentHash STRING,      -- sha256 of the parsed source bytes
      parseStatus STRING,      -- current | parse_error
      depth INT64,             -- nesting depth for ControlFlow nodes
      updatedAt INT64,         -- shared (Task/Knowledge also use updatedAt)
      lastSeenMtime INT64,

      -- ===== IPv6 addressing (code + Task) =====
      ipv6 STRING,
      ipv6mask INT64,

      -- ===== identity / timestamps =====
      nodeId STRING,
      createdAt INT64,         -- shared (Task/Knowledge also use createdAt)

      -- ===== rename/move bookkeeping =====
      renamedFrom STRING,
      renamedAt INT64,
      movedFrom STRING,
      movedAt INT64,

      -- ===== LOCK props (all nullable) =====
      locked BOOLEAN,
      lockedBy STRING,
      lockGroup STRING,
      lockStatus STRING,
      lockExpires INT64,
      lockOrigin STRING,
      plannedBy STRING,
      editInProgress BOOLEAN,
      editInProgressSince INT64,

      -- ===== RELEASE props (all nullable) =====
      pendingRelease BOOLEAN,
      releaseSummary STRING,
      releaseRequestedAt INT64,
      releaseRequestedBy STRING,
      releasedAt INT64,
      releasedBy STRING,
      releaseRejectedReason STRING,
      releaseRejectedAt INT64,

      -- ===== ERROR props (all nullable) =====
      lastError STRING,
      lastErrorStack STRING,
      lastErrorTimestamp INT64,

      -- ===== TOMBSTONE props =====
      removedFromDisk BOOLEAN,
      removedBy STRING,
      removedAt INT64,

      -- ===== Task (folded in from former Task table) =====
      taskId STRING,
      title STRING,
      description STRING,
      workInstructions STRING,
      scopeMode STRING,
      activeScopeMode STRING,
      status STRING,           -- shared (BraindumpSession also has status)
      priority STRING,
      category STRING,         -- shared (Knowledge also has category)
      docId STRING,            -- repository Markdown Knowledge: stable frontmatter id
      sourcePath STRING,       -- repository-relative Markdown source file
      tags STRING[],           -- repository Markdown Knowledge tags
      createdBy STRING,
      assignedTo STRING,
      completedAt INT64,
      summary STRING,
      claimedAt INT64,
      lastComment STRING,
      updatedBy STRING,
      comments STRING[],
      wave STRING,
      waveStatus STRING,

      -- ===== Knowledge (folded in from former Knowledge table) =====
      content STRING,          -- name/category/createdAt/updatedAt shared above

      -- ===== Annotation (LLM/human semantic proposals) =====
      annotationId STRING,
      targetUid STRING,        -- exact elementId to re-link after code rebuilds
      tag STRING,
      evidence STRING,
      confidence DOUBLE,
      weight DOUBLE,
      sourceKind STRING,       -- llm | human | import
      model STRING,

      -- ===== BraindumpSession (folded in from former BraindumpSession table) =====
      sessionId STRING,
      text STRING,
      ts INT64,                -- status shared above

      -- ===== UserEvent (folded in from former UserEvent table) =====
      eventType STRING,
      timestamp INT64,         -- shared (RouteEvent + LogEntry also use timestamp)
      targetTestId STRING,
      targetTagName STRING,
      componentName STRING,
      componentNameLeaf STRING,
      executionPathHex STRING,
      executionPathUids STRING[],
      executionPathNames STRING[],
      executionPathNamesUser STRING[],

      -- ===== RouteEvent (folded in from former RouteEvent table) =====
      fromRoute STRING,
      toRoute STRING,          -- timestamp shared above

      -- ===== VisibleComponent (folded in from former VisibleComponent table) =====
      isVisible BOOLEAN,
      boundingBox STRING,
      capturedAt INT64,        -- name/textSnippet shared above

      -- ===== LogEntry (folded in from former LogEntry table) =====
      agent STRING,
      operation STRING,
      result STRING,
      durationMs INT64,
      error STRING,            -- timestamp/taskId shared above

      PRIMARY KEY(uid)
  )`,
];

// ============================================================================
// REL TABLES
// Each entry: rel type -> { props?: "col TYPE, ...", renamedProps?: {...} }.
// In the single-table model EVERY endpoint is a CodeNode, so every rel table
// is simply FROM CodeNode TO CodeNode.
//
// NOTE: `props` here describes ONLY which columns the migration WRITES for that
// rel type (the type-specific properties that actually carry data). The DDL
// column set is uniform — every rel table is created with the full
// REL_PROP_UNION below — so that strict Kuzu reads of any `r.<prop>` never
// crash. Columns not listed in a type's `props` simply stay NULL on its rows.
// ============================================================================

const REL_SPECS = {
  // --- structural / code <-> code -----------------------------------------
  CONTAINS:           {},
  CONTAINS_AST:       {},
  CONTAINS_FLOW:      {},
  CONTAINS_STMT:      {},
  DECLARES:           {},
  RETURNS:            {},
  IMPORTS:            {},
  IMPORTS_SYMBOL:     {},
  EXPORTS_SYMBOL:     {},
  RESOLVES_TO:        {},
  READS_STATE:        {},
  WRITES_STATE:       {},
  HAS_EFFECT:         {},
  WATCHES:            {},
  BELONGS_TO:         {},
  HANDLES:            {},
  FETCHES:            {},
  AWAITS:             {},
  RENDERS:            {},
  WRAPS:              {},
  ALIAS_OF:           {},
  CONSUMES_CONTEXT:   {},
  INHERITS:           {},
  // Function|File -> Class, written for every `new Foo()` whose class is in the
  // graph. The class diagram derives its association arrows from these.
  INSTANTIATES:       {},
  // Function|Class -> Class, from a type annotation (`def plan(o: Obstacle)`).
  // The association a Python type hint states outright — see
  // extractTypeReferences. `role` says where the annotation sat.
  USES_TYPE:          { props: "role STRING" },
  // Function|Class -> Function, for `@decorator` where the decorator resolves to
  // a function in the graph. Unresolvable decorators (@property, third-party)
  // are kept as the `decorators` property on the node instead.
  DECORATED_BY:       {},
  // The ROS extractor writes all three of these. Only USES_TOPIC ever had a rel
  // table, so a Python publisher — `create_publisher(String, '/chatter', 10)` —
  // aborted the whole build with "Table PUBLISHES_TOPIC does not exist". Every
  // ROS project failed to build, and the failure looked like a database problem
  // rather than a missing table declaration.
  USES_TOPIC:         {},
  PUBLISHES_TOPIC:    {},
  SUBSCRIBES_TOPIC:   {},
  // Services and actions, written by the same ROS extractor.
  PROVIDES_SERVICE:   {},
  CALLS_SERVICE:      {},
  PROVIDES_ACTION:    {},
  USES_ACTION:        {},
  HAS_CHILD:          {}, // RuntimeDOM -> RuntimeDOM

  // --- code <-> code WITH properties --------------------------------------
  CALLS:              { props: "resolvedBy STRING" },
  CALLS_CONDITIONALLY:{ props: "condition STRING, branch STRING" },
  PASSES_CALLBACK:    { props: "via STRING, argumentIndex INT64, confidence STRING, resolvedBy STRING" },
  ASYNC_CHAIN:        { props: "method STRING" },
  DATA_FLOWS_TO:      { props: "via STRING, inFunc STRING" },
  ON_EVENT:           { props: "event STRING" },
  PASSES_PROP:        { props: "props STRING[], hasSpread BOOLEAN, spreadVars STRING[]" },

  // --- workflow edges (now all CodeNode->CodeNode) ------------------------
  AFFECTS:            {}, // Task -> CodeNode and Task -> Task
  RESERVES:           {}, // Task -> explicit edit scope; never impact traversal
  TOUCHED:            { props: "at INT64, kind STRING" }, // documentary only; never lock traversal
  FULFILLED_BY:       {}, // Epic -> Task; documentary only; never lock traversal
  DEPENDS_ON:         { props: "kind STRING" }, // Task -> Task workflow order; documentary only; never lock traversal
  CREATED:            {}, // Task -> CodeNode
  REMOVED:            {}, // Task -> CodeNode
  APPLIES_TO:         {}, // Knowledge -> CodeNode and Knowledge -> Task
  ANNOTATES:          {}, // proposed/accepted semantic Annotation -> any graph node
  REFERENCES:         {}, // Markdown Knowledge -> Markdown Knowledge wiki/reference link
  LOG_OF:             {}, // LogEntry -> Task
  DERIVES:            {}, // BraindumpSession/Architect ("book") -> Knowledge/Task it produced.
                          // Provenance only — NEVER part of lock traversal.
  // SpecClass -> SpecClass for the UML relations that have NO code counterpart:
  // composition, aggregation, association, dependency. The concrete UML type
  // lives in `name` (already part of REL_PROP_UNION). Inheritance deliberately
  // does NOT come here — it is persisted as the ordinary INHERITS edge, so an
  // imported diagram's class hierarchy is the same edge type as parsed code's
  // and existing INHERITS queries see both without knowing about specs.
  SPEC_RELATES:       { props: "name STRING, umlLabel STRING, multiplicityFrom STRING, multiplicityTo STRING" },
  // Spec node -> the code node that realises it. THE binding between diagram
  // and code, and the reason the two are one graph rather than two islands.
  //
  // Deliberately an edge and not (only) a uid property: an edge cannot point at
  // something that is gone. The property form silently kept claiming
  // status:'confirmed' after a rename changed the target's uid.
  REALIZED_BY:        { props: "confidence STRING, matchedAt INT64" },
  PROMOTED_TO:        {}, // Idea -> Task (idea was promoted; idea gets status='promoted')

  // --- runtime edges (now all CodeNode->CodeNode) -------------------------
  PERFORMED:          {}, // User -> UserEvent
  NAVIGATED:          {}, // User -> RouteEvent
  TRIGGERS:           {}, // UserEvent -> CodeNode
  TRIGGERS_LEAF:      {}, // UserEvent -> CodeNode
  TRIGGERS_RENDER:    { props: "count INT64, firstSeen INT64, lastSeen INT64" },
  // Neo4j prop name `order` is a reserved keyword in Kuzu DML and cannot be
  // backtick-escaped in CREATE/SET, so it is migrated under the name `stepOrder`.
  EXECUTION_STEP:     { props: "stepOrder INT64", renamedProps: { order: "stepOrder" } },
  EXECUTION_NEXT:     { props: "count INT64, lastSeen INT64" },
  CLICKED_ELEMENT:    {}, // UserEvent -> CodeNode
  CLICKS_ON:          { props: "count INT64, lastClicked INT64" },
  SHOWS:              {}, // UserEvent -> VisibleComponent
  MAPS_TO:            {}, // VisibleComponent -> CodeNode
  MAPS_TO_STATIC:     {}, // RuntimeDOM -> static DOMElement
  RUNTIME_RENDERS:    { props: "count INT64, lastSeen INT64" },
};

// ============================================================================
// REL PROPERTY UNION
// ----------------------------------------------------------------------------
// Kuzu/Ladybug is STRICT: reading `r.foo` on a rel table that has no `foo`
// column is a binder error (Neo4j would just return null). The bridge reads
// assorted rel properties generically (e.g. `r.name` on PASSES_PROP), so — just
// like CodeNode carries the union of all NODE columns — EVERY rel table carries
// the union of ALL rel properties as nullable columns. A property that does not
// apply to a given rel type is simply NULL, and `r.<anything-in-the-union>`
// never crashes.
//
// `order` is a reserved keyword in Kuzu DML: it cannot be set/written via
// Cypher even backtick-quoted, but it CAN exist as a (backtick-quoted) column
// and be read back as null. We keep it in the union purely so a generic
// `r.order` read does not crash; the real ordering value is migrated into
// `stepOrder` (see EXECUTION_STEP.renamedProps).
//
// On a name collision across rel types we keep one column; on a type conflict
// we would prefer the looser type — but the inventory has no conflicting types.
// ============================================================================
const REL_PROP_SHARED = [
  "name STRING",
  "props STRING[]",
  "hasSpread BOOLEAN",
  "spreadVars STRING[]",
  "condition STRING",
  "branch STRING",
  "via STRING",
  "inFunc STRING",
  "event STRING",
  "resolvedBy STRING",
  "method STRING",
  "count INT64",
  "lastSeen INT64",
  "firstSeen INT64",
  "lastClicked INT64",
  "stepOrder INT64",
  "confidence STRING", // REALIZED_BY: exact | ambiguous | rebound | manual
  "matchedAt INT64",   // REALIZED_BY: when the binding was (re)established
  "at INT64",          // TOUCHED: when the successful edit completed
  "kind STRING",       // TOUCHED: edit tool name; DEPENDS_ON: 'derived' | 'manual'
  "`order` INT64", // reserved keyword -> backtick-quoted; read-only/null in practice
  // ROS 2 interface edges: the message/service type, the callback the interface
  // is wired to, and the QoS profile where one was given.
  "msgType STRING",
  "callback STRING",
  "qos STRING",
  // Where a type annotation sat: 'param' | 'return' | 'field' (USES_TYPE).
  "role STRING",
  // Klassendiagramm-Beziehungen (SPEC_RELATES/INHERITS): was am Pfeil steht.
  // `name` trägt den UML-Typ, diese drei tragen, was der Typ NICHT sagt —
  // ohne sie liest sich jede Beziehung im Graphen nur als "association".
  "umlLabel STRING",
  "multiplicityFrom STRING",
  "multiplicityTo STRING",
];

/**
 * The list above, plus every property declared per-type in REL_SPECS.
 *
 * WHY this is derived rather than hand-maintained: `buildRelDDL` builds every
 * rel table from this union and ignores its `spec` argument, so a `props:`
 * entry in REL_SPECS that is not also in the list above never becomes a column.
 * It reads like a declaration and behaves like a comment. The first
 * `SET r.<prop> = ...` against it then fails with
 *
 *   [ladybug] Binder exception: Cannot find property <prop> for r
 *
 * at build time — and because `reconcileSchema` also reconciles rel tables
 * against this union, no amount of reconciling repairs it either.
 *
 * That is not hypothetical: PASSES_CALLBACK declared `argumentIndex INT64` at
 * REL_SPECS, it was missing here, and `extractCallbacks` failed on every build
 * of any project containing a callback passed as an argument. Deriving the
 * union closes the class of bug instead of the one instance.
 *
 * Additive and order-stable: the shared list keeps its position, per-type
 * properties are appended in REL_SPECS order, and a name already present is
 * skipped so the shared spelling wins.
 */
const REL_PROP_UNION = (() => {
  const out = [...REL_PROP_SHARED];
  const have = new Set(parseColumns(`X(${out.join(", ")})`).map((c) => c.name));
  for (const spec of Object.values(REL_SPECS)) {
    if (!spec || !spec.props) continue;
    for (const col of parseColumns(`X(${spec.props})`)) {
      if (have.has(col.name)) continue;
      have.add(col.name);
      out.push(col.decl);
    }
  }
  return out;
})();

/**
 * Build a CREATE REL TABLE statement. Single-table model: every rel is
 * FROM CodeNode TO CodeNode, and every rel table gets the full REL_PROP_UNION
 * so that any `r.<prop>` read is binder-safe (returns null when not set).
 *
 * `spec` is unused because the union above has already absorbed every spec's
 * properties — which is exactly what makes the uniform column set safe.
 */
function buildRelDDL(type, _spec) {
  return `CREATE REL TABLE ${type}(FROM CodeNode TO CodeNode, ${REL_PROP_UNION.join(", ")})`;
}

const REL_TABLES = Object.entries(REL_SPECS).map(([type, spec]) => buildRelDDL(type, spec));

/** Full DDL: node table first (rels reference it), then rel tables. */
const DDL = [...NODE_TABLES, ...REL_TABLES];

/**
 * Strip `-- ...` line comments. Ladybug's DDL parser rejects inline comments
 * inside CREATE TABLE statements, so we keep comments in the readable source
 * but remove them right before execution.
 */
function stripComments(sql) {
  return sql
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
}

/**
 * Apply the full schema to an open Ladybug connection.
 * Runs each CREATE statement sequentially; logs progress.
 */
async function applySchema(conn, { log = console.log } = {}) {
  let n = 0;
  for (const stmt of DDL) {
    try {
      await conn.query(stripComments(stmt));
      n++;
    } catch (e) {
      // Ladybug/Kuzu versions in the supported range do not consistently
      // accept IF NOT EXISTS for REL TABLE. Existing databases are therefore
      // handled statement-by-statement: skip only the precise, harmless
      // "already exists" case and propagate every other DDL failure.
      if (!/already exists|table .* exists/i.test(String(e && e.message))) throw e;
    }
  }
  log(`[schema] applied ${n} statements (${NODE_TABLES.length} node table, ${REL_TABLES.length} rel tables)`);
  return n;
}

/**
 * Split a DDL column list on top-level commas. `STRING[]` and the parenthesised
 * `PRIMARY KEY(uid)` must not be torn apart, so we track bracket depth.
 */
function splitTopLevel(body) {
  const out = [];
  let depth = 0;
  let cur = "";
  for (const ch of body) {
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/**
 * Extract `{ name, type, decl }` for every column in a CREATE TABLE statement.
 * `decl` keeps the original spelling (including backticks) so it can be fed
 * straight back into ALTER TABLE; `name` is unquoted for comparison.
 */
function parseColumns(ddl) {
  const sql = stripComments(ddl);
  const open = sql.indexOf("(");
  const close = sql.lastIndexOf(")");
  if (open < 0 || close < open) return [];
  const cols = [];
  for (const raw of splitTopLevel(sql.slice(open + 1, close))) {
    const decl = raw.trim().replace(/\s+/g, " ");
    if (!decl) continue;
    if (/^PRIMARY\s+KEY/i.test(decl)) continue;
    if (/^(FROM|TO)\s/i.test(decl)) continue; // rel table endpoints
    const sp = decl.indexOf(" ");
    if (sp < 0) continue;
    cols.push({
      name: decl.slice(0, sp).replace(/`/g, ""),
      type: decl.slice(sp + 1),
      decl,
    });
  }
  return cols;
}

/**
 * Bring an EXISTING database up to the current schema.
 *
 * WHY this exists: applySchema() only ever runs against a brand-new database
 * (the daemon calls it when the CodeNode table is missing). Every table or
 * column added to this file after a user's database was created therefore never
 * reached it — the query would fail with "Table X does not exist" and the only
 * remedy was deleting the data directory and rebuilding the whole graph.
 *
 * Safe because the schema is append-only: tables and columns are added here,
 * never renamed or dropped. So reconciling is exactly "create what is missing",
 * which cannot destroy existing data. Anything that is already present is left
 * untouched.
 *
 * Individual failures are logged, not thrown: a half-recognised column must not
 * stop the daemon from opening a database that is otherwise perfectly usable.
 */
async function reconcileSchema(conn, { log = console.log } = {}) {
  const added = { tables: [], columns: [] };

  // ── Missing tables ────────────────────────────────────────────────────────
  const existing = new Set();
  const res = await conn.query("CALL show_tables() RETURN name");
  for (const row of await res.getAll()) existing.add(row.name);

  for (const [type, spec] of Object.entries(REL_SPECS)) {
    if (existing.has(type)) continue;
    try {
      await conn.query(stripComments(buildRelDDL(type, spec)));
      added.tables.push(type);
    } catch (e) {
      log(`[schema] WARN could not create rel table ${type}: ${e.message}`);
    }
  }

  // ── Missing columns ───────────────────────────────────────────────────────
  // Only tables that already existed need checking; the ones just created above
  // were built from the current DDL by definition.
  const addColumns = async (table, wanted) => {
    const have = new Set();
    try {
      const info = await conn.query(`CALL table_info('${table}') RETURN name`);
      for (const row of await info.getAll()) have.add(row.name);
    } catch (e) {
      log(`[schema] WARN could not read columns of ${table}: ${e.message}`);
      return;
    }
    for (const col of wanted) {
      if (have.has(col.name)) continue;
      try {
        await conn.query(`ALTER TABLE ${table} ADD ${col.decl}`);
        added.columns.push(`${table}.${col.name}`);
      } catch (e) {
        log(`[schema] WARN could not add ${table}.${col.name}: ${e.message}`);
      }
    }
  };

  if (existing.has("CodeNode")) {
    await addColumns("CodeNode", parseColumns(NODE_TABLES[0]));
  }
  const relUnionCols = parseColumns(`X(${REL_PROP_UNION.join(", ")})`);
  for (const type of Object.keys(REL_SPECS)) {
    if (existing.has(type)) await addColumns(type, relUnionCols);
  }

  if (added.tables.length || added.columns.length) {
    log(
      `[schema] reconciled: +${added.tables.length} table(s) ` +
      `[${added.tables.join(", ")}], +${added.columns.length} column(s)` +
      (added.columns.length ? ` [${added.columns.join(", ")}]` : "")
    );
  }
  return added;
}

module.exports = {
  NODE_TABLES,
  REL_TABLES,
  REL_SPECS,
  REL_PROP_UNION,
  DDL,
  buildRelDDL,
  stripComments,
  parseColumns,
  applySchema,
  reconcileSchema,
};

// ---------------------------------------------------------------------------
// CLI: `node scripts/ladybug_schema.cjs [dbPath]` -> create a fresh DB & apply.
// ---------------------------------------------------------------------------
if (require.main === module) {
  (async () => {
    const lbug = require("@ladybugdb/core");
    const dbPath = process.argv[2] || ":memory:";
    const db = new lbug.Database(dbPath);
    if (db.init) await db.init();
    const conn = new lbug.Connection(db);
    if (conn.init) await conn.init();
    await applySchema(conn);
    console.log(`[schema] OK against ${dbPath}`);
    // Checkpoint the WAL into the main file before exit.
    if (conn.close) await conn.close();
    if (db.close) await db.close();
  })().catch((e) => {
    console.error("[schema] FAILED:", e.message);
    process.exit(1);
  });
}

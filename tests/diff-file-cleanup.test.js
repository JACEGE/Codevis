const { test } = require("node:test");
const assert = require("node:assert/strict");

const { openTestDb } = require("./helpers/ladybug-session.cjs");
const { __testing__ } = require("../scripts/graph_builder.js");
const { readSnapshot } = require("../scripts/diff/graph_snapshot.cjs");
const { diffSnapshots } = require("../scripts/diff/graph_diff.cjs");

const FILE = "src/sample.js";
const OTHER_FILE = "src/other.js";

const SNAPSHOT_LABELS = [
  "File", "Function", "ASTNode", "Variable", "ControlFlow",
  "ReturnStatement", "Effect", "DOMElement", "ImportedSymbol",
  "ExportedSymbol", "Alias",
];

const SNAPSHOT_RELS = [
  "CONTAINS", "CONTAINS_AST", "DECLARES", "CONTAINS_FLOW",
  "CONTAINS_STMT", "HAS_EFFECT", "BELONGS_TO", "IMPORTS_SYMBOL",
  "EXPORTS_SYMBOL", "ALIAS_OF",
];

async function createFileGraph(session, version) {
  const line = version === "old" ? 3 : 7;
  await session.run(`
    CREATE (file:File {path: $path, name: $path})
    CREATE (fn:Function {name: 'run', file: $path, startLine: $line, endLine: $line})
    CREATE (ast:ASTNode {elementId: $astId, file: $path, startLine: $line})
    CREATE (variable:Variable {name: 'value', elementId: $variableId, file: $path, startLine: $line})
    CREATE (flow:ControlFlow {elementId: $flowId, file: $path, startLine: $line})
    CREATE (stmt:ReturnStatement {elementId: $statementId, file: $path, startLine: $line})
    CREATE (effect:Effect {name: 'useEffect_sample', hookType: 'useEffect', file: $path, startLine: $line})
    CREATE (dom:DOMElement {elementId: $domId, file: $path, startLine: $line})
    CREATE (imported:ImportedSymbol {localName: 'helper', file: $path})
    CREATE (exported:ExportedSymbol {publicName: 'run', file: $path})
    CREATE (alias:Alias {name: 'runner', file: $path})
    CREATE (file)-[:CONTAINS]->(fn)
    CREATE (fn)-[:CONTAINS_AST]->(ast)
    CREATE (fn)-[:DECLARES]->(variable)
    CREATE (fn)-[:CONTAINS_FLOW]->(flow)
    CREATE (fn)-[:CONTAINS_STMT]->(stmt)
    CREATE (fn)-[:HAS_EFFECT]->(effect)
    CREATE (dom)-[:BELONGS_TO]->(fn)
    CREATE (file)-[:IMPORTS_SYMBOL]->(imported)
    CREATE (file)-[:EXPORTS_SYMBOL]->(exported)
    CREATE (alias)-[:ALIAS_OF]->(fn)
  `, {
    path: FILE,
    line,
    astId: `StringLiteral:${line}:2`,
    variableId: `value:${line}:6`,
    flowId: `if:${line}:2`,
    statementId: `return:${line}:4`,
    domId: `button:${line}:2`,
  });
}

async function createUnaffectedGraph(session) {
  await session.run(`
    CREATE (file:File {path: $path, name: $path})
    CREATE (fn:Function {name: 'untouched', file: $path})
    CREATE (ast:ASTNode {elementId: 'Identifier:1:0', file: $path})
    CREATE (file)-[:CONTAINS]->(fn)
    CREATE (fn)-[:CONTAINS_AST]->(ast)
  `, { path: OTHER_FILE });
}

async function count(session, cypher, params = {}) {
  const result = await session.run(cypher, params);
  const value = result.records[0].get("count");
  return Number(value?.toNumber?.() ?? value);
}

test("DIFF cleanup matches a clean graph and leaves no old file-scoped detail nodes", async () => {
  const incremental = await openTestDb();
  const clean = await openTestDb();

  try {
    for (const session of [incremental.session, clean.session]) {
      await createUnaffectedGraph(session);
      await session.run(`
        CREATE (:Task {taskId: 'task-preserved', name: 'authored', file: $path})
        CREATE (:Knowledge {name: 'file knowledge', file: $path})
      `, { path: FILE });
    }

    await createFileGraph(incremental.session, "old");
    await incremental.session.run(`
      MATCH (fn:Function {name: 'run', file: $path})
      MATCH (task:Task {taskId: 'task-preserved'})
      MATCH (knowledge:Knowledge {name: 'file knowledge'})
      SET fn.locked = true, fn.lockedBy = 'worker'
      CREATE (task)-[:AFFECTS]->(fn)
      CREATE (knowledge)-[:APPLIES_TO]->(fn)
    `, { path: FILE });
    const backup = await __testing__.backupLocksAndAffects(
      incremental.session,
      "AND n.file IN $paths",
      { paths: [FILE] },
    );
    assert.equal(backup.locks.length, 1, "set-based cleanup must back up locks once");
    assert.equal(backup.affects.length, 1, "set-based cleanup must back up authored task edges");
    assert.equal(backup.knowledge.length, 1, "set-based cleanup must back up Knowledge edges");

    await __testing__.removeFileDerivedNodes(incremental.session, [FILE]);

    assert.equal(
      await count(
        incremental.session,
        `MATCH (n) WHERE n.file = $path AND NOT n:Task AND NOT n:Knowledge RETURN count(n) AS count`,
        { path: FILE },
      ),
      0,
      "all generated nodes from the old file version must be removed",
    );
    assert.equal(
      await count(
        incremental.session,
        `MATCH (n) WHERE n.file = $path AND (n:Task OR n:Knowledge) RETURN count(n) AS count`,
        { path: FILE },
      ),
      2,
      "authored labels must survive even when they carry a file property",
    );
    assert.equal(
      await count(
        incremental.session,
        `MATCH (n) WHERE n.file = $path RETURN count(n) AS count`,
        { path: OTHER_FILE },
      ),
      2,
      "cleanup must not touch another file",
    );

    await createFileGraph(incremental.session, "head");
    await __testing__.restoreLocksAndAffects(incremental.session, backup);
    await createFileGraph(clean.session, "head");

    assert.equal(
      await count(
        incremental.session,
        `MATCH (fn:Function {name: 'run', file: $path})
         WHERE fn.locked = true AND fn.lockedBy = 'worker'
         RETURN count(fn) AS count`,
        { path: FILE },
      ),
      1,
      "the rebuilt function must recover its lock",
    );
    assert.equal(
      await count(
        incremental.session,
        `MATCH (:Task {taskId: 'task-preserved'})-[:AFFECTS]->(fn:Function {name: 'run', file: $path})
         RETURN count(fn) AS count`,
        { path: FILE },
      ),
      1,
      "the rebuilt function must recover its authored task edge",
    );
    assert.equal(
      await count(
        incremental.session,
        `MATCH (:Knowledge {name: 'file knowledge'})-[:APPLIES_TO]->(fn:Function {name: 'run', file: $path})
         RETURN count(fn) AS count`,
        { path: FILE },
      ),
      1,
      "the rebuilt function must recover its Knowledge edge",
    );

    const [incrementalSnapshot, cleanSnapshot] = await Promise.all([
      readSnapshot(incremental.session, { labels: SNAPSHOT_LABELS, rels: SNAPSHOT_RELS }),
      readSnapshot(clean.session, { labels: SNAPSHOT_LABELS, rels: SNAPSHOT_RELS }),
    ]);
    const representedLabels = new Set([...incrementalSnapshot.nodes.values()].map(node => node.label));
    for (const label of SNAPSHOT_LABELS) {
      assert.ok(representedLabels.has(label), `${label} must be represented in the exact diff snapshot`);
    }
    const delta = diffSnapshots(cleanSnapshot, incrementalSnapshot);

    assert.deepEqual(delta.nodes.added, [], "incremental build must not retain extra nodes");
    assert.deepEqual(delta.nodes.removed, [], "incremental build must not lose clean-build nodes");
    assert.deepEqual(delta.nodes.changed, [], "incremental node properties must match a clean build");
    assert.deepEqual(delta.edges.added, [], "incremental build must not retain extra edges");
    assert.deepEqual(delta.edges.removed, [], "incremental edges must match a clean build");
  } finally {
    await incremental.cleanup();
    await clean.cleanup();
  }
});

test("shared semantic nodes survive only while a code ownership edge reaches them", async () => {
  const db = await openTestDb();
  try {
    await db.session.run(`
      CREATE (:File {path: 'src/owner.js', name: 'src/owner.js'})
      CREATE (:Task {taskId: 'task-authored', name: 'authored task'})
    `);

    for (const [label, relations] of __testing__.SHARED_DERIVED_OWNERSHIP) {
      const relation = relations.split("|")[0];
      await db.session.run(`
        MATCH (owner:File {path: 'src/owner.js'})
        MATCH (task:Task {taskId: 'task-authored'})
        CREATE (kept:${label} {name: $kept})
        CREATE (orphan:${label} {name: $orphan})
        CREATE (owner)-[:${relation}]->(kept)
        CREATE (task)-[:AFFECTS]->(orphan)
      `, { kept: `${label}-kept`, orphan: `${label}-orphan` });
    }

    await __testing__.removeOrphanedSharedDerivedNodes(db.session);

    for (const [label] of __testing__.SHARED_DERIVED_OWNERSHIP) {
      assert.equal(
        await count(
          db.session,
          `MATCH (n:${label} {name: $name}) RETURN count(n) AS count`,
          { name: `${label}-kept` },
        ),
        1,
        `${label} with a code owner must survive`,
      );
      assert.equal(
        await count(
          db.session,
          `MATCH (n:${label} {name: $name}) RETURN count(n) AS count`,
          { name: `${label}-orphan` },
        ),
        0,
        `${label} without its code ownership relation must be removed`,
      );
    }
    assert.equal(
      await count(
        db.session,
        `MATCH (n:Task {taskId: 'task-authored'}) RETURN count(n) AS count`,
      ),
      1,
      "removing a stale semantic target must not remove the authored source node",
    );
  } finally {
    await db.cleanup();
  }
});

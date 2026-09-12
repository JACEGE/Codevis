const { test } = require("node:test");
const assert = require("node:assert/strict");

const { openTestDb } = require("./helpers/ladybug-session.cjs");
const { recordTouchedNodes, getTouchedNodes } = require("../tools/lib/task-context.cjs");
const { __testing__ } = require("../scripts/graph_builder.js");

test("TOUCHED records edit outcome without changing locks/AFFECTS and survives rebuild", async () => {
  const { session, cleanup } = await openTestDb();
  try {
    await session.run(`
      CREATE (t:Task {uid: 'task-node', taskId: 'task-explicit', status: 'in_progress', assignedTo: 'worker-1'})
      CREATE (n:Function {uid: 'function-node', name: 'helper', file: 'src/b.js',
        locked: true, lockedBy: 'worker-1', lockGroup: 'task-explicit', lockStatus: 'active'})
      CREATE (t)-[:AFFECTS]->(n)
    `);

    const recorded = await recordTouchedNodes(session, {
      agentId: "worker-1",
      kind: "edit_code_patch",
      targets: [{ name: "helper", file: "src/b.js" }],
    });
    assert.deepEqual(recorded, { taskId: "task-explicit", touched: 1 });

    const unchanged = await session.run(`
      MATCH (t:Task {taskId: 'task-explicit'})-[a:AFFECTS]->(n:Function {name: 'helper', file: 'src/b.js'})
      RETURN n.locked AS locked, n.lockedBy AS lockedBy, n.lockGroup AS lockGroup,
             n.lockStatus AS lockStatus, count(a) AS affects
    `);
    assert.equal(unchanged.records[0].get("locked"), true);
    assert.equal(unchanged.records[0].get("lockedBy"), "worker-1");
    assert.equal(unchanged.records[0].get("lockGroup"), "task-explicit");
    assert.equal(unchanged.records[0].get("lockStatus"), "active");
    assert.equal(Number(unchanged.records[0].get("affects")), 1);

    const before = await getTouchedNodes(session, "task-explicit");
    assert.equal(before.length, 1);
    assert.equal(before[0].kind, "edit_code_patch");
    assert.equal(typeof before[0].at, "number");

    const backup = await __testing__.backupLocksAndAffects(
      session,
      "AND n.file = $path",
      { path: "src/b.js" },
    );
    await session.run(`MATCH (n:Function {name: 'helper', file: 'src/b.js'}) DETACH DELETE n`);
    await session.run(`CREATE (n:Function {uid: 'function-node-rebuilt', name: 'helper', file: 'src/b.js'})`);
    await __testing__.restoreLocksAndAffects(session, backup);

    const after = await getTouchedNodes(session, "task-explicit");
    assert.equal(after.length, 1);
    assert.equal(after[0].kind, "edit_code_patch");
    assert.equal(after[0].at, before[0].at);
  } finally {
    await cleanup();
  }
});

test("explicit taskId takes precedence and an agent without a task is a no-op", async () => {
  const { session, cleanup } = await openTestDb();
  try {
    await session.run(`
      CREATE (t:Task {uid: 'explicit-task', taskId: 'task-explicit'})
      CREATE (n:Function {uid: 'target-function', name: 'target', file: 'src/x.js'})
    `);
    const explicit = await recordTouchedNodes(session, {
      taskId: "task-explicit", agentId: "worker-without-task", kind: "move_function",
      targets: [{ name: "target", file: "src/x.js" }],
    });
    assert.equal(explicit.touched, 1);

    const noTask = await recordTouchedNodes(session, {
      agentId: "nobody", kind: "insert_code", targets: [{ name: "target", file: "src/x.js" }],
    });
    assert.deepEqual(noTask, { taskId: null, touched: 0 });
  } finally {
    await cleanup();
  }
});

test("multiple active tasks never receive an arbitrarily inferred edit", async () => {
  const { session, cleanup } = await openTestDb();
  try {
    await session.run(`
      CREATE (:Task {uid:'first', taskId:'first', assignedTo:'worker', status:'in_progress'})
      CREATE (:Task {uid:'second', taskId:'second', assignedTo:'worker', status:'in_progress'})
      CREATE (:Function {uid:'fn', name:'target', file:'src/x.js'})
    `);
    const args = { agentId:'worker', kind:'edit_function', targets:[{name:'target', file:'src/x.js'}] };
    assert.deepEqual(await recordTouchedNodes(session, args), { taskId:null, touched:0 });
    assert.equal((await getTouchedNodes(session, 'first')).length, 0);
    assert.equal((await getTouchedNodes(session, 'second')).length, 0);
    assert.deepEqual(await recordTouchedNodes(session, {...args, taskId:'second'}), { taskId:'second', touched:1 });
  } finally { await cleanup(); }
});

test("a unique function body fingerprint carries authored links across a rename", async () => {
  const { session, cleanup } = await openTestDb();
  try {
    await session.run(`
      CREATE (t:Task {uid: 'rename-task', taskId: 'rename-task'})
      CREATE (k:Knowledge {uid: 'rename-knowledge', name: 'Clearance invariant'})
      CREATE (old:Function {uid: 'old-function', name: 'calculate_clearance', file: 'src/geometry.py',
        params: '(points)', bodySnippet: '{ return minimum_distance(points); }'})
      CREATE (t)-[:AFFECTS]->(old)
      CREATE (k)-[:APPLIES_TO]->(old)
    `);
    const backup = await __testing__.backupLocksAndAffects(session, 'AND n.file = $path', { path: 'src/geometry.py' });
    assert.equal(backup.affects[0].bodySnippet, '{ return minimum_distance(points); }');
    assert.equal(backup.affects[0].params, '(points)');
    assert.ok(backup.affects[0].nodeLabels.includes('Function'));
    await session.run(`MATCH (n:Function {name: 'calculate_clearance', file: 'src/geometry.py'}) DETACH DELETE n`);
    await session.run(`CREATE (:Function {uid: 'new-function', name: 'compute_clearance', file: 'src/geometry.py',
      params: '(points)', bodySnippet: '{ return minimum_distance(points); }'})`);
    const candidates = await session.run(`MATCH (n:Function) WHERE n.bodySnippet = $bodySnippet AND n.params = $params RETURN n.name AS name`, {
      bodySnippet: backup.affects[0].bodySnippet, params: backup.affects[0].params,
    });
    assert.equal(candidates.records.length, 1);
    const restored = await __testing__.restoreLocksAndAffects(session, backup);
    assert.equal(restored.edgesRestored, 1);
    assert.equal(restored.knowledgeRestored, 1);
    const links = await session.run(`
      MATCH (:Task {taskId: 'rename-task'})-[:AFFECTS]->(f:Function {name: 'compute_clearance'})
      MATCH (:Knowledge {name: 'Clearance invariant'})-[:APPLIES_TO]->(f)
      RETURN count(f) AS count
    `);
    assert.equal(Number(links.records[0].get('count')), 1);
  } finally {
    await cleanup();
  }
});

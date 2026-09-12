const { test } = require("node:test");
const assert = require("node:assert/strict");

const { openTestDb } = require("./helpers/ladybug-session.cjs");
const { __testing__ } = require("../scripts/graph_builder.js");

test("diff rebuild includes direct source files of incoming cross-file edges", async () => {
  const { session, cleanup } = await openTestDb();
  try {
    await session.run(`
      CREATE (a:File {uid: 'file-a', path: 'src/a.js', name: 'src/a.js'})
      CREATE (b:File {uid: 'file-b', path: 'src/b.js', name: 'src/b.js'})
      CREATE (c:File {uid: 'file-c', path: 'src/c.js', name: 'src/c.js'})
      CREATE (caller:Function {uid: 'fn-caller', name: 'caller', file: 'src/a.js'})
      CREATE (helperB:Function {uid: 'fn-helper-b', name: 'helper', file: 'src/b.js'})
      CREATE (helperC:Function {uid: 'fn-helper-c', name: 'helper', file: 'src/c.js'})
      CREATE (a)-[:CONTAINS]->(caller)
      CREATE (b)-[:CONTAINS]->(helperB)
      CREATE (c)-[:CONTAINS]->(helperC)
      CREATE (a)-[:IMPORTS]->(b)
      CREATE (caller)-[:CALLS {resolvedBy: 'imported-symbol'}]->(helperB)
    `);

    const allFiles = new Map([
      ['src/a.js', 'C:/fixture/src/a.js'],
      ['src/b.js', 'C:/fixture/src/b.js'],
      ['src/c.js', 'C:/fixture/src/c.js'],
    ]);
    const dependents = await __testing__.getDirectDependentFiles(
      session,
      ['src/b.js'],
      allFiles,
    );

    assert.deepEqual(dependents, ['C:/fixture/src/a.js']);
  } finally {
    await cleanup();
  }
});

test("diff detects deleted paths before their dependency evidence is removed", async () => {
  const { session, cleanup } = await openTestDb();
  try {
    await session.run(`
      CREATE (:File {uid: 'keep', path: 'src/keep.js'})
      CREATE (:File {uid: 'gone', path: 'src/old-name.js'})
    `);
    const deleted = await __testing__.getDeletedFilePaths(session, new Set(['src/keep.js', 'src/new-name.js']));
    assert.deepEqual(deleted, ['src/old-name.js']);
  } finally {
    await cleanup();
  }
});

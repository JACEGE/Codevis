const test = require('node:test');
const assert = require('node:assert/strict');
const { openTestDb } = require('./helpers/ladybug-session.cjs');
const { PREDEFINED_QUERIES } = require('../scripts/predefined-queries.cjs');

test('confidence-sensitive analysis queries execute and expose evidence', async () => {
  const { session, cleanup } = await openTestDb();
  try {
    const numeric = (value) => value?.toNumber?.() ?? Number(value);
    await session.run(`
      CREATE (publicFn:Function {uid:'public', name:'point_jacobian', file:'src/kinematics.py', visibility:'public'})
      CREATE (privateFn:Function {uid:'private', name:'_best_axis', file:'src/geometry.py', visibility:'private', startLine:1, endLine:80})
      CREATE (flow:ControlFlow {uid:'flow', name:'if', file:'src/geometry.py'})
      CREATE (privateFn)-[:CONTAINS_FLOW]->(flow)
    `);
    const dead = PREDEFINED_QUERIES.find(q => q.name === 'dead_code');
    const deadResult = await session.run(dead.query);
    const categories = new Map(deadResult.records.map(r => [r.get('function'), r.get('category')]));
    assert.equal(categories.get('point_jacobian'), 'public_no_static_caller');
    assert.equal(categories.get('_best_axis'), 'private_no_caller');

    const refactoring = PREDEFINED_QUERIES.find(q => q.name === 'most_complex_functions');
    const scoreResult = await session.run(refactoring.query);
    assert.ok(scoreResult.records.length >= 1);
    const score = numeric(scoreResult.records[0].get('refactoringScore'));
    assert.ok(Number.isFinite(score), `expected a numeric refactoring score, got ${score}`);
    assert.ok(score > 0, `expected the 80-line fixture to have a positive score, got ${score}`);

    await session.run(`CREATE (file:File {uid:'file', path:'src/app.py', callSites:20, externalCallSites:15, internalCallSites:5, callsResolved:4})`);
    const coverage = PREDEFINED_QUERIES.find(q => q.name === 'call_graph_coverage');
    const coverageResult = await session.run(coverage.query);
    assert.equal(numeric(coverageResult.records[0].get('internalSites')), 5);
    assert.equal(numeric(coverageResult.records[0].get('externalSites')), 15);
    assert.equal(coverageResult.records[0].get('percent'), 80);
  } finally {
    await cleanup();
  }
});

test('recursion scan returns real cycle members instead of empty translated paths', async () => {
  const { session, cleanup } = await openTestDb();
  try {
    await session.run(`
      CREATE (a:Function {uid:'cycle-a', name:'alpha', file:'src/cycle.js'})
      CREATE (b:Function {uid:'cycle-b', name:'beta', file:'src/cycle.js'})
      CREATE (leaf:Function {uid:'leaf', name:'leaf', file:'src/cycle.js'})
      CREATE (a)-[:CALLS]->(b)
      CREATE (b)-[:CALLS]->(a)
      CREATE (a)-[:CALLS]->(leaf)
    `);

    const recursion = PREDEFINED_QUERIES.find(q => q.name === 'recursion');
    const rows = (await session.run(recursion.query)).records;
    const members = new Set(rows.map(row => row.get('recursiveFunction')));
    assert.deepEqual(members, new Set(['alpha', 'beta']));
    assert.equal(rows.some(row => row.get('recursiveFunction') == null), false);
  } finally {
    await cleanup();
  }
});

test('magic number queries separate signal from the numbers that are always there', async () => {
  const { session, cleanup } = await openTestDb();
  try {
    // Jede Zeile steht fuer eine Entscheidung der Abfrage. Die kleinen Zahlen
    // und die runden Zehnerpotenzen sind bewusst dabei: sie fuehren jede
    // ungefilterte Haeufigkeitsliste an und muessen hier verschwinden.
    await session.run(`
      CREATE (retry:Function {uid:'retry', name:'retryConnect', file:'src/net.js'})
      CREATE (a1:ASTNode {uid:'a1', value:'2000', file:'src/net.js', startLine:10})
      CREATE (a2:ASTNode {uid:'a2', value:'2000', file:'src/pool.js', startLine:20})
      CREATE (retry)-[:CONTAINS_AST]->(a1)
      CREATE (b1:ASTNode {uid:'b1', value:'0.05', file:'src/net.js', startLine:11})
      CREATE (b2:ASTNode {uid:'b2', value:'0.05', file:'src/pool.js', startLine:21})
      CREATE (b3:ASTNode {uid:'b3', value:'0.05', file:'src/rate.js', startLine:31})
      CREATE (c1:ASTNode {uid:'c1', value:'404', file:'src/net.js', startLine:12})
      CREATE (c2:ASTNode {uid:'c2', value:'404', file:'src/pool.js', startLine:22})
      CREATE (d1:ASTNode {uid:'d1', value:'3', file:'src/net.js', startLine:13})
      CREATE (d2:ASTNode {uid:'d2', value:'3', file:'src/pool.js', startLine:23})
      CREATE (e1:ASTNode {uid:'e1', value:'1.0', file:'src/net.js', startLine:14})
      CREATE (e2:ASTNode {uid:'e2', value:'1.0', file:'src/pool.js', startLine:24})
      CREATE (f1:ASTNode {uid:'f1', value:'1000', file:'src/net.js', startLine:15})
      CREATE (f2:ASTNode {uid:'f2', value:'1000', file:'src/pool.js', startLine:25})
      CREATE (g1:ASTNode {uid:'g1', value:'7777', file:'src/net.test.js', startLine:16})
      CREATE (g2:ASTNode {uid:'g2', value:'7777', file:'src/pool.test.js', startLine:26})
      CREATE (h1:ASTNode {uid:'h1', value:'8443', file:'src/pool.js', startLine:27})
    `);

    const magic = PREDEFINED_QUERIES.find(q => q.name === 'magic_numbers');
    const rows = (await session.run(magic.query)).records;
    const byNumber = new Map(rows.map(r => [r.get('number'), r]));
    const numeric = (value) => value?.toNumber?.() ?? Number(value);

    // Drei Dateien schlagen zwei: das ist die Rangfolge, nicht die Trefferzahl.
    assert.equal(rows[0].get('number'), '0.05');
    assert.equal(numeric(byNumber.get('0.05').get('fileCount')), 3);
    assert.equal(byNumber.get('0.05').get('analysisConfidence'), 'high');
    assert.equal(byNumber.get('0.05').get('numberKind'), 'precise_decimal');

    assert.equal(numeric(byNumber.get('2000').get('fileCount')), 2);
    assert.equal(byNumber.get('2000').get('numberKind'), 'large_integer');
    assert.equal(byNumber.get('2000').get('analysisConfidence'), 'medium');

    // 404 bleibt in der Liste, aber unten und ohne Vertrauen.
    assert.equal(byNumber.get('404').get('numberKind'), 'standard_code');
    assert.equal(byNumber.get('404').get('analysisConfidence'), 'low');
    assert.equal(rows[rows.length - 1].get('number'), '404');

    for (const stumm of ['3', '1.0', '1000', '7777', '8443']) {
      assert.equal(byNumber.has(stumm), false, `${stumm} gehoert nicht in magic_numbers`);
    }

    const sites = PREDEFINED_QUERIES.find(q => q.name === 'magic_number_sites');
    const siteRows = (await session.run(sites.query)).records;
    const orte = new Map(siteRows.map(r => [`${r.get('number')}@${r.get('file')}`, r]));

    // Einmalige Werte fehlen in magic_numbers und muessen hier auftauchen.
    assert.ok(orte.has('8443@src/pool.js'));
    assert.equal(orte.get('2000@src/net.js').get('function'), 'retryConnect');
    assert.equal(orte.get('2000@src/pool.js').get('function'), '(module level)');
    assert.equal(numeric(orte.get('2000@src/net.js').get('line')), 10);
    assert.ok(orte.get('2000@src/net.js').get('uid'));
    assert.equal(siteRows.some(r => r.get('file').includes('.test.')), false);
  } finally {
    await cleanup();
  }
});

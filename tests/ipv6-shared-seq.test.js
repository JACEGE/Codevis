const test = require('node:test');
const assert = require('node:assert/strict');
const { openTestDb } = require('./helpers/ladybug-session.cjs');
const { __testing__: { assignIpv6Addresses } } = require('../scripts/graph_builder.js');

// Nodes written in one UNWIND batch share a seq until repairSeq runs, which
// is after address assignment. Keyed by id(n) (= seq), a method sharing its
// class's seq counted as "the same node" and was addressed outside the class.
test('a member that shares its class seq is still addressed inside the class', async () => {
    const { session, cleanup } = await openTestDb();
    // The daemon driver encodes ladybug.int() values inside batch rows; the
    // in-process test session does not, so unwrap them here.
    const plain = value => Array.isArray(value) ? value.map(plain)
        : value && typeof value === 'object' ? ('_v' in value ? Number(value._v) : Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)])))
        : value;
    const run = session.run.bind(session);
    session.run = (cypher, params) => run(cypher, plain(params));
    try {
        await session.run(`CREATE (f:File {uid:'f1', path:'loan.py', seq:1})
            CREATE (c:Class {uid:'c1', name:'Loan', file:'loan.py', startLine:1, endLine:20, seq:7})
            CREATE (m:Function {uid:'m1', name:'close', file:'loan.py', startLine:5, endLine:9, seq:7})
            CREATE (f)-[:CONTAINS]->(c) CREATE (f)-[:CONTAINS]->(m)`);
        // CREATE assigns its own seq; force the batch collision explicitly.
        await session.run("MATCH (n) WHERE n.name IN ['Loan','close'] SET n.seq = 7");
        const seqs = await session.run("MATCH (n) WHERE n.name IN ['Loan','close'] RETURN DISTINCT id(n) AS s");
        assert.equal(seqs.records.length, 1, 'precondition: both nodes share one id(n)');
        await assignIpv6Addresses(session, 1);
        const rows = await session.run(`MATCH (n) WHERE n.name IN ['Loan','close'] RETURN n.name AS uid, n.ipv6 AS ipv6, n.ipv6mask AS mask`);
        const by = Object.fromEntries(rows.records.map(r => [r.get('uid'), { ipv6: r.get('ipv6'), mask: Number(r.get('mask')) }]));
        assert.equal(by.Loan.mask, 64);
        assert.equal(by.close.mask, 80, 'the method is a member, not a second top-level declaration');
        assert.equal(by.close.ipv6.split(':').slice(0, 4).join(':'), by.Loan.ipv6.split(':').slice(0, 4).join(':'), 'inside the class /64');
    } finally { await cleanup(); }
});

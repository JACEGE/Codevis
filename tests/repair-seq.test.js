const { test } = require("node:test");
const assert = require("node:assert/strict");

const { openTestDb } = require("./helpers/ladybug-session.cjs");
const { repairSeq } = require("../scripts/repair_seq.cjs");

function number(value) {
  return Number(value?.toNumber?.() ?? value);
}

test("seq repair changes only colliding nodes and reports progress in English", async () => {
  const db = await openTestDb();
  try {
    await db.session.run(`
      CREATE (:Function {name: 'a', file: 'src/a.js'})
      CREATE (:Function {name: 'b', file: 'src/a.js'})
      CREATE (:Function {name: 'c', file: 'src/a.js'})
      CREATE (:Function {name: 'd', file: 'src/a.js'})
    `);
    await db.session.run(`MATCH (n:Function {name: 'a'}) SET n.seq = 7`);
    await db.session.run(`MATCH (n:Function {name: 'b'}) SET n.seq = 7`);
    await db.session.run(`MATCH (n:Function {name: 'c'}) SET n.seq = 9`);
    await db.session.run(`MATCH (n:Function {name: 'd'}) SET n.seq = 11`);

    const logs = [];
    const options = { log: message => logs.push(message), intValue: value => value };
    const changed = await repairSeq(db.session, options);
    assert.equal(changed, 1, "one of the two colliding nodes may keep seq=7");
    assert.ok(logs.every(message => !/verschiedene|Knoten|nummerier/i.test(message)));
    assert.match(logs.join("\n"), /distinct values.*repairing collisions/i);
    assert.match(logs.join("\n"), /repaired 1 collision/i);

    const result = await db.session.run(
      `MATCH (n:Function) RETURN n.name AS name, n.seq AS seq ORDER BY name`,
    );
    const seqByName = Object.fromEntries(
      result.records.map(record => [record.get("name"), number(record.get("seq"))]),
    );
    assert.equal(seqByName.c, 9, "an unrelated unique seq must remain stable");
    assert.equal(seqByName.d, 11, "the current maximum must remain stable");
    assert.equal(new Set(Object.values(seqByName)).size, 4, "all seq values must be unique afterwards");
    assert.ok(Math.max(seqByName.a, seqByName.b) > 11, "the repaired value is allocated above the old maximum");

    assert.equal(
      await repairSeq(db.session, options),
      0,
      "a healthy graph must not be rewritten again",
    );
  } finally {
    await db.cleanup();
  }
});

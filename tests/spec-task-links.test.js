/**
 * Tests für die Verknüpfung der aus einem Diagramm erzeugten Tasks
 * (scripts/spec/spec_db.cjs — emitTask, ensureDiagramEpic).
 *
 * Worum es geht: ein Task, der aus einer Diagrammlücke entsteht, hing bisher
 * ausschließlich per AFFECTS an einem CODE-Knoten — und Use-Case-Tasks
 * gar nicht, weil es dort per Definition noch keinen Code gibt. Damit fand ein
 * Worker nie zurück zum Diagramm, obwohl genau das die Vorlage seiner Arbeit
 * ist. Der umgekehrte Weg (Code -> REALIZED_BY -> Spec) kann das nicht lösen:
 * ein Knoten, der erst gebaut werden soll, trägt keine solche Kante.
 *
 * Ansatz wie in tests/spec-rebind.test.js: Fake-Session, die Cypher mitschreibt.
 */

const test = require('node:test');
const assert = require('node:assert');
const { emitTask, ensureDiagramEpic } = require('../scripts/spec/spec_db.cjs');

/** @param {Record<string, any[]>} byFragment Cypher-Fragment -> Ergebniszeilen */
function fakeSession(byFragment = {}) {
    const runs = [];
    return {
        runs,
        async run(cypher, params) {
            runs.push({ cypher, params });
            for (const [fragment, rows] of Object.entries(byFragment)) {
                if (cypher.includes(fragment)) {
                    return { records: rows.map(row => ({ get: k => row[k], keys: Object.keys(row) })) };
                }
            }
            return { records: [] };
        },
        async close() {},
    };
}

const find = (session, fragment) => session.runs.find(r => r.cypher.includes(fragment));
const all = (session, fragment) => session.runs.filter(r => r.cypher.includes(fragment));

test('ohne Diagrammbezug bleibt alles wie vorher', async () => {
    const session = fakeSession();
    await emitTask(session, 'Titel', 'Beschreibung', 'Anweisung', 'high', 'Class||file=a.py||name=Foo');

    assert.ok(find(session, 'CREATE (t:Task'), 'Task wird angelegt');
    assert.ok(find(session, 'MERGE (t)-[:AFFECTS]->(n)'), 'AFFECTS auf den Code-Knoten');
    assert.ok(!find(session, 'APPLIES_TO'), 'keine Spec-Kante ohne Diagramm');
    assert.ok(!find(session, 'FULFILLED_BY'), 'kein Epic ohne Diagramm');
});

test('mit Diagrammbezug: Spec-Knoten zeigt auf den Task', async () => {
    const session = fakeSession();
    await emitTask(session, 'Implement use case: Adresse eingeben', 'd', 'w', 'medium', null,
        { specId: 'sample-usecase', specNodeName: 'UC1', specNodeLabel: 'SpecUseCase' });

    const link = find(session, 'MERGE (p)-[:APPLIES_TO]->(t)');
    assert.ok(link, 'die Kante Spec -> Task wird gezogen');
    assert.strictEqual(link.params.specId, 'sample-usecase');
    assert.strictEqual(link.params.nodeName, 'UC1', 'der Knotenname, nicht der Anzeigetext');
    assert.strictEqual(link.params.nodeLabel, 'SpecUseCase');
    assert.ok(!find(session, 'MERGE (t)-[:AFFECTS]->(n)'),
        'ohne Code-Knoten keine AFFECTS-Kante — genau der Fall, für den die Spec-Kante existiert');
});

test('der Task landet im Epic des Diagramms', async () => {
    const session = fakeSession({
        'RETURN s.title AS title': [{ title: 'Sample Project - Use Cases', sourceFile: 'usecase.puml' }],
    });
    await emitTask(session, 't', 'd', 'w', 'medium', null,
        { specId: 'sample-usecase', specNodeName: 'UC1', specNodeLabel: 'SpecUseCase' });

    const epic = find(session, 'CREATE (e:Epic');
    assert.ok(epic, 'das Epic entsteht beim ersten Task');
    assert.strictEqual(epic.params.epicId, 'epic-spec-sample-usecase',
        'die epicId leitet sich fest aus der specId ab');
    assert.match(epic.params.title, /Sample Project - Use Cases/, 'der Diagrammtitel steht im Epic-Titel');

    const member = find(session, 'MERGE (e)-[:FULFILLED_BY]->(t)');
    assert.ok(member, 'der Task haengt am Epic');
    assert.strictEqual(member.params.epicId, 'epic-spec-sample-usecase');
});

test('ein zweiter Lauf benutzt dasselbe Epic weiter', async () => {
    const session = fakeSession({
        'MATCH (e:Epic {taskId: $epicId}) RETURN': [{ epicId: 'epic-spec-diagram-1' }],
    });
    await emitTask(session, 't', 'd', 'w', 'medium', null,
        { specId: 'diagram-1', specNodeName: 'X', specNodeLabel: 'SpecClass' });

    assert.ok(!find(session, 'CREATE (e:Epic'), 'kein zweites Epic daneben');
    assert.ok(find(session, 'MERGE (e)-[:FULFILLED_BY]->(t)'), 'der Task haengt trotzdem daran');
});

test('ensureDiagramEpic ist idempotent und faellt auf die specId zurueck', async () => {
    const leer = fakeSession();   // kein Diagramm gefunden, kein Epic vorhanden
    const epicId = await ensureDiagramEpic(leer, 'namenloses-diagramm');
    assert.strictEqual(epicId, 'epic-spec-namenloses-diagramm');
    const created = find(leer, 'CREATE (e:Epic');
    assert.match(created.params.title, /namenloses-diagramm/,
        'ohne Titel im Diagramm dient die specId als Name');

    const vorhanden = fakeSession({
        'MATCH (e:Epic {taskId: $epicId}) RETURN': [{ epicId: 'epic-spec-x' }],
    });
    assert.strictEqual(await ensureDiagramEpic(vorhanden, 'x'), 'epic-spec-x');
    assert.strictEqual(all(vorhanden, 'CREATE').length, 0, 'nichts wird angelegt');
});

test('jeder der vier Knotentypen kann verlinkt werden', async () => {
    for (const [label, name] of [
        ['SpecClass', 'GeocodeService'],
        ['SpecParticipant', 'API'],
        ['SpecUseCase', 'UC7'],
        ['SpecProcess', 'Analyse durchfuehren'],
    ]) {
        const session = fakeSession();
        await emitTask(session, 't', 'd', 'w', 'low', null,
            { specId: 'spec-1', specNodeName: name, specNodeLabel: label });
        const link = find(session, 'MERGE (p)-[:APPLIES_TO]->(t)');
        assert.ok(link, `${label} wird verlinkt`);
        assert.strictEqual(link.params.nodeLabel, label);
        assert.strictEqual(link.params.nodeName, name);
    }
});

/**
 * Tests für den Spec->Code-Rebind (scripts/spec/spec_db.cjs).
 *
 * Warum ausgerechnet hier: dieser Pfad kann nicht krachen, er kann nur still
 * nichts mehr verbinden. In einem betroffenen Graphen standen 13
 * SpecClass-Knoten auf status='exact' mit einer uid, die es in dieser
 * SCHREIBWEISE nicht mehr gab (`Class||name=…||file=…` statt der kanonisch
 * sortierten `Class||file=…||name=…`) — 0 REALIZED_BY-Kanten, keine Meldung,
 * und `relinkRealizations` probierte nach jedem Build denselben String.
 *
 * Ansatz wie in tests/idea-dump.test.js: Fake-Session, die auf
 * Cypher-Fragmente matcht. Keine echte DB.
 */

const test = require('node:test');
const assert = require('node:assert');
const { linkRealization, parseUidHint } = require('../scripts/spec/spec_db.cjs');

const SORTED = 'Class||file=src/services/geocode.py||name=GeocodeService';
const LEGACY = 'Class||name=GeocodeService||file=src/services/geocode.py';

/**
 * @param {object} opts
 *   direct  — uid, die ein direkter `c.uid = $uid` findet (sonst keine)
 *   byProps — Treffer der Eigenschaftssuche: Array von uids (0, 1 oder mehr)
 */
function fakeSession({ direct = null, byProps = [] } = {}) {
    const runs = [];
    return {
        runs,
        async run(cypher, params) {
            runs.push({ cypher, params });
            const rows = (values) => ({ records: values.map(v => ({ get: () => v })) });

            if (cypher.includes('MATCH (c) WHERE c.uid = $uid RETURN c.uid'))
                return rows(direct && params.uid === direct ? [direct] : []);
            if (cypher.includes('c.label = $label AND c.uid IS NOT NULL'))
                return rows(byProps);
            if (cypher.includes('MERGE (p)-[e:REALIZED_BY]->(c)'))
                return rows([params.uid]);
            return { records: [] };
        },
        async close() {},
    };
}

const args = (uid) => ({ specId: 'spec-1', nodeName: 'GeocodeService', label: 'SpecClass', uid, confidence: 'exact' });

test('parseUidHint — zerlegt beide Schreibweisen gleich', () => {
    for (const uid of [SORTED, LEGACY]) {
        const hint = parseUidHint(uid);
        assert.strictEqual(hint.label, 'Class');
        assert.strictEqual(hint.name, 'GeocodeService');
        assert.strictEqual(hint.file, 'src/services/geocode.py');
    }
});

test('parseUidHint — uids ohne Segmente geben null', () => {
    assert.strictEqual(parseUidHint('specclass:6155'), null);
    assert.strictEqual(parseUidHint('a3f9c1b2d4e5f607'), null);
    assert.strictEqual(parseUidHint(null), null);
});

test('direkter Treffer: Kante wird gezogen, der Hinweis bleibt unangetastet', async () => {
    const session = fakeSession({ direct: SORTED });
    const ok = await linkRealization(session, args(SORTED));
    assert.strictEqual(ok, true);
    assert.ok(session.runs.some(r => r.cypher.includes('REALIZED_BY')), 'Kante gezogen');
    assert.ok(!session.runs.some(r => r.cypher.includes('SET p.value')), 'kein unnoetiges Umschreiben');
});

test('alte Schreibweise: findet den Knoten ueber (label, name, file) und schreibt den Hinweis um', async () => {
    const session = fakeSession({ direct: SORTED, byProps: [SORTED] });
    const ok = await linkRealization(session, args(LEGACY));
    assert.strictEqual(ok, true, 'der Knoten existiert, nur unter anderer uid-Schreibweise');

    const rewrite = session.runs.find(r => r.cypher.includes('SET p.value'));
    assert.ok(rewrite, 'der Hinweis wird auf die aktuelle uid umgeschrieben');
    assert.strictEqual(rewrite.params.newUid, SORTED);

    const merge = session.runs.find(r => r.cypher.includes('REALIZED_BY'));
    assert.strictEqual(merge.params.uid, SORTED, 'die Kante zeigt auf die aufgeloeste uid, nicht auf den Hinweis');
});

test('mehrdeutig: lieber keine Bindung als eine erfundene', async () => {
    const session = fakeSession({ byProps: ['Class||file=a.py||name=X', 'Class||file=b.py||name=X'] });
    const ok = await linkRealization(session, args(LEGACY));
    assert.strictEqual(ok, false);
    assert.ok(!session.runs.some(r => r.cypher.includes('REALIZED_BY')), 'keine Kante');
});

test('Knoten wirklich weg (umbenannt/geloescht): bleibt unrealisiert', async () => {
    const session = fakeSession({ byProps: [] });
    const ok = await linkRealization(session, args(SORTED));
    assert.strictEqual(ok, false);
    assert.ok(!session.runs.some(r => r.cypher.includes('SET p.value')), 'kein Hinweis auf einen Knoten, den es nicht gibt');
});

test('ohne uid passiert gar nichts', async () => {
    const session = fakeSession();
    assert.strictEqual(await linkRealization(session, args(null)), false);
    assert.strictEqual(session.runs.length, 0, 'keine einzige Query');
});

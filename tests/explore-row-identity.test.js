/**
 * Tests für frontend/src/explore/rowIdentity.js — welche Werte einer
 * Abfragezeile einen Knoten adressieren.
 *
 * Warum getestet: ein Fehler hier kracht nicht, er zeigt nur weniger. Eine
 * unerkannte Identität meldet die Zeile als „not representable", der Knopf
 * „Show" fehlt, und der Abfragegraph bleibt leer — in einem betroffenen
 * Projektgraphen galt das für JEDEN zur Laufzeit angelegten Knoten:
 * Task (`task:259`), Knowledge (`knowledge:341`), Epic, Idea und alle
 * Spec*-Knoten (`specmethod:5538`). Erkannt wurde nur die Builder-Form
 * `Label||key=value`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../frontend/src/explore/rowIdentity.js');

test('erkennt die Builder-Form Label||key=value', async () => {
    const { rowKeys } = await load();
    const { uids } = rowKeys({ uid: 'Function||file=../sample-project/src/app.py||name=geocode', name: 'geocode' });
    assert.deepEqual(uids, ['Function||file=../sample-project/src/app.py||name=geocode']);
});

test('erkennt die Laufzeit-Form praefix:seq — der eigentliche Fehler', async () => {
    const { rowKeys } = await load();
    for (const uid of ['task:259', 'knowledge:341', 'specmethod:5538', 'epic:5241', 'idea:5599']) {
        const { uids } = rowKeys({ uid, title: 'egal' });
        assert.deepEqual(uids, [uid], `${uid} muss als Identität gelten`);
    }
});

test('eine Spalte namens uid gilt, wie der Wert auch aussieht', async () => {
    const { rowKeys } = await load();
    // Eine dritte uid-Form würde sonst dasselbe Loch neu aufreissen.
    const { uids } = rowKeys({ uid: 'irgendeine-neue-form-42', name: 'x' });
    assert.deepEqual(uids, ['irgendeine-neue-form-42']);
    for (const col of ['elementId', 'nodeId', 'UID']) {
        assert.deepEqual(rowKeys({ [col]: 'was-auch-immer' }).uids, ['was-auch-immer'], col);
    }
});

test('ipv6 bleibt ipv6, auch in einer Spalte namens uid', async () => {
    const { rowKeys } = await load();
    const ipv6 = 'fd00:0002:b6ac:5100:05ed:0000:0000:0001';
    assert.deepEqual(rowKeys({ uid: ipv6 }).ipv6s, [ipv6]);
    assert.deepEqual(rowKeys({ uid: ipv6 }).uids, []);
});

test('beide Enden einer Kante, aus frei benannten Spalten', async () => {
    const { rowKeys } = await load();
    const { uids } = rowKeys({
        caller: 'Function||file=a.py||name=f',
        callee: 'Function||file=b.py||name=g',
    });
    assert.equal(uids.length, 2);
});

test('collect()-Listen werden aufgeloest', async () => {
    const { rowKeys } = await load();
    const { uids } = rowKeys({ callees: ['task:1', 'task:2'], name: 'x' });
    assert.deepEqual(uids, ['task:1', 'task:2']);
});

test('gewoehnliche Werte sind keine Identitaeten', async () => {
    const { rowKeys } = await load();
    const { uids, ipv6s } = rowKeys({
        name: 'geocode', file: '../sample-project/src/app.py', lines: 42, leer: null,
        text: 'ein Satz mit: Doppelpunkt', version: 'v1:2',
    });
    assert.deepEqual(ipv6s, []);
    // `v1:2` sieht der Laufzeitform aehnlich — und ist absichtlich zugelassen,
    // weil eine falsche uid nur ins Leere greift, eine verpasste dagegen die
    // Zeile unbrauchbar macht. Der Rest darf nicht mitgehen.
    assert.ok(!uids.includes('geocode'));
    assert.ok(!uids.includes('../sample-project/src/app.py'));
    assert.ok(!uids.includes('ein Satz mit: Doppelpunkt'));
});

test('rowIpv6s liefert uids und ipv6 zusammen', async () => {
    const { rowIpv6s } = await load();
    const both = rowIpv6s({ uid: 'task:259', addr: 'fd00:0002:b6ac:5100:05ed:0000:0000:0001' });
    assert.equal(both.length, 2);
    assert.equal(both[0], 'task:259', 'uids stehen vorn');
});

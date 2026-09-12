/**
 * Tests for the class-diagram layer.
 *
 * The renderer is exercised directly (pure), the model against a fake session
 * that answers Cypher by pattern. A fake beats a real database here: the point
 * is what the model does with the rows — external bases, the method cap, the
 * inheritance-beats-uses rule — not whether the driver works.
 */

const test = require('node:test');
const assert = require('node:assert');

const { readClassModel } = require('../scripts/diagram/class_model.cjs');
const { renderClassDiagram, methodLine } = require('../scripts/diagram/class_render.cjs');

/** Minimal stand-in for a driver session: matches on a fragment of the query. */
function fakeSession(byFragment) {
    return {
        async run(cypher) {
            for (const [fragment, rows] of Object.entries(byFragment)) {
                if (cypher.includes(fragment)) {
                    return { records: rows.map((row) => ({ get: (k) => row[k] })) };
                }
            }
            return { records: [] };
        },
    };
}

const CLASSES = [
    { name: 'Session', file: 'server/driver.cjs', startLine: 10 },
    { name: 'Driver', file: 'server/driver.cjs', startLine: 100 },
];

test('readClassModel — classes, methods and inheritance to a real class', async () => {
    const session = fakeSession({
        'MATCH (c:Class)\n': CLASSES,
        '-[:CONTAINS]->(f:Function)\n            RETURN c.name AS cls, c.file AS clsFile,\n                   f.name AS fn, f.signature': [
            { cls: 'Session', clsFile: 'server/driver.cjs', fn: 'run', signature: 'run(cypher, params)', startLine: 20 },
            { cls: 'Session', clsFile: 'server/driver.cjs', fn: 'close', signature: 'close()', startLine: 30 },
        ],
        '-[:INHERITS]->(b:Class)': [
            { aName: 'Driver', aFile: 'server/driver.cjs', bName: 'Session', bFile: 'server/driver.cjs' },
        ],
    });

    const model = await readClassModel(session, { includeUses: false });

    assert.strictEqual(model.stats.classes, 2);
    assert.strictEqual(model.stats.inheritance, 1);
    const session_ = model.classes.find((c) => c.name === 'Session');
    assert.deepStrictEqual(session_.methods.map((m) => m.name), ['run', 'close'], 'methods keep source order');
});

test('readClassModel — an external base becomes its own <<external>> node', async () => {
    const session = fakeSession({
        'MATCH (c:Class)\n': [{ name: 'MyNode', file: 'src/node.py', startLine: 1 }],
        '-[:INHERITS]->(b:ExternalBase)': [
            { aName: 'MyNode', aFile: 'src/node.py', bName: 'rclpy.node.Node' },
        ],
    });

    const model = await readClassModel(session, { includeUses: false });

    const external = model.classes.find((c) => c.external);
    assert.ok(external, 'a library base class is part of the architecture and must appear');
    assert.strictEqual(external.name, 'rclpy.node.Node');
    assert.strictEqual(model.stats.externalBases, 1);
    assert.strictEqual(model.stats.classes, 1, 'the external base is not counted as project code');
});

test('readClassModel — the method cap is recorded, not silently applied', async () => {
    const methods = Array.from({ length: 20 }, (_, i) => ({
        cls: 'Big', clsFile: 'src/big.js', fn: `m${i}`, signature: `m${i}()`, startLine: i,
    }));
    const session = fakeSession({
        'MATCH (c:Class)\n': [{ name: 'Big', file: 'src/big.js', startLine: 1 }],
        'f.name AS fn, f.signature': methods,
    });

    const model = await readClassModel(session, { maxMethods: 5, includeUses: false });
    const big = model.classes[0];

    assert.strictEqual(big.methods.length, 5);
    assert.strictEqual(big.hiddenMethods, 15);
    assert.strictEqual(model.stats.methods, 20, 'stats report the real total, not the shown one');
});

test('readClassModel — calls between methods become a uses relation, inheritance wins', async () => {
    const session = fakeSession({
        'MATCH (c:Class)\n': [
            { name: 'A', file: 'src/a.js', startLine: 1 },
            { name: 'B', file: 'src/b.js', startLine: 1 },
            { name: 'C', file: 'src/c.js', startLine: 1 },
        ],
        'f.name AS fn, f.signature': [],
        'f.file AS fnFile, f.owner AS fnOwner': [
            { cls: 'A', clsFile: 'src/a.js', fn: 'callB', fnFile: 'src/a.js' },
            { cls: 'B', clsFile: 'src/b.js', fn: 'target', fnFile: 'src/b.js' },
            { cls: 'C', clsFile: 'src/c.js', fn: 'inherited', fnFile: 'src/c.js' },
            { cls: 'A', clsFile: 'src/a.js', fn: 'callC', fnFile: 'src/a.js' },
        ],
        '-[:INHERITS]->(b:Class)': [
            { aName: 'A', aFile: 'src/a.js', bName: 'C', bFile: 'src/c.js' },
        ],
        '(a:Function)-[:CALLS]->(b:Function)': [
            { aName: 'callB', aFile: 'src/a.js', bName: 'target', bFile: 'src/b.js' },
            { aName: 'callC', aFile: 'src/a.js', bName: 'inherited', bFile: 'src/c.js' },
        ],
    });

    const model = await readClassModel(session);
    const kinds = model.relations.map((r) => `${r.from.split('|')[0]}-${r.kind}->${r.to.split('|')[0]}`);

    assert.ok(kinds.includes('A-uses->B'));
    assert.ok(kinds.includes('A-inherits->C'));
    assert.ok(!kinds.includes('A-uses->C'), 'inheritance already says more than uses');
});

test('readClassModel — a constructor call becomes a creates relation', async () => {
    const session = fakeSession({
        'MATCH (c:Class)\n': [
            { name: 'Driver', file: 'src/driver.js', startLine: 1 },
            { name: 'Session', file: 'src/session.js', startLine: 1 },
        ],
        'f.file AS fnFile, f.owner AS fnOwner': [
            { cls: 'Driver', clsFile: 'src/driver.js', fn: 'session', fnFile: 'src/driver.js' },
        ],
        '-[:INSTANTIATES]->(t:Class)': [
            { fn: 'session', fnFile: 'src/driver.js', target: 'Session', targetFile: 'src/session.js' },
        ],
    });

    const model = await readClassModel(session, { includeUses: false });

    assert.strictEqual(model.stats.creates, 1);
    assert.deepStrictEqual(
        model.relations.map((r) => r.kind),
        ['creates'],
        'creating an object is the association a class diagram must show'
    );
});

test('readClassModel — creates beats uses for the same pair', async () => {
    const session = fakeSession({
        'MATCH (c:Class)\n': [
            { name: 'A', file: 'a.js', startLine: 1 },
            { name: 'B', file: 'b.js', startLine: 1 },
        ],
        'f.file AS fnFile, f.owner AS fnOwner': [
            { cls: 'A', clsFile: 'a.js', fn: 'make', fnFile: 'a.js' },
            { cls: 'B', clsFile: 'b.js', fn: 'run', fnFile: 'b.js' },
        ],
        '-[:INSTANTIATES]->(t:Class)': [
            { fn: 'make', fnFile: 'a.js', target: 'B', targetFile: 'b.js' },
        ],
        '(a:Function)-[:CALLS]->(b:Function)': [
            { aName: 'make', aFile: 'a.js', bName: 'run', bFile: 'b.js' },
        ],
    });

    const model = await readClassModel(session);

    assert.deepStrictEqual(model.relations.map((r) => r.kind), ['creates'], 'one arrow per pair, the stronger one');
    assert.strictEqual(model.stats.uses, 0);
});

test('readClassModel — onlyConnected drops isolated classes', async () => {
    const session = fakeSession({
        'MATCH (c:Class)\n': [
            { name: 'Lonely', file: 'src/l.js', startLine: 1 },
            { name: 'Child', file: 'src/c.js', startLine: 1 },
            { name: 'Parent', file: 'src/p.js', startLine: 1 },
        ],
        '-[:INHERITS]->(b:Class)': [
            { aName: 'Child', aFile: 'src/c.js', bName: 'Parent', bFile: 'src/p.js' },
        ],
    });

    const model = await readClassModel(session, { onlyConnected: true, includeUses: false });

    assert.deepStrictEqual(model.classes.map((c) => c.name).sort(), ['Child', 'Parent']);
});

test('readClassModel — test classes can be excluded without hiding production classes', async () => {
    const session = fakeSession({
        'MATCH (c:Class)\n': [
            { name: 'Service', file: 'src/service.py', startLine: 1 },
            { name: 'FakeService', file: 'tests/test_service.py', startLine: 1 },
            { name: 'WidgetSpec', file: 'viewer/src/Widget.spec.ts', startLine: 1 },
        ],
    });

    const model = await readClassModel(session, { includeTests: false, includeUses: false });
    assert.deepStrictEqual(model.classes.map((c) => c.name), ['Service']);
});

test('renderClassDiagram — PlantUML is well-formed and states the cap', () => {
    const model = {
        classes: [
            { key: 'A|a.js', name: 'A', file: 'a.js', external: false, methods: [{ name: 'go', signature: 'go(x)' }], hiddenMethods: 3 },
            { key: 'Base|', name: 'rclcpp::Node', file: null, external: true, methods: [], hiddenMethods: 0 },
        ],
        relations: [{ from: 'A|a.js', to: 'Base|', kind: 'inherits' }],
        stats: {},
    };

    const uml = renderClassDiagram(model, { format: 'plantuml', title: 'T' });

    assert.match(uml, /^@startuml/);
    assert.match(uml, /@enduml$/);
    assert.match(uml, /class "rclcpp::Node" as C1 <<external>>/);
    assert.match(uml, /C0 --\|> C1/);
    assert.match(uml, /\.\. 3 more \.\./, 'a truncated class must not read as complete');
});

test('renderClassDiagram — duplicate class names include their source path', () => {
    const model = {
        classes: [
            { key: 'Frame|src/frame.py', name: 'Frame', file: 'src/frame.py', attributes: [], methods: [] },
            { key: 'Frame|viewer/frame.ts', name: 'Frame', file: 'viewer/frame.ts', attributes: [], methods: [] },
        ],
        relations: [], stats: {},
    };
    const uml = renderClassDiagram(model, { format: 'plantuml' });
    const mmd = renderClassDiagram(model, { format: 'mermaid' });
    assert.match(uml, /Frame — src\/frame\.py/);
    assert.match(mmd, /Frame — viewer\/frame\.ts/);
});

test('renderClassDiagram — Mermaid draws generalisation parent-first', () => {
    const model = {
        classes: [
            { key: 'A|a.js', name: 'A', file: 'a.js', external: false, methods: [], hiddenMethods: 0 },
            { key: 'B|b.js', name: 'B', file: 'b.js', external: false, methods: [], hiddenMethods: 0 },
        ],
        relations: [{ from: 'A|a.js', to: 'B|b.js', kind: 'inherits' }],
        stats: {},
    };

    const mmd = renderClassDiagram(model, { format: 'mermaid' });

    assert.match(mmd, /classDiagram/);
    assert.match(mmd, /C1 <\|-- C0/, 'mermaid expects parent <|-- child');
});

test('renderClassDiagram — Mermaid member signatures cannot alter class structure', () => {
    const model = {
        classes: [{
            key: 'A|a.js',
            name: 'A',
            file: 'a.js',
            external: false,
            methods: [{ name: 'run', signature: 'run(ns::Type, params = {}, value = <T>)' }],
            hiddenMethods: 2,
        }],
        relations: [],
        stats: {},
    };

    const memberLines = renderClassDiagram(model, { format: 'mermaid' })
        .split('\n')
        .filter((line) => line.startsWith('  C0 :'));

    assert.strictEqual(memberLines.length, 2);
    for (const line of memberLines) {
        // Exactly one colon: the `ClassId : member` separator. Braces and angle
        // brackets stay as written — tests/class-mermaid-render.test.js renders
        // them in a browser and Mermaid accepts them inside member text.
        assert.strictEqual((line.match(/:/g) || []).length, 1);
    }
});

test('renderClassDiagram — a creates relation is drawn as a <<create>> dependency', () => {
    const model = {
        classes: [
            { key: 'A|a.js', name: 'A', file: 'a.js', external: false, methods: [], hiddenMethods: 0 },
            { key: 'B|b.js', name: 'B', file: 'b.js', external: false, methods: [], hiddenMethods: 0 },
        ],
        relations: [{ from: 'A|a.js', to: 'B|b.js', kind: 'creates' }],
        stats: {},
    };

    assert.match(renderClassDiagram(model, { format: 'plantuml' }), /C0 \.\.> C1 : <<create>>/);
    assert.match(renderClassDiagram(model, { format: 'mermaid' }), /C0 \.\.> C1 : creates/);
});

test('renderClassDiagram — quotes in names cannot break the output', () => {
    const model = {
        classes: [{ key: 'X|x.js', name: 'Weird"Name', file: 'x.js', external: false, methods: [], hiddenMethods: 0 }],
        relations: [],
        stats: {},
    };

    assert.ok(!renderClassDiagram(model, { format: 'plantuml' }).includes('"Weird"Name"'));
    assert.ok(!renderClassDiagram(model, { format: 'mermaid' }).includes('"Weird"Name"'));
});

test('renderClassDiagram — an unknown format fails loudly', () => {
    assert.throws(() => renderClassDiagram({ classes: [], relations: [] }, { format: 'svg' }), /Unknown diagram format/);
});

test('methodLine — long signatures are capped', () => {
    const line = methodLine({ name: 'f', signature: `f(${'a'.repeat(200)})` }, 40);
    assert.strictEqual(line.length, 40);
    assert.ok(line.endsWith('…'));
});

/**
 * Tests for the attribute compartment and the association arrow.
 *
 * Both exist because a class diagram that shows only methods misreads a data
 * model: a Python dataclass declares its whole shape as fields and has no
 * methods at all, so `Location`/`POI`/`Waypoint` rendered as empty boxes with
 * no arrows between them — while the graph already held every field and every
 * field type. Same fake-session approach as class-diagram.test.js: what matters
 * is what the model does with the rows.
 */

const test = require('node:test');
const assert = require('node:assert');

const { readClassModel } = require('../scripts/diagram/class_model.cjs');
const { renderClassDiagram } = require('../scripts/diagram/class_render.cjs');

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

const MODEL_CLASSES = [
    { name: 'Location', file: 'app/models.py', startLine: 30 },
    { name: 'POI', file: 'app/models.py', startLine: 38 },
];

const FIELDS = [
    { cls: 'Location', clsFile: 'app/models.py', attr: 'lat', declaredType: 'float', startLine: 32 },
    { cls: 'Location', clsFile: 'app/models.py', attr: 'lon', declaredType: 'float', startLine: 33 },
    { cls: 'POI', clsFile: 'app/models.py', attr: 'location', declaredType: 'Location', startLine: 41 },
];

test('readClassModel — declared fields become attributes with their types', async () => {
    const session = fakeSession({
        'MATCH (c:Class)\n': MODEL_CLASSES,
        "-[:DECLARES]->(v:Variable)": FIELDS,
    });

    const model = await readClassModel(session, { includeUses: false });

    const location = model.classes.find((c) => c.name === 'Location');
    assert.deepStrictEqual(
        location.attributes.map((a) => `${a.name}: ${a.declaredType}`),
        ['lat: float', 'lon: float'],
        'source order, with the annotated type kept'
    );
    assert.strictEqual(model.stats.attributes, 3);
});

test('readClassModel — a field assigned twice is one attribute, and keeps the typed record', async () => {
    const session = fakeSession({
        'MATCH (c:Class)\n': [{ name: 'Service', file: 'app/svc.py', startLine: 1 }],
        "-[:DECLARES]->(v:Variable)": [
            // `self._ts` assigned in __init__ and again in a reset path: one field.
            { cls: 'Service', clsFile: 'app/svc.py', attr: '_ts', declaredType: null, startLine: 12 },
            { cls: 'Service', clsFile: 'app/svc.py', attr: '_ts', declaredType: 'float', startLine: 40 },
        ],
    });

    const model = await readClassModel(session, { includeUses: false });
    const svc = model.classes[0];

    assert.strictEqual(svc.attributes.length, 1, 'deduplicated by name');
    assert.strictEqual(svc.attributes[0].declaredType, 'float', 'the record that knows a type wins');
});

test('readClassModel — a field typed as another class becomes an association', async () => {
    const session = fakeSession({
        'MATCH (c:Class)\n': MODEL_CLASSES,
        "-[:DECLARES]->(v:Variable)": FIELDS,
        '-[e:USES_TYPE]->(b:Class)': [
            { aName: 'POI', aFile: 'app/models.py', bName: 'Location', bFile: 'app/models.py' },
        ],
    });

    const model = await readClassModel(session, { includeUses: false });

    assert.strictEqual(model.stats.associations, 1);
    const assoc = model.relations.find((r) => r.kind === 'association');
    assert.ok(assoc, 'an association relation exists');
    assert.ok(assoc.from.startsWith('POI|'), 'points from the class that holds the field');
});

test('readClassModel — inheritance beats an association for the same pair', async () => {
    const session = fakeSession({
        'MATCH (c:Class)\n': [
            { name: 'Base', file: 'app/base.py', startLine: 1 },
            { name: 'Child', file: 'app/child.py', startLine: 1 },
        ],
        '-[:INHERITS]->(b:Class)': [
            { aName: 'Child', aFile: 'app/child.py', bName: 'Base', bFile: 'app/base.py' },
        ],
        '-[e:USES_TYPE]->(b:Class)': [
            { aName: 'Child', aFile: 'app/child.py', bName: 'Base', bFile: 'app/base.py' },
        ],
    });

    const model = await readClassModel(session, { includeUses: false });

    assert.strictEqual(model.stats.inheritance, 1);
    assert.strictEqual(model.stats.associations, 0, 'the stronger relation is the only arrow');
});

test('renderClassDiagram — attributes are drawn, split from methods by a compartment line', async () => {
    const model = {
        classes: [{
            key: 'POI|app/models.py', name: 'POI', file: 'app/models.py', external: false,
            attributes: [{ name: 'location', declaredType: 'Location' }],
            hiddenAttributes: 0,
            methods: [{ name: 'label', signature: 'label() -> str' }],
            hiddenMethods: 0,
        }],
        relations: [],
        stats: {},
    };

    const puml = renderClassDiagram(model, { format: 'plantuml' });
    assert.ok(puml.includes('location: Location'), 'attribute with its type');
    assert.ok(puml.includes('  --'), 'UML compartment separator between fields and methods');

    const mermaid = renderClassDiagram(model, { format: 'mermaid' });
    assert.ok(/C0 : location Location/.test(mermaid), 'Mermaid attribute, colon stripped');
});

test('renderClassDiagram — a dataclass gets no compartment line under nothing', async () => {
    const model = {
        classes: [{
            key: 'Location|app/models.py', name: 'Location', file: 'app/models.py', external: false,
            attributes: [{ name: 'lat', declaredType: 'float' }],
            hiddenAttributes: 0, methods: [], hiddenMethods: 0,
        }],
        relations: [],
        stats: {},
    };

    const puml = renderClassDiagram(model, { format: 'plantuml' });
    assert.ok(puml.includes('lat: float'));
    assert.ok(!puml.includes('  --'), 'no separator when there are no methods');
});

test('renderClassDiagram — PlantUML does not read a Python dunder as underline markup', async () => {
    const model = {
        classes: [{
            key: 'S|a.py', name: 'S', file: 'a.py', external: false,
            attributes: [], hiddenAttributes: 0,
            methods: [
                { name: '__init__', signature: '__init__(self, **kwargs) -> None' },
            ],
            hiddenMethods: 0,
        }],
        relations: [],
        stats: {},
    };

    const puml = renderClassDiagram(model, { format: 'plantuml' });
    // Unescaped, `__init__` is creole for underline and the box shows "init";
    // `**kwargs` is creole for bold and eats the asterisks.
    assert.ok(!/(^|[^~])__init__/m.test(puml), 'the dunder pair is escaped');
    assert.ok(puml.includes('~__init~__'), 'escaped with PlantUML\'s ~');
    assert.ok(puml.includes('~**kwargs'), 'a bold marker is escaped too');
});

test('renderClassDiagram — Mermaid keeps a dunder visible instead of styling it away', async () => {
    const model = {
        classes: [{
            key: 'S|a.py', name: 'S', file: 'a.py', external: false,
            attributes: [], hiddenAttributes: 0,
            methods: [{ name: '__init__', signature: '__init__(self) -> None' }],
            hiddenMethods: 0,
        }],
        relations: [],
        stats: {},
    };

    const mermaid = renderClassDiagram(model, { format: 'mermaid' });
    // Left raw, Mermaid reads `__…__` as emphasis and the box shows "init".
    assert.ok(!mermaid.includes('__init__'), 'the raw dunder does not reach the renderer');
    assert.ok(mermaid.includes('#95;#95;init#95;#95;'), 'written as Mermaid underscore entities');
    // A single leading underscore is not emphasis and stays readable as-is.
    assert.ok(renderClassDiagram({
        ...model,
        classes: [{ ...model.classes[0], methods: [{ name: '_helper', signature: '_helper()' }] }],
    }, { format: 'mermaid' }).includes('_helper'), 'ordinary private names are untouched');
});

test('renderClassDiagram — an association is a solid arrow, not a dashed dependency', async () => {
    const model = {
        classes: [
            { key: 'A|a.py', name: 'A', file: 'a.py', external: false, attributes: [], hiddenAttributes: 0, methods: [], hiddenMethods: 0 },
            { key: 'B|b.py', name: 'B', file: 'b.py', external: false, attributes: [], hiddenAttributes: 0, methods: [], hiddenMethods: 0 },
        ],
        relations: [{ from: 'A|a.py', to: 'B|b.py', kind: 'association' }],
        stats: {},
    };

    assert.ok(renderClassDiagram(model, { format: 'plantuml' }).includes('C0 --> C1'));
    assert.ok(renderClassDiagram(model, { format: 'mermaid' }).includes('C0 --> C1'));
});

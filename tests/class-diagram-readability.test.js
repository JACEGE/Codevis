/**
 * Readability options of the class diagram: public-only members, the uses
 * threshold and cap, the 'auto' simplifications for large diagrams,
 * stereotypes from Function.isAbstract, compact mode and directory grouping.
 * Defaults of readClassModel must stay what they were (MCP callers rely on it).
 */

const test = require('node:test');
const assert = require('node:assert');

const { readClassModel, isPublicMember } = require('../scripts/diagram/class_model.cjs');
const { renderClassDiagram } = require('../scripts/diagram/class_render.cjs');
const { parsePumlClass } = require('../scripts/spec/puml_class_parser.js');

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

const METHODS = 'f.name AS fn, f.signature';
const OWNERS = 'f.file AS fnFile, f.owner AS fnOwner';
const CALLS = '(a:Function)-[:CALLS]->(b:Function)';

test('isPublicMember — keeps __init__/constructor, hides _private, #private, dunders, private/protected', () => {
    assert.ok(isPublicMember('__init__'));
    assert.ok(isPublicMember('constructor'));
    assert.ok(isPublicMember('run'));
    assert.ok(!isPublicMember('_helper'));
    assert.ok(!isPublicMember('#secret'));
    assert.ok(!isPublicMember('__repr__'));
    assert.ok(!isPublicMember('run', 'private'));
    assert.ok(!isPublicMember('run', 'protected'));
});

test('readClassModel — memberVisibility public hides private members but counts them', async () => {
    const session = fakeSession({
        'MATCH (c:Class)\n': [{ name: 'S', file: 'src/s.py', startLine: 1 }],
        [METHODS]: [
            { cls: 'S', clsFile: 'src/s.py', fn: '__init__', signature: '__init__(self)', startLine: 2 },
            { cls: 'S', clsFile: 'src/s.py', fn: '__repr__', signature: '__repr__(self)', startLine: 3 },
            { cls: 'S', clsFile: 'src/s.py', fn: '_helper', signature: '_helper(self)', startLine: 4 },
            { cls: 'S', clsFile: 'src/s.py', fn: 'run', signature: 'run(self)', startLine: 5 },
        ],
        'v.scope = \'field\'': [
            { cls: 'S', clsFile: 'src/s.py', attr: '_cache', startLine: 2 },
            { cls: 'S', clsFile: 'src/s.py', attr: 'name', startLine: 2 },
        ],
    });
    const all = await readClassModel(session, { includeUses: false });
    assert.deepStrictEqual(all.classes[0].methods.map((m) => m.name), ['__init__', '__repr__', '_helper', 'run'], 'default is unchanged');

    const pub = await readClassModel(session, { includeUses: false, memberVisibility: 'public' });
    const s = pub.classes[0];
    assert.deepStrictEqual(s.methods.map((m) => m.name), ['__init__', 'run']);
    assert.strictEqual(s.hiddenMethods, 2);
    assert.deepStrictEqual(s.attributes.map((a) => a.name), ['name']);
    assert.strictEqual(s.hiddenAttributes, 1);
    assert.strictEqual(pub.stats.methods, 4, 'stats still report the real total');
});

test('readClassModel — the cap applies after the visibility filter and adds to hidden', async () => {
    const methods = Array.from({ length: 10 }, (_, i) => ({
        cls: 'B', clsFile: 'b.py', fn: i < 2 ? `_p${i}` : `m${i}`, signature: `m${i}()`, startLine: i,
    }));
    const session = fakeSession({ 'MATCH (c:Class)\n': [{ name: 'B', file: 'b.py' }], [METHODS]: methods });
    const model = await readClassModel(session, { includeUses: false, memberVisibility: 'public', maxMethods: 6 });
    assert.strictEqual(model.classes[0].methods.length, 6);
    assert.strictEqual(model.classes[0].hiddenMethods, 4);
});

function usesSession(classCount = 3) {
    const classes = Array.from({ length: classCount }, (_, i) => ({ name: `K${i}`, file: `src/d${i % 3}/k${i}.js` }));
    classes[0] = { name: 'A', file: 'src/a.js' };
    classes[1] = { name: 'B', file: 'src/b.js' };
    classes[2] = { name: 'C', file: 'src/c.js' };
    return fakeSession({
        'MATCH (c:Class)\n': classes,
        [OWNERS]: [
            { cls: 'A', clsFile: 'src/a.js', fn: 'a1', fnFile: 'src/a.js' },
            { cls: 'A', clsFile: 'src/a.js', fn: 'a2', fnFile: 'src/a.js' },
            { cls: 'B', clsFile: 'src/b.js', fn: 'b1', fnFile: 'src/b.js' },
            { cls: 'C', clsFile: 'src/c.js', fn: 'c1', fnFile: 'src/c.js' },
        ],
        [CALLS]: [
            { aName: 'a1', aFile: 'src/a.js', bName: 'b1', bFile: 'src/b.js' },
            { aName: 'a2', aFile: 'src/a.js', bName: 'b1', bFile: 'src/b.js' },
            { aName: 'a1', aFile: 'src/a.js', bName: 'c1', bFile: 'src/c.js' },
        ],
    });
}

const pairs = (model) => model.relations.map((r) => `${r.from.split('|')[0]}-${r.kind}->${r.to.split('|')[0]}`);

test('readClassModel — minUseCalls drops incidental uses arrows', async () => {
    const all = await readClassModel(usesSession());
    assert.deepStrictEqual(pairs(all), ['A-uses->B', 'A-uses->C']);
    assert.strictEqual(all.relations[0].calls, 2);
    const strong = await readClassModel(usesSession(), { minUseCalls: 2 });
    assert.deepStrictEqual(pairs(strong), ['A-uses->B']);
});

test('readClassModel — maxUses keeps the strongest arrows and reports the rest', async () => {
    const model = await readClassModel(usesSession(), { maxUses: 1 });
    assert.deepStrictEqual(pairs(model), ['A-uses->B']);
    assert.strictEqual(model.stats.usesOmitted, 1);
});

test('readClassModel — auto mode: small diagrams keep uses and isolated classes', async () => {
    const model = await readClassModel(usesSession(4), { includeUses: 'auto', onlyConnected: 'auto', groupByDirectory: 'auto', minUseCalls: 'auto' });
    assert.strictEqual(model.options.large, false);
    assert.strictEqual(model.options.includeUses, true);
    assert.strictEqual(model.options.onlyConnected, false);
    assert.strictEqual(model.options.groupByDirectory, false);
    assert.strictEqual(model.stats.classes, 4);
});

test('readClassModel — auto mode: large diagrams drop uses, hide isolated, group by folder', async () => {
    const model = await readClassModel(usesSession(45), { includeUses: 'auto', onlyConnected: 'auto', groupByDirectory: 'auto', minUseCalls: 'auto' });
    assert.strictEqual(model.options.large, true);
    assert.strictEqual(model.options.includeUses, false);
    assert.strictEqual(model.options.onlyConnected, true);
    assert.strictEqual(model.options.groupByDirectory, true);
    assert.strictEqual(model.options.minUseCalls, 2);
    assert.strictEqual(model.stats.classes, 0, 'without uses arrows nothing here is connected');
    assert.strictEqual(model.stats.isolatedHidden, 45);

    const explicit = await readClassModel(usesSession(45), { includeUses: true, onlyConnected: 'auto', minUseCalls: 'auto' });
    assert.deepStrictEqual(pairs(explicit), ['A-uses->B'], 'explicit uses on a large diagram still applies the threshold');

    const scoped = await readClassModel(usesSession(45), { groupByDirectory: 'auto', pathPrefix: 'src/' });
    assert.strictEqual(scoped.options.groupByDirectory, false, 'a path prefix is already a focus — no grouping');
});

test('readClassModel — stereotypes come from Function.isAbstract and ABC/Protocol bases', async () => {
    const session = fakeSession({
        'MATCH (c:Class)\n': [
            { name: 'Repo', file: 'r.ts' },
            { name: 'Base', file: 'b.py' },
            { name: 'Plain', file: 'p.py' },
            { name: 'Proto', file: 'q.py' },
        ],
        [METHODS]: [
            { cls: 'Repo', clsFile: 'r.ts', fn: 'get', isAbstract: true },
            { cls: 'Repo', clsFile: 'r.ts', fn: 'put', isAbstract: true },
            { cls: 'Base', clsFile: 'b.py', fn: 'run', isAbstract: true },
            { cls: 'Base', clsFile: 'b.py', fn: 'helper', isAbstract: false },
            { cls: 'Plain', clsFile: 'p.py', fn: 'run', isAbstract: null },
        ],
        '-[:INHERITS]->(b:ExternalBase)': [{ aName: 'Proto', aFile: 'q.py', bName: 'typing.Protocol' }],
    });
    const model = await readClassModel(session, { includeUses: false });
    const st = Object.fromEntries(model.classes.filter((c) => !c.external).map((c) => [c.name, c.stereotype]));
    assert.deepStrictEqual(st, { Repo: 'interface', Base: 'abstract', Plain: null, Proto: 'interface' });

    const puml = renderClassDiagram(model, { format: 'plantuml' });
    const mmd = renderClassDiagram(model, { format: 'mermaid' });
    assert.match(puml, /as C\d+ <<interface>>/);
    assert.match(mmd, /<<abstract>> C\d+/);
    const parsed = parsePumlClass(puml);
    const names = (parsed.classes || []).map((c) => c.name);
    for (const n of ['Repo', 'Base', 'Plain']) assert.ok(names.includes(n), `PlantUML round-trip lost ${n}`);
});

test('renderClassDiagram — compact drops members, uses arrows are unlabeled in Mermaid only', () => {
    const model = {
        classes: [
            { key: 'a', name: 'A', file: 'src/x/a.js', attributes: [{ name: 'f' }], methods: [{ name: 'run', signature: 'run()' }], hiddenMethods: 3 },
            { key: 'b', name: 'B', file: 'src/y/b.js', attributes: [], methods: [] },
        ],
        relations: [{ from: 'a', to: 'b', kind: 'uses' }],
        stats: { usesOmitted: 7 },
        options: { groupByDirectory: true },
    };
    const mmd = renderClassDiagram(model, { format: 'mermaid', compact: true });
    assert.ok(!/ : /.test(mmd.split('\n').slice(4).join('\n')), `compact Mermaid must not list members:\n${mmd}`);
    assert.match(mmd, /^ {2}C0 \.\.> C1$/m);
    assert.match(mmd, /%% 7 weaker uses arrows omitted/);
    assert.match(mmd, /namespace NS0\["src\/x"\] \{/, 'model.options.groupByDirectory is honoured');

    const flat = renderClassDiagram(model, { format: 'mermaid', groupByDirectory: false });
    assert.ok(!flat.includes('namespace'), 'an explicit option beats the model default');
    assert.match(flat, /C0 : run\(\)/);

    const puml = renderClassDiagram(model, { format: 'plantuml', compact: true });
    assert.match(puml, /C0 \.\.> C1 : uses/, 'PlantUML keeps its label for the round-trip');
    assert.ok(!puml.includes('run()'));
});

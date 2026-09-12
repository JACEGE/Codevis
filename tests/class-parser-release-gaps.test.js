const { test } = require('node:test');
const assert = require('node:assert/strict');
const { diagramFromSource, extractFromSource, loadLanguage } = require('./helpers/class-extract.cjs');
const { __testing__: builder } = require('../scripts/graph_builder.js');
const { openTestDb } = require('./helpers/ladybug-session.cjs');
const { readClassModel } = require('../scripts/diagram/class_model.cjs');

for (const ext of ['js', 'jsx', 'ts', 'tsx']) {
    test(`${ext}: anonymous default class keeps its members, source range and base`, async () => {
        const typed = ext.startsWith('ts');
        const r = await diagramFromSource(
            'class Base {}\n' + (typed ? 'interface I {}\n' : '')
            + `export default class extends Base${typed ? ' implements I' : ''} {\n`
            + '  count = 1;\n  run() {}\n}\n', `src/Store.${ext}`);
        assert.equal(r.extracted.parseError, false);
        const cls = r.model.classes.find(c => c.name === 'Store');
        assert.deepEqual(cls.methods.map(m => m.name), ['run']);
        assert.deepEqual(cls.attributes.map(a => a.name), ['count']);
        assert.deepEqual(r.extracted.inherits.map(e => [e.child, e.parent, e.external]),
            typed ? [['Store', 'Base', false], ['Store', 'I', false]] : [['Store', 'Base', false]]);
        assert.equal(r.extracted.classes.find(c => c.name === 'Store').endLine, typed ? 6 : 5);
    });

    test(`${ext}: default name cannot merge with a real same-file class`, async () => {
        const r = await extractFromSource('class Store {}\nexport default class extends Store { run() {} }', `Store.${ext}`);
        assert.deepEqual(r.classes.map(c => c.name), ['Store', 'Store:default']);
        assert.equal(r.functions[0].className, 'Store:default');
        assert.deepEqual(r.inherits.map(e => [e.child, e.parent]), [['Store:default', 'Store']]);
        const named = await extractFromSource('export default class Named { run() {} }', `Store.${ext}`);
        assert.deepEqual(named.classes.map(c => c.name), ['Named']);
    });
}

for (const ext of ['c', 'cpp']) {
    test(`${ext}: direct typedef aliases own their fields without duplicate bodies`, async () => {
        const r = await diagramFromSource('typedef struct {\n  int y;\n} Named, Other;\ntypedef struct Foo { int x; } Foo;\n', `n.${ext}`);
        assert.equal(r.extracted.parseError, false);
        assert.deepEqual(r.extracted.classes.map(c => c.name), ['Named', 'Foo']);
        assert.deepEqual(r.extracted.fields.map(f => [f.name, f.className]), [['y', 'Named'], ['x', 'Foo']]);
        assert.deepEqual(r.extracted.classes.map(c => [c.startLine, c.endLine]), [[1, 3], [4, 4]]);
        const pointers = await extractFromSource('typedef struct { int x; } *Ptr;\nstruct Forward;\n', `n.${ext}`);
        assert.deepEqual(pointers.classes, [], 'a pointer alias is not a value type');
    });
}

test('C++ enums have values and stereotypes, without turning references into definitions', async () => {
    const r = await diagramFromSource('enum class Mode : int { Fast = 1, Slow };\nenum Plain { On, Off };\nenum class Forward;\nenum Mode value;\n', 'mode.hpp');
    assert.equal(r.extracted.parseError, false);
    assert.deepEqual(r.model.classes.map(c => c.name).sort(), ['Mode', 'Plain']);
    for (const cls of r.model.classes) assert.equal(cls.kind, 'enumeration');
    assert.deepEqual(r.model.classes.find(c => c.name === 'Mode').attributes.map(a => a.name), ['Fast', 'Slow']);
    assert.match(r.mermaid, /<<enumeration>>/);
    assert.match(r.plantuml, /<<enumeration>>/);
    const capped = await diagramFromSource('enum class Mode { Fast, Slow };', 'mode.hpp', { maxAttributes: 1 });
    assert.equal(capped.model.classes[0].hiddenAttributes, 1);
});

for (const ext of ['ts', 'tsx']) {
    test(`${ext}: typed and private instance accessors retain their real names`, async () => {
        const r = await diagramFromSource('class A { accessor count: number = 0; accessor #secret = 1; plain = 2; }', `a.${ext}`);
        assert.equal(r.extracted.parseError, false);
        assert.deepEqual(r.model.classes[0].attributes.map(a => a.name).sort(), ['#secret', 'count', 'plain']);
    });

    test(`${ext}: static accessor syntax retains the actual field name`, async () => {
        const r = await diagramFromSource('class A { static accessor count = 0; plain = 1; }', `a.${ext}`);
        assert.equal(r.extracted.parseError, false);
        assert.deepEqual(r.model.classes[0].attributes.map(a => a.name).sort(), ['count', 'plain']);
    });
}

test('parser additions persist exact class identities, members and enum kinds in Ladybug', async () => {
    const db = await openTestDb();
    try {
        // Match the driver's transport conversion of its Integer shim.
        const run = db.session.run.bind(db.session);
        db.session.run = (query, params = {}) => run(query, Object.fromEntries(
            Object.entries(params).map(([key, value]) => [key, value?.toNumber ? value.toNumber() : value])));
        const { Parser } = require('web-tree-sitter');
        const parse = async (file, source) => {
            const { config, lang } = await loadLanguage(require('node:path').extname(file));
            const parser = new Parser();
            parser.setLanguage(lang);
            const tree = parser.parse(source);
            const cached = { lang };
            for (const key of Object.keys(config)) if (key.endsWith('Query')) cached[key] = builder.safeQuery(lang, config[key]);
            await db.session.run('MERGE (f:File {path: $path})', { path: file });
            const classes = await builder.extractClasses(db.session, cached, tree, file, { int: n => n });
            const functions = await builder.extractFunctions(db.session, cached, tree, file, { int: n => n }, classes);
            await builder.extractAllVariables(db.session, cached, tree, file, functions, classes);
            builder.invalidateClassResolution();
            await builder.extractClassInheritance(db.session, cached, tree, file);
            tree.delete(); parser.delete();
        };
        await parse('Store.js', 'class Base {}\nexport default class extends Base { count = 1; run() {} }');
        await parse('n.c', 'typedef struct { int y; } Named;');
        await parse('mode.hpp', 'enum class Mode { Fast, Slow };');
        const before = await db.session.run("MATCH (c:Class {name:'Store'}) RETURN elementId(c) AS id");
        const id = before.records[0].get('id');
        await db.session.run("CREATE (t:Task {taskId:'parser-regression'})");
        await db.session.run("MATCH (t:Task {taskId:'parser-regression'}), (c:Class) WHERE elementId(c) = $id MERGE (t)-[:AFFECTS]->(c)", { id });
        await parse('Store.js', 'class Base {}\nexport default class extends Base { count = 1; run() { return 2; } }');
        const links = await db.session.run("MATCH (t:Task {taskId:'parser-regression'})-[:AFFECTS]->(c:Class) RETURN elementId(c) AS id");
        assert.equal(links.records[0].get('id'), id);
        const model = await readClassModel(db.session);
        const store = model.classes.find(c => c.name === 'Store');
        assert.deepEqual(store.methods.map(m => m.name), ['run']);
        assert.deepEqual(store.attributes.map(a => a.name), ['count']);
        assert.equal(model.classes.find(c => c.name === 'Mode').kind, 'enumeration');
        assert.deepEqual(model.classes.find(c => c.name === 'Mode').attributes.map(a => a.name), ['Fast', 'Slow']);
        assert.deepEqual(model.classes.find(c => c.name === 'Named').attributes.map(a => a.name), ['y']);
    } finally { await db.cleanup(); }
});

/**
 * Adversarial tests for the class-diagram MODEL and RENDERER.
 *
 * class-diagram.test.js and class-attributes.test.js cover what the layer is
 * supposed to do. This file covers what it does when the graph hands it
 * something ugly: a class the builder recorded without a file, two classes in
 * one file that share a method name, a cap of zero, a name that is nothing but
 * spaces, a signature that still carries its semicolon. Each of these produced a
 * diagram that was either wrong about the code or refused to render at all.
 *
 * Same fake-session approach as its two siblings: what matters is what the model
 * does with the rows, not whether a driver works.
 *
 * The Mermaid claims are not guesses about its grammar — the block at the bottom
 * renders them in a real browser, and it renders the UNFIXED shapes too, so the
 * escaping cannot be deleted later as superstition. `{}`, `<>` and `~` are
 * deliberately absent from that list: they were measured and they parse fine.
 */

const test = require('node:test');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const { readClassModel, externalBaseKey } = require('../scripts/diagram/class_model.cjs');
const {
    renderClassDiagram, renderMermaid, mermaidMember, methodLine, classLabel,
} = require('../scripts/diagram/class_render.cjs');

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

// The query fragments the fake dispatches on, named once so a reordered test
// does not silently answer the wrong question.
const Q = {
    classes: 'MATCH (c:Class)\n',
    methods: 'f.name AS fn, f.signature',
    owners: 'f.file AS fnFile, f.owner AS fnOwner',
    inherits: '-[:INHERITS]->(b:Class)',
    external: '-[:INHERITS]->(b:ExternalBase)',
    calls: '(a:Function)-[:CALLS]->(b:Function)',
    fields: '-[:DECLARES]->(v:Variable)',
};

const kinds = (model) =>
    model.relations.map((r) => `${r.from.split('|')[0]}-${r.kind}->${r.to.split('|')[0]}`);

// ── name collisions ─────────────────────────────────────────────────────────

test('readClassModel — an external base does not swallow a class whose file is unknown', async () => {
    // The builder writes a class it could not attribute to a file with no file
    // at all, and its natural key is then `Node|`. An external base used to be
    // keyed `Node|` as well: the library `Node` and the project's own `Node`
    // became one box, the <<external>> marker vanished, and the diagram claimed
    // Widget inherits from project code the graph never said it inherits from.
    const session = fakeSession({
        [Q.classes]: [
            { name: 'Node', file: null, startLine: 1 },
            { name: 'Widget', file: 'w.ts', startLine: 1 },
        ],
        [Q.methods]: [
            { cls: 'Node', clsFile: null, fn: 'own', signature: 'own()', startLine: 2 },
        ],
        [Q.external]: [{ aName: 'Widget', aFile: 'w.ts', bName: 'Node' }],
    });

    const model = await readClassModel(session, { includeUses: false });

    assert.strictEqual(model.stats.classes, 2, 'the project Node is still project code');
    assert.strictEqual(model.stats.externalBases, 1, 'the library Node is still a separate box');
    const [rel] = model.relations;
    assert.strictEqual(rel.to, externalBaseKey('Node'), 'the arrow points at the external box');
    const project = model.classes.find((c) => !c.external && c.name === 'Node');
    assert.deepStrictEqual(project.methods.map((m) => m.name), ['own'],
        'the project class keeps its own members instead of being emptied by the merge');
});

test('readClassModel — the same external base from two files is one box', async () => {
    const session = fakeSession({
        [Q.classes]: [
            { name: 'A', file: 'a.py', startLine: 1 },
            { name: 'B', file: 'b.py', startLine: 1 },
        ],
        [Q.external]: [
            { aName: 'A', aFile: 'a.py', bName: 'rclpy.Node' },
            { aName: 'B', aFile: 'b.py', bName: 'rclpy.Node' },
        ],
    });

    const model = await readClassModel(session, { includeUses: false });

    assert.strictEqual(model.stats.externalBases, 1, 'one framework, one box — not one per subclass');
    assert.strictEqual(model.stats.inheritance, 2, 'both children still point at it');
});

test('readClassModel — an external base named like a real class keeps its own box', async () => {
    // Same display name, different things: a `Node` the parser found in the
    // codebase and a `Node` it only saw in an extends clause. Collapsing them
    // would attribute the project class's members to a library type.
    const session = fakeSession({
        [Q.classes]: [
            { name: 'Node', file: 'src/node.ts', startLine: 1 },
            { name: 'Widget', file: 'src/w.ts', startLine: 1 },
        ],
        [Q.external]: [{ aName: 'Widget', aFile: 'src/w.ts', bName: 'Node' }],
    });

    const model = await readClassModel(session, { includeUses: false });

    assert.strictEqual(model.classes.filter((c) => c.name === 'Node').length, 2);
    assert.strictEqual(model.stats.externalBases, 1);
    // Both boxes remain, and the project class gets a source qualifier so the
    // identical type name no longer looks like one duplicated box.
    const mmd = renderClassDiagram(model, { format: 'mermaid' });
    assert.match(mmd, /class C\d+\["Node"\]/);
    assert.match(mmd, /class C\d+\["Node — src\/node\.ts"\]/);
});

test('readClassModel — two classes of one name in different files stay apart', async () => {
    const session = fakeSession({
        [Q.classes]: [
            { name: 'Node', file: 'a.ts', startLine: 1 },
            { name: 'Node', file: 'b.ts', startLine: 1 },
        ],
        [Q.methods]: [
            { cls: 'Node', clsFile: 'a.ts', fn: 'fromA', signature: 'fromA()', startLine: 2 },
            { cls: 'Node', clsFile: 'b.ts', fn: 'fromB', signature: 'fromB()', startLine: 2 },
        ],
    });

    const model = await readClassModel(session, { includeUses: false });

    assert.strictEqual(model.classes.length, 2);
    for (const c of model.classes) {
        assert.deepStrictEqual(c.methods.map((m) => m.name), [`from${c.file[0].toUpperCase()}`],
            'a method belongs to the class in ITS file, not to the same name elsewhere');
    }
});

// ── ambiguity the graph itself cannot resolve ───────────────────────────────

test('readClassModel — a method name shared inside one file resolves the same way every time', async () => {
    // The builder merges Function nodes on {name, file}, so `A.run` and `B.run`
    // in one file are a single node CONTAINed by both classes: the graph cannot
    // say which class a call to it meant. That is not fixable here — but the
    // answer must not depend on the order the database returned the rows in,
    // which is what "last row wins" amounted to.
    const classes = [
        { name: 'A', file: 'x.js', startLine: 1 },
        { name: 'B', file: 'x.js', startLine: 9 },
        { name: 'Caller', file: 'y.js', startLine: 1 },
    ];
    const owners = [
        { cls: 'A', clsFile: 'x.js', fn: 'run', fnFile: 'x.js' },
        { cls: 'B', clsFile: 'x.js', fn: 'run', fnFile: 'x.js' },
        { cls: 'Caller', clsFile: 'y.js', fn: 'go', fnFile: 'y.js' },
    ];

    const run = (rows) => readClassModel(fakeSession({
        [Q.classes]: classes,
        [Q.owners]: rows,
        [Q.calls]: [{ aName: 'go', aFile: 'y.js', bName: 'run', bFile: 'x.js' }],
    }), {});

    const forward = kinds(await run(owners));
    const reversed = kinds(await run([...owners].reverse()));

    assert.deepStrictEqual(forward, reversed, 'the same graph must draw the same arrow');
    assert.deepStrictEqual(forward, ['Caller-uses->A']);
});

test('readClassModel — members without a startLine keep a stable order, so the cap hides the same ones', async () => {
    // Plenty of extractors record no line for a field. All of them then compare
    // equal, the sort keeps whatever order the driver produced, and the cap cut
    // a different set of fields per run — a diagram that changes without the
    // code changing.
    const withOrder = (names) => readClassModel(fakeSession({
        [Q.classes]: [{ name: 'D', file: 'd.py', startLine: 1 }],
        [Q.fields]: names.map((n) => ({
            cls: 'D', clsFile: 'd.py', attr: n, declaredType: 'int', startLine: null,
        })),
    }), { includeUses: false, maxAttributes: 2 });

    const a = await withOrder(['alpha', 'beta', 'gamma']);
    const b = await withOrder(['gamma', 'beta', 'alpha']);

    assert.deepStrictEqual(
        a.classes[0].attributes.map((x) => x.name),
        b.classes[0].attributes.map((x) => x.name),
    );
    assert.strictEqual(a.classes[0].hiddenAttributes, 1);
});

test('readClassModel — a recorded line still beats the name', async () => {
    // The tie-break must not turn the compartment alphabetical: source order is
    // what makes the box read like the file.
    const session = fakeSession({
        [Q.classes]: [{ name: 'S', file: 's.py', startLine: 1 }],
        [Q.methods]: [
            { cls: 'S', clsFile: 's.py', fn: 'zeta', signature: 'zeta()', startLine: 2 },
            { cls: 'S', clsFile: 's.py', fn: 'alpha', signature: 'alpha()', startLine: 9 },
        ],
    });

    const model = await readClassModel(session, { includeUses: false });

    assert.deepStrictEqual(model.classes[0].methods.map((m) => m.name), ['zeta', 'alpha']);
});

// ── truncation ──────────────────────────────────────────────────────────────

test('readClassModel — the cap hides nothing at exactly the limit and one at one over', async () => {
    const build = (n) => fakeSession({
        [Q.classes]: [{ name: 'C', file: 'c.js', startLine: 1 }],
        [Q.methods]: Array.from({ length: n }, (_, i) => ({
            cls: 'C', clsFile: 'c.js', fn: `m${i}`, signature: `m${i}()`, startLine: i,
        })),
    });

    const exact = await readClassModel(build(5), { maxMethods: 5, includeUses: false });
    assert.strictEqual(exact.classes[0].methods.length, 5);
    assert.strictEqual(exact.classes[0].hiddenMethods, 0, 'a complete class must not claim a remainder');
    assert.ok(!renderClassDiagram(exact, { format: 'mermaid' }).includes('more ..'));

    const over = await readClassModel(build(6), { maxMethods: 5, includeUses: false });
    assert.strictEqual(over.classes[0].hiddenMethods, 1);
});

test('readClassModel — a cap of zero shows nothing but says how much', async () => {
    const session = fakeSession({
        [Q.classes]: [{ name: 'C', file: 'c.js', startLine: 1 }],
        [Q.methods]: [0, 1, 2].map((i) => ({
            cls: 'C', clsFile: 'c.js', fn: `m${i}`, signature: `m${i}()`, startLine: i,
        })),
    });

    const model = await readClassModel(session, { maxMethods: 0, includeUses: false });

    assert.strictEqual(model.classes[0].methods.length, 0);
    assert.strictEqual(model.classes[0].hiddenMethods, 3);
    assert.strictEqual(model.stats.methods, 3, 'the total is still the truth');
    // A box that is nothing but its remainder line must still be a valid box.
    assert.match(renderClassDiagram(model, { format: 'plantuml' }), /\{\n  \.\. 3 more \.\.\n\}/);
    assert.match(renderClassDiagram(model, { format: 'mermaid' }), /C0 : \.\. 3 more \.\./);
});

test('readClassModel — a negative cap cannot invent hidden members', async () => {
    // `slice(0, -2)` drops from the END and the remainder was computed from the
    // raw number: a 3-method class reported 5 hidden and stats counted 6.
    const session = fakeSession({
        [Q.classes]: [{ name: 'C', file: 'c.js', startLine: 1 }],
        [Q.methods]: [0, 1, 2].map((i) => ({
            cls: 'C', clsFile: 'c.js', fn: `m${i}`, signature: `m${i}()`, startLine: i,
        })),
    });

    const model = await readClassModel(session, { maxMethods: -2, includeUses: false });
    const c = model.classes[0];

    assert.strictEqual(c.methods.length + c.hiddenMethods, 3, 'shown plus hidden is what the class has');
    assert.strictEqual(model.stats.methods, 3);
});

// ── cycles and dangling ends ────────────────────────────────────────────────

test('readClassModel — self-inheritance is dropped, a two-class cycle is kept', async () => {
    const session = fakeSession({
        [Q.classes]: [
            { name: 'A', file: 'a.js', startLine: 1 },
            { name: 'B', file: 'b.js', startLine: 1 },
        ],
        [Q.inherits]: [
            { aName: 'A', aFile: 'a.js', bName: 'A', bFile: 'a.js' },
            { aName: 'A', aFile: 'a.js', bName: 'B', bFile: 'b.js' },
            { aName: 'B', aFile: 'b.js', bName: 'A', bFile: 'a.js' },
        ],
    });

    const model = await readClassModel(session, { includeUses: false });

    // `A extends A` is a parser artefact, never real code; a mutual dependency
    // between two classes is real code and worth seeing.
    assert.deepStrictEqual(kinds(model).sort(), ['A-inherits->B', 'B-inherits->A']);
});

test('readClassModel — a relation whose other end the filter removed is not drawn', async () => {
    const session = fakeSession({
        [Q.classes]: [
            { name: 'In', file: 'src/in.js', startLine: 1 },
            { name: 'Out', file: 'vendor/out.js', startLine: 1 },
        ],
        [Q.inherits]: [{ aName: 'In', aFile: 'src/in.js', bName: 'Out', bFile: 'vendor/out.js' }],
    });

    const model = await readClassModel(session, { pathPrefix: 'src/', includeUses: false });

    assert.deepStrictEqual(model.classes.map((c) => c.name), ['In']);
    assert.strictEqual(model.relations.length, 0, 'an arrow needs two boxes');
});

test('renderClassDiagram — a relation pointing at a class that is not in the model is skipped', async () => {
    const model = {
        classes: [{ key: 'a', name: 'A', file: 'a.js', external: false, attributes: [], methods: [] }],
        relations: [{ from: 'a', to: 'ghost', kind: 'uses' }],
        stats: {},
    };

    assert.ok(!renderClassDiagram(model, { format: 'mermaid' }).includes('undefined'));
    assert.ok(!renderClassDiagram(model, { format: 'plantuml' }).includes('undefined'));
});

test('readClassModel — the same rows twice produce byte-identical diagrams', async () => {
    const session = fakeSession({
        [Q.classes]: [
            { name: 'B', file: 'z.js', startLine: 1 },
            { name: 'A', file: 'z.js', startLine: 2 },
        ],
        // Same line for both: the pathological case for a sort without a
        // tie-break, and the one a decorator or a one-liner class produces.
        [Q.methods]: [
            { cls: 'A', clsFile: 'z.js', fn: 'x', signature: 'x()', startLine: 5 },
            { cls: 'A', clsFile: 'z.js', fn: 'y', signature: 'y()', startLine: 5 },
        ],
    });

    const first = await readClassModel(session, { includeUses: false });
    const second = await readClassModel(session, { includeUses: false });

    assert.strictEqual(renderMermaid(first), renderMermaid(second));
    assert.strictEqual(
        renderClassDiagram(first, { format: 'plantuml' }),
        renderClassDiagram(second, { format: 'plantuml' }),
    );
});

// ── renderer: names and members ─────────────────────────────────────────────

test('renderClassDiagram — a blank class name becomes a visible placeholder', () => {
    // The model only rejects a falsy name, so `"  "` reaches the renderer. In a
    // browser that is not one bad box: `class C0["  "]` fails during layout
    // ("svg element not in render tree") and the whole tab shows an error.
    assert.strictEqual(classLabel('  '), '(unnamed)');
    assert.strictEqual(classLabel(null), '(unnamed)');
    assert.strictEqual(classLabel(' Widget '), 'Widget');

    const model = {
        classes: [{ key: 'k', name: '\t', file: 'a.js', external: false, attributes: [], methods: [] }],
        relations: [], stats: {},
    };
    assert.ok(!/class C0\[""\]|class C0\["\s+"\]/.test(renderClassDiagram(model, { format: 'mermaid' })));
    assert.ok(renderClassDiagram(model, { format: 'plantuml' }).includes('class "(unnamed)"'));
});

test('mermaidMember — a semicolon cannot reach Mermaid', () => {
    // Measured: a semicolon anywhere in member text is a lexical error and takes
    // the entire diagram with it. A declaration-style signature carries one.
    assert.strictEqual(mermaidMember('virtual void area() const = 0;'), 'virtual void area() const = 0');
    assert.strictEqual(mermaidMember('Ljava/lang/String; sig'), 'Ljava/lang/String sig');
    assert.ok(!mermaidMember('a;b;c').includes(';'));
});

test('mermaidMember — a closing parenthesis with nothing open is removed', () => {
    // Measured: `C0 : a)` throws inside Mermaid's own parser. Balanced text and
    // an unclosed opener both render, so only the unopened closer is touched.
    assert.strictEqual(mermaidMember('x) -> int'), 'x -> int');
    assert.strictEqual(mermaidMember('run(a, b)'), 'run(a, b)', 'well-formed text is untouched');
    assert.strictEqual(mermaidMember('run(a…'), 'run(a…', 'a capped signature keeps its opener');
    assert.strictEqual(mermaidMember('a(b)c)'), 'a(b)c');
    assert.strictEqual(mermaidMember('()'), '');
});

test('methodLine — a signature that is only a parameter list gets its name back', () => {
    // Some captures store `(self, x)` as the signature. Rendered as-is that is a
    // member with no name — unreadable in PlantUML and fatal in Mermaid.
    assert.strictEqual(methodLine({ name: 'load', signature: '(self, path)' }), 'load(self, path)');
    assert.strictEqual(methodLine({ name: 'load', signature: 'load(self)' }), 'load(self)');
});

test('renderClassDiagram — a class without member arrays renders instead of throwing', () => {
    // Not every caller builds a full model object; the renderer is the layer
    // that must not take the tab down over a missing array.
    const model = { classes: [{ key: 'k', name: 'A' }], relations: [], stats: {} };

    assert.match(renderClassDiagram(model, { format: 'mermaid' }), /class C0\["A"\]/);
    assert.match(renderClassDiagram(model, { format: 'plantuml' }), /class "A" as C0/);
});

test('renderClassDiagram — PlantUML escapes creole in attribute text too', () => {
    // plantumlMember() is applied to both compartments; a field named
    // `__slots__` would otherwise show up as an underlined "slots".
    const model = {
        classes: [{
            key: 'k', name: 'S', file: 'a.py', external: false,
            attributes: [{ name: '__slots__', declaredType: null }], hiddenAttributes: 0,
            methods: [], hiddenMethods: 0,
        }],
        relations: [], stats: {},
    };

    assert.ok(renderClassDiagram(model, { format: 'plantuml' }).includes('~__slots~__'));
});

test('renderClassDiagram — an empty model draws a message, and drops relations with it', () => {
    const mmd = renderClassDiagram({ classes: [], relations: [{ from: 'a', to: 'b', kind: 'uses' }] }, { format: 'mermaid' });

    assert.match(mmd, /class Empty\[/, 'an empty classDiagram body is a parse error');
    assert.ok(!mmd.includes('..>'), 'an arrow between boxes that do not exist is not drawn');
});

// ── the part that only a browser can answer ─────────────────────────────────

const MERMAID_ESM = path.resolve(__dirname, '../frontend/node_modules/mermaid/dist/mermaid.esm.min.mjs');
let puppeteer = null;
try { puppeteer = require('puppeteer'); } catch { /* optional */ }
const SKIP = process.env.SKIP_BROWSER_TESTS === '1' || !puppeteer || !fs.existsSync(MERMAID_ESM);

/** Every hazard this file found, in one model, so they are proven together. */
const HOSTILE = {
    classes: [
        {
            key: 'k1', name: '   ', file: 'a.cpp', external: false,
            attributes: [{ name: 'w_', declaredType: 'double;' }], hiddenAttributes: 2,
            methods: [
                { name: 'area', signature: 'virtual double area() const = 0;' },
                { name: 'load', signature: '(self, path)' },
                { name: 'trunc', signature: 'x) -> int' },
            ],
            hiddenMethods: 4,
        },
        { key: 'k2', name: 'Node', file: 'b.ts', external: false, attributes: [], methods: [] },
        { key: 'k3', name: 'Node', file: null, external: true, attributes: [], methods: [] },
    ],
    relations: [
        { from: 'k1', to: 'k3', kind: 'inherits' },
        { from: 'k1', to: 'k2', kind: 'creates' },
        { from: 'k2', to: 'k1', kind: 'uses' }, // a cycle
    ],
};

describe('the hostile model renders in a browser', { skip: SKIP && 'puppeteer/mermaid/browser not available' }, () => {
    let browser, page, server;

    before(async () => {
        const http = require('node:http');
        const DIST = path.dirname(MERMAID_ESM);
        server = http.createServer((req, res) => {
            const url = req.url.split('?')[0];
            if (url === '/') {
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end("<!doctype html><html><body></body></html>");
                return;
            }
            const file = path.resolve(DIST, '.' + url);
            if (!file.startsWith(DIST) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
                res.writeHead(404).end();
                return;
            }
            res.writeHead(200, { 'Content-Type': 'text/javascript' });
            res.end(fs.readFileSync(file));
        });
        await new Promise((r) => server.listen(0, '127.0.0.1', r));

        browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-dev-shm-usage', '--proxy-server=direct://', '--proxy-bypass-list=*'],
        });
        page = await browser.newPage();
        await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'domcontentloaded' });
        await page.evaluate(async () => {
            const mermaid = (await import('/mermaid.esm.min.mjs')).default;
            mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'strict' });
            window.__render = async (src, id) => {
                try { const { svg } = await mermaid.render(id, src); return { ok: true, svg }; }
                catch (e) { return { ok: false, error: String((e && e.message) || e).split('\n')[0] }; }
            };
        });
    });

    after(async () => {
        if (browser) await browser.close();
        if (server) await new Promise((r) => server.close(r));
    });

    const render = (src, id) => page.evaluate((s, i) => window.__render(s, i), src, id);

    it('renders parsed C++ enumeration stereotypes and values', async () => {
        const { diagramFromSource } = require('./helpers/class-extract.cjs');
        const diagram = await diagramFromSource('enum class Mode { Fast, Slow };', 'mode.hpp');
        const r = await render(diagram.mermaid, 'parsed-enum');
        assert.ok(r.ok, r.error);
        assert.match(r.svg, /enumeration/);
        assert.match(r.svg, /Fast/);
        assert.match(r.svg, /Slow/);
    });

    it('survives a blank name, a semicolon, a stray paren and a cycle at once', async () => {
        const src = renderMermaid(HOSTILE, { title: 'Hostile' });
        const r = await render(src, 'adv-hostile');
        assert.ok(r.ok, `mermaid failed on the generated diagram:\n${r.error}\n\n--- source ---\n${src}`);
        assert.match(r.svg, /<svg/);
        assert.ok(r.svg.includes('(unnamed)'), 'the blank box says so instead of disappearing');
        assert.ok(r.svg.includes('4 more'), 'the truncation notice survives');
    });

    /**
     * The escaping is only worth its cost if the raw text really does break.
     * Two of the three characters an earlier version substituted turned out to
     * be harmless, so this proves the remaining ones rather than assuming them —
     * if a future Mermaid stops caring, this test says so out loud.
     */
    it('confirms the raw shapes really are fatal', async () => {
        const raw = (member) => `classDiagram\n  class C0["A"]\n  C0 : ${member}`;
        const cases = {
            semicolon: raw('virtual double area() = 0;'),
            unopenedParen: raw('x) -> int'),
            bareParens: raw('()'),
            blankName: 'classDiagram\n  class C0["   "]',
        };
        for (const [name, src] of Object.entries(cases)) {
            const r = await render(src, `adv-raw-${name}`);
            assert.ok(!r.ok, `'${name}' rendered fine — the sanitiser for it may be unnecessary now`);
        }
    });
});

/**
 * Python that the class-diagram pipeline is not supposed to survive.
 *
 * The other class tests attack the ends: a fake session hands finished rows to
 * readClassModel (class-diagram.test.js, class-attributes.test.js), or a single
 * tree-sitter query is compiled and matched (class-inheritance.test.js). This
 * file drives the whole strecke — real grammar, real extractors, real model,
 * real renderer — with Python written to break it: classes whose entire content
 * is fields, classes with no content at all, classes defined inside other
 * classes, inside functions, inside an `if`, and attribute assignments that look
 * like fields but belong to somebody else's object.
 *
 * What counts as a defect here: the structure is in the source and the diagram
 * does not show it, or shows something that is not in the source. What does NOT
 * count is documented simplification — a base name is deliberately reduced to
 * its last dotted segment and its type parameters are dropped
 * (extractClassInheritance), and `self` stays in the rendered signature.
 *
 * Two things this file wires up that the shared harness does not:
 *
 *  - extractAllVariables. It is what fills the ATTRIBUTE compartment, and
 *    Python has no declaration site for fields — `self.x = …` and the bare
 *    annotations in a class body are the entire field list. Without it every
 *    box here would be method-only and a dataclass would look correct while
 *    being empty.
 *  - invalidateClassResolution. The builder memoises the class catalogue in a
 *    module-level cache that outlives a single file, so the SECOND source in a
 *    process resolves its base classes against the FIRST one's classes. Left
 *    alone, `class Impl(Base)` in the same file reports an <<external>> Base —
 *    a failure the test itself created.
 */

const test = require('node:test');
const assert = require('node:assert');

const { __testing__ } = require('../scripts/graph_builder.js');
const { extractFromSource, sessionFrom, loadLanguage } = require('./helpers/class-extract.cjs');
const { readClassModel } = require('../scripts/diagram/class_model.cjs');
const { renderClassDiagram } = require('../scripts/diagram/class_render.cjs');

const FILE = 'app/models.py';

/**
 * Record the Variable writes AND the class link.
 *
 * extractAllVariables writes a field in two statements: the Variable node, and
 * a separate MATCH/MERGE that hangs it off its class. Only the pair says which
 * box an attribute belongs in, so both are kept and joined on the elementId —
 * a recorder that keeps just the first would report every attribute as ownerless
 * and every compartment as empty.
 */
function variableRecorder() {
    const variables = [];
    const owners = new Map();
    return {
        variables, owners,
        async run(cypher, params = {}) {
            const flat = cypher.replace(/\s+/g, ' ').trim();
            if (flat.includes('MERGE (v:Variable')) variables.push(params);
            else if (flat.includes('MERGE (cls)-[:DECLARES]->(v)')) owners.set(params.elementId, params.className);
            return { records: [] };
        },
    };
}

/**
 * The harness's model session answers the attribute query with `startLine: null`
 * for every field, and readClassModel sorts the compartment by that line. Left
 * alone, the attributes arrive in tree-sitter's match order — which groups by
 * query pattern, not by position — and a test asserting source order would be
 * measuring the harness. The recorded line is put back so the compartment reads
 * the way it does against a real graph.
 */
function withFieldLines(base, fields) {
    return {
        async run(cypher, params) {
            if (!cypher.includes('[:DECLARES]->(v:Variable)')) return base.run(cypher, params);
            const rows = fields.map((f) => ({
                cls: f.className, clsFile: FILE, attr: f.name,
                declaredType: f.declaredType, startLine: f.startLine,
            }));
            return { records: rows.map((row) => ({ get: (k) => (k in row ? row[k] : null) })) };
        },
    };
}

/** Python source -> extracted graph (incl. fields) -> class model -> Mermaid. */
async function pyDiagram(source, opts = {}) {
    __testing__.invalidateClassResolution();
    const extracted = await extractFromSource(source, FILE);

    const { lang } = await loadLanguage('.py');
    const cached = { variableQuery: __testing__.safeQuery(lang, extracted.config.variableQuery) };
    assert.ok(cached.variableQuery, 'PY_VARIABLE_QUERY must compile — safeQuery swallows a grammar error as null');

    const recorder = variableRecorder();
    await __testing__.extractAllVariables(
        recorder, cached, extracted.tree, FILE, extracted.funcBounds, extracted.classBounds
    );
    const fields = recorder.variables
        .filter((v) => v.scope === 'field')
        .map((v) => ({
            name: v.name,
            className: recorder.owners.get(v.elementId) || null,
            declaredType: v.declaredType,
            startLine: Number(v.startLine?.toNumber?.() ?? v.startLine ?? 0),
        }));

    const full = { ...extracted, fields };
    const model = await readClassModel(withFieldLines(sessionFrom(full), fields), { includeUses: false, ...opts });
    return {
        extracted: full,
        model,
        mermaid: renderClassDiagram(model, { format: 'mermaid' }),
        plantuml: renderClassDiagram(model, { format: 'plantuml' }),
        box: (name) => model.classes.find((c) => c.name === name),
        attrs: (name) => (model.classes.find((c) => c.name === name)?.attributes || [])
            .map((a) => (a.declaredType ? `${a.name}: ${a.declaredType}` : a.name)),
        methods: (name) => (model.classes.find((c) => c.name === name)?.methods || []).map((m) => m.name),
        bases: (name) => model.relations
            .filter((r) => r.kind === 'inherits' && r.from.startsWith(`${name}|`))
            .map((r) => model.classes.find((c) => c.key === r.to).name),
    };
}

// ── classes whose entire content is data ────────────────────────────────────

test('a @dataclass is not an empty box — its annotations are the attributes', async () => {
    const r = await pyDiagram(`
from dataclasses import dataclass, field

@dataclass
class Location:
    lat: float
    lon: float = 0.0
    tags: list = field(default_factory=list)
`);

    assert.strictEqual(r.extracted.parseError, false);
    // No methods at all: without the attribute compartment this box would be
    // blank and read as a failed extraction.
    assert.deepStrictEqual(r.methods('Location'), []);
    assert.deepStrictEqual(r.attrs('Location'), ['lat: float', 'lon: float', 'tags: list']);
    assert.ok(r.mermaid.includes('lat float'), 'Mermaid draws the attribute, colon stripped');
});

test('NamedTuple, TypedDict and Enum members reach the attribute compartment', async () => {
    const r = await pyDiagram(`
class Config(NamedTuple):
    host: str
    port: int = 80

class Movie(TypedDict):
    title: str

class Color(Enum):
    RED = 1
    GREEN = 2
`);

    assert.deepStrictEqual(r.attrs('Config'), ['host: str', 'port: int']);
    assert.deepStrictEqual(r.attrs('Movie'), ['title: str']);
    // An enum member has no annotation; the name alone is the whole fact.
    assert.deepStrictEqual(r.attrs('Color'), ['RED', 'GREEN']);
    // The three bases come from the standard library, so they are external
    // boxes rather than missing arrows.
    assert.deepStrictEqual(r.bases('Config'), ['NamedTuple']);
    assert.deepStrictEqual(r.bases('Color'), ['Enum']);
});

// ── the receiver of an attribute assignment ─────────────────────────────────

test("only self's and cls's attributes are the class's attributes", async () => {
    const r = await pyDiagram(`
class Runner:
    def run(self, cfg):
        cfg.timeout = 5
        logging.root.level = 1
        self.state.ready = False
        self.done = True

    @classmethod
    def boot(cls):
        cls.registry = {}
`);

    // `cfg.timeout` and `logging.root.level` are somebody else's attributes;
    // `self.state.ready` belongs to `state`, not to Runner. All three used to
    // land in Runner's compartment, where nothing distinguishes them from a
    // real field.
    assert.deepStrictEqual(r.attrs('Runner'), ['done', 'registry']);
    assert.ok(!r.mermaid.includes('timeout'), 'a foreign object\'s attribute is not drawn');
    assert.ok(!r.mermaid.includes('ready'), 'a nested self.a.b target belongs to a, not to the class');
});

test('every self-assignment shape counts, and an annotation keeps its type', async () => {
    const r = await pyDiagram(`
class R:
    limit: int = 10

    def __init__(self):
        self.x, self.y = 0, 0
        (self.p, self.q) = 3, 4
        self.n: int = 1

    def bump(self):
        self.n += 1
`);

    assert.deepStrictEqual(
        r.attrs('R'),
        ['limit: int', 'x', 'y', 'p', 'q', 'n: int'],
        'pattern list, parenthesised tuple, annotated and augmented targets all count'
    );
    // `self.n` is assigned twice; one attribute, and the typed record wins.
    assert.strictEqual(r.model.classes.find((c) => c.name === 'R').attributes.filter((a) => a.name === 'n').length, 1);
});

// ── inheritance ─────────────────────────────────────────────────────────────

test('class A(object) draws no base at all', async () => {
    const r = await pyDiagram(`
class A(object):
    def go(self): pass
`);

    // `object` is the implicit root of every Python 3 class. Drawn, it is one
    // hub every legacy class in a project points at — a fact about all of them,
    // so it separates none of them.
    assert.deepStrictEqual(r.extracted.inherits, [], 'no INHERITS edge is written');
    assert.strictEqual(r.model.stats.externalBases, 0);
    assert.ok(!r.mermaid.includes('object'), 'no <<external>> object box');
    assert.strictEqual(r.model.stats.classes, 1);
});

test('multiple inheritance draws every base, and metaclass= is not one', async () => {
    const r = await pyDiagram(`
class Storage: pass
class Auditable: pass

class Service(Storage, Auditable, metaclass=ABCMeta):
    def run(self): pass
`);

    assert.deepStrictEqual(r.bases('Service').sort(), ['Auditable', 'Storage']);
    assert.ok(!r.mermaid.includes('ABCMeta'), 'a metaclass is not a base class');
});

test('a base defined in the same file is the real box, not an external twin', async () => {
    const r = await pyDiagram(`
from abc import ABC, abstractmethod

class Base(ABC):
    @abstractmethod
    def run(self) -> None: ...

class Impl(Base):
    def run(self) -> None: pass
`);

    // Two boxes named Base — one real, one <<external>> — is what a stale class
    // catalogue produces, and it splits the hierarchy in half.
    assert.strictEqual(r.model.classes.filter((c) => c.name === 'Base').length, 1);
    assert.strictEqual(r.box('Base').external, false);
    assert.deepStrictEqual(r.bases('Impl'), ['Base']);
    // ABC comes from the standard library and stays external — that IS the
    // information "this class is abstract".
    assert.deepStrictEqual(r.bases('Base'), ['ABC']);
});

test('a parameterised base is drawn under its bare name', async () => {
    const r = await pyDiagram(`
class Box(Generic[T]):
    def get(self) -> T: ...

class Registry(collections.abc.Mapping[str, int]):
    pass
`);

    // Documented simplification: the type arguments are dropped and a dotted
    // base keeps only its last segment. What must not happen is no edge at all,
    // which is what a `generic_type`-shaped query would produce here.
    assert.deepStrictEqual(r.bases('Box'), ['Generic']);
    assert.deepStrictEqual(r.bases('Registry'), ['Mapping']);
});

// ── where a class may be written ────────────────────────────────────────────

test('a nested class is its own box and does not lend its methods to the outer one', async () => {
    const r = await pyDiagram(`
class Outer:
    def run(self): pass

    class Inner:
        def ping(self): pass
`);

    assert.deepStrictEqual(r.methods('Outer'), ['run']);
    assert.deepStrictEqual(r.methods('Inner'), ['ping'], 'the innermost class owns the method');
});

test('a function nested in a method is not a method', async () => {
    const r = await pyDiagram(`
class A:
    def run(self):
        def helper():
            return 1
        return helper
`);

    // Byte containment alone would file `helper` under A: it is textually
    // inside the class.
    assert.deepStrictEqual(r.methods('A'), ['run']);
});

test('a class defined under if/try/with is still a class', async () => {
    const r = await pyDiagram(`
import typing

if typing.TYPE_CHECKING:
    class OnlyTyped:
        def t(self): pass

def factory():
    class Product:
        def go(self): pass
    return Product
`);

    // Conditionally defined and function-local classes are ordinary
    // class_definitions; a scan that only walked module-level statements would
    // lose both.
    assert.deepStrictEqual(r.methods('OnlyTyped'), ['t']);
    assert.deepStrictEqual(r.methods('Product'), ['go']);
});

// ── methods ─────────────────────────────────────────────────────────────────

test('decorated and async methods all reach the box', async () => {
    const r = await pyDiagram(`
class D:
    @staticmethod
    def make(): pass

    @classmethod
    def build(cls): pass

    async def run(self): pass
`);

    assert.deepStrictEqual(r.methods('D'), ['make', 'build', 'run'], 'source order');
    const sig = (n) => r.box('D').methods.find((m) => m.name === n).signature;
    assert.strictEqual(sig('run'), 'async run(self)', 'async is part of the signature');
    // Known gap, not a defect of this pipeline: nothing marks `make` as static
    // or `build` as a classmethod. UML underlines a static member; the renderer
    // has no channel for it because the graph carries no such flag on Function.
    assert.strictEqual(sig('make'), 'make()');
});

test('a class with only a docstring is an empty box, not a missing one', async () => {
    const r = await pyDiagram(`
class Marker:
    """Nothing but documentation."""
    pass
`);

    assert.ok(r.box('Marker'), 'the box exists');
    assert.deepStrictEqual(r.methods('Marker'), []);
    assert.deepStrictEqual(r.attrs('Marker'), []);
    assert.ok(!r.mermaid.includes('No classes found'), 'the diagram is not reported as empty');
});

// ── documented gaps ─────────────────────────────────────────────────────────

// Nicht über die Variablen-Query gelöst, sondern im Modell: die Dekoratoren
// stehen ohnehin am Function-Knoten, also ist "ist das in Wahrheit ein
// Attribut?" eine Frage der Darstellung und keine zweite Extraktion. Der
// Rückgabetyp des Getters wird zum Typ des Attributs.
test('a @property is an attribute, not a method', async () => {
    const r = await pyDiagram(`
class P:
    @property
    def label(self) -> str:
        return self._label

    @label.setter
    def label(self, v: str) -> None:
        self._label = v
`);

    // A property is part of a class's DATA surface — `p.label` is read and
    // written like a field, and UML models it as an attribute. Today both the
    // getter and the setter arrive as methods called `label`, so the box shows
    // the same name twice with contradictory signatures (and in a real graph
    // the two MERGE onto one Function node, where the last write wins).
    //
    // Not fixable inside the Python query alone: extractAllVariables turns
    // EVERY capture of a match into a Variable, so the decorator capture that a
    // `#match? property` predicate needs would itself become an attribute named
    // "property". A fix belongs in extractAllVariables, next to the `self`/`cls`
    // skip that makes the receiver capture harmless.
    assert.ok(r.attrs('P').includes('label: str'), 'the property is an attribute with its return type');
    assert.deepStrictEqual(r.methods('P'), [], 'and not a method — twice, with two signatures');
});

// Pythons `lambda_parameters` sind blosser Text ohne Klammern, also klebte die
// Signatur den ersten Parameter an den Namen: `cbself, x`. Die Klammern werden
// jetzt ergänzt, wenn eine Parameterliste ohne sie ankommt.
test('a named lambda in a class body keeps its parameter list', async () => {
    const r = await pyDiagram(`
class A:
    cb = lambda self, x: x
`);

    // `(lambda_parameters)` has no parentheses in the source, and the signature
    // is built as name + params, so the box reads `cbself, x`. The parenthesis
    // fallback in extractFunctions only fires when NO params were captured, so
    // the query cannot repair this from its side: dropping the capture would
    // render `cb()` and lose the parameters instead of garbling them.
    assert.strictEqual(r.box('A').methods[0].signature, 'cb(self, x)');
});

test('same-named methods retain distinct ownership and identities in the real graph', async () => {
    const { openTestDb } = require('./helpers/ladybug-session.cjs');
    const db = await openTestDb();
    const extracted = await extractFromSource('class Outer:\n    def go(self): pass\nclass Inner:\n    def go(self, value): pass\n', FILE);
    const { lang, config } = await loadLanguage('.py');
    const funcQuery = __testing__.safeQuery(lang, config.funcQuery);
    try {
        await db.session.run('CREATE (:File {path:$file}) CREATE (:Class {name:"Outer", file:$file}) CREATE (:Class {name:"Inner", file:$file})', { file: FILE });
        for (let attempt = 0; attempt < 2; attempt++) {
            await __testing__.extractFunctions(db.session, { lang, funcQuery }, extracted.tree, FILE, { int: Number }, extracted.classBounds);
        }
        const result = await db.session.run('MATCH (c:Class)-[:CONTAINS]->(f:Function) RETURN c.name AS owner, elementId(f) AS id, f.uid AS uid, f.params AS params');
        const rows = result.records.map(r => ({ owner: r.get('owner'), id: r.get('id'), uid: r.get('uid'), params: r.get('params') }));
        assert.equal(rows.length, 2);
        assert.equal(new Set(rows.map(r => r.id)).size, 2);
        assert.equal(new Set(rows.map(r => r.uid)).size, 2);
        assert.equal(rows.find(r => r.owner === 'Outer').params, '(self)');
        assert.equal(rows.find(r => r.owner === 'Inner').params, '(self, value)');
    } finally {
        funcQuery.delete();
        extracted.tree.delete();
        await db.cleanup();
    }
});

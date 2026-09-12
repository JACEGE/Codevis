/**
 * `new Foo()` extraction, checked against the real tree-sitter grammars.
 *
 * This edge did not exist at all before: the call queries match
 * `call_expression`, and a constructor call is a different node type in every
 * language. The consequence was a class diagram of unconnected boxes for code
 * that creates objects on every other line.
 *
 * Compiled with `new Query(...)` rather than the builder's `safeQuery`, which
 * returns null on a malformed query — that would turn a broken query into
 * "no instantiations found" instead of a failure.
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');

const { __testing__ } = require('../scripts/graph_builder.js');
const { LANG_CONFIGS, resolveGrammarWasm } = __testing__;

let Parser, Language, Query;

const CASES = [
    {
        ext: '.js',
        source: 'function f() { const a = new Session(1); const b = new ns.Record(2); }\n',
        expected: ['Session', 'ns.Record'],
    },
    {
        ext: '.ts',
        source: 'function f() { const a = new Session<T>(1); const b = new ns.Record(2); }\n',
        expected: ['Session', 'ns.Record'],
    },
    {
        ext: '.jsx',
        source: 'function f() { return new Widget(1); }\n',
        expected: ['Widget'],
    },
    {
        ext: '.cpp',
        // Only the heap form is matched: `Widget w(1);` is syntactically a
        // function declaration and guessing there would invent edges.
        source: 'void f(){ auto* p = new Widget(1); auto* q = new ns::Thing(2); }\n',
        expected: ['Widget', 'ns::Thing'],
    },
    {
        ext: '.java',
        source: 'class A { void f(){ var x = new Widget(1); } }\n',
        expected: ['Widget'],
    },
    {
        ext: '.py',
        // Python cannot distinguish a constructor from any other call at parse
        // time — everything is captured here and filtered against the classes
        // in the graph by the extractor.
        source: 'def f():\n    x = Widget(1)\n    y = pkg.Thing(2)\n',
        expected: ['Widget', 'pkg.Thing'],
    },
];

function captured(query, tree) {
    const names = [];
    for (const match of query.matches(tree.rootNode)) {
        for (const capture of match.captures) {
            if (capture.name === 'class_name') names.push(capture.node.text);
        }
    }
    return names;
}

/** The extractor's rule for turning a captured expression into a class name. */
function leafName(raw) {
    return raw.split(/::|\./).pop().trim();
}

describe('instantiation queries', () => {
    before(async () => {
        ({ Parser, Language, Query } = require('web-tree-sitter'));
        await Parser.init();
    });

    for (const testCase of CASES) {
        it(`${testCase.ext} — captures constructor calls`, async () => {
            const config = LANG_CONFIGS[testCase.ext];
            assert.ok(config.instantiationQuery, `${testCase.ext} has no instantiationQuery`);

            const lang = await Language.load(resolveGrammarWasm(config.wasm));
            const query = new Query(lang, config.instantiationQuery);
            const parser = new Parser();
            parser.setLanguage(lang);

            const names = captured(query, parser.parse(testCase.source));
            for (const expected of testCase.expected) {
                assert.ok(names.includes(expected), `expected ${expected} in ${JSON.stringify(names)}`);
            }
        });
    }

    it('a qualified name reduces to the class itself', () => {
        assert.strictEqual(leafName('ns.Record'), 'Record');
        assert.strictEqual(leafName('ns::Thing'), 'Thing');
        assert.strictEqual(leafName('pkg.sub.Widget'), 'Widget');
        assert.strictEqual(leafName('Widget'), 'Widget');
    });

    it('.js — an ordinary call is not an instantiation', async () => {
        const config = LANG_CONFIGS['.js'];
        const lang = await Language.load(resolveGrammarWasm(config.wasm));
        const query = new Query(lang, config.instantiationQuery);
        const parser = new Parser();
        parser.setLanguage(lang);

        assert.deepStrictEqual(captured(query, parser.parse('function f(){ helper(1); obj.method(2); }\n')), []);
    });
});

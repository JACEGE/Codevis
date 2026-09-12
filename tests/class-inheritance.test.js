/**
 * Class-inheritance extraction, checked against the REAL tree-sitter grammars.
 *
 * These queries used to exist for Python only, so `INHERITS` was empty for
 * every other language and anything reading it (spec reconciliation, the class
 * diagram) reported a flat hierarchy rather than an unsupported one.
 *
 * The test compiles each query with `new Query(...)` — not through the
 * builder's `safeQuery`, which returns null on a malformed query and would let
 * a broken one pass as "no matches". A wrong node type must fail here loudly.
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');

const { __testing__ } = require('../scripts/graph_builder.js');
const { LANG_CONFIGS, resolveGrammarWasm } = __testing__;

let Parser, Language, Query;

/** Every language that claims inheritance support, with code that exercises it. */
const CASES = [
    {
        ext: '.js',
        source: 'class A extends B {}\nclass C extends ns.D {}\nclass Plain {}\n',
        expected: [['A', 'B'], ['C', 'ns.D']],
    },
    {
        ext: '.jsx',
        source: 'class Widget extends React.Component {}\n',
        expected: [['Widget', 'React.Component']],
    },
    {
        ext: '.ts',
        source: 'class A extends B implements I {}\nclass Plain {}\n',
        expected: [['A', 'B'], ['A', 'I']],
    },
    {
        ext: '.tsx',
        source: 'class Widget extends React.Component implements Renderable {}\n',
        expected: [['Widget', 'React.Component'], ['Widget', 'Renderable']],
    },
    {
        ext: '.py',
        // The dotted base is the reason `(attribute)` is in the query: without
        // it, `class Node(rclpy.node.Node)` produced no edge at all.
        source: 'class A(B):\n    pass\n\nclass C(pkg.mod.D):\n    pass\n\nclass Plain:\n    pass\n',
        expected: [['A', 'B'], ['C', 'pkg.mod.D']],
    },
    {
        ext: '.cpp',
        source: 'class A : public B {};\nstruct D : E {};\nclass F : private ns::G {};\nclass Plain {};\n',
        expected: [['A', 'B'], ['D', 'E'], ['F', 'ns::G']],
    },
    {
        ext: '.java',
        source: 'class A extends B implements I, J {}\n',
        expected: [['A', 'B'], ['A', 'I'], ['A', 'J']],
    },
    {
        ext: '.rb',
        source: 'class A < B\nend\n\nclass Plain\nend\n',
        expected: [['A', 'B']],
    },
];

/** Run a compiled query the way extractClassInheritance does. */
function extractPairs(query, tree) {
    const pairs = [];
    for (const match of query.matches(tree.rootNode)) {
        let className = null;
        const bases = [];
        for (const capture of match.captures) {
            if (capture.name === 'class_name') className = capture.node.text;
            if (capture.name === 'base_class') bases.push(capture.node.text);
        }
        if (!className) continue;
        for (const base of bases) pairs.push([className, base]);
    }
    return pairs;
}

describe('class inheritance queries', () => {
    before(async () => {
        ({ Parser, Language, Query } = require('web-tree-sitter'));
        await Parser.init();
    });

    for (const testCase of CASES) {
        it(`${testCase.ext} — extracts every base class`, async () => {
            const config = LANG_CONFIGS[testCase.ext];
            assert.ok(config, `no LANG_CONFIG for ${testCase.ext}`);
            assert.ok(
                config.classInheritanceQuery,
                `${testCase.ext} has no classInheritanceQuery — inheritance would be silently missing`
            );

            const lang = await Language.load(resolveGrammarWasm(config.wasm));
            // Deliberately NOT safeQuery: a malformed query must throw here.
            const query = new Query(lang, config.classInheritanceQuery);
            const parser = new Parser();
            parser.setLanguage(lang);

            const pairs = extractPairs(query, parser.parse(testCase.source));
            const asStrings = pairs.map(([c, b]) => `${c}<-${b}`).sort();
            const expected = testCase.expected.map(([c, b]) => `${c}<-${b}`).sort();

            assert.deepStrictEqual(asStrings, expected);
        });
    }

    it('classes without a base produce no edge', async () => {
        const config = LANG_CONFIGS['.js'];
        const lang = await Language.load(resolveGrammarWasm(config.wasm));
        const query = new Query(lang, config.classInheritanceQuery);
        const parser = new Parser();
        parser.setLanguage(lang);

        assert.deepStrictEqual(extractPairs(query, parser.parse('class Solo {}\n')), []);
    });
});

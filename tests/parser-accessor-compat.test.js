const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Parser } = require('web-tree-sitter');
const { parseSource } = require('../scripts/parser/parse-source.cjs');
const { diagramFromSource, loadLanguage } = require('./helpers/class-extract.cjs');

for (const ext of ['ts', 'tsx']) {
    test(`${ext}: accessor fallback preserves original text, Unicode offsets and modifier combinations`, async () => {
        const source = '// 😀 comment: static accessor fake = 3\r\n'
            + 'class Base { accessor count: number = 0; }\r\n'
            + 'class A extends Base {\r\n'
            + '  @tracked static accessor #secret: number = 2;\r\n'
            + '  override accessor count: number = 3;\r\n'
            + '  private static accessor label = "static accessor fake = 7";\r\n'
            + '  accessor() { return this.count; }\r\n}\r\n';
        const r = await diagramFromSource(source, `a.${ext}`);
        assert.equal(r.extracted.parseError, false);
        assert.equal(r.extracted.tree.rootNode.text, source);
        const cls = r.model.classes.find(c => c.name === 'A');
        assert.deepEqual(cls.attributes.map(a => a.name).sort(), ['#secret', 'count', 'label']);
        assert.deepEqual(cls.methods.map(m => m.name), ['accessor']);
        assert.match(cls.methods[0].signature, /accessor/);
        const field = r.extracted.tree.rootNode.descendantsOfType('public_field_definition')
            .find(n => n.childForFieldName('name')?.text === '#secret');
        assert.equal(field.childForFieldName('name').startIndex, source.indexOf('#secret'));
        assert.equal(field.childForFieldName('name').startPosition.row, 3);
        assert.match(field.text, /static accessor #secret/);
    });

    test(`${ext}: an accessor-named method alone is not lost or renamed`, async () => {
        const r = await diagramFromSource('class A { accessor() { return 1; } }', `a.${ext}`);
        assert.equal(r.extracted.parseError, false);
        assert.deepEqual(r.model.classes[0].methods.map(m => m.name), ['accessor']);
    });

    test(`${ext}: unrelated syntax errors and accessor-like text are not repaired`, async () => {
        const { lang } = await loadLanguage(`.${ext}`);
        const parser = new Parser(); parser.setLanguage(lang);
        try {
            for (const source of [
                'class A { static accessor count = ; }',
                'class A { static accessor count = 1; broken( { }',
                'const text = "static accessor count = 1"; const bad = ;',
                '// static accessor count = 1\nconst bad = ;',
            ]) {
                const tree = parseSource(parser, source, `a.${ext}`);
                assert.equal(tree.rootNode.hasError, true, source);
                assert.equal(tree.rootNode.text, source);
                tree.delete();
            }
        } finally { parser.delete(); }
    });
}

for (const ext of ['js', 'jsx', 'ts', 'tsx']) {
    test(`${ext}: parenthesized default classes retain members and direct/mixin bases`, async () => {
        for (const expression of ['Base', 'mixin(Base)', 'mixin(ns.Base)']) {
            for (const wrap of [false, true]) {
                const value = `class extends ${expression} { count = 1; run() {} }`;
                const source = `class Base {}\nexport default ${wrap ? `(${value})` : value};`;
                const r = await diagramFromSource(source, `Store.${ext}`);
                assert.equal(r.extracted.parseError, false);
                const cls = r.model.classes.find(c => c.name === 'Store');
                assert.ok(cls, source);
                assert.deepEqual(cls.methods.map(m => m.name), ['run']);
                assert.deepEqual(cls.attributes.map(a => a.name), ['count']);
                assert.deepEqual(r.extracted.inherits.map(e => [e.child, e.parent]), [['Store', 'Base']]);
            }
        }
        const noBase = await diagramFromSource('export default (class extends makeBase({}) {});', `Store.${ext}`);
        assert.deepEqual(noBase.extracted.inherits, [], 'do not invent a base for a factory with no class arguments');
    });
}

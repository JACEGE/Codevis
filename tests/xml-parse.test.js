const test = require('node:test');
const assert = require('node:assert/strict');
const { Parser, Language, Query } = require('web-tree-sitter');
const { __testing__: { LANG_CONFIGS, resolveGrammarWasm } } = require('../scripts/graph_builder.js');

// A ROS 2 package.xml exactly as `ros2 pkg create` writes it.
const PACKAGE_XML = `<?xml version="1.0"?>
<?xml-model href="http://download.ros.org/schema/package_format3.xsd" schematypelocation="http://www.w3.org/2001/XMLSchema"?>
<package format="3">
  <name>beerpong_core</name>
  <depend>rclpy</depend>
  <test_depend>ament_copyright</test_depend>
  <!-- launcher plugins -->
  <export>
    <build_type>ament_python</build_type>
  </export>
</package>
`;

async function parse(source) {
    await Parser.init();
    const config = LANG_CONFIGS['.xml'];
    const lang = await Language.load(resolveGrammarWasm(config.wasm));
    const parser = new Parser();
    parser.setLanguage(lang);
    return { tree: parser.parse(config.preprocess(source)), lang, config };
}

test('XML with a declaration, processing instructions, doctype and CDATA parses without syntax errors', async () => {
    const { tree, lang, config } = await parse(PACKAGE_XML);
    assert.equal(tree.rootNode.hasError, false);
    const elements = new Query(lang, config.astQuery).captures(tree.rootNode).filter(c => c.name === 'XMLElement');
    assert.ok(elements.length >= 6);
    // Masking keeps offsets: <package> is still on line 3.
    const pkg = elements.map(c => c.node).find(n => n.text.startsWith('<package'));
    assert.equal(pkg.startPosition.row, 2);

    const other = await parse('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE robot [\n  <!ENTITY a "b">\n]>\n<robot name="r"><script><![CDATA[ if (a < b) {} ]]></script></robot>\n');
    assert.equal(other.tree.rootNode.hasError, false);
});

test('masking keeps the source length and every line break', () => {
    const masked = LANG_CONFIGS['.xml'].preprocess(PACKAGE_XML);
    assert.equal(masked.length, PACKAGE_XML.length);
    assert.equal(masked.split('\n').length, PACKAGE_XML.split('\n').length);
    assert.match(masked, /<package format="3">/);
});

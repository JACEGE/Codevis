'use strict';

/**
 * Work around the bundled TS grammar's mutually exclusive static/accessor
 * modifier branches and accessor-named members. Only TypeScript-confirmed
 * class-member tokens are adapted; strings, comments and unrelated errors stay.
 * This is a structural compatibility parse, not an auto-accessor desugaring.
 */
function parseSource(parser, source, file) {
    const original = parser.parse(source);
    if (!/\.tsx?$/.test(file) || !original.rootNode.hasError || !source.includes('accessor')) return original;

    // Load the compiler only for TS/TSX files that need the fallback.
    const ts = require('typescript');
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, false,
        file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    if (ast.parseDiagnostics.length) return original;
    const ranges = [];
    const visit = (node) => {
        if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
            for (const member of node.members) {
                // The same grammar also mistakes a method named accessor for
                // a modifier. Rename only the parser input, never Node.text.
                if (member.name && ts.isIdentifier(member.name)
                    && source.slice(member.name.getStart(ast), member.name.end) === 'accessor') {
                    ranges.push([member.name.getStart(ast), member.name.end, '_ccessor']);
                }
                if (!ts.isPropertyDeclaration(member)) continue;
                for (const modifier of member.modifiers || []) {
                    if (modifier.kind === ts.SyntaxKind.AccessorKeyword) {
                        ranges.push([modifier.getStart(ast), modifier.end, '        ']);
                    }
                }
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(ast);
    if (!ranges.length) return original;
    let normalized = source;
    for (const [start, end, replacement] of ranges) {
        normalized = normalized.slice(0, start) + replacement + normalized.slice(end);
    }
    // Equal-length substitutions retain UTF-16 offsets, line/column positions and IDs.
    // Tree-sitter retains this public input callback for Node.text. Once the
    // parse is finished, serve the original source for all extraction/snippets.
    let input = normalized;
    const compatible = parser.parse(index => input.slice(index));
    input = source;
    if (compatible.rootNode.hasError) {
        compatible.delete();
        return original;
    }
    original.delete();
    return compatible;
}

module.exports = { parseSource };

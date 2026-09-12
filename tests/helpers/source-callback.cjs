// Extract production callbacks verbatim; controlled promises test their actual
// state writes, without claiming to exercise React rendering.
const fs = require('node:fs');
const ts = require('typescript');
const vm = require('node:vm');
function sourceCallback(file, name, globals, method) {
    const tree = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JSX);
    let found;
    function visit(node) {
        if (!method && ts.isFunctionDeclaration(node) && node.name?.text === name) found = node;
        if (method && ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
            && node.expression.name.text === method && node.arguments[0]?.text === name) found = node.arguments[1];
        if (!method && ts.isVariableDeclaration(node) && node.name.getText(tree) === name) {
            const value = node.initializer;
            found = ts.isCallExpression(value) ? value.arguments[0] : value;
        }
        ts.forEachChild(node, visit);
    }
    visit(tree);
    if (!found) throw new Error(`Callback ${name} not found in ${file}`);
    return vm.runInNewContext(`(${found.getText(tree).replace(/^export\s+(?:default\s+)?/, '')})`, globals);
}
module.exports = sourceCallback;

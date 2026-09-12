function containsRequire(node: any): boolean {
    if (['arrow_function', 'function_expression', 'function_declaration', 'method_definition'].includes(node.type)) return false;
    if (node.type === 'call_expression' && node.childForFieldName('function')?.text === 'require') return true;
    return node.namedChildren.some(containsRequire);
}

/** Return the line after complete top-level imports, preserving the file prologue. */
export function lineAfterImports(tree: any): number {
    let prologueLine = 0;
    let importLine = 0;
    let inPrologue = true;
    for (const node of tree.rootNode.namedChildren) {
        const endLine = node.endPosition.row + (node.endPosition.column > 0 ? 1 : 0);
        if (['import_statement', 'import_from_statement', 'future_import_statement', 'import_alias'].includes(node.type)
            || (['lexical_declaration', 'variable_declaration'].includes(node.type) && containsRequire(node))) {
            importLine = endLine;
        }
        if (node.type === 'comment' && node.startPosition.row < importLine) {
            importLine = Math.max(importLine, endLine);
        }
        if (inPrologue) {
            if (['comment', 'hash_bang_line'].includes(node.type)
                || (node.type === 'expression_statement' && node.namedChildren[0]?.type === 'string')) {
                prologueLine = endLine;
            } else {
                inPrologue = false;
            }
        }
    }
    return importLine || prologueLine;
}

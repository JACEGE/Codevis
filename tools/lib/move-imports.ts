import ts from 'typescript';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
const { resolvePhysicalPath } = createRequire(import.meta.url)('../../lib/file-publication.cjs');

const extension = /\.(?:[cm]?[jt]sx?)$/i;

/** Change only bindings of the moved export, preserving other imports. */
export function rewriteMovedImports(content: string, importer: string, source: string,
    target: string, symbol: string, paths: typeof path = path, movedExport: 'named' | 'default' = 'named'): string {
    const ast = ts.createSourceFile(importer, content, ts.ScriptTarget.Latest, true);
    if ((ast as any).parseDiagnostics.length) throw new Error(`Cannot parse importer: ${importer}`);
    const normal = (p: string) => {
        let resolved = paths.resolve(p);
        if (paths === path) {
            const candidate = [resolved, ...['.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs', '.mts', '.cts'].map(ext => resolved + ext)].find(existsSync);
            if (candidate) resolved = resolvePhysicalPath(candidate);
        }
        resolved = resolved.replace(extension, '');
        return paths === path.win32 || (paths === path && process.platform === 'win32') ? resolved.toLowerCase() : resolved;
    };
    const edits: Array<{ start: number; end: number; text: string }> = [];
    const printer = ts.createPrinter({ newLine: content.includes('\r\n') ? ts.NewLineKind.CarriageReturnLineFeed : ts.NewLineKind.LineFeed });
    for (const statement of ast.statements) {
        if ((!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement))
            || !statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
        const module = statement.moduleSpecifier.text;
        if (!module.startsWith('.')) continue;
        const resolved = paths.resolve(paths.dirname(importer), module);
        const candidates = [resolved, paths.join(resolved, 'index')];
        if (/\.[mc]?js$/i.test(resolved)) candidates.push(resolved.replace(/\.([mc]?)js$/i, '.$1ts'));
        if (/\.jsx?$/i.test(resolved)) candidates.push(resolved.replace(/\.jsx?$/i, '.tsx'));
        if (!candidates.some(candidate => normal(candidate) === normal(source))) continue;
        if (ts.isExportDeclaration(statement)) {
            const clause = statement.exportClause;
            if (!clause || !ts.isNamedExports(clause) || clause.elements.some(e =>
                (e.propertyName || e.name).text === (movedExport === 'default' ? 'default' : symbol))) {
                throw new Error(`Re-export in ${importer} requires explicit migration before moving ${symbol}.`);
            }
            continue;
        }
        const clause = statement.importClause;
        if (!clause) continue; // side-effect import still belongs to the source
        const bindings = clause.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings)) {
            throw new Error(`Namespace import in ${importer} requires manual migration before moving ${symbol}.`);
        }
        const elements = bindings && ts.isNamedImports(bindings) ? bindings.elements : [];
        const moved = elements.filter(e => (e.propertyName || e.name).text === (movedExport === 'default' ? 'default' : symbol));
        const movedDefault = movedExport === 'default' ? clause.name : undefined;
        if (!moved.length && !movedDefault) continue;
        if (normal(importer) === normal(target)) throw new Error(`Destination imports ${symbol}; remove that binding before moving it here.`);
        if (statement.attributes) throw new Error(`Import attributes in ${importer} require manual migration.`);
        const kept = elements.filter(e => !moved.includes(e));
        const keptDefault = movedDefault ? undefined : clause.name;
        let modulePath = paths.relative(paths.dirname(importer), target).replace(/\\/g, '/');
        if (paths.isAbsolute(modulePath) || /^[A-Za-z]:/.test(modulePath)) throw new Error('Cannot create an import across filesystem volumes');
        const oldExt = module.match(extension)?.[0];
        const targetExt = modulePath.match(extension)?.[0] || '';
        const newExt = oldExt && /\.[cm]?js$/i.test(oldExt) && /\.[cm]?tsx?$/i.test(targetExt)
            ? targetExt.replace(/tsx?$/i, 'js') : targetExt;
        modulePath = modulePath.replace(extension, oldExt ? newExt : '');
        if (!modulePath.startsWith('./') && !modulePath.startsWith('../')) modulePath = './' + modulePath;
        const print = (node: ts.Node) => printer.printNode(ts.EmitHint.Unspecified, node, ast);
        const keptImport = kept.length || keptDefault
            ? print(ts.factory.updateImportDeclaration(statement, statement.modifiers,
                ts.factory.updateImportClause(clause, clause.isTypeOnly, keptDefault,
                    kept.length ? ts.factory.createNamedImports(kept) : undefined),
                statement.moduleSpecifier, statement.attributes)) : '';
        const movedImport = ts.factory.createImportDeclaration(undefined,
            ts.factory.createImportClause(clause.isTypeOnly, movedDefault, moved.length ? ts.factory.createNamedImports(moved) : undefined),
            ts.factory.createStringLiteral(modulePath));
        edits.push({ start: statement.getStart(ast), end: statement.end,
            text: [keptImport, print(movedImport)].filter(Boolean).join(content.includes('\r\n') ? '\r\n' : '\n') });
    }
    for (const edit of edits.reverse()) content = content.slice(0, edit.start) + edit.text + content.slice(edit.end);
    return content;
}

export function assertMoveDestination(content: string, file: string, movedExport: 'named' | 'default') {
    if (movedExport !== 'default') return;
    const ast = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true);
    const hasDefault = ast.statements.some(statement =>
        (ts.isExportAssignment(statement) && !statement.isExportEquals)
        || (ts.canHaveModifiers(statement) && ts.getModifiers(statement)?.some(m => m.kind === ts.SyntaxKind.DefaultKeyword))
        || (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)
            && statement.exportClause.elements.some(e => e.name.text === 'default')));
    if (hasDefault) throw new Error('Destination already has a default export. No files were modified.');
}

import ts from 'typescript';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { FileSnapshot } from './edit-transaction.js';
const { resolvePhysicalPath } = createRequire(import.meta.url)('../../lib/file-publication.cjs');

/** Resolve JS/TS bindings rather than renaming equal identifier spellings. */
export function planSemanticRename(files: Array<Omit<FileSnapshot, 'content'>>, declarationFile: string,
    oldName: string, newName: string, hintLine?: number): FileSnapshot[] {
    const key = (file: string) => {
        const physical = resolvePhysicalPath(file);
        return process.platform === 'win32' ? physical.toLowerCase() : physical;
    };
    const byPath = new Map(files.map(file => [key(file.path), file]));
    const sourceFile = byPath.get(key(declarationFile));
    if (!sourceFile) throw new Error('Missing declaration snapshot');
    const options: ts.CompilerOptions = { allowJs: true, checkJs: true, noLib: true,
        target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler };
    const host: ts.LanguageServiceHost = {
        getScriptFileNames: () => files.map(file => file.path), getScriptVersion: () => '0',
        getScriptSnapshot: file => {
            const snapshot = byPath.get(key(file));
            return snapshot ? ts.ScriptSnapshot.fromString(snapshot.original) : undefined;
        },
        getCurrentDirectory: () => path.dirname(declarationFile), getCompilationSettings: () => options,
        getDefaultLibFileName: () => '', fileExists: file => byPath.has(key(file)),
        realpath: file => resolvePhysicalPath(file),
        resolveModuleNames: (names, containingFile) => names.map(name => {
            const resolved = ts.resolveModuleName(name, containingFile, options, host).resolvedModule;
            return resolved ? { ...resolved, resolvedFileName: resolvePhysicalPath(resolved.resolvedFileName) } : undefined;
        }),
        readFile: file => byPath.get(key(file))?.original,
        directoryExists: directory => files.some(file => key(file.path).startsWith(key(directory) + path.sep)),
    };
    const service = ts.createLanguageService(host);
    try {
        const program = service.getProgram()!;
        for (const file of files) {
            if (service.getSyntacticDiagnostics(file.path).length) throw new Error(`Cannot safely rename: syntax errors in ${file.file}`);
        }
        const ast = program.getSourceFile(declarationFile)!;
        const names: ts.Identifier[] = [];
        const visit = (node: ts.Node) => {
            if ((ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node) || ts.isMethodDeclaration(node)
                || ts.isClassDeclaration(node)) && node.name && ts.isIdentifier(node.name) && node.name.text === oldName) names.push(node.name);
            ts.forEachChild(node, visit);
        };
        visit(ast);
        if (!names.length) throw new Error(`Declaration ${oldName} not found in source`);
        if (names.length > 1 && !hintLine) throw new Error(`Ambiguous declaration ${oldName}`);
        names.sort((a, b) => Math.abs(ast.getLineAndCharacterOfPosition(a.getStart(ast)).line + 1 - (hintLine || 1))
            - Math.abs(ast.getLineAndCharacterOfPosition(b.getStart(ast)).line + 1 - (hintLine || 1)));
        const position = names[0].getStart(ast);
        const info = service.getRenameInfo(declarationFile, position, { allowRenameOfImportPath: false });
        if (info.canRename === false) throw new Error(info.localizedErrorMessage);
        const locations = service.findRenameLocations(declarationFile, position, false, false, true);
        if (!locations?.length) throw new Error('No safe rename locations found');
        const checker = program.getTypeChecker();
        const resolveAlias = (symbol: ts.Symbol) => symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
        const originalSymbol = checker.getSymbolAtLocation(names[0])!;
        for (const location of locations) {
            const file = program.getSourceFile(location.fileName)!;
            let token: ts.Node = file;
            const find = (node: ts.Node) => {
                if (node.getStart(file) <= location.textSpan.start && node.end > location.textSpan.start) {
                    token = node; ts.forEachChild(node, find);
                }
            };
            find(file);
            const conflict = checker.getSymbolsInScope(token, ts.SymbolFlags.Value | ts.SymbolFlags.Type | ts.SymbolFlags.Alias)
                .find(symbol => symbol.name === newName && resolveAlias(symbol) !== resolveAlias(originalSymbol));
            if (conflict) throw new Error(`NAME_CONFLICT: ${newName} is already bound in ${location.fileName}`);
        }
        const result = files.map(file => ({ ...file, content: file.original }));
        for (const file of result) {
            const edits = locations.filter(location => key(location.fileName) === key(file.path))
                .sort((a, b) => b.textSpan.start - a.textSpan.start);
            for (const edit of edits) {
                file.content = file.content.slice(0, edit.textSpan.start) + (edit.prefixText || '') + newName
                    + (edit.suffixText || '') + file.content.slice(edit.textSpan.start + edit.textSpan.length);
            }
            const updated = ts.createSourceFile(file.path, file.content, ts.ScriptTarget.Latest, true);
            if ((updated as any).parseDiagnostics.length) throw new Error(`Rename would create syntax errors in ${file.file}`);
        }
        return result;
    } finally { service.dispose(); }
}

import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Tree-sitter lazy init ────────────────────────
let tsParserInstance: any = null;
const tsLangCache: Record<string, any> = {};
const tsQueryCache: Record<string, any> = {};

export const JS_FUNC_QUERY_STR = `
  (function_declaration name: (identifier) @func_name parameters: (formal_parameters) @params)
  (lexical_declaration (variable_declarator name: (identifier) @func_name value: [(arrow_function parameters: (formal_parameters) @params) (function_expression parameters: (formal_parameters) @params)]))
  (variable_declaration (variable_declarator name: (identifier) @func_name value: [(arrow_function parameters: (formal_parameters) @params) (function_expression parameters: (formal_parameters) @params)]))
  (method_definition name: (property_identifier) @func_name parameters: (formal_parameters) @params)
  (export_statement declaration: (function_declaration name: (identifier) @func_name parameters: (formal_parameters) @params))
  (export_statement declaration: (lexical_declaration (variable_declarator name: (identifier) @func_name value: [(arrow_function parameters: (formal_parameters) @params) (function_expression parameters: (formal_parameters) @params)])))
`;
export const TS_FUNC_QUERY_STR = `
  (function_declaration name: (identifier) @func_name parameters: (formal_parameters) @params return_type: (type_annotation)? @return_type)
  (lexical_declaration (variable_declarator name: (identifier) @func_name value: (arrow_function parameters: (formal_parameters) @params return_type: (type_annotation)? @return_type)))
  (variable_declaration (variable_declarator name: (identifier) @func_name value: (arrow_function parameters: (formal_parameters) @params return_type: (type_annotation)? @return_type)))
  (method_definition name: (property_identifier) @func_name parameters: (formal_parameters) @params return_type: (type_annotation)? @return_type)
  (export_statement declaration: (function_declaration name: (identifier) @func_name parameters: (formal_parameters) @params))
  (export_statement declaration: (lexical_declaration (variable_declarator name: (identifier) @func_name value: (arrow_function parameters: (formal_parameters) @params return_type: (type_annotation)? @return_type))))
`;
export const PY_FUNC_QUERY_STR = `
  (function_definition name: (identifier) @func_name parameters: (parameters) @params return_type: (type)? @return_type)
  (decorated_definition definition: (function_definition name: (identifier) @func_name parameters: (parameters) @params return_type: (type)? @return_type))
`;

/**
 * Welche Dateien `edit_function` bearbeiten kann.
 *
 * `.cjs` und `.mjs` fehlten, obwohl der Builder sie kennt
 * (`scripts/graph_builder.js`, LANG_CONFIGS) und mit derselben
 * JavaScript-Grammatik parst. Der Agent fand die Funktion also im Graphen und
 * bekam beim Bearbeiten "Unsupported file extension: .cjs" -- eine Meldung, die
 * die Endung nennt und nicht die Ursache. Allein in diesem Repo betrifft das
 * 59 Dateien (44 .cjs, 15 .mjs), darunter der halbe Server.
 *
 * Keine neue Grammatik nötig: es ist derselbe Eintrag wie `.js`.
 */
export const EDIT_LANG_CONFIGS: Record<string, { wasm: string; funcQuery: string }> = {
    ".js":  { wasm: "tree-sitter-javascript/tree-sitter-javascript.wasm", funcQuery: JS_FUNC_QUERY_STR },
    ".cjs": { wasm: "tree-sitter-javascript/tree-sitter-javascript.wasm", funcQuery: JS_FUNC_QUERY_STR },
    ".mjs": { wasm: "tree-sitter-javascript/tree-sitter-javascript.wasm", funcQuery: JS_FUNC_QUERY_STR },
    ".jsx": { wasm: "tree-sitter-javascript/tree-sitter-javascript.wasm", funcQuery: JS_FUNC_QUERY_STR },
    ".ts":  { wasm: "tree-sitter-typescript/tree-sitter-typescript.wasm", funcQuery: TS_FUNC_QUERY_STR },
    ".tsx": { wasm: "tree-sitter-typescript/tree-sitter-tsx.wasm",        funcQuery: TS_FUNC_QUERY_STR },
    ".py":  { wasm: "tree-sitter-python/tree-sitter-python.wasm",         funcQuery: PY_FUNC_QUERY_STR },
};

let TSParser: any = null;
let TSLanguage: any = null;
let TSQuery: any = null;
let tsInitPromise: Promise<void> | null = null;

export async function ensureTreeSitter() {
    if (tsParserInstance) return;
    if (!tsInitPromise) {
        tsInitPromise = (async () => {
            // Use createRequire to load CommonJS web-tree-sitter (avoids ESM import issues)
            const tsReq = createRequire(import.meta.url);
            const ts = tsReq("web-tree-sitter");
            TSParser = ts.Parser || ts;
            TSLanguage = ts.Language;
            TSQuery = ts.Query;
            await TSParser.init();
            tsParserInstance = new TSParser();
        })();
    }
    await tsInitPromise;
}

export async function getLanguageAndQuery(ext: string) {
    const cfg = EDIT_LANG_CONFIGS[ext];
    if (!cfg) throw new Error(`Unsupported file extension: ${ext}`);

    await ensureTreeSitter();

    if (!tsLangCache[ext]) {
        // Navigate from lib/ up to project root's node_modules
        const wasmPath = resolve(__dirname, "../../node_modules", cfg.wasm);
        tsLangCache[ext] = await TSLanguage.load(wasmPath);
    }
    if (!tsQueryCache[ext]) {
        tsQueryCache[ext] = new TSQuery(tsLangCache[ext], cfg.funcQuery);
    }
    return { lang: tsLangCache[ext], funcQuery: tsQueryCache[ext] };
}

export function getParserInstance() {
    return tsParserInstance;
}

// ── Find function in AST by name, return byte offsets ────────────────
export function findFunctionInAST(tree: any, funcQuery: any, functionName: string, hintStartLine?: number): { node: any; startIndex: number; endIndex: number; startLine: number; endLine: number } | null {
    // 1. Try tree-sitter query matches first — collect ALL matches by name
    const matches = funcQuery.matches(tree.rootNode);
    const candidates: Array<{ node: any; startIndex: number; endIndex: number; startLine: number; endLine: number }> = [];

    for (const match of matches) {
        const nameCapture = match.captures.find((c: any) => c.name === "func_name");
        if (nameCapture && nameCapture.node.text === functionName) {
            let funcNode = nameCapture.node.parent;
            if (funcNode?.type === "variable_declarator") {
                const declaration = funcNode.parent;
                // Grouped declarations contain other bindings outside this function.
                if (declaration?.namedChildren.filter((node: any) => node.type === 'variable_declarator').length === 1) {
                    funcNode = declaration;
                }
            }
            if (!funcNode) continue;
            candidates.push({
                node: funcNode,
                startIndex: funcNode.startIndex,
                endIndex: funcNode.endIndex,
                startLine: funcNode.startPosition.row + 1,
                endLine: funcNode.endPosition.row + 1,
            });
        }
    }

    if (candidates.length === 1) return candidates[0];
    if (candidates.length > 1 && hintStartLine) {
        // Disambiguate: pick closest to hintStartLine
        candidates.sort((a, b) => Math.abs(a.startLine - hintStartLine) - Math.abs(b.startLine - hintStartLine));
        return candidates[0];
    }
    if (candidates.length > 1) return candidates[0]; // No hint — return first

    // Query gaps must not turn comments, strings or calls into editable definitions.
    return walkASTForFunction(tree.rootNode, functionName);
}

// Walk AST to find class methods, property assignments, etc.
export function walkASTForFunction(node: any, name: string): { node: any; startIndex: number; endIndex: number; startLine: number; endLine: number } | null {
    const field = (key: string) => node.childForFieldName?.(key);
    let definition = null;
    if (['function_declaration', 'generator_function_declaration', 'function_definition', 'method_definition'].includes(node.type)
        && field('name')?.text === name) {
        definition = node;
    } else if (['variable_declarator', 'pair', 'field_definition', 'public_field_definition'].includes(node.type)
        && (field('name') || field('key') || field('property'))?.text === name) {
        let value = field('value');
        while (value?.type === 'parenthesized_expression') value = value.namedChildren[0];
        if (['arrow_function', 'function_expression', 'generator_function'].includes(value?.type)) {
            definition = node;
            if (node.type === 'variable_declarator'
                && node.parent.namedChildren.filter((child: any) => child.type === 'variable_declarator').length === 1) definition = node.parent;
        }
    }
    if (definition) return {
        node: definition, startIndex: definition.startIndex, endIndex: definition.endIndex,
        startLine: definition.startPosition.row + 1, endLine: definition.endPosition.row + 1,
    };

    // Recurse into children
    for (const child of node.children || []) {
        const result = walkASTForFunction(child, name);
        if (result) return result;
    }
    return null;
}

// Regex-based fallback for when tree-sitter queries miss a pattern
export function findFunctionByRegex(source: string, functionName: string): { node: any; startIndex: number; endIndex: number; startLine: number; endLine: number } | null {
    const escaped = functionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const patterns = [
        new RegExp(`(?:async\\s+)?function\\s+${escaped}\\s*\\(`),
        new RegExp(`(?:const|let|var)\\s+${escaped}\\s*=\\s*(?:async\\s+)?(?:function\\s*)?\\(`),
        new RegExp(`(?:const|let|var)\\s+${escaped}\\s*=\\s*(?:async\\s+)?\\(`),
        new RegExp(`^\\s*(?:async\\s+)?${escaped}\\s*\\(`, "m"), // class method
        new RegExp(`def\\s+${escaped}\\s*\\(`), // Python
    ];

    for (const pattern of patterns) {
        const m = pattern.exec(source);
        if (!m) continue;

        const startIdx = m.index;
        // Find the end by brace/indent counting.
        // Track string/comment state so braces inside string literals or comments
        // (e.g. `{ const s = "}"; return 1; }`) do NOT prematurely close the body.
        let braceDepth = 0;
        let foundOpen = false;
        let endIdx = startIdx;

        let inString = false;
        let stringChar = "";
        let escaped = false;
        let inLineComment = false;
        let inBlockComment = false;

        for (let i = startIdx; i < source.length; i++) {
            const ch = source[i];
            const next = source[i + 1];

            // Inside a line comment: consume until newline.
            if (inLineComment) {
                if (ch === "\n") inLineComment = false;
                continue;
            }
            // Inside a block comment: consume until '*/'.
            if (inBlockComment) {
                if (ch === "*" && next === "/") { inBlockComment = false; i++; }
                continue;
            }
            // Inside a string/template literal: consume until the matching quote,
            // honouring backslash escapes.
            if (inString) {
                if (escaped) { escaped = false; continue; }
                if (ch === "\\") { escaped = true; continue; }
                if (ch === stringChar) { inString = false; }
                continue;
            }

            // Not in a string/comment — detect entries into them first.
            if (ch === "/" && next === "/") { inLineComment = true; i++; continue; }
            if (ch === "/" && next === "*") { inBlockComment = true; i++; continue; }
            if (ch === "'" || ch === '"' || ch === "`") { inString = true; stringChar = ch; continue; }

            if (ch === "{") { braceDepth++; foundOpen = true; }
            if (ch === "}") { braceDepth--; }
            if (foundOpen && braceDepth === 0) {
                endIdx = i + 1;
                break;
            }
            // Python: use indentation (find next line at same or lower indent)
            if (!foundOpen && ch === ":" && source.slice(startIdx, i).includes("def ")) {
                foundOpen = true;
                const lineStart = source.lastIndexOf("\n", startIdx) + 1;
                const lineText = source.slice(lineStart, source.indexOf("\n", startIdx));
                const baseIndent = lineText.match(/^(\s*)/)?.[1]?.length || 0;
                let j = i + 1;
                while (j < source.length) {
                    const lineEnd = source.indexOf("\n", j);
                    if (lineEnd === -1) { endIdx = source.length; break; }
                    const nextLine = source.slice(j, lineEnd);
                    if (nextLine.trim().length > 0) {
                        const indent = nextLine.match(/^(\s*)/)?.[1]?.length || 0;
                        if (indent <= baseIndent) { endIdx = j; break; }
                    }
                    j = lineEnd + 1;
                }
                if (endIdx === startIdx) endIdx = source.length;
                break;
            }
        }

        if (endIdx <= startIdx) continue;

        const beforeText = source.slice(0, startIdx);
        const startLine = beforeText.split("\n").length;
        const funcText = source.slice(startIdx, endIdx);
        const endLine = startLine + funcText.split("\n").length - 1;

        // Use character offsets (matching web-tree-sitter's startIndex/endIndex)
        const startIndex = startIdx;
        const endIndex = endIdx;

        return {
            node: { text: funcText },
            startIndex,
            endIndex,
            startLine,
            endLine,
        };
    }
    return null;
}

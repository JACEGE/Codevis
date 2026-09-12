#!/usr/bin/env node
/**
 * Tests for tree-sitter function finding (matching findFunctionInAST logic).
 * Run: node --test tests/treesitter.test.js
 */

const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { resolve } = require("node:path");

let Parser, Language, Query;
let jsLang, jsxLang, tsLang, tsxLang, pyLang, cLang, cppLang, goLang, rustLang, javaLang, rubyLang, luaLang;

const {
    LANG_CONFIGS,
    resolveImportPath,
    resolveGrammarWasm,
    safeQuery,
    extractFunctions,
    extractCalls,
    extractCallbacks,
    extractStates,
    extractEffects,
    extractReactWrappers,
    cppReceiverTypes,
    pythonScopedAliases,
} = require("../scripts/graph_builder.js").__testing__;

const JS_FUNC_QUERY_STR = `
  (function_declaration name: (identifier) @func_name parameters: (formal_parameters) @params)
  (lexical_declaration (variable_declarator name: (identifier) @func_name value: [(arrow_function parameters: (formal_parameters) @params) (function_expression parameters: (formal_parameters) @params)]))
  (variable_declaration (variable_declarator name: (identifier) @func_name value: [(arrow_function parameters: (formal_parameters) @params) (function_expression parameters: (formal_parameters) @params)]))
  (method_definition name: (property_identifier) @func_name parameters: (formal_parameters) @params)
  (export_statement declaration: (function_declaration name: (identifier) @func_name parameters: (formal_parameters) @params))
  (export_statement declaration: (lexical_declaration (variable_declarator name: (identifier) @func_name value: [(arrow_function parameters: (formal_parameters) @params) (function_expression parameters: (formal_parameters) @params)])))
`;

const TS_FUNC_QUERY_STR = `
  (function_declaration name: (identifier) @func_name parameters: (formal_parameters) @params return_type: (type_annotation)? @return_type)
  (lexical_declaration (variable_declarator name: (identifier) @func_name value: (arrow_function parameters: (formal_parameters) @params return_type: (type_annotation)? @return_type)))
  (variable_declaration (variable_declarator name: (identifier) @func_name value: (arrow_function parameters: (formal_parameters) @params return_type: (type_annotation)? @return_type)))
  (method_definition name: (property_identifier) @func_name parameters: (formal_parameters) @params return_type: (type_annotation)? @return_type)
  (export_statement declaration: (function_declaration name: (identifier) @func_name parameters: (formal_parameters) @params))
  (export_statement declaration: (lexical_declaration (variable_declarator name: (identifier) @func_name value: (arrow_function parameters: (formal_parameters) @params return_type: (type_annotation)? @return_type))))
`;

const PY_FUNC_QUERY_STR = `
  (function_definition name: (identifier) @func_name parameters: (parameters) @params return_type: (type)? @return_type)
  (decorated_definition definition: (function_definition name: (identifier) @func_name parameters: (parameters) @params return_type: (type)? @return_type))
`;

function findFunctionInAST(tree, funcQuery, functionName, hintStartLine) {
    const matches = funcQuery.matches(tree.rootNode);
    const candidates = [];
    for (const match of matches) {
        const nameCapture = match.captures.find(c => c.name === "func_name");
        if (nameCapture && nameCapture.node.text === functionName) {
            let funcNode = nameCapture.node.parent;
            if (funcNode?.type === "variable_declarator") {
                funcNode = funcNode.parent;
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
        candidates.sort((a, b) => Math.abs(a.startLine - hintStartLine) - Math.abs(b.startLine - hintStartLine));
        return candidates[0];
    }
    if (candidates.length > 1) return candidates[0];
    return null;
}

before(async () => {
    const ts = require("web-tree-sitter");
    Parser = ts.Parser || ts;
    Language = ts.Language;
    Query = ts.Query;
    await Parser.init();

    const nmDir = resolve(__dirname, "../node_modules");
    jsLang = await Language.load(resolve(nmDir, "tree-sitter-javascript/tree-sitter-javascript.wasm"));
    jsxLang = jsLang;
    tsLang = await Language.load(resolve(nmDir, "tree-sitter-typescript/tree-sitter-typescript.wasm"));
    tsxLang = await Language.load(resolve(nmDir, "tree-sitter-typescript/tree-sitter-tsx.wasm"));
    pyLang = await Language.load(resolve(nmDir, "tree-sitter-python/tree-sitter-python.wasm"));
    cLang = await Language.load(resolve(nmDir, "tree-sitter-c/tree-sitter-c.wasm"));
    cppLang = await Language.load(resolve(nmDir, "tree-sitter-cpp/tree-sitter-cpp.wasm"));
    goLang = await Language.load(resolve(nmDir, "tree-sitter-go/tree-sitter-go.wasm"));
    rustLang = await Language.load(resolve(nmDir, "tree-sitter-rust/tree-sitter-rust.wasm"));
    javaLang = await Language.load(resolve(nmDir, "tree-sitter-java/tree-sitter-java.wasm"));
    rubyLang = await Language.load(resolve(nmDir, "tree-sitter-ruby/tree-sitter-ruby.wasm"));
    luaLang = await Language.load(resolve(nmDir, "tree-sitter-wasm/out/lua/tree-sitter-lua.wasm"));
});

function realLanguage(extension) {
    if (extension === ".js") return jsLang;
    if (extension === ".jsx") return jsxLang;
    if (extension === ".ts") return tsLang;
    if (extension === ".tsx") return tsxLang;
    if (extension === ".py") return pyLang;
    if (extension === ".c") return cLang;
    if (extension === ".cpp") return cppLang;
    if (extension === ".go") return goLang;
    if (extension === ".rs") return rustLang;
    if (extension === ".java") return javaLang;
    if (extension === ".rb") return rubyLang;
    if (extension === ".lua") return luaLang;
    throw new Error(`unsupported test extension: ${extension}`);
}

function parseWithRealConfig(extension, source) {
    const language = realLanguage(extension);
    const config = LANG_CONFIGS[extension];
    const parser = new Parser();
    parser.setLanguage(language);
    const tree = parser.parse(source);
    assert.equal(tree.rootNode.hasError, false, tree.rootNode.toString());
    return { language, config, tree };
}

function capturesFor(extension, source, queryName, captureName) {
    const { language, config, tree } = parseWithRealConfig(extension, source);
    const query = safeQuery(language, config[queryName]);
    assert.ok(query, `${extension} ${queryName} must compile against the real grammar`);
    return query.matches(tree.rootNode)
        .flatMap(match => match.captures)
        .filter(capture => capture.name === captureName)
        .map(capture => capture.node.text);
}

function recordingFunctionSession(file = "fixture.js") {
    const calls = [];
    const functionNames = new Set();
    return {
        calls,
        async run(cypher, params = {}) {
            const normalized = cypher.replace(/\s+/g, " ").trim();
            calls.push({ cypher: normalized, params });
            if (normalized.includes("MERGE (func:") && params.funcName) {
                functionNames.add(params.funcName);
            }
            if (normalized.includes("RETURN f.name AS name, f.file AS file")) {
                return {
                    records: [...functionNames].map(name => ({
                        get(key) {
                            return key === "name" ? name : file;
                        },
                    })),
                };
            }
            return { records: [] };
        },
    };
}

async function extractRealFunctions(extension, source, session = null, relativePath = `fixture${extension}`) {
    session ||= recordingFunctionSession(relativePath);
    const { language, config, tree } = parseWithRealConfig(extension, source);
    const cached = {
        funcQuery: new Query(language, config.funcQuery),
        callQuery: new Query(language, config.callQuery),
        jsxQuery: safeQuery(language, config.jsxQuery),
        stateQuery: safeQuery(language, config.stateQuery),
        hookEffectQuery: safeQuery(language, config.hookEffectQuery),
        callbackQuery: safeQuery(language, config.callbackQuery),
        variableQuery: safeQuery(language, config.variableQuery),
        reactWrapperQuery: safeQuery(language, config.reactWrapperQuery),
        moduleAliasQuery: null,
        attributeTypeQuery: null,
    };
    const graphMod = { int: value => value };
    const funcBounds = await extractFunctions(
        session, cached, tree, relativePath, graphMod, []
    );
    return { cached, tree, funcBounds, session, relativePath };
}

// Jede Tabellenzeile wird als eigener Test registriert. Damit kann keine neue
// Query nur deshalb grün werden, weil safeQuery ihren Grammatikfehler als null
// verschluckt: sie muss kompilieren UND den sprachtypischen Schnipsel treffen.
function registerLanguageQueryTests(label, extension, source, expectations) {
    describe(`graph_builder ${label} core queries`, () => {
        for (const [queryName, captureName, expectedText] of expectations) {
            it(`${queryName} compiles and captures ${expectedText}`, () => {
                const captures = capturesFor(
                    extension, source, queryName, captureName
                );
                assert.ok(
                    captures.includes(expectedText),
                    `${queryName} produced ${JSON.stringify(captures)}`
                );
            });
        }
    });
}

const C_CORE_SOURCE = `#include "local.h"
#include <stdio.h>
int helper(int value) { return value; }
int run(int callback, int *pointer) {
    int alias = callback;
    dispatch(callback);
    if (pointer) { helper(alias); }
    for (int index = 0; index < 1; index++) { continue; }
    return pointer[0];
}`;

registerLanguageQueryTests("C", ".c", C_CORE_SOURCE, [
    ["importQuery", "import_source", "\"local.h\""],
    ["aliasQuery", "alias_name", "alias"],
    ["callbackQuery", "callback_ref", "callback"],
    ["conditionalCallQuery", "then_branch", "{ helper(alias); }"],
    ["controlFlowQuery", "for_stmt", "for (int index = 0; index < 1; index++) { continue; }"],
    ["statementQuery", "return_stmt", "return pointer[0];"],
    ["variableQuery", "param_name", "pointer"],
    ["astQuery", "SubscriptExpression", "pointer[0]"],
]);

const CPP_CORE_SOURCE = `#include "box.hpp"
#include <vector>
template<class T> class Box { public: T get(); };
template<class T> T Box<T>::get() { return T{}; }
int helper(int value) { return value; }
int run(int callback, int *pointer) {
    auto alias = callback;
    dispatch(callback);
    if (pointer) { helper(alias); }
    for (int index = 0; index < 1; index++) { continue; }
    auto box = new Box<int>();
    co_await helper(1);
    return box->get();
}`;

registerLanguageQueryTests("C++", ".cpp", CPP_CORE_SOURCE, [
    ["funcQuery", "func_name", "get"],
    ["importQuery", "import_source", "\"box.hpp\""],
    ["aliasQuery", "alias_name", "alias"],
    ["callbackQuery", "callback_ref", "callback"],
    ["conditionalCallQuery", "then_branch", "{ helper(alias); }"],
    ["asyncChainQuery", "await_target", "helper"],
    ["instantiationQuery", "class_name", "Box"],
    ["controlFlowQuery", "for_stmt", "for (int index = 0; index < 1; index++) { continue; }"],
    ["statementQuery", "return_stmt", "return box->get();"],
    ["variableQuery", "param_name", "pointer"],
    ["astQuery", "MemberExpression", "box->get"],
]);

describe("graph_builder C/C++ include resolution", () => {
    it("captures project headers but excludes system headers", () => {
        assert.deepEqual(capturesFor(".c", C_CORE_SOURCE, "importQuery", "import_source"), ["\"local.h\""]);
        assert.deepEqual(capturesFor(".cpp", CPP_CORE_SOURCE, "importQuery", "import_source"), ["\"box.hpp\""]);
    });

    it("resolves quoted headers relative to the source and project root", () => {
        const files = new Set(["src/local.h", "include/shared.hpp"]);
        assert.equal(resolveImportPath("\"local.h\"", "src/main.c", files).resolved, "src/local.h");
        assert.equal(resolveImportPath("\"include/shared.hpp\"", "src/main.cpp", files).resolved, "include/shared.hpp");
    });
});

describe("graph_builder C++ receiver resolution", () => {
    it("captures member and class-qualified call receivers", () => {
        assert.deepEqual(
            capturesFor(".cpp", "void run(Box* box) { box->get(); Box::reset(); }", "callQuery", "call_object"),
            ["box", "Box"]
        );
    });

    it("infers conservative types for values, pointers, references and smart pointers", () => {
        const types = cppReceiverTypes(`
void run(const ns::Widget& input, Controller* controller) {
  Widget local{};
  auto heap = std::make_unique<ns::Widget>();
  auto shared = std::make_shared<Controller>();
}`);
        assert.equal(types.get("input"), "Widget");
        assert.equal(types.get("controller"), "Controller");
        assert.equal(types.get("local"), "Widget");
        assert.equal(types.get("heap"), "Widget");
        assert.equal(types.get("shared"), "Controller");
    });

    it("captures address-of callbacks", () => {
        assert.deepEqual(
            capturesFor(".cpp", "void hook(){} void setup(){ subscribe(&hook); }", "callbackQuery", "callback_ref"),
            ["hook"]
        );
        assert.deepEqual(
            capturesFor(".cpp", "void setup(){ subscribe(*handler); }", "callbackQuery", "callback_ref"),
            []
        );
    });

    it("does not invent receivers from class declarations or conflicting scopes", () => {
        const types = cppReceiverTypes(`
struct Owner {};
void first(Alpha& value) { value.run(); }
void second(Beta& value) { value.run(); }
`);
        assert.equal(types.has("r"), false, "`struct Owner` must not become the bogus pair Owne/r");
        assert.equal(types.has("value"), false, "conflicting scoped types must remain unresolved");
    });
});

it("Java generic superclass and interfaces retain their base symbols", () => {
    const source = "class A<T> extends Base<T> implements Comparable<A<T>>, Runnable {}";
    assert.deepEqual(
        capturesFor(".java", source, "classInheritanceQuery", "base_class").sort(),
        ["Base", "Comparable", "Runnable"]
    );
});

it("Java qualified nested generic bases retain the final scoped symbol", () => {
    const source = "class A<T> extends pkg.Outer.Inner<java.util.List<T>> implements pkg.Api.Contract<java.util.Map<String, T>>, Plain {}";
    const bases = capturesFor(".java", source, "classInheritanceQuery", "base_class")
        .map((name) => name.replace(/<.*$/s, "").split(".").pop()).sort();
    assert.deepEqual(bases, ["Contract", "Inner", "Plain"]);
});

describe("adversarial receiver safety", () => {
    const corpus = JSON.parse(fs.readFileSync(resolve(__dirname, "fixtures", "adversarial", "parser-cases.json"), "utf8"));
    assert.equal(corpus.version, 1);
    for (const fixture of corpus.cases) {
        it(`${fixture.id} forbids an unsupported exact call edge`, async () => {
            const { extension, source, forbidCall: { caller, target } } = fixture;
            const relativePath = `adversarial-${fixture.id}${extension}`;
            const extracted = await extractRealFunctions(extension, source, null, relativePath);
            await extractCalls(
                extracted.session, extracted.cached, extracted.tree,
                relativePath, extracted.funcBounds, []
            );
            const falseEdge = extracted.session.calls.find(call =>
                call.cypher.includes("MERGE (caller)-[r:CALLS]->(callee)") &&
                call.params.callerName === caller &&
                call.params.targetFuncName === target
            );
            assert.equal(falseEdge, undefined);
        });
    }

    it("Ruby keeps explicit self recursion inside the method scope", async () => {
        const relativePath = "ruby-self.rb";
        const extracted = await extractRealFunctions(".rb", "def run; self.run(); end", null, relativePath);
        await extractCalls(extracted.session, extracted.cached, extracted.tree, relativePath, extracted.funcBounds, []);
        assert.ok(extracted.session.calls.some(call =>
            call.cypher.includes("MERGE (caller)-[r:CALLS]->(callee)") &&
            call.params.callerName === "run" && call.params.targetFuncName === "run"
        ));
    });

    for (const [extension, source] of [
        [".java", "class A { void save(){} void invoke(){ this.save(); } }"],
        [".js", "class A { save(){} invoke(){ this.save(); } }"],
    ]) {
        it(`${extension} preserves explicit self receiver calls`, async () => {
            const relativePath = `self-receiver${extension}`;
            const extracted = await extractRealFunctions(extension, source, null, relativePath);
            await extractCalls(
                extracted.session, extracted.cached, extracted.tree,
                relativePath, extracted.funcBounds, []
            );
            assert.ok(extracted.session.calls.some(call =>
                call.cypher.includes("MERGE (caller)-[r:CALLS]->(callee)") &&
                call.params.callerName === "invoke" &&
                call.params.targetFuncName === "save" &&
                call.params.via === "self-receiver"
            ), JSON.stringify(extracted.session.calls.filter(call => call.params.targetFuncName === "save"), null, 2));
        });
    }
});

describe("Python single-assignment aliases", () => {
    it("keeps immutable aliases and rejects reassignment", () => {
        const one = parseWithRealConfig(".py", "handler = on_tick");
        assert.deepEqual([...pythonScopedAliases(one.tree.rootNode)], [["<module>|handler", "on_tick"]]);
        const reassigned = parseWithRealConfig(".py", "handler = on_tick\nhandler = fallback");
        assert.equal(pythonScopedAliases(reassigned.tree.rootNode).has("<module>|handler"), false);
        const stringOnly = parseWithRealConfig(".py", "\"\"\"\\nhandler = on_tick\\n\"\"\"\nhandler()");
        assert.equal(pythonScopedAliases(stringOnly.tree.rootNode).has("<module>|handler"), false);
    });

    it("resolves alias calls and alias callback arguments", async () => {
        const source = `
def helper(): pass
def register(callback): pass
def run():
    alias = helper
    alias()
    register(alias)
`;
        const relativePath = "python-alias.py";
        const extracted = await extractRealFunctions(".py", source, null, relativePath);
        await extractCalls(extracted.session, extracted.cached, extracted.tree, relativePath, extracted.funcBounds, []);
        await extractCallbacks(extracted.session, extracted.cached, extracted.tree, relativePath, extracted.funcBounds);
        assert.ok(extracted.session.calls.some(call =>
            call.cypher.includes("MERGE (caller)-[r:CALLS]->(callee)") &&
            call.params.callerName === "run" && call.params.targetFuncName === "helper" &&
            call.params.via === "single-assignment-alias"
        ));
        assert.ok(extracted.session.calls.some(call =>
            call.cypher.includes("PASSES_CALLBACK") &&
            call.params.enclosingFunc === "run" && call.params.callbackRef === "helper"
        ));
    });

    it("lets a function parameter shadow a module alias", async () => {
        const source = `
def helper(): pass
def register(callback): pass
alias = helper
def run(alias):
    alias()
    register(alias)
`;
        const relativePath = "python-alias-shadow.py";
        const extracted = await extractRealFunctions(".py", source, null, relativePath);
        await extractCalls(extracted.session, extracted.cached, extracted.tree, relativePath, extracted.funcBounds, []);
        await extractCallbacks(extracted.session, extracted.cached, extracted.tree, relativePath, extracted.funcBounds);
        assert.equal(extracted.session.calls.some(call =>
            (call.cypher.includes("CALLS]->") || call.cypher.includes("PASSES_CALLBACK")) &&
            call.params.enclosingFunc === "run" && call.params.callbackRef === "helper"
        ), false);
        assert.equal(extracted.session.calls.some(call =>
            call.cypher.includes("MERGE (caller)-[r:CALLS]->(callee)") &&
            call.params.callerName === "run" && call.params.targetFuncName === "helper"
        ), false);
    });
});

const GO_CORE_SOURCE = `package fixture
import alias "example.com/lib"
type Base struct{}
type Child struct{ Base }
func Exported(cb func()) int {
    copy := Exported
    dispatch(cb)
    go Exported(cb)
    if true { alias.Run() }
    value := Child{}
    for value != (Child{}) { break }
    return 1
}`;

registerLanguageQueryTests("Go", ".go", GO_CORE_SOURCE, [
    ["namedImportQuery", "import_name", "alias"],
    ["namedExportQuery", "export_name", "Exported"],
    ["aliasQuery", "alias_name", "copy"],
    ["callbackQuery", "callback_ref", "cb"],
    ["conditionalCallQuery", "then_branch", "{ alias.Run() }"],
    ["asyncChainQuery", "spawn_target", "Exported"],
    ["classInheritanceQuery", "base_class", "Base"],
    ["instantiationQuery", "class_name", "Child"],
    ["controlFlowQuery", "for_stmt", "for value != (Child{}) { break }"],
    ["statementQuery", "return_stmt", "return 1"],
    ["variableQuery", "param_name", "cb"],
    ["astQuery", "NumberLiteral", "1"],
]);

const RUST_CORE_SOURCE = `use crate::tools::run as execute;
pub struct Worker { value: i32 }
pub fn exported(cb: fn()) -> i32 {
    let alias = exported;
    dispatch(cb);
    if true { execute(); }
    let worker = Worker { value: 1 };
    async_call().await;
    for item in [1] { if item > 0 { continue; } }
    return worker.value;
}
trait Job {}
impl Job for Worker {}`;

registerLanguageQueryTests("Rust", ".rs", RUST_CORE_SOURCE, [
    ["namedImportQuery", "import_name", "run"],
    ["namedExportQuery", "export_name", "exported"],
    ["aliasQuery", "alias_name", "alias"],
    ["callbackQuery", "callback_ref", "cb"],
    ["conditionalCallQuery", "then_branch", "{ execute(); }"],
    ["asyncChainQuery", "await_target", "async_call"],
    ["classInheritanceQuery", "base_class", "Job"],
    ["instantiationQuery", "class_name", "Worker"],
    ["controlFlowQuery", "for_stmt", "for item in [1] { if item > 0 { continue; } }"],
    ["statementQuery", "return_stmt", "return worker.value"],
    ["variableQuery", "param_name", "cb"],
    ["astQuery", "MemberExpression", "worker.value"],
]);

const JAVA_CORE_SOURCE = `import static demo.Tools.run;
public class Worker {
    int value;
    public int work(Runnable cb) {
        Runnable alias = cb;
        dispatch(cb);
        if (true) { run(); }
        Worker worker = new Worker();
        for (int i = 0; i < 1; i++) { continue; }
        return worker.value;
    }
}`;

registerLanguageQueryTests("Java", ".java", JAVA_CORE_SOURCE, [
    ["namedImportQuery", "import_name", "run"],
    ["namedExportQuery", "export_name", "work"],
    ["aliasQuery", "alias_name", "alias"],
    ["callbackQuery", "callback_ref", "cb"],
    ["conditionalCallQuery", "then_branch", "{ run(); }"],
    ["controlFlowQuery", "for_stmt", "for (int i = 0; i < 1; i++) { continue; }"],
    ["statementQuery", "return_stmt", "return worker.value;"],
    ["variableQuery", "param_name", "cb"],
    ["astQuery", "MemberExpression", "worker.value"],
]);

describe("graph_builder JavaScript/TypeScript regression queries", () => {
    it("1 - parses JSX in .js files and marks the enclosing function as a component", async () => {
        assert.ok(LANG_CONFIGS[".js"].jsxQuery);
        assert.ok(LANG_CONFIGS[".js"].jsxComponentQuery);
        assert.ok(LANG_CONFIGS[".js"].jsxPropQuery);

        const { session } = await extractRealFunctions(
            ".js", "function App() { return <main />; }"
        );
        const write = session.calls.find(call => call.params.funcName === "App");
        assert.match(write.cypher, /MERGE \(func:Function:Component/);
    });

    it("2 - detects self-closing JSX and fragments as component output", async () => {
        const { funcBounds, session } = await extractRealFunctions(".jsx", `
const Icon = () => <Glyph />;
const Group = () => <>content</>;
`);
        assert.deepEqual(
            funcBounds.filter(bound => bound.isComponent).map(bound => bound.name).sort(),
            ["Group", "Icon"]
        );
        const componentWrites = session.calls
            .filter(call => /MERGE \(func:Function:Component/.test(call.cypher))
            .map(call => call.params.funcName)
            .sort();
        assert.deepEqual(componentWrites, ["Group", "Icon"]);
    });

    it("3 - captures member-expression JSX component names and spread props", () => {
        const source = `
const View = props => (
  <Motion.div><Icons.Search /><Form.Item {...props} /></Motion.div>
);
`;
        assert.deepEqual(
            capturesFor(".jsx", source, "jsxComponentQuery", "component_name").sort(),
            ["Form.Item", "Icons.Search", "Motion.div"]
        );
        assert.deepEqual(
            capturesFor(".jsx", source, "jsxSpreadQuery", "component_name"),
            ["Form.Item"]
        );
    });

    it("4 - finds TypeScript function expressions assigned to variables", () => {
        assert.deepEqual(
            capturesFor(
                ".ts",
                "const parse = function(value: string): string { return value; };",
                "funcQuery",
                "func_name"
            ),
            ["parse"]
        );
    });

    it("5 - finds unparenthesized single-parameter arrows in JS and TS", () => {
        assert.deepEqual(
            capturesFor(".js", "const useThing = x => x;", "funcQuery", "func_name"),
            ["useThing"]
        );
        assert.deepEqual(
            capturesFor(".ts", "const Row = props => props.id;", "funcQuery", "func_name"),
            ["Row"]
        );
    });

    it("6 - finds class fields, object functions, generators, var declarations and TS signatures", () => {
        const jsNames = capturesFor(".js", `
class Controller { onClick = event => event; }
const service = { load() {}, reduce: state => state };
function* watchSaga(action) { yield action; }
var legacy = function(value) { return value; };
`, "funcQuery", "func_name");
        assert.deepEqual(jsNames.sort(), [
            "legacy", "load", "onClick", "reduce", "watchSaga"
        ]);

        const tsNames = capturesFor(".ts", `
abstract class Base { abstract execute(value: string): void; field = value => value; }
interface Service { request(value: string): Promise<string>; }
const reducers = { reset() {}, apply: state => state };
function* typedSaga(action: string) { yield action; }
var typedLegacy = function(value: string): string { return value; };
`, "funcQuery", "func_name");
        assert.deepEqual(tsNames.sort(), [
            "apply", "execute", "field", "request", "reset", "typedLegacy", "typedSaga"
        ]);
    });

    it("6 - does not duplicate exported definitions in function bounds", async () => {
        const { funcBounds } = await extractRealFunctions(".js", `
export function declared() {}
export const assigned = () => null;
`);
        assert.deepEqual(funcBounds.map(bound => bound.name).sort(), ["assigned", "declared"]);
    });

    it("7a - models custom hooks and links calls from their users", async () => {
        const extracted = await extractRealFunctions(".js", `
const useThing = value => value;
function Panel() { return useThing(1); }
`);
        await extractCalls(
            extracted.session,
            extracted.cached,
            extracted.tree,
            "fixture.js",
            extracted.funcBounds,
            []
        );

        const hookWrite = extracted.session.calls.find(
            call => call.params.funcName === "useThing"
        );
        assert.match(hookWrite.cypher, /MERGE \(func:Function:Hook/);
        assert.equal(hookWrite.params.functionKind, "CustomHook");
        assert.ok(extracted.session.calls.some(call =>
            call.cypher.includes("MERGE (caller)-[r:CALLS]->(callee)") &&
            call.params.callerName === "Panel" &&
            call.params.targetFuncName === "useThing"
        ));
    });

    it("7b - extracts useEffect without a dependency array", async () => {
        const hooks = capturesFor(
            ".jsx",
            "function App() { useEffect(() => subscribe()); return <main />; }",
            "hookEffectQuery",
            "hook_name"
        );
        assert.deepEqual(hooks, ["useEffect"]);

        const extracted = await extractRealFunctions(
            ".jsx",
            "function App() { useEffect(() => subscribe()); return <main />; }"
        );
        await extractEffects(
            extracted.session,
            extracted.cached,
            extracted.tree,
            "fixture.js",
            extracted.funcBounds,
            { int: value => value }
        );
        const effectWrite = extracted.session.calls.find(call =>
            call.cypher.includes("MERGE (eff:Effect")
        );
        assert.ok(effectWrite);
        assert.deepEqual(effectWrite.params.deps, []);
    });

    it("7c - extracts useReducer state and useRef values", async () => {
        const source = `
function App() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const inputRef = useRef(null);
  dispatch(state);
  return <input ref={inputRef} />;
}
`;
        const states = capturesFor(".jsx", `
function App() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const inputRef = useRef(null);
  return <input ref={inputRef} />;
}
`, "stateQuery", "state_name");
        assert.deepEqual(states.sort(), ["inputRef", "state"]);

        const extracted = await extractRealFunctions(".jsx", source);
        await extractStates(
            extracted.session,
            extracted.cached,
            extracted.tree,
            "fixture.js",
            extracted.funcBounds
        );
        const stateWrites = extracted.session.calls
            .filter(call => call.cypher.includes("MERGE (state:State"))
            .map(call => call.params.stateName)
            .sort();
        assert.deepEqual(stateWrites, ["inputRef", "state"]);
        assert.ok(extracted.session.calls.some(call =>
            call.cypher.includes("MERGE (func)-[:WRITES_STATE]->(state)") &&
            call.params.stateName === "state"
        ));
    });

    it("7d - extracts nested memo(forwardRef(...)) wrappers", async () => {
        assert.deepEqual(
            capturesFor(
                ".tsx",
                "const Row = memo(forwardRef((props, ref) => <Form.Item />));",
                "reactWrapperQuery",
                "component_name"
            ),
            ["Row"]
        );

        const extracted = await extractRealFunctions(
            ".tsx",
            "const Row = memo(forwardRef((props, ref) => <Form.Item />));"
        );
        await extractReactWrappers(
            extracted.session,
            extracted.cached,
            extracted.tree,
            "fixture.js",
            extracted.funcBounds,
            { int: value => value }
        );
        const wrapperWrite = extracted.session.calls.find(call =>
            call.params.componentName === "Row"
        );
        assert.ok(wrapperWrite);
        assert.match(wrapperWrite.cypher, /MERGE \(func:Function:Component/);
        assert.equal(wrapperWrite.params.wrapperFunc, "memo>forwardRef");
        assert.equal(wrapperWrite.params.params, "(props, ref)");
    });
});

describe("findFunctionInAST - JavaScript", () => {
    let parser, funcQuery;

    before(() => {
        parser = new Parser();
        parser.setLanguage(jsLang);
        funcQuery = new Query(jsLang, JS_FUNC_QUERY_STR);
    });

    it("finds a named function declaration", () => {
        const code = `function hello(name) {\n  return "Hi " + name;\n}`;
        const tree = parser.parse(code);
        const result = findFunctionInAST(tree, funcQuery, "hello");
        assert.ok(result);
        assert.equal(result.startLine, 1);
        assert.equal(result.endLine, 3);
        assert.ok(result.node.text.includes("function hello"));
    });

    it("finds an arrow function assigned to const", () => {
        const code = `const add = (a, b) => {\n  return a + b;\n};`;
        const tree = parser.parse(code);
        const result = findFunctionInAST(tree, funcQuery, "add");
        assert.ok(result);
        assert.equal(result.startLine, 1);
        assert.ok(result.node.text.includes("const add"));
    });

    it("finds a function expression assigned to const", () => {
        const code = `const multiply = function(a, b) {\n  return a * b;\n};`;
        const tree = parser.parse(code);
        const result = findFunctionInAST(tree, funcQuery, "multiply");
        assert.ok(result);
        assert.ok(result.node.text.includes("multiply"));
    });

    it("returns null for non-existent function", () => {
        const code = `function hello() {}`;
        const tree = parser.parse(code);
        const result = findFunctionInAST(tree, funcQuery, "notHere");
        assert.equal(result, null);
    });

    it("finds the correct function among multiple", () => {
        const code = [
            "function first() { return 1; }",
            "function second() { return 2; }",
            "function third() { return 3; }",
        ].join("\n");
        const tree = parser.parse(code);
        const result = findFunctionInAST(tree, funcQuery, "second");
        assert.ok(result);
        assert.ok(result.node.text.includes("second"));
        assert.ok(!result.node.text.includes("first"));
        assert.ok(!result.node.text.includes("third"));
    });

    it("finds exported function declaration", () => {
        const code = `export function render(props) {\n  return null;\n}`;
        const tree = parser.parse(code);
        const result = findFunctionInAST(tree, funcQuery, "render");
        assert.ok(result);
    });

    it("finds var-declared function expression", () => {
        const code = `var handler = function(req, res) {\n  res.send("ok");\n};`;
        const tree = parser.parse(code);
        const result = findFunctionInAST(tree, funcQuery, "handler");
        assert.ok(result);
        assert.ok(result.node.text.includes("handler"));
    });

    it("finds var-declared arrow function", () => {
        const code = `var process = (data) => {\n  return data;\n};`;
        const tree = parser.parse(code);
        const result = findFunctionInAST(tree, funcQuery, "process");
        assert.ok(result);
    });

    it("finds exported const arrow function", () => {
        const code = `export const fetchData = async (url) => {\n  return await fetch(url);\n};`;
        const tree = parser.parse(code);
        const result = findFunctionInAST(tree, funcQuery, "fetchData");
        assert.ok(result);
    });
});

describe("findFunctionInAST - TypeScript", () => {
    let parser, funcQuery;

    before(() => {
        parser = new Parser();
        parser.setLanguage(tsLang);
        funcQuery = new Query(tsLang, TS_FUNC_QUERY_STR);
    });

    it("finds typed function", () => {
        const code = `function greet(name: string): string {\n  return "hi " + name;\n}`;
        const tree = parser.parse(code);
        const result = findFunctionInAST(tree, funcQuery, "greet");
        assert.ok(result);
        assert.ok(result.node.text.includes("greet"));
    });

    it("finds typed arrow function", () => {
        const code = `const handler = (req: Request): Response => {\n  return new Response();\n};`;
        const tree = parser.parse(code);
        const result = findFunctionInAST(tree, funcQuery, "handler");
        assert.ok(result);
    });

    it("finds async function", () => {
        const code = `async function fetchData(url: string): Promise<any> {\n  return await fetch(url);\n}`;
        const tree = parser.parse(code);
        const result = findFunctionInAST(tree, funcQuery, "fetchData");
        assert.ok(result);
    });
});

describe("findFunctionInAST - Python", () => {
    let parser, funcQuery;

    before(() => {
        parser = new Parser();
        parser.setLanguage(pyLang);
        funcQuery = new Query(pyLang, PY_FUNC_QUERY_STR);
    });

    it("finds a Python function", () => {
        const code = `def greet(name):\n    return f"Hi {name}"`;
        const tree = parser.parse(code);
        const result = findFunctionInAST(tree, funcQuery, "greet");
        assert.ok(result);
        assert.equal(result.startLine, 1);
    });

    it("finds typed Python function", () => {
        const code = `def add(a: int, b: int) -> int:\n    return a + b`;
        const tree = parser.parse(code);
        const result = findFunctionInAST(tree, funcQuery, "add");
        assert.ok(result);
    });
});

describe("byte-offset replacement", () => {
    let parser, funcQuery;

    before(() => {
        parser = new Parser();
        parser.setLanguage(jsLang);
        funcQuery = new Query(jsLang, JS_FUNC_QUERY_STR);
    });

    it("replaces function body using byte offsets without corruption", () => {
        const code = [
            "const x = 1;",
            "function target() {",
            "  return 'old';",
            "}",
            "const y = 2;",
        ].join("\n");

        const tree = parser.parse(code);
        const result = findFunctionInAST(tree, funcQuery, "target");
        assert.ok(result);

        const newBody = "function target() {\n  return 'new';\n}";
        const before = code.slice(0, result.startIndex);
        const after = code.slice(result.endIndex);
        const newCode = before + newBody + after;

        assert.ok(newCode.includes("const x = 1;"));
        assert.ok(newCode.includes("return 'new'"));
        assert.ok(newCode.includes("const y = 2;"));
        assert.ok(!newCode.includes("return 'old'"));
    });

    it("handles multi-byte characters (UTF-8)", () => {
        const code = `// Ümlauts: äöü\nfunction grüß() {\n  return "Grüße";\n}\nconst after = true;`;
        const tree = parser.parse(code);
        const result = findFunctionInAST(tree, funcQuery, "grüß");
        assert.ok(result);

        const newBody = `function grüß() {\n  return "Hallo Welt";\n}`;
        const before = Buffer.from(code).slice(0, result.startIndex).toString();
        const after = Buffer.from(code).slice(result.endIndex).toString();
        const newCode = before + newBody + after;

        assert.ok(newCode.includes("Ümlauts"));
        assert.ok(newCode.includes("Hallo Welt"));
        assert.ok(newCode.includes("const after = true;"));
    });
});

describe("withFileLock concurrency", () => {
    // Re-implement withFileLock to test its serialization behavior
    const fileMutexes = new Map();

    async function withFileLock(filePath, fn) {
        const prev = fileMutexes.get(filePath) || Promise.resolve();
        let releaseFn;
        const next = new Promise(r => { releaseFn = r; });
        fileMutexes.set(filePath, next);
        await prev;
        try { return await fn(); } finally { releaseFn(); }
    }

    it("serializes concurrent operations on the same file", async () => {
        const order = [];

        const op1 = withFileLock("/test/file.js", async () => {
            order.push("op1-start");
            await new Promise(r => setTimeout(r, 50));
            order.push("op1-end");
            return "op1";
        });

        const op2 = withFileLock("/test/file.js", async () => {
            order.push("op2-start");
            order.push("op2-end");
            return "op2";
        });

        const [r1, r2] = await Promise.all([op1, op2]);
        assert.equal(r1, "op1");
        assert.equal(r2, "op2");
        assert.deepEqual(order, ["op1-start", "op1-end", "op2-start", "op2-end"]);
    });

    it("allows parallel operations on different files", async () => {
        const order = [];

        const op1 = withFileLock("/test/a.js", async () => {
            order.push("a-start");
            await new Promise(r => setTimeout(r, 50));
            order.push("a-end");
        });

        const op2 = withFileLock("/test/b.js", async () => {
            order.push("b-start");
            await new Promise(r => setTimeout(r, 50));
            order.push("b-end");
        });

        await Promise.all([op1, op2]);
        // Both should start before either ends
        assert.ok(order.indexOf("a-start") < order.indexOf("a-end"));
        assert.ok(order.indexOf("b-start") < order.indexOf("b-end"));
        // b-start should happen before a-end (parallel)
        assert.ok(order.indexOf("b-start") < order.indexOf("a-end"));
    });
});

describe("findFunctionByRegex fallback", () => {
    // Re-implement regex fallback from mcp_server.ts for testing
    function findFunctionByRegex(source, functionName) {
        const escaped = functionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const patterns = [
            new RegExp(`(?:async\\s+)?function\\s+${escaped}\\s*\\(`),
            new RegExp(`(?:const|let|var)\\s+${escaped}\\s*=\\s*(?:async\\s+)?(?:function\\s*)?\\(`),
            new RegExp(`(?:const|let|var)\\s+${escaped}\\s*=\\s*(?:async\\s+)?\\(`),
            new RegExp(`^\\s*(?:async\\s+)?${escaped}\\s*\\(`, "m"),
            new RegExp(`def\\s+${escaped}\\s*\\(`),
        ];

        for (const pattern of patterns) {
            const m = pattern.exec(source);
            if (!m) continue;

            const startIdx = m.index;
            let braceDepth = 0;
            let foundOpen = false;
            let endIdx = startIdx;

            for (let i = startIdx; i < source.length; i++) {
                if (source[i] === "{") { braceDepth++; foundOpen = true; }
                if (source[i] === "}") { braceDepth--; }
                if (foundOpen && braceDepth === 0) {
                    endIdx = i + 1;
                    break;
                }
                if (!foundOpen && source[i] === ":" && source.slice(startIdx, i).includes("def ")) {
                    foundOpen = true;
                    const baseIndent = m[0].match(/^(\s*)/)?.[1]?.length || 0;
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

            return { node: { text: funcText }, startIndex: startIdx, endIndex: endIdx, startLine, endLine };
        }
        return null;
    }

    it("finds function declaration via regex", () => {
        const code = "// comment\nfunction myFunc(a, b) {\n  return a + b;\n}";
        const result = findFunctionByRegex(code, "myFunc");
        assert.ok(result);
        assert.ok(result.node.text.includes("function myFunc"));
        assert.equal(result.startLine, 2);
    });

    it("finds class method via regex", () => {
        const code = "class Foo {\n  bar(x) {\n    return x;\n  }\n}";
        const result = findFunctionByRegex(code, "bar");
        assert.ok(result);
        assert.ok(result.node.text.includes("bar(x)"));
    });

    it("finds Python function via regex", () => {
        const code = "import os\n\ndef process(data):\n    result = data * 2\n    return result\n\nx = 1";
        const result = findFunctionByRegex(code, "process");
        assert.ok(result);
        assert.ok(result.node.text.includes("def process"));
        assert.ok(result.node.text.includes("return result"));
    });

    it("returns null for non-existent function", () => {
        const code = "function hello() { return 1; }";
        const result = findFunctionByRegex(code, "notHere");
        assert.equal(result, null);
    });

    it("finds const arrow function via regex", () => {
        const code = "const transform = (input) => {\n  return input.map(x => x * 2);\n};";
        const result = findFunctionByRegex(code, "transform");
        assert.ok(result);
        assert.ok(result.node.text.includes("transform"));
    });
});

describe("syntax check behavior", () => {
    let parser, funcQuery;

    before(() => {
        parser = new Parser();
        parser.setLanguage(jsLang);
        funcQuery = new Query(jsLang, JS_FUNC_QUERY_STR);
    });

    it("detects syntax errors in modified code", () => {
        const badCode = "function broken( {\n  return;\n}";
        const tree = parser.parse(badCode);
        assert.ok(tree.rootNode.hasError, "Should detect syntax error");
    });

    it("accepts valid modified code", () => {
        const goodCode = "function valid() {\n  return 42;\n}";
        const tree = parser.parse(goodCode);
        assert.ok(!tree.rootNode.hasError, "Should not detect syntax error");
    });
});

describe("decorated Python functions", () => {
    let parser, funcQuery;

    before(() => {
        parser = new Parser();
        parser.setLanguage(pyLang);
        funcQuery = new Query(pyLang, PY_FUNC_QUERY_STR);
    });

    it("finds a decorated function", () => {
        const code = "@app.route('/api')\ndef handler(request):\n    return response";
        const tree = parser.parse(code);
        const result = findFunctionInAST(tree, funcQuery, "handler");
        assert.ok(result);
        assert.ok(result.node.text.includes("handler"));
    });

    it("finds a function with multiple decorators", () => {
        const code = "@login_required\n@cache(timeout=300)\ndef get_data(user_id):\n    return fetch(user_id)";
        const tree = parser.parse(code);
        const result = findFunctionInAST(tree, funcQuery, "get_data");
        assert.ok(result);
    });
});

describe("duplicate function name disambiguation", () => {
    let parser, funcQuery;
    before(async () => {
        parser = new Parser();
        parser.setLanguage(jsLang);
        funcQuery = new Query(jsLang, JS_FUNC_QUERY_STR);
    });

    it("returns first match when no startLine hint is given", () => {
        const code = "function render() { return 'A'; }\nfunction render() { return 'B'; }";
        const tree = parser.parse(code);
        const result = findFunctionInAST(tree, funcQuery, "render");
        assert.ok(result);
        assert.equal(result.startLine, 1); // First one
    });

    it("picks the correct function using startLine hint", () => {
        const code = "function render() { return 'A'; }\nfunction render() { return 'B'; }";
        const tree = parser.parse(code);
        const result = findFunctionInAST(tree, funcQuery, "render", 2);
        assert.ok(result);
        assert.equal(result.startLine, 2); // Second one, closest to hint=2
    });

    it("picks closest match when hint is approximate", () => {
        const code = "function init() { return 1; }\n\n\n\nfunction init() { return 2; }";
        const tree = parser.parse(code);
        const result = findFunctionInAST(tree, funcQuery, "init", 4);
        assert.ok(result);
        assert.equal(result.startLine, 5); // Line 5 is closest to hint=4
    });
});

const test = require("node:test");
const assert = require("node:assert/strict");
const { Parser, Language, Query } = require("web-tree-sitter");
const { openTestDb } = require("./helpers/ladybug-session.cjs");
const {
    LANG_CONFIGS, resolveGrammarWasm, extractFunctions, extractAsyncChains,
} = require("../scripts/graph_builder.js").__testing__;

async function withAsyncGraph(extension, source, verify) {
    await Parser.init();
    const config = LANG_CONFIGS[extension];
    const language = await Language.load(resolveGrammarWasm(config.wasm));
    const parser = new Parser();
    let tree, funcQuery, asyncChainQuery, fixture;
    try {
        parser.setLanguage(language);
        tree = parser.parse(source);
        assert.equal(tree.rootNode.hasError, false, "fixture must parse with the real grammar");
        funcQuery = new Query(language, config.funcQuery);
        asyncChainQuery = new Query(language, config.asyncChainQuery);
        fixture = await openTestDb();
        const { session } = fixture;
        const file = `async-fixture${extension}`;
        await session.run("CREATE (:File {path: $path})", { path: file });
        const cached = { funcQuery, asyncChainQuery };
        const bounds = await extractFunctions(session, cached, tree, file, { int: (n) => n });
        await extractAsyncChains(session, cached, tree, file, bounds);
        // A repeated extraction must not duplicate the relationship.
        await extractAsyncChains(session, cached, tree, file, bounds);
        await verify(session);
    } finally {
        await fixture?.cleanup();
        asyncChainQuery?.delete();
        funcQuery?.delete();
        tree?.delete();
        parser.delete();
    }
}

test("Go goroutines persist SPAWNS without inventing AWAITS or spawning ordinary calls", async () => {
    await withAsyncGraph(".go", `package fixture
func worker() {}
func normal() {}
func start() {
    go worker()
    normal()
    go worker()
}
`, async (session) => {
        const spawns = await session.run(
            "MATCH (caller:Function)-[:SPAWNS]->(target:Function) RETURN caller.name AS caller, target.name AS target",
        );
        assert.deepEqual(spawns.records.map((r) => [r.get("caller"), r.get("target")]), [["start", "worker"]]);
        const awaits = await session.run("MATCH (:Function)-[:AWAITS]->(:Function) RETURN count(*) AS count");
        assert.equal(Number(awaits.records[0].get("count")), 0);
    });
});

test("JavaScript await and promise chains retain their separate relationship types", async () => {
    await withAsyncGraph(".js", `function worker() {}
function handler() {}
async function start() {
    await worker();
    worker().then(handler);
}
`, async (session) => {
        const awaits = await session.run(
            "MATCH (caller:Function)-[:AWAITS]->(target:Function) RETURN caller.name AS caller, target.name AS target",
        );
        assert.deepEqual(awaits.records.map((r) => [r.get("caller"), r.get("target")]), [["start", "worker"]]);
        const chains = await session.run(
            "MATCH (caller:Function)-[r:ASYNC_CHAIN]->(target:Function) RETURN caller.name AS caller, target.name AS target, r.method AS method",
        );
        assert.deepEqual(chains.records.map((r) => [r.get("caller"), r.get("target"), r.get("method")]), [["start", "handler", "then"]]);
        const spawns = await session.run("MATCH (:Function)-[:SPAWNS]->(:Function) RETURN count(*) AS count");
        assert.equal(Number(spawns.records[0].get("count")), 0);
    });
});

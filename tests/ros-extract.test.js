#!/usr/bin/env node
/**
 * ROS 2 extraction, end to end through the REAL tree-sitter grammars.
 *
 * Why this test exists: graph_builder compiles the ROS queries with
 * `safeQuery`, which returns null on a malformed query instead of throwing. A
 * typo in a query would therefore not break the build — it would silently
 * extract nothing. Only running the queries against real Python/C++ ROS source
 * proves they work.
 *
 * The graph writes go to a recording stub session, so this stays hermetic and
 * fast; the Cypher it emits is asserted directly.
 */

const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { Parser, Language } = require("web-tree-sitter");
const {
    LANG_CONFIGS, safeQuery, resolveGrammarWasm,
    extractClasses, extractFunctions, extractRosNodes, extractRosInterfaces,
    invalidateClassResolution,
} = require("../scripts/graph_builder.js").__testing__;

const FIXTURES = path.join(__dirname, "fixtures", "ros");

/** Records every Cypher statement instead of touching a database. */
function stubSession() {
    const calls = [];
    return {
        calls,
        async run(cypher, params = {}) {
            calls.push({ cypher: cypher.replace(/\s+/g, " ").trim(), params });
            if (cypher.includes("RETURN c.uid AS uid, c.name AS name, c.file AS file")) {
                const classes = calls.filter((c) =>
                    c.cypher.includes("MERGE (cls:") && c.params.uid && c.params.className
                );
                return {
                    records: classes.map((c) => ({
                        get(key) {
                            return { uid: c.params.uid, name: c.params.className, file: c.params.path }[key];
                        },
                    })),
                };
            }
            return { records: [] };
        },
        /** Edges of one rel type, as `{ name, msgType, callback }`. */
        edges(relType) {
            return calls
                .filter((c) => c.cypher.includes(`[r:${relType}]`))
                .map((c) => ({ name: c.params.name, msgType: c.params.msgType, callback: c.params.callback,
                               owner: c.params.className || c.params.funcName || c.params.path }));
        },
        /** Interface nodes created, as `{ label, name, kind, dynamic }`. */
        interfaces() {
            return calls
                .filter((c) => /^MERGE \(t:(Topic|Service|Action) \{name: \$name\}\)/.test(c.cypher))
                .map((c) => ({
                    label: /MERGE \(t:(\w+)/.exec(c.cypher)[1],
                    name: c.params.name, kind: c.params.kind, dynamic: c.params.dynamic,
                }));
        },
        /** Classes marked as ROS nodes. */
        rosNodes() {
            return calls
                .filter((c) => c.cypher.includes("SET c.isRosNode = true"))
                .map((c) => ({ name: c.params.className, base: c.params.rosBase }));
        },
        nodeNames() {
            return calls
                .filter((c) => c.cypher.includes("SET c.rosNodeName"))
                .map((c) => ({ name: c.params.className, nodeName: c.params.nodeName }));
        },
    };
}

/** Parse a fixture and run the full ROS extraction chain over it. */
async function runExtraction(fixture, ext, existingSession = null) {
    invalidateClassResolution();
    await Parser.init();
    const cfg = LANG_CONFIGS[ext];
    const lang = await Language.load(resolveGrammarWasm(cfg.wasm));
    const parser = new Parser();
    parser.setLanguage(lang);

    const src = fs.readFileSync(path.join(FIXTURES, fixture), "utf8");
    const tree = parser.parse(src);

    const cached = {
        lang,
        classQuery: safeQuery(lang, cfg.classQuery),
        funcQuery: safeQuery(lang, cfg.funcQuery),
        classInheritanceQuery: safeQuery(lang, cfg.classInheritanceQuery),
        rosInterfaceQuery: safeQuery(lang, cfg.rosInterfaceQuery),
        rosNodeNameQuery: safeQuery(lang, cfg.rosNodeNameQuery),
        rosLang: cfg.rosLang,
    };

    // Every ROS query must have COMPILED — safeQuery hands back null otherwise.
    assert.ok(cached.rosInterfaceQuery, `${ext}: rosInterfaceQuery failed to compile`);
    assert.ok(cached.rosNodeNameQuery, `${ext}: rosNodeNameQuery failed to compile`);
    assert.ok(cached.classInheritanceQuery, `${ext}: classInheritanceQuery failed to compile`);

    const session = existingSession || stubSession();
    const graphMod = { int: (n) => n };
    const classBounds = await extractClasses(session, cached, tree, fixture, graphMod);
    const funcBounds = await extractFunctions(session, cached, tree, fixture, graphMod, classBounds);
    await extractRosNodes(session, cached, tree, fixture, classBounds);
    await extractRosInterfaces(session, cached, tree, fixture, funcBounds, classBounds);
    return { session, classBounds, funcBounds };
}

// ============================================================================
// PYTHON (rclpy)
// ============================================================================

describe("ROS extraction — Python (rclpy)", () => {
    let session;
    before(async () => { ({ session } = await runExtraction("talker.py", ".py")); });

    it("marks Node subclasses as ROS nodes, including dotted bases", () => {
        const names = session.rosNodes().map((n) => n.name);
        assert.ok(names.includes("MinimalPublisher"));
        // Regression: `class DottedBase(rclpy.node.Node)` was invisible while the
        // inheritance query only matched a bare (identifier) superclass.
        assert.ok(names.includes("DottedBase"));
    });

    it("records the runtime node name from super().__init__()", () => {
        const byClass = Object.fromEntries(session.nodeNames().map((n) => [n.name, n.nodeName]));
        assert.equal(byClass.MinimalPublisher, "minimal_publisher");
        assert.equal(byClass.DottedBase, "dotted_node");
    });

    it("extracts a publisher with its relative topic name and type", () => {
        const pubs = session.edges("PUBLISHES_TOPIC");
        const cmd = pubs.find((p) => p.name === "cmd_vel");
        assert.ok(cmd, "relative topic 'cmd_vel' must be extracted");
        assert.equal(cmd.msgType, "Twist");
    });

    it("extracts a subscription with its callback", () => {
        const sub = session.edges("SUBSCRIBES_TOPIC").find((s) => s.name === "/scan");
        assert.ok(sub);
        assert.equal(sub.msgType, "LaserScan");
        assert.equal(sub.callback, "self.scan_cb");
    });

    it("separates service server, service client and action server", () => {
        assert.ok(session.edges("PROVIDES_SERVICE").some((e) => e.name === "reset"));
        assert.ok(session.edges("CALLS_SERVICE").some((e) => e.name === "/enable"));
        assert.ok(session.edges("PROVIDES_ACTION").some((e) => e.name === "fibonacci"));
    });

    it("labels interfaces by kind", () => {
        const byName = Object.fromEntries(session.interfaces().map((i) => [i.name, i]));
        assert.equal(byName.cmd_vel.label, "Topic");
        assert.equal(byName.reset.label, "Service");
        assert.equal(byName.fibonacci.label, "Action");
        assert.equal(byName.fibonacci.kind, "action");
    });

    it("keeps a runtime-computed topic name, flagged as dynamic", () => {
        const dyn = session.interfaces().find((i) => i.dynamic === true);
        assert.ok(dyn, "publisher with a computed name must not be dropped");
        assert.equal(dyn.name, "self.topic_name");
    });

    it("does not invent topics from ordinary string arguments", () => {
        const names = session.interfaces().map((i) => i.name);
        assert.ok(!names.some((n) => n.includes(" ")), `no prose should become a topic: ${names}`);
        assert.ok(!names.includes("/etc/hostname"));
    });

    it("attaches interfaces to the owning class, not just the function", () => {
        const owners = session.edges("PUBLISHES_TOPIC").map((e) => e.owner);
        assert.ok(owners.includes("MinimalPublisher"));
    });
});

// ============================================================================
// C++ (rclcpp)
// ============================================================================

describe("ROS extraction — C++ (rclcpp)", () => {
    let session;
    before(async () => { ({ session } = await runExtraction("listener.cpp", ".cpp")); });

    it("recognises `class X : public rclcpp::Node`", () => {
        // C++ had no inheritance query at all before, so no C++ class could
        // ever be identified as a ROS node.
        const nodes = session.rosNodes();
        assert.deepEqual(nodes.map((n) => n.name), ["ScanListener"]);
        assert.equal(nodes[0].base, "rclcpp::Node");
    });

    it("reads the node name from the constructor initialiser list", () => {
        assert.deepEqual(session.nodeNames(), [{ name: "ScanListener", nodeName: "scan_listener" }]);
    });

    it("extracts the publisher through the this-> template form", () => {
        const pub = session.edges("PUBLISHES_TOPIC").find((e) => e.name === "cmd_vel");
        assert.ok(pub);
        assert.equal(pub.msgType, "geometry_msgs/msg/Twist");
    });

    it("extracts the subscription and canonicalises its template type", () => {
        const sub = session.edges("SUBSCRIBES_TOPIC").find((e) => e.name === "/scan");
        assert.ok(sub);
        assert.equal(sub.msgType, "sensor_msgs/msg/LaserScan");
    });

    it("extracts the free-function template form (create_service<T>)", () => {
        assert.ok(session.edges("PROVIDES_SERVICE").some((e) => e.name === "reset"));
    });

    it("tells a service client apart from an action client by its type", () => {
        // Both spell the factory `create_client`; only the interface type differs.
        assert.ok(session.edges("CALLS_SERVICE").some((e) => e.name === "/enable"));
        const act = session.edges("USES_ACTION").find((e) => e.name === "fibonacci");
        assert.ok(act, "rclcpp_action::create_client must become an action edge");
        assert.equal(act.msgType, "example_interfaces/action/Fibonacci");
    });

    it("leaves non-ROS classes alone", () => {
        assert.ok(!session.rosNodes().some((n) => n.name === "PlainClass"));
        assert.ok(!session.interfaces().some((i) => i.name.includes(" ")));
    });

    it("reads the node name from an out-of-line constructor in another file", async () => {
        const splitSession = stubSession();
        await runExtraction("aeb.hpp", ".hpp", splitSession);
        await runExtraction("aeb.cpp", ".cpp", splitSession);

        assert.ok(splitSession.rosNodes().some((n) => n.name === "AEB"));
        assert.ok(splitSession.nodeNames().some((n) => n.name === "AEB" && n.nodeName === "aeb"));
        const crossFileSet = splitSession.calls.find((c) =>
            c.cypher.includes("WHERE c.isRosNode = true") && c.cypher.includes("SET c.rosNodeName")
        );
        assert.ok(crossFileSet, "out-of-line constructors must update the ROS class across files");
        assert.ok(!crossFileSet.cypher.includes("file: $path"));
    });
});

#!/usr/bin/env node
/**
 * Unit tests for the ROS 2 semantics module and the diagram renderer.
 * Pure, no tree-sitter, no graph.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
    classifyRosCall, normalizeRosName, normalizeMsgType, shortMsgType,
    isRosNodeBase, refineKind, canonicalizeRosName,
} = require("../scripts/ros/ros_model.js");
const { buildRosDiagram, callbackName } = require("../scripts/ros/ros_diagram.js");

const lit = (t) => ({ text: t, isLiteral: true });
const expr = (t) => ({ text: t, isLiteral: false });

describe("normalizeRosName", () => {
    it("accepts relative names — the ROS 2 default", () => {
        // Regression: an earlier extractor required a leading '/', which
        // dropped essentially every real publisher.
        assert.deepEqual(normalizeRosName("'cmd_vel'"), { name: "cmd_vel", dynamic: false });
    });

    it("accepts absolute, private and nested names", () => {
        assert.equal(normalizeRosName('"/scan"').name, "/scan");
        assert.equal(normalizeRosName("'~/config'").name, "~/config");
        assert.equal(normalizeRosName("'/robot1/camera/image_raw'").name, "/robot1/camera/image_raw");
    });

    it("rejects literals that cannot be ROS names", () => {
        assert.equal(normalizeRosName("'hello world'"), null);
        assert.equal(normalizeRosName("'http://example.com'"), null);
        assert.equal(normalizeRosName("'%s failed'"), null);
        assert.equal(normalizeRosName("''"), null);
    });

    it("keeps non-literal names but flags them dynamic", () => {
        const r = normalizeRosName("self.topic_name", { wasLiteral: false });
        assert.deepEqual(r, { name: "self.topic_name", dynamic: true });
    });
});

describe("canonicalizeRosName", () => {
    it("resolves a relative name against the default namespace", () => {
        // The whole point: a publisher on 'cmd_vel' and a subscriber on
        // '/cmd_vel' are one topic at runtime and must land on one box.
        assert.equal(canonicalizeRosName("cmd_vel"), "/cmd_vel");
        assert.equal(canonicalizeRosName("/cmd_vel"), "/cmd_vel");
    });

    it("resolves a private name against the node name", () => {
        assert.equal(canonicalizeRosName("~/config", { nodeName: "talker" }), "/talker/config");
        assert.equal(canonicalizeRosName("~", { nodeName: "talker" }), "/talker");
    });

    it("leaves a private name alone when the node name is unknown", () => {
        assert.equal(canonicalizeRosName("~/config"), "~/config");
    });

    it("never rewrites a runtime-computed name", () => {
        assert.equal(canonicalizeRosName("self.topic_name", { dynamic: true }), "self.topic_name");
    });

    it("preserves nested paths", () => {
        assert.equal(canonicalizeRosName("camera/image_raw"), "/camera/image_raw");
    });
});

describe("normalizeMsgType", () => {
    it("canonicalises C++ and Python type spellings to pkg/msg/Type", () => {
        assert.equal(normalizeMsgType("<geometry_msgs::msg::Twist>"), "geometry_msgs/msg/Twist");
        assert.equal(normalizeMsgType("geometry_msgs.msg.Twist"), "geometry_msgs/msg/Twist");
        assert.equal(normalizeMsgType("Twist"), "Twist");
    });

    it("strips pointer, ref and SharedPtr noise", () => {
        assert.equal(normalizeMsgType("const sensor_msgs::msg::LaserScan::SharedPtr &"),
            "sensor_msgs/msg/LaserScan");
    });

    it("rejects expressions", () => {
        assert.equal(normalizeMsgType("a + b"), null);
        assert.equal(normalizeMsgType(""), null);
    });

    it("shortMsgType takes the last segment", () => {
        assert.equal(shortMsgType("geometry_msgs/msg/Twist"), "Twist");
    });
});

describe("classifyRosCall — Python (rclpy)", () => {
    it("classifies a publisher", () => {
        const r = classifyRosCall({
            method: "create_publisher", lang: "py",
            args: [expr("Twist"), lit("'cmd_vel'"), expr("10")],
        });
        assert.equal(r.relType, "PUBLISHES_TOPIC");
        assert.equal(r.kind, "topic");
        assert.equal(r.name, "cmd_vel");
        assert.equal(r.msgType, "Twist");
        assert.equal(r.dynamic, false);
    });

    it("classifies a subscription and keeps the callback", () => {
        const r = classifyRosCall({
            method: "create_subscription", lang: "py",
            args: [expr("LaserScan"), lit("'/scan'"), expr("self.cb"), expr("10")],
        });
        assert.equal(r.relType, "SUBSCRIBES_TOPIC");
        assert.equal(r.name, "/scan");
        assert.equal(r.callback, "self.cb");
    });

    it("separates service server from service client", () => {
        const srv = classifyRosCall({
            method: "create_service", lang: "py",
            args: [expr("Trigger"), lit("'reset'"), expr("self.handle")],
        });
        const cli = classifyRosCall({
            method: "create_client", lang: "py",
            args: [expr("SetBool"), lit("'enable'")],
        });
        assert.equal(srv.relType, "PROVIDES_SERVICE");
        assert.equal(srv.label, "Service");
        assert.equal(cli.relType, "CALLS_SERVICE");
    });

    it("handles the action constructors, whose first arg is the node", () => {
        const r = classifyRosCall({
            method: "ActionServer", lang: "py",
            args: [expr("self"), expr("Fibonacci"), lit("'fibonacci'"), expr("self.execute_cb")],
        });
        assert.equal(r.relType, "PROVIDES_ACTION");
        assert.equal(r.name, "fibonacci");
        assert.equal(r.msgType, "Fibonacci");
    });

    it("keeps a computed topic name instead of dropping the publisher", () => {
        const r = classifyRosCall({
            method: "create_publisher", lang: "py",
            args: [expr("String"), expr("self.topic_name"), expr("10")],
        });
        assert.equal(r.dynamic, true);
        assert.equal(r.name, "self.topic_name");
    });

    it("ignores non-ROS calls", () => {
        assert.equal(classifyRosCall({ method: "append", lang: "py", args: [lit("'x'")] }), null);
        assert.equal(classifyRosCall({ method: "create_publisher", lang: "js", args: [] }), null);
    });
});

describe("classifyRosCall — C++ (rclcpp)", () => {
    it("takes the type from the template argument and the name from arg 0", () => {
        const r = classifyRosCall({
            method: "create_publisher", lang: "cpp",
            args: [lit('"cmd_vel"'), expr("10")],
            templateType: "<geometry_msgs::msg::Twist>",
        });
        assert.equal(r.relType, "PUBLISHES_TOPIC");
        assert.equal(r.name, "cmd_vel");
        assert.equal(r.msgType, "geometry_msgs/msg/Twist");
    });

    it("refines create_client to an action when the type says so", () => {
        // rclcpp::Client and rclcpp_action::Client share the factory name; only
        // the interface type tells them apart.
        const svc = classifyRosCall({
            method: "create_client", lang: "cpp",
            args: [lit('"enable"')], templateType: "<std_srvs::srv::SetBool>",
        });
        const act = classifyRosCall({
            method: "create_client", lang: "cpp",
            args: [lit('"fibonacci"')], templateType: "<example_interfaces::action::Fibonacci>",
        });
        assert.equal(svc.relType, "CALLS_SERVICE");
        assert.equal(act.relType, "USES_ACTION");
        assert.equal(act.label, "Action");
    });

    it("finds the action name by scanning for the first string literal", () => {
        // rclcpp_action::create_server overloads shift the name position.
        const r = classifyRosCall({
            method: "create_server", lang: "cpp",
            args: [expr("this"), expr("node_iface"), lit('"fibonacci"'), expr("handle_goal")],
            templateType: "<example_interfaces::action::Fibonacci>",
        });
        assert.equal(r.relType, "PROVIDES_ACTION");
        assert.equal(r.name, "fibonacci");
    });

    it("refineKind leaves the kind alone for an unknown type", () => {
        assert.equal(refineKind("topic", "Twist"), "topic");
    });
});

describe("isRosNodeBase", () => {
    it("recognises the base through any qualification", () => {
        assert.ok(isRosNodeBase("Node"));
        assert.ok(isRosNodeBase("rclpy.node.Node"));
        assert.ok(isRosNodeBase("rclcpp::Node"));
        assert.ok(isRosNodeBase("rclcpp_lifecycle::LifecycleNode"));
    });
    it("rejects everything else", () => {
        assert.equal(isRosNodeBase("Object"), false);
        assert.equal(isRosNodeBase("NodeHandle"), false);
        assert.equal(isRosNodeBase(null), false);
    });
});

// ============================================================================
// DIAGRAM RENDERING
// ============================================================================

const MODEL = {
    nodes: [
        { id: "n1", name: "MinimalPublisher", kind: "class", file: "robot_control/pub.py", nodeName: "minimal_publisher", base: "Node" },
        { id: "n2", name: "ScanListener", kind: "class", file: "car-controller/sub.cpp", nodeName: null, base: "rclcpp::Node" },
    ],
    interfaces: [
        { name: "cmd_vel", kind: "topic", msgType: "geometry_msgs/msg/Twist", dynamic: false },
        { name: "/scan", kind: "topic", msgType: "sensor_msgs/msg/LaserScan", dynamic: false },
        { name: "reset", kind: "service", msgType: "std_srvs/srv/Trigger", dynamic: false },
    ],
    edges: [
        { nodeId: "n1", iface: "cmd_vel", relType: "PUBLISHES_TOPIC", msgType: "geometry_msgs/msg/Twist" },
        { nodeId: "n2", iface: "cmd_vel", relType: "SUBSCRIBES_TOPIC", msgType: "geometry_msgs/msg/Twist", callback: "on_cmd" },
        { nodeId: "n2", iface: "/scan", relType: "SUBSCRIBES_TOPIC", msgType: "sensor_msgs/msg/LaserScan" },
        { nodeId: "n1", iface: "reset", relType: "PROVIDES_SERVICE", msgType: "std_srvs/srv/Trigger" },
    ],
};

describe("buildRosDiagram — PlantUML", () => {
    const uml = buildRosDiagram(MODEL, { title: "Test System" });

    it("is a well-formed PlantUML document", () => {
        assert.ok(uml.startsWith("@startuml"));
        assert.ok(uml.trimEnd().endsWith("@enduml"));
        assert.ok(uml.includes("title Test System"));
    });

    // Every box carries an alias (`class Name as E0`). PlantUML identifies a
    // class by its NAME, so two packages with a class of the same name — which
    // is the norm in a ROS workspace — used to collapse into one box that
    // published every topic of both. The assertions match the alias form so a
    // regression back to plain names fails here.
    it("renders node classes with the rosnode stereotype and the runtime name", () => {
        assert.match(uml, /class MinimalPublisher as \w+ <<rosnode>>/);
        assert.ok(uml.includes('node name = "minimal_publisher"'));
    });

    it("groups node classes into source packages", () => {
        assert.ok(uml.includes('package "robot_control" {'));
        assert.ok(uml.includes('package "car-controller" {'));
    });

    it("renders interfaces as their own typed boxes", () => {
        assert.match(uml, /class cmd_vel as \w+ <<topic>>/);
        assert.ok(uml.includes("geometry_msgs/msg/Twist"));
        assert.match(uml, /class reset as \w+ <<service>>/);
    });

    it("shortens generated message type names but preserves the full type", () => {
        const typed = buildRosDiagram({
            nodes: [{ id: "n", name: "N", kind: "class", file: "pkg/n.cpp" }],
            interfaces: [{ name: "/vehicle", kind: "topic", msgType: "cm_msgs_msg_Vehicle" }],
            edges: [{ nodeId: "n", iface: "/vehicle", relType: "PUBLISHES_TOPIC", msgType: "cm_msgs_msg_Vehicle" }],
        });
        assert.ok(typed.includes("{field} Vehicle"));
        assert.ok(typed.includes("full type: cm_msgs_msg_Vehicle"));
        assert.ok(typed.includes("publish(/vehicle) : Vehicle"));
    });

    it("quotes names that are not bare identifiers", () => {
        assert.match(uml, /class "\/scan" as \w+ <<topic>>/);
        assert.ok(!/class \/scan/.test(uml));
    });

    it("points publish edges out of the node and subscribe edges into it", () => {
        assert.match(uml, /E\d+ \.\.> E\d+ : <<publishes>>/);
        assert.match(uml, /E\d+ \.\.> E\d+ : <<subscribes>>/);
    });

    it("uses the real callback name when the code gave one", () => {
        assert.ok(uml.includes("+on_cmd(msg : Twist)"));
        assert.ok(uml.includes("+on_scan(msg : LaserScan)")); // derived fallback
    });

    it("reduces a callback expression to a bare UML method name", () => {
        // The graph stores the source expression; the diagram must not show
        // `self.scan_cb` or `&ScanListener::scan_cb` as a method name.
        assert.equal(callbackName("self.scan_cb"), "scan_cb");
        assert.equal(callbackName("&ScanListener::scan_cb"), "scan_cb");
        assert.equal(callbackName("std::bind(&ScanListener::scan_cb, this, _1)"), "scan_cb");
        assert.equal(callbackName("lambda msg: None"), null); // falls back to a derived name
        assert.equal(callbackName(null), null);
    });

    it("draws inheritance from the ROS base", () => {
        assert.match(uml, /E\d+ <\|-- E\d+/);
        assert.match(uml, /class "rclcpp::Node" as \w+ <<framework>>/);
    });

    it("two classes of the same name stay two boxes", () => {
        // The reason aliases exist. Three packages each defining `AEB` is normal
        // in a ROS workspace; without aliases PlantUML merges them and hangs
        // every package's topics off one box.
        const twins = buildRosDiagram({
            nodes: [
                { id: "a", name: "AEB", kind: "class", file: "pkg_a/aeb.py" },
                { id: "b", name: "AEB", kind: "class", file: "pkg_b/aeb.py" },
            ],
            interfaces: [{ name: "/a", kind: "topic" }, { name: "/b", kind: "topic" }],
            edges: [
                { nodeId: "a", iface: "/a", relType: "PUBLISHES_TOPIC" },
                { nodeId: "b", iface: "/b", relType: "PUBLISHES_TOPIC" },
            ],
        });
        const aliases = [...twins.matchAll(/class AEB as (\w+)/g)].map((m) => m[1]);
        assert.equal(aliases.length, 2, "both classes must be declared");
        assert.notEqual(aliases[0], aliases[1], "and they must not share an alias");
    });

    it("omits inheritance when asked to", () => {
        const plain = buildRosDiagram(MODEL, { showInheritance: false });
        assert.ok(!plain.includes("<|--"));
    });

    it("onlyConnected drops interfaces with a single endpoint", () => {
        const connected = buildRosDiagram(MODEL, { onlyConnected: true });
        assert.ok(connected.includes("cmd_vel"));      // pub + sub
        assert.ok(!connected.includes("<<service>>")); // provider only
    });

    it("marks interfaces whose name is resolved at runtime", () => {
        const dyn = buildRosDiagram({
            nodes: [{ id: "n1", name: "N", kind: "class" }],
            interfaces: [{ name: "self.topic", kind: "topic", msgType: "String", dynamic: true }],
            edges: [{ nodeId: "n1", iface: "self.topic", relType: "PUBLISHES_TOPIC", msgType: "String" }],
        });
        assert.ok(dyn.includes("name resolved at runtime"));
    });

    it("survives an empty model", () => {
        const empty = buildRosDiagram({ nodes: [], interfaces: [], edges: [] });
        assert.ok(empty.includes("@startuml") && empty.includes("@enduml"));
    });
});

describe("buildRosDiagram — Mermaid", () => {
    const mmd = buildRosDiagram(MODEL, { format: "mermaid", title: "Test System" });

    it("emits a mermaid classDiagram", () => {
        assert.ok(mmd.includes("classDiagram"));
        assert.ok(mmd.includes("title: Test System"));
    });

    it("sanitises ids that mermaid cannot parse but keeps the display name", () => {
        assert.ok(!/class \/scan/.test(mmd));
        assert.ok(mmd.includes('["/scan"]'));
    });

    it("carries the stereotypes over", () => {
        assert.ok(mmd.includes("<<rosnode>>"));
        assert.ok(mmd.includes("<<topic>>"));
    });

    it("uses short interface type names", () => {
        const typed = buildRosDiagram({
            nodes: [{ id: "n", name: "N", kind: "class", file: "pkg/n.cpp" }],
            interfaces: [{ name: "/vehicle", kind: "topic", msgType: "cm_msgs/msg/Vehicle" }],
            edges: [{ nodeId: "n", iface: "/vehicle", relType: "PUBLISHES_TOPIC", msgType: "cm_msgs/msg/Vehicle" }],
        }, { format: "mermaid" });
        assert.ok(typed.includes("+Vehicle"));
        assert.ok(!typed.includes("cm_msgs_msg_Vehicle"));
    });
});

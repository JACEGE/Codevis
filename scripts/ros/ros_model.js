/**
 * ros_model.js
 * ----------------------------------------------------------------------------
 * Pure ROS 2 semantics — no tree-sitter, no graph, no I/O.
 *
 * This is the single place that knows what a ROS interface call *means*:
 * which factory method creates which kind of interface, where the type and
 * the name sit in the argument list, and what a legal ROS name looks like.
 * `scripts/graph_builder.js` feeds it raw capture text; the tests exercise it
 * directly.
 *
 * Why a separate module: the same classification is needed twice — once when
 * writing the graph (builder) and once when reading it back for the diagram
 * (scripts/ros/ros_diagram.js). Keeping it pure means both agree by
 * construction, and the tricky parts (dynamic topic names, C++ template types)
 * are unit-testable without a database.
 * ----------------------------------------------------------------------------
 */

"use strict";

// ============================================================================
// INTERFACE KINDS
// ----------------------------------------------------------------------------
// `relType` is the graph edge written from the enclosing Function (or File) to
// the interface node; `label` is the interface node's semantic label.
// ============================================================================

const KIND_LABEL = { topic: "Topic", service: "Service", action: "Action" };

/**
 * ROS factory calls, keyed by the method/constructor name as it appears in
 * source. `typeArg`/`nameArg` are POSITIONAL indices into the call's argument
 * list; `-1` means "not in the argument list" (C++ carries the type in the
 * template parameter instead).
 *
 * Python rclpy:
 *   create_publisher(msg_type, topic, qos)
 *   create_subscription(msg_type, topic, callback, qos)
 *   create_service(srv_type, srv_name, callback)
 *   create_client(srv_type, srv_name)
 *   ActionServer(node, action_type, action_name, callback)   <- node is arg 0
 *   ActionClient(node, action_type, action_name)
 *
 * C++ rclcpp (type comes from the template argument, so typeArg is -1; the
 * interface name is located as the first string literal rather than by index,
 * because the argument position varies — `create_publisher<T>("cmd_vel", 10)`
 * puts it first, while `rclcpp_action::create_client<T>(this, "fibonacci")`
 * takes the node first):
 *   create_publisher<T>(topic, qos)
 *   create_subscription<T>(topic, qos, callback)
 *   create_service<T>(name, callback)
 *   create_client<T>(name)                    / rclcpp_action::create_client<T>(node, name)
 *   rclcpp_action::create_server<T>(node, ..., name, ...)
 */
const ROS_CALLS = {
    // --- topics -------------------------------------------------------------
    create_publisher: {
        py: { kind: "topic", relType: "PUBLISHES_TOPIC", typeArg: 0, nameArg: 1 },
        cpp: { kind: "topic", relType: "PUBLISHES_TOPIC", typeArg: -1, nameArg: "first-string" },
    },
    create_subscription: {
        py: { kind: "topic", relType: "SUBSCRIBES_TOPIC", typeArg: 0, nameArg: 1, callbackArg: 2 },
        cpp: { kind: "topic", relType: "SUBSCRIBES_TOPIC", typeArg: -1, nameArg: "first-string" },
    },
    // --- services -----------------------------------------------------------
    create_service: {
        py: { kind: "service", relType: "PROVIDES_SERVICE", typeArg: 0, nameArg: 1, callbackArg: 2 },
        cpp: { kind: "service", relType: "PROVIDES_SERVICE", typeArg: -1, nameArg: "first-string" },
    },
    create_client: {
        py: { kind: "service", relType: "CALLS_SERVICE", typeArg: 0, nameArg: 1 },
        cpp: { kind: "service", relType: "CALLS_SERVICE", typeArg: -1, nameArg: "first-string" },
    },
    // --- actions ------------------------------------------------------------
    // rclpy exposes actions as constructors, not Node methods.
    ActionServer: {
        py: { kind: "action", relType: "PROVIDES_ACTION", typeArg: 1, nameArg: 2, callbackArg: 3 },
    },
    ActionClient: {
        py: { kind: "action", relType: "USES_ACTION", typeArg: 1, nameArg: 2 },
    },
    create_server: {
        cpp: { kind: "action", relType: "PROVIDES_ACTION", typeArg: -1, nameArg: "first-string" },
    },
};

/**
 * Base classes that make a class a ROS node. Matched against the *last*
 * segment of the base name, so `Node`, `rclpy.node.Node` and `rclcpp::Node`
 * all resolve. `LifecycleNode` is the managed-node variant.
 */
const ROS_NODE_BASES = new Set(["Node", "LifecycleNode"]);

// ============================================================================
// NAME + TYPE NORMALISATION
// ============================================================================

/**
 * Legal ROS 2 name, per the naming rules: optional `/` or `~/` prefix, then
 * `/`-separated tokens of [A-Za-z_][A-Za-z0-9_]*.
 *
 * NOTE: relative names (`cmd_vel`, no leading slash) are the common case in
 * ROS 2 and MUST be accepted — an earlier version of the extractor required a
 * leading `/`, which silently dropped almost every real publisher.
 */
const ROS_NAME_RE = /^(?:~?\/|~)?[A-Za-z_][A-Za-z0-9_]*(?:\/[A-Za-z_][A-Za-z0-9_]*)*$/;

/** Strip surrounding quotes from a source-literal capture. */
function stripQuotes(raw) {
    if (typeof raw !== "string") return "";
    const t = raw.trim();
    const m = /^(['"])([\s\S]*)\1$/.exec(t);
    return m ? m[2] : t;
}

/**
 * Normalise a captured topic/service/action name.
 * Returns `{ name, dynamic }`:
 *   - a string literal that parses as a ROS name  -> { name, dynamic: false }
 *   - anything else (variable, f-string, concat)  -> { name: <expr>, dynamic: true }
 *
 * Dynamic names are deliberately KEPT rather than dropped: a topic whose name
 * is computed at runtime is still an edge in the architecture, and hiding it
 * would make the generated diagram quietly incomplete. The diagram renders it
 * with a `?` marker instead.
 */
function normalizeRosName(raw, { wasLiteral = true } = {}) {
    if (raw === null || raw === undefined) return null;
    const text = String(raw).trim();
    if (!text) return null;

    if (wasLiteral) {
        const bare = stripQuotes(text);
        if (ROS_NAME_RE.test(bare)) return { name: bare, dynamic: false };
        // A literal that is not a legal ROS name is not a topic at all
        // (e.g. a format string, a URL, a log message) — reject it outright.
        return null;
    }

    // Non-literal expression: keep a compact single-line form as the label.
    const expr = text.replace(/\s+/g, " ").slice(0, 80);
    return { name: expr, dynamic: true };
}

/**
 * Normalise an interface type to the canonical ROS form `pkg/msg/Type`.
 *   geometry_msgs::msg::Twist  -> geometry_msgs/msg/Twist   (C++)
 *   geometry_msgs.msg.Twist    -> geometry_msgs/msg/Twist   (Python dotted)
 *   Twist                      -> Twist                     (Python bare import)
 * Template/pointer noise (`const`, `::SharedPtr`, `&`) is stripped.
 */
function normalizeMsgType(raw) {
    if (raw === null || raw === undefined) return null;
    let t = String(raw).trim();
    if (!t) return null;

    t = t.replace(/^<|>$/g, "").trim();          // C++ template_argument_list text
    t = t.replace(/\bconst\b/g, "").trim();       // const qualifiers
    t = t.replace(/[&*]/g, "").trim();            // ref/pointer
    t = t.replace(/::(SharedPtr|ConstSharedPtr|UniquePtr|Ptr)\b/g, "");
    t = t.replace(/::/g, "/").replace(/\./g, "/");
    t = t.replace(/\/+/g, "/").replace(/^\/|\/$/g, "");
    if (!t) return null;
    // Anything with whitespace left is an expression, not a type name.
    if (/\s/.test(t)) return null;
    return t;
}

/**
 * Resolve a ROS name to its fully-qualified form, per the ROS 2 name-resolution
 * rules for a node in the default namespace:
 *
 *   cmd_vel    (relative) -> /cmd_vel
 *   /cmd_vel   (absolute) -> /cmd_vel      unchanged
 *   ~/config   (private)  -> /<node_name>/config
 *
 * This matters for more than tidiness: a publisher written as `'cmd_vel'` and a
 * subscriber written as `'/cmd_vel'` are the SAME topic at runtime. Keyed on the
 * literal source string they stay two separate nodes and the diagram shows two
 * disconnected boxes instead of the connection it exists to show.
 *
 * CAVEAT: this assumes the default namespace. A node pushed into a namespace by
 * a launch file actually resolves `cmd_vel` to `/<ns>/cmd_vel`. Launch files are
 * not parsed, so that case is still not modelled — but the default namespace is
 * the common one, and getting it right connects the graph rather than leaving
 * every relative name stranded.
 */
function canonicalizeRosName(name, { nodeName = null, dynamic = false } = {}) {
    if (!name || dynamic) return name;
    if (name === "~") return nodeName ? `/${nodeName}` : name;
    if (name.startsWith("~/")) return nodeName ? `/${nodeName}/${name.slice(2)}` : name;
    if (name.startsWith("/")) return name;
    return `/${name}`;
}

/** Short display form of a type: the last segment (`geometry_msgs/msg/Twist` -> `Twist`). */
function shortMsgType(type) {
    if (!type) return null;
    const text = String(type);
    const parts = text.split(/\/|::|\./);
    if (parts.length > 1) return parts[parts.length - 1] || null;
    const generated = /^.+_(?:msg|srv|action)_(.+)$/.exec(text);
    return generated ? generated[1] : text;
}

/**
 * Refine the interface kind from the type's ROS namespace. `create_client<T>`
 * is ambiguous in C++ (rclcpp::Client vs rclcpp_action::Client); the type tells
 * us which one it is.
 */
function refineKind(kind, msgType) {
    if (!msgType) return kind;
    if (/(^|\/)action(\/|$)/.test(msgType)) return "action";
    if (/(^|\/)srv(\/|$)/.test(msgType)) return "service";
    if (/(^|\/)msg(\/|$)/.test(msgType)) return "topic";
    return kind;
}

/** Rel type for a (kind, direction) pair — used after refineKind changes kind. */
const REL_BY_KIND = {
    topic: { provide: "PUBLISHES_TOPIC", consume: "SUBSCRIBES_TOPIC" },
    service: { provide: "PROVIDES_SERVICE", consume: "CALLS_SERVICE" },
    action: { provide: "PROVIDES_ACTION", consume: "USES_ACTION" },
};

/** Whether a rel type is the "server/producer" side of its interface. */
function directionOf(relType) {
    return relType === "PUBLISHES_TOPIC" || relType === "PROVIDES_SERVICE" || relType === "PROVIDES_ACTION"
        ? "provide"
        : "consume";
}

// ============================================================================
// CLASSIFICATION
// ============================================================================

/**
 * Pick the argument that carries the interface name.
 * `spec.nameArg` is either a positional index or the string "first-string",
 * which scans for the first string-literal argument (C++ action factories,
 * whose overloads shift the name position around).
 */
function pickNameArg(spec, args) {
    if (spec.nameArg === "first-string") {
        return args.find((a) => a && a.isLiteral) || null;
    }
    return args[spec.nameArg] || null;
}

/**
 * Classify a captured ROS factory call.
 *
 * @param {object} input
 * @param {string} input.method   Method / constructor name (`create_publisher`, `ActionServer`, ...).
 * @param {"py"|"cpp"} input.lang Language dialect — decides the argument layout.
 * @param {Array<{text: string, isLiteral: boolean}>} input.args Positional arguments, in order.
 * @param {string} [input.templateType] C++ template argument text (`<geometry_msgs::msg::Twist>`).
 * @returns {null | {kind, label, relType, name, dynamic, msgType, callback}}
 *          `null` when the call is not a ROS interface factory, or when the
 *          name argument is missing/unusable.
 */
function classifyRosCall({ method, lang, args = [], templateType = null }) {
    const entry = ROS_CALLS[method];
    if (!entry) return null;
    const spec = entry[lang];
    if (!spec) return null;

    const nameArg = pickNameArg(spec, args);
    if (!nameArg) return null;

    const named = normalizeRosName(nameArg.text, { wasLiteral: nameArg.isLiteral });
    if (!named) return null;

    const rawType = spec.typeArg >= 0 ? (args[spec.typeArg] || {}).text : templateType;
    const msgType = normalizeMsgType(rawType);

    const kind = refineKind(spec.kind, msgType);
    const relType = kind === spec.kind
        ? spec.relType
        : REL_BY_KIND[kind][directionOf(spec.relType)];

    const cbArg = spec.callbackArg !== undefined ? args[spec.callbackArg] : null;

    return {
        kind,
        label: KIND_LABEL[kind],
        relType,
        name: named.name,
        dynamic: named.dynamic,
        msgType: msgType || null,
        callback: cbArg && !cbArg.isLiteral ? cbArg.text : null,
    };
}

/** Does this base-class name make the class a ROS node? */
function isRosNodeBase(baseName) {
    if (!baseName) return false;
    const last = String(baseName).split(/::|\./).pop();
    return ROS_NODE_BASES.has(last);
}

module.exports = {
    ROS_CALLS,
    ROS_NODE_BASES,
    KIND_LABEL,
    REL_BY_KIND,
    ROS_NAME_RE,
    stripQuotes,
    normalizeRosName,
    canonicalizeRosName,
    normalizeMsgType,
    shortMsgType,
    refineKind,
    directionOf,
    classifyRosCall,
    isRosNodeBase,
};

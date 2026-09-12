#!/usr/bin/env node
/**
 * Does the generated Mermaid actually RENDER?
 *
 * The ROS tab draws its diagram with Mermaid in the browser. Mermaid failing to
 * parse is a silent-ish failure — the tab shows an error box and the feature is
 * useless — and nothing in a Node-only test suite would catch it, because
 * Mermaid needs a real DOM. So this test drives the same Mermaid build the
 * frontend bundles, inside the Chromium that is already installed.
 *
 * Skipped automatically when no browser is available (`SKIP_BROWSER_TESTS=1`, or
 * puppeteer/mermaid not installed), so it never blocks a plain `npm test`.
 *
 * Run: node --test tests/ros-mermaid-render.test.js
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

const { buildRosDiagram } = require("../scripts/ros/ros_diagram.js");

const MERMAID_ESM = path.resolve(__dirname, "../frontend/node_modules/mermaid/dist/mermaid.esm.min.mjs");
const haveMermaid = fs.existsSync(MERMAID_ESM);
let puppeteer = null;
try { puppeteer = require("puppeteer"); } catch { /* optional */ }

const SKIP = process.env.SKIP_BROWSER_TESTS === "1" || !puppeteer || !haveMermaid;

/** The model the ROS tab renders: node classes, interface boxes, wiring. */
const MODEL = {
    nodes: [
        { id: "n1", name: "MinimalPublisher", kind: "class", file: "talker.py", nodeName: "minimal_publisher", base: "Node" },
        { id: "n2", name: "ScanListener", kind: "class", file: "listener.cpp", nodeName: "scan_listener", base: "rclcpp::Node" },
        { id: "n3", name: "DottedBase", kind: "class", file: "talker.py", nodeName: "dotted_node", base: "rclpy.node.Node" },
    ],
    interfaces: [
        { name: "/cmd_vel", kind: "topic", msgType: "geometry_msgs/msg/Twist", dynamic: false },
        { name: "/scan", kind: "topic", msgType: "sensor_msgs/msg/LaserScan", dynamic: false },
        { name: "self.topic_name", kind: "topic", msgType: "String", dynamic: true },
        { name: "/reset", kind: "service", msgType: "std_srvs/srv/Trigger", dynamic: false },
        { name: "/fibonacci", kind: "action", msgType: "example_interfaces/action/Fibonacci", dynamic: false },
    ],
    edges: [
        { nodeId: "n1", iface: "/cmd_vel", relType: "PUBLISHES_TOPIC", msgType: "geometry_msgs/msg/Twist" },
        { nodeId: "n2", iface: "/cmd_vel", relType: "SUBSCRIBES_TOPIC", msgType: "geometry_msgs/msg/Twist", callback: "std::bind(&ScanListener::on_cmd, this, _1)" },
        { nodeId: "n2", iface: "/scan", relType: "SUBSCRIBES_TOPIC", msgType: "sensor_msgs/msg/LaserScan" },
        { nodeId: "n1", iface: "self.topic_name", relType: "PUBLISHES_TOPIC", msgType: "String" },
        { nodeId: "n1", iface: "/reset", relType: "PROVIDES_SERVICE", msgType: "std_srvs/srv/Trigger", callback: "self.handle_reset" },
        { nodeId: "n2", iface: "/reset", relType: "CALLS_SERVICE", msgType: "std_srvs/srv/Trigger" },
        { nodeId: "n1", iface: "/fibonacci", relType: "PROVIDES_ACTION", msgType: "example_interfaces/action/Fibonacci" },
        { nodeId: "n3", iface: "/fibonacci", relType: "USES_ACTION", msgType: "example_interfaces/action/Fibonacci" },
    ],
};

describe("generated Mermaid renders in a browser", { skip: SKIP && "puppeteer/mermaid/browser not available" }, () => {
    let browser, page, server;

    before(async () => {
        // Chromium gives every file:// document an opaque origin, so an ES
        // module import from one file:// URL to another is blocked. Serving the
        // harness over http keeps the test free of browser security flags.
        const http = require("node:http");
        // Mermaid's ESM build code-splits into ./chunks/*.mjs, so the whole dist
        // directory has to be reachable — serving just the entry file leaves
        // every dynamic import 404ing.
        const DIST = path.dirname(MERMAID_ESM);
        server = http.createServer((req, res) => {
            const url = req.url.split("?")[0];
            if (url === "/") {
                res.writeHead(200, { "Content-Type": "text/html" });
                res.end("<!doctype html><html><body><div id='out'></div></body></html>");
                return;
            }
            // Confined to DIST: resolve, then verify the result is still inside.
            const file = path.resolve(DIST, "." + url);
            if (!file.startsWith(DIST) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
                res.writeHead(404).end();
                return;
            }
            res.writeHead(200, { "Content-Type": "text/javascript" });
            res.end(fs.readFileSync(file));
        });
        await new Promise((r) => server.listen(0, "127.0.0.1", r));
        const base = `http://127.0.0.1:${server.address().port}`;

        browser = await puppeteer.launch({
            headless: true,
            // The sandbox runs behind an HTTP proxy; without bypassing it,
            // Chromium sends even 127.0.0.1 through the proxy and the module
            // fetch fails.
            args: [
                "--no-sandbox", "--disable-dev-shm-usage",
                "--proxy-server=direct://", "--proxy-bypass-list=*",
            ],
        });
        page = await browser.newPage();
        await page.goto(base, { waitUntil: "domcontentloaded" });
        // Expose a render helper that resolves with either the SVG or the error,
        // mirroring how RosTab calls mermaid.render().
        await page.evaluate(async () => {
            const mermaid = (await import("/mermaid.esm.min.mjs")).default;
            mermaid.initialize({ startOnLoad: false, theme: "dark", securityLevel: "strict" });
            window.__render = async (src, id) => {
                try {
                    const { svg } = await mermaid.render(id, src);
                    return { ok: true, svg };
                } catch (e) {
                    return { ok: false, error: String((e && e.message) || e) };
                }
            };
        });
    });

    after(async () => {
        if (browser) await browser.close();
        if (server) await new Promise((r) => server.close(r));
    });

    const render = async (src, id) => page.evaluate((s, i) => window.__render(s, i), src, id);

    it("renders the full ROS model without a parse error", async () => {
        const src = buildRosDiagram(MODEL, { format: "mermaid", title: "ROS 2 Architecture" });
        const r = await render(src, "full");
        assert.ok(r.ok, `mermaid failed to parse the generated diagram:\n${r.error}\n\n--- source ---\n${src}`);
        assert.match(r.svg, /<svg/, "expected an SVG document back");
    });

    it("draws every node and interface box", async () => {
        const src = buildRosDiagram(MODEL, { format: "mermaid" });
        const r = await render(src, "boxes");
        assert.ok(r.ok, r.error);
        for (const label of ["MinimalPublisher", "ScanListener", "/cmd_vel", "/scan", "/reset", "/fibonacci"]) {
            assert.ok(r.svg.includes(label), `'${label}' missing from the rendered SVG`);
        }
    });

    it("renders with inheritance disabled", async () => {
        const src = buildRosDiagram(MODEL, { format: "mermaid", showInheritance: false });
        const r = await render(src, "noinherit");
        assert.ok(r.ok, r.error);
    });

    it("renders an empty model rather than throwing", async () => {
        const src = buildRosDiagram({ nodes: [], interfaces: [], edges: [] }, { format: "mermaid" });
        const r = await render(src, "empty");
        assert.ok(r.ok, r.error);
    });

    it("survives names that collide once sanitised", async () => {
        // '/a/b' and '/a_b' both reduce to the same id characters; the renderer
        // has to keep them apart or mermaid redefines one class as the other.
        const src = buildRosDiagram({
            nodes: [{ id: "n1", name: "N", kind: "class" }],
            interfaces: [
                { name: "/a/b", kind: "topic", msgType: "String" },
                { name: "/a_b", kind: "topic", msgType: "Int32" },
            ],
            edges: [
                { nodeId: "n1", iface: "/a/b", relType: "PUBLISHES_TOPIC", msgType: "String" },
                { nodeId: "n1", iface: "/a_b", relType: "PUBLISHES_TOPIC", msgType: "Int32" },
            ],
        }, { format: "mermaid" });
        const r = await render(src, "collide");
        assert.ok(r.ok, r.error);
        assert.ok(r.svg.includes("/a/b") && r.svg.includes("/a_b"), "both topics must survive as distinct boxes");
    });
});

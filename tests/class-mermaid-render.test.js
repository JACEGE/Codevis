#!/usr/bin/env node
/**
 * Does the generated CLASS diagram actually render?
 *
 * tests/ros-mermaid-render.test.js already does this for the ROS diagram, but
 * the Classes tab goes through a different renderer (scripts/diagram/
 * class_render.cjs) and had no such coverage. It showed: a single C++ method
 * whose signature contained `sensor_msgs::msg::LaserScan::SharedPtr` made
 * Mermaid abort with "Expecting 'NEWLINE', 'EOF', got 'COLON'", because the
 * colon is Mermaid's own class-member separator. The tab rendered an error box
 * and nothing else, and no Node-only assertion would have noticed — the source
 * string it produced was perfectly well-formed text.
 *
 * Skipped automatically when no browser is available, like its ROS sibling, so
 * it never blocks a plain `npm test`.
 *
 * Run: node --test tests/class-mermaid-render.test.js
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

const { renderMermaid, mermaidMember } = require("../scripts/diagram/class_render.cjs");

const MERMAID_ESM = path.resolve(__dirname, "../frontend/node_modules/mermaid/dist/mermaid.esm.min.mjs");
const haveMermaid = fs.existsSync(MERMAID_ESM);
let puppeteer = null;
try { puppeteer = require("puppeteer"); } catch { /* optional */ }

const SKIP = process.env.SKIP_BROWSER_TESTS === "1" || !puppeteer || !haveMermaid;

/**
 * A model built from the signature shapes that actually break things: a C++
 * namespace chain, a TypeScript annotated parameter with a return type, and an
 * annotated Python def. All three carry colons.
 */
const MODEL = {
    classes: [
        {
            key: "k1",
            name: "ScanListener",
            methods: [
                { name: "on_scan", signature: "void on_scan(const sensor_msgs::msg::LaserScan::SharedPtr msg)" },
                { name: "publish", signature: "void publish(const std::string & topic)" },
            ],
            attributes: [{ name: "products", declaredType: "std::vector<InventoryItem>" }],
        },
        {
            key: "k2",
            name: "TaskService",
            methods: [
                { name: "run", signature: "run(a: string, b: number): Promise<void>" },
                { name: "load", signature: "def load(self, path: str) -> dict" },
            ],
            hiddenMethods: 3,
        },
        { key: "k3", name: "rclcpp::Node", external: true, methods: [] },
    ],
    relations: [
        { from: "k1", to: "k3", kind: "inherits" },
        { from: "k2", to: "k1", kind: "creates" },
    ],
};

/**
 * Der Tab rendert nicht die Generator-Ausgabe, sondern die Ausgabe MIT
 * Theme-Direktive. Genau in diesem Unterschied sass der Fehler: die Direktive
 * wurde vorangestellt, der Frontmatter-Block war damit nicht mehr die erste
 * Zeile, und Mermaid erkannte den Diagrammtyp nicht mehr. Deshalb wird hier die
 * echte Funktion des Frontends geladen statt der Zusammenbau nachgebaut.
 */
const loadTabSource = async () => {
    const mod = await import(
        require("node:url").pathToFileURL(
            path.resolve(__dirname, "../frontend/src/lib/loadMermaid.js")
        ).href
    );
    return mod.withMermaidTheme;
};

describe("withMermaidTheme", () => {
    it("laesst den Frontmatter-Block die erste Zeile bleiben", async () => {
        const withMermaidTheme = await loadTabSource();
        const src = withMermaidTheme(renderMermaid(MODEL), "default");
        assert.ok(src.startsWith("---\n"), `Frontmatter nicht mehr vorne:\n${src.slice(0, 80)}`);
        assert.ok(src.includes("%%{init: {'theme':'default'}}%%"), "Theme-Direktive fehlt");
        // Und sie muss VOR dem Diagrammschlüsselwort stehen, nicht dahinter.
        assert.ok(
            src.indexOf("%%{init") < src.indexOf("classDiagram"),
            "Direktive steht hinter dem Diagrammtyp"
        );
    });

    it("stellt die Direktive voran, wenn es keinen Frontmatter gibt", async () => {
        const withMermaidTheme = await loadTabSource();
        assert.equal(
            withMermaidTheme("classDiagram\n  class A", "default"),
            "%%{init: {'theme':'default'}}%%\nclassDiagram\n  class A"
        );
    });
});

describe("mermaidMember", () => {
    it("turns a C++ namespace chain into dots", () => {
        assert.equal(
            mermaidMember("void on_scan(const sensor_msgs::msg::LaserScan::SharedPtr msg)"),
            "void on_scan(const sensor_msgs.msg.LaserScan.SharedPtr msg)"
        );
    });

    it("drops the colon from an annotated parameter and return type", () => {
        assert.equal(mermaidMember("run(a: string, b: number): Promise<void>"), "run(a string, b number) Promise‹void›");
    });

    it("encodes generic brackets so Mermaid does not swallow their contents", () => {
        assert.equal(mermaidMember("items: std::vector<Product>"), "items std.vector‹Product›");
    });

    it("leaves colon-free text alone", () => {
        assert.equal(mermaidMember("getName()"), "getName()");
    });

    it("emits no colon anywhere in a rendered member line", () => {
        const src = renderMermaid(MODEL);
        for (const line of src.split("\n")) {
            // Class-member lines are `  Cn : text`; only that one separator may
            // be a colon. The title block above is not a member line.
            const m = /^ {2}(C\d+) : (.*)$/.exec(line);
            if (!m) continue;
            assert.ok(!m[2].includes(":"), `member text still carries a colon: ${line}`);
        }
    });
});

describe("generated class-diagram Mermaid renders in a browser", { skip: SKIP && "puppeteer/mermaid/browser not available" }, () => {
    let browser, page, server;

    before(async () => {
        const http = require("node:http");
        const DIST = path.dirname(MERMAID_ESM);
        server = http.createServer((req, res) => {
            const url = req.url.split("?")[0];
            if (url === "/") {
                res.writeHead(200, { "Content-Type": "text/html" });
                res.end("<!doctype html><html><body><div id='out'></div></body></html>");
                return;
            }
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
            args: ["--no-sandbox", "--disable-dev-shm-usage", "--proxy-server=direct://", "--proxy-bypass-list=*"],
        });
        page = await browser.newPage();
        await page.goto(base, { waitUntil: "domcontentloaded" });
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

    it("renders signatures full of colons without a parse error", async () => {
        const src = renderMermaid(MODEL, { title: "Class Diagram" });
        const r = await render(src, "classes-colons");
        assert.ok(r.ok, `mermaid failed to parse the generated diagram:\n${r.error}\n\n--- source ---\n${src}`);
        assert.match(r.svg, /<svg/, "expected an SVG document back");
    });

    it("keeps the class names and the truncation notice", async () => {
        const src = renderMermaid(MODEL);
        const r = await render(src, "classes-labels");
        assert.ok(r.ok, r.error);
        for (const name of ["ScanListener", "TaskService"]) {
            assert.ok(r.svg.includes(name), `'${name}' missing from the rendered SVG`);
        }
        // A truncated class must say so rather than read as complete.
        assert.ok(r.svg.includes("3 more"), "the hidden-method notice must survive rendering");
        assert.ok(r.svg.includes("InventoryItem"), "the generic argument must survive rendering");
    });

    /**
     * Der Fall, der die Bombe erzeugt hat: Theme-Direktive plus Frontmatter.
     * Voranstellen kostete die Typerkennung, Mermaid warf "No diagram type
     * detected" und malte sein Fehlerbild an document.body — unter die Seite,
     * außerhalb jedes React-Baums, ein Bild pro Fehlversuch.
     */
    it("rendert die Quelle so, wie der Tab sie zusammensetzt", async () => {
        const withMermaidTheme = await loadTabSource();
        const src = withMermaidTheme(renderMermaid(MODEL, { title: "Class Diagram" }), "default");
        const r = await render(src, "classes-themed");
        assert.ok(r.ok, `mermaid failed on the tab's own source:\n${r.error}\n\n--- source ---\n${src}`);
        assert.match(r.svg, /<svg/, "expected an SVG document back");
    });

    it("renders an empty model rather than throwing", async () => {
        const r = await render(renderMermaid({ classes: [], relations: [] }), "classes-empty");
        assert.ok(r.ok, r.error);
    });
});

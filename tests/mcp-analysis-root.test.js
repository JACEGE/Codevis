const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { tmpdir } = require("node:os");
const { pathToFileURL } = require("node:url");
const { execFileSync } = require("node:child_process");

test("MCP analysis resolves the project from a nested cwd without a project environment variable", (t) => {
    const root = fs.mkdtempSync(path.join(tmpdir(), "codevis-analysis-root-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, "src/generated"), { recursive: true });
    fs.writeFileSync(path.join(root, "src/a.js"), "export function seed() {}\n");
    fs.writeFileSync(path.join(root, "src/generated/ignored.js"), "not parsed\n");
    fs.writeFileSync(path.join(root, "codevis.config.cjs"), 'module.exports = { workspaces: { project_db: { sourceDir: ["src"], exclude: ["src/generated/**"] } } };');
    const moduleUrl = (file) => JSON.stringify(pathToFileURL(path.resolve(__dirname, "..", file)).href);
    const code = `
        import fs from 'node:fs';
        import assert from 'node:assert/strict';
        const { impactTools } = await import(${moduleUrl("tools/handlers/impact-tools.ts")});
        const { analysisTools } = await import(${moduleUrl("tools/handlers/analysis-tools.ts")});
        const paths = (await import(${moduleUrl("server/codevis-paths.cjs")})).default;
        const rec = values => ({ get: key => values[key] });
        const file = { path: 'src/a.js', sourceMtime: Date.now() + 60000, parseStatus: 'current', language: 'js' };
        const session = { close: async () => {}, run: async query => ({ records:
            query.startsWith('MATCH (n)') ? [rec({ nId: 'seed', nLabels: ['Function'], nName: 'seed', nFile: 'src/a.js' })]
            : query.startsWith('MATCH (f:File)') ? [rec(file)] : [] }) };
        const driver = { session: () => session };
        const workspace = paths.loadConfig().workspaces.target;
        const ctx = { targetDriver: driver, metaDriver: driver, targetWorkspace: workspace, metaWorkspace: workspace };
        const impact = JSON.parse((await impactTools.handlers.impact({ nodeId: 'seed', depth: 0 }, ctx)).content[0].text);
        const quality = JSON.parse((await analysisTools.handlers.analysis_quality({}, ctx)).content[0].text);
        assert.equal(impact.graphFreshness.state, 'current');
        assert.equal(quality.graphFreshness.state, 'current');
        fs.writeFileSync('new.js', 'export const added = 1;');
        const changed = JSON.parse((await analysisTools.handlers.analysis_quality({}, ctx)).content[0].text);
        assert.equal(changed.graphFreshness.state, 'stale');
        assert.deepEqual(changed.graphFreshness.staleFiles, ['src/new.js']);
        console.log('analysis root and freshness verified');
    `;
    const output = execFileSync(process.execPath, ["--import", pathToFileURL(require.resolve("tsx")).href, "--input-type=module", "-e", code], {
        cwd: path.join(root, "src"), encoding: "utf8", timeout: 30000,
        env: { ...process.env, CODEVIS_PROJECT_DIR: "", TSX_DISABLE_CACHE: "1" },
    });
    assert.match(output, /analysis root and freshness verified/);
});

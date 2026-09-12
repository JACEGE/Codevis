#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createReadStream } from "node:fs";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const nodeBinDir = dirname(process.execPath);
const npmCli = join(nodeBinDir, "node_modules", "npm", "bin", "npm-cli.js");
const npxCli = join(nodeBinDir, "node_modules", "npm", "bin", "npx-cli.js");
const npmCommand = process.platform === "win32" ? process.execPath : "npm";
const npxCommand = process.platform === "win32" ? process.execPath : "npx";
const npmPrefix = process.platform === "win32" ? [npmCli] : [];
const npxPrefix = process.platform === "win32" ? [npxCli] : [];
const COMMAND_TIMEOUT_MS = 180_000;
const DASHBOARD_TIMEOUT_MS = 45_000;
let tempRoot;
let dashboard;
let dashboardOutput = "";
let registry;
let mcp;
let testEnv = {};
let projectDir;

function step(message) {
  console.log(`\n[smoke] ${message}`);
}

function run(command, args, { cwd, timeout = COMMAND_TIMEOUT_MS, capture = false, likelyCause, input, env = {} }) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      stdio: capture ? [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] : "inherit",
      env: {
        ...process.env,
        ...testEnv,
        ...env,
        CI: "1",
        npm_config_yes: "true",
        // Deliberately NOT an isolated npm cache. It would force a cold download
        // of every dependency on each run — minutes instead of seconds — without
        // buying anything: the bug class this test exists for is "a file was left
        // out of the package", and the cache cannot hide that. The tarball is
        // built fresh from the working tree every time, which is the part that
        // has to be isolated.
      },
    });
    if (input !== undefined) child.stdin.end(input);
    let stdout = "";
    let stderr = "";
    if (capture) {
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
    }
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${likelyCause} The command exceeded ${timeout / 1000}s and was terminated.`));
    }, timeout);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`${likelyCause} Could not start ${command}: ${error.message}`));
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) return resolvePromise({ stdout, stderr });
      const detail = capture ? `\n${stderr || stdout}`.trimEnd() : "";
      reject(new Error(`${likelyCause} Command exited with ${code ?? signal}.${detail ? `\n${detail}` : ""}`));
    });
  });
}

async function freePort() {
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolvePromise(port));
    });
  });
}

async function getJson(url, timeout = 2_000) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeout) });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`returned HTTP ${response.status} but invalid JSON: ${text.slice(0, 200)}`);
  }
  return { status: response.status, json };
}

async function waitForDashboard(url) {
  const deadline = Date.now() + DASHBOARD_TIMEOUT_MS;
  let lastError = "no response";
  while (Date.now() < deadline) {
    if (dashboard.exitCode !== null) {
      throw new Error(`The installed dashboard exited before becoming healthy. This usually means a packaged runtime file is missing or a route was registered before the Express app existed.\n${dashboardOutput}`);
    }
    try {
      const result = await getJson(url);
      if (result.status === 200) return result.json;
      lastError = `HTTP ${result.status}`;
    } catch (error) {
      lastError = error.message;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  throw new Error(`The installed dashboard did not answer /api/status within ${DASHBOARD_TIMEOUT_MS / 1000}s (${lastError}). This usually means startup crashed, a package file is missing, or the bridge could not bind its port.\n${dashboardOutput}`);
}

/**
 * Stop the dashboard AND everything it spawned.
 *
 * `codevis dashboard` is started through npx, which spawns the bridge, which in
 * turn spawns the graph daemon. Signalling only the npx wrapper leaves the two
 * children alive: they keep the port bound, keep the database files open (so the
 * temp directory cannot be removed on Windows) and keep this process's stdio
 * pipes attached, so the script itself never exits. Kill the tree, not the head.
 */
async function stopDashboard() {
  if (!dashboard || dashboard.exitCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(dashboard.pid), "/T", "/F"], { windowsHide: true });
  } else {
    dashboard.kill("SIGTERM");
  }
  await Promise.race([
    new Promise((resolvePromise) => dashboard.once("exit", resolvePromise)),
    new Promise((resolvePromise) => setTimeout(resolvePromise, 5_000)),
  ]);
  if (dashboard.exitCode === null) dashboard.kill("SIGKILL");
  // Detach the pipes: a child that outlived the kill would otherwise hold the
  // event loop open and the run would hang after all checks have passed.
  dashboard.stdout?.destroy();
  dashboard.stderr?.destroy();
}

try {
  step("Creating a throwaway new-user project outside the repository");
  tempRoot = await mkdtemp(join(tmpdir(), "codevis-fresh-install-"));
  projectDir = join(tempRoot, "sample-project");
  testEnv = {
    CODEVIS_PROJECT_DIR: projectDir,
    CODEVIS_DATA_DIR: join(projectDir, '.codevis'),
    LADYBUG_DAEMON_PORT: String(await freePort()),
    CODEVIS_LOCKING: 'off',
  };
  const sourceDir = join(projectDir, "src");
  await mkdir(sourceDir, { recursive: true });
  await writeFile(join(projectDir, "package.json"), JSON.stringify({ name: "codevis-smoke-sample", private: true, type: "module" }, null, 2));
  await writeFile(join(sourceDir, "math.js"), "export function double(value) { return value * 2; }\n");
  await writeFile(join(sourceDir, "format.js"), "export function format(value) { return `Result: ${value}`; }\n");
  await writeFile(join(sourceDir, 'Store.js'), 'class Base {}\nexport default (class extends mixin(Base) { count = 1; run() { return this.count; } });\n');
  await writeFile(join(sourceDir, 'Accessors.ts'), 'class Accessors { static accessor count = 1; accessor() { return Accessors.count; } }\n');
  await writeFile(join(sourceDir, 'AccessorView.tsx'), 'class AccessorView { static accessor count = 1; accessor() { return AccessorView.count; } }\n');
  await writeFile(join(sourceDir, 'types.cpp'), 'typedef struct { int y; } Named;\nenum class Mode { Fast, Slow };\n');
  await writeFile(join(sourceDir, "index.js"), "import { double } from './math.js';\nimport { format } from './format.js';\nexport function main() { return format(double(21)); }\nmain();\n");
  await mkdir(join(projectDir, 'docs', 'knowledge'), { recursive: true });
  await writeFile(join(projectDir, 'docs', 'knowledge', 'rule.md'), '---\nid: smoke-rule\ntitle: Markdown rule\nappliesTo: [src/math.js]\n---\nAuthoritative Markdown content.\n');

  // Das Dashboard-Bundle ist eine VORBEDINGUNG dieses Tests, keine Nebensache.
  //
  // `frontend/dist/` steht in package.json files[], ist aber gitignored — es
  // entsteht erst durch einen Build. Gebaut wird es von `prepublishOnly`, und
  // das läuft nur bei `npm publish`; der Pack-Aufruf unten benutzt bewusst
  // `--ignore-scripts`. In einem frischen Klon — also in CI und bei jedem, der
  // das Repo neu auscheckt — landete deshalb ein Tarball ohne Dashboard im
  // Test, die Installation startete nicht, und die Meldung lautete
  // "packaging bug — please report it". Sie zeigte damit auf das Manifest,
  // während in Wahrheit nur niemand das Frontend gebaut hatte.
  //
  // Auf dieser Maschine fiel es nicht auf, weil dort ein alter Build lag. Genau
  // deshalb stellt der Test die Vorbedingung jetzt selbst her, statt sich auf
  // den Zustand des Arbeitsplatzes zu verlassen.
  if (!existsSync(join(repoRoot, "frontend", "dist", "index.html"))) {
    step("Building the dashboard bundle (frontend/dist is gitignored and missing)");
    await run(npmCommand, [...npmPrefix, "run", "build:frontend"], {
      cwd: repoRoot,
      timeout: 600_000,
      likelyCause: "The dashboard bundle could not be built; the packed artifact would be missing frontend/dist.",
    });
  }

  step("Packing the repository with npm pack");
  const packed = await run(npmCommand, [...npmPrefix, "pack", "--ignore-scripts", "--json", "--pack-destination", tempRoot], {
    cwd: repoRoot,
    capture: true,
    likelyCause: "npm pack failed; check the package manifest and publish-time file selection.",
  });
  let tarballName;
  try {
    tarballName = JSON.parse(packed.stdout)[0].filename;
  } catch {
    throw new Error(`npm pack did not report its tarball as JSON; packaging output changed or was corrupted.\n${packed.stdout}\n${packed.stderr}`);
  }
  const tarball = join(tempRoot, tarballName);

  // Serve only this unpublished CodeVis artifact. Everything else uses npm's
  // public registry. This exercises the actual npx -> local install path without
  // publishing a test version or relying on a global link from a developer.
  const manifest = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'));
  registry = createHttpServer((req, res) => {
    if (req.url === '/codevis.tgz') return createReadStream(tarball).pipe(res);
    if (req.url === '/codevis') {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ name: 'codevis', 'dist-tags': { latest: manifest.version, beta: manifest.version }, versions: {
        [manifest.version]: { ...manifest, dist: { tarball: `http://127.0.0.1:${registry.address().port}/codevis.tgz` } },
      } }));
    }
    res.writeHead(302, { Location: `https://registry.npmjs.org${req.url}` });
    res.end();
  });
  await new Promise(resolvePromise => registry.listen(0, '127.0.0.1', resolvePromise));
  testEnv.npm_config_registry = `http://127.0.0.1:${registry.address().port}`;

  step("Running the packed CLI through npm exec in a project without local CodeVis");
  await run(npmCommand, [...npmPrefix, "exec", "--yes", "--package", tarball, "--", "codevis", "init", "new", "-y"], {
    cwd: projectDir,
    // This includes two native dependency installs: npm exec's temporary
    // package and init's persistent project install. Cold Windows runners
    // take longer than five minutes for both; retain a bounded ten-minute cap.
    timeout: 600_000,
    likelyCause: "codevis init failed in a clean project; a generated template or packaged init-time module is likely missing or broken.",
  });
  assert.equal(JSON.parse(await readFile(join(projectDir, 'package.json'), 'utf8')).devDependencies.codevis, manifest.version);
  const require = createRequire(join(projectDir, 'package.json'));
  const loadConfig = () => {
    const configPath = join(projectDir, 'codevis.config.cjs');
    delete require.cache[require.resolve(configPath)];
    return require(configPath);
  };
  assert.equal(loadConfig().workMode, 'planning');
  assert.deepEqual(loadConfig().workspaces.project_db.sourceDir, []);

  step("Executing both installed hooks in the ESM project");
  for (const hook of ['lock-guard.cjs', 'bash-guard.cjs']) {
    const result = await run(process.execPath, [join(projectDir, '.claude/hooks', hook)], {
      cwd: projectDir, capture: true, input: JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: 'src/index.js' } }),
      likelyCause: 'A shipped hook failed to execute in an ESM project.',
    });
    assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'allow');
  }

  step("Starting the generated MCP command and creating work before any code build");
  const mcpConfig = JSON.parse(await readFile(join(projectDir, '.mcp.json'), 'utf8')).mcpServers.codevis_graph;
  mcp = new Client({ name: 'fresh-install-smoke', version: '1.0' }, { capabilities: {} });
  await mcp.connect(new StdioClientTransport({ ...mcpConfig, cwd: tempRoot, env: { ...process.env, ...testEnv, ...mcpConfig.env }, stderr: 'pipe' }));
  const call = async (name, args) => {
    const result = await mcp.callTool({ name, arguments: args });
    assert.ok(!result.isError, JSON.stringify(result));
    return result.content.map(item => item.text || '').join('\n');
  };
  assert.match(await call('update_graph_smart', { target: 'project_db' }), /Skipped/);
  await call('create_task', {
    title: 'Preserve planning work after the first build', targetNodes: [],
    description: 'This task was authored before any code was parsed. It must survive switching to code mode and a full graph rebuild without losing its content.',
    workInstructions: 'Create this task, switch to code mode, build the graph, and verify that this exact task is still available.',
  });
  await call('create_knowledge', { name: 'Planning decision', content: 'Retain this decision after code is first parsed.' });
  step('Running the installed runtime reset scripts from a project subdirectory');
  for (const [script, args] of [
    ['reset_user_events.js', ['project_db', '--force']],
    ['reset_component.js', ['project_db', 'App', '--list']],
  ]) {
    await run(process.execPath, [join(projectDir, 'node_modules/codevis/scripts', script), ...args], {
      cwd: sourceDir, capture: true, env: { CODEVIS_PROJECT_DIR: '' },
      likelyCause: `${script} failed to resolve the installed project's configuration.`,
    });
  }
  await call('create_epic', {
    title: 'Preserve the planning epic',
    description: 'Keep the project roadmap available before and after the first code graph build, with all planning notes retained.',
    workInstructions: 'Create the epic before parsing code, then confirm its title and content survive the first full graph build.',
  });
  const kanban = await run(npxCommand, [...npxPrefix, '--no-install', 'codevis', 'kanban'], {
    cwd: sourceDir, capture: true, env: { CODEVIS_PROJECT_DIR: '' },
    likelyCause: 'The terminal Kanban failed to find the project from a source subdirectory.',
  });
  assert.match(kanban.stdout, /OPEN \(1\)/);

  step("Confirming that planning mode skips graph builds");
  const plannedBuild = await run(npxCommand, [...npxPrefix, "--no-install", "codevis", "build", "full"], {
    cwd: projectDir,
    capture: true,
    likelyCause: "A planning-mode build should return successfully without starting the graph builder.",
  });
  if (!plannedBuild.stdout.includes("Planning mode does not build a code graph")) {
    throw new Error(`Planning mode did not explain that the build was skipped.\n${plannedBuild.stdout}`);
  }

  step("Switching the installed project from planning mode to code mode");
  await run(npxCommand, [...npxPrefix, "--no-install", "codevis", "init", "code", "--source", "./src", "--knowledge", "./docs/knowledge", "-y"], {
    cwd: projectDir,
    likelyCause: "codevis init code failed to switch a planning project after source code became available.",
  });
  assert.equal(loadConfig().workMode, 'code');
  assert.deepEqual(loadConfig().workspaces.project_db.sourceDir, ['./src']);
  step("Building through the same MCP process after switching modes");
  assert.match(await call('update_graph_smart', { target: 'project_db' }), /Update finished successfully/);

  step("Building the full graph");
  await run(npxCommand, [...npxPrefix, "--no-install", "codevis", "build", "full"], {
    cwd: sourceDir,
    env: { CODEVIS_PROJECT_DIR: '' },
    timeout: 300_000,
    likelyCause: "codevis build full failed on the sample sources; the packed graph builder, parser assets, or generated config may be incomplete.",
  });

  const port = await freePort();
  testEnv.CODEVIS_BRIDGE_PORT = String(port);
  step(`Starting the installed dashboard on port ${port}`);
  dashboard = spawn(npxCommand, [...npxPrefix, "--no-install", "codevis", "dashboard", "--port", String(port), "--no-open"], {
    cwd: sourceDir,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...testEnv, CODEVIS_PROJECT_DIR: '', CI: "1" },
  });
  dashboard.stdout.on("data", (chunk) => {
    dashboardOutput += chunk;
    process.stdout.write(chunk);
  });
  dashboard.stderr.on("data", (chunk) => {
    dashboardOutput += chunk;
    process.stderr.write(chunk);
  });
  dashboard.on("error", (error) => { dashboardOutput += `\n${error.message}`; });

  step("Polling GET /api/status for HTTP 200 and valid JSON");
  const status = await waitForDashboard(`http://127.0.0.1:${port}/api/status`);
  console.log(`[smoke] Dashboard status: ${JSON.stringify(status)}`);

  step('Starting the optional Brain channel from the installed package');
  const channel = new Client({ name: 'fresh-install-channel', version: '1.0' }, { capabilities: {} });
  try {
    await channel.connect(new StdioClientTransport({
      command: process.execPath,
      args: [join(projectDir, 'node_modules/codevis/lib/tsx-launcher.cjs'),
        join(projectDir, 'node_modules/codevis/tools/channels/codevis-brain/server.ts')],
      cwd: sourceDir,
      env: { ...process.env, ...testEnv, CODEVIS_BRIDGE_PORT: String(port) },
      stderr: 'inherit',
    }));
    assert.ok((await channel.listTools()).tools.some(tool => tool.name === 'reply_brain'));
  } finally { await channel.close(); }

  step("Checking that the built graph contains File and Function nodes");
  const statsResult = await getJson(`http://127.0.0.1:${port}/api/graph/stats?db=target`, 10_000);
  if (statsResult.status !== 200) {
    throw new Error(`Graph stats returned HTTP ${statsResult.status}. The bridge is running, but it cannot query the freshly built target graph.`);
  }
  const fileCount = Number(statsResult.json.nodesByLabel?.File ?? statsResult.json.fileCount ?? 0);
  const functionCount = Number(statsResult.json.nodesByLabel?.Function ?? 0);
  if (fileCount < 1 || functionCount < 1) {
    throw new Error(`The build completed but produced an empty/incomplete graph (File=${fileCount}, Function=${functionCount}). Source discovery or AST extraction is broken on the new-user path.`);
  }
  console.log(`[smoke] Graph counts: File=${fileCount}, Function=${functionCount}`);

  step('Checking quality freshness through the installed CLI');
  assert.equal(statsResult.json.graphState, 'current');
  const freshQuality = await run(npxCommand, [...npxPrefix, '--no-install', 'codevis', 'quality', '--json', '--max-parse-errors', '0'], {
    cwd: sourceDir, capture: true, env: { CODEVIS_PROJECT_DIR: '' },
    likelyCause: 'Quality must inspect the installed project sources and accept its freshly built graph.',
  });
  const qualityReport = JSON.parse(freshQuality.stdout);
  assert.equal(qualityReport.graphFreshness.state, 'current');
  assert.equal(qualityReport.gate.passed, true);

  step('Checking parser edge cases after the installed full build');
  const parserClasses = JSON.parse(await call('project_db', {
    query: "MATCH (c:Class) RETURN elementId(c) AS id, c.name AS name, c.kind AS kind",
  }));
  const storeId = parserClasses.find(c => c.name === 'Store')?.id;
  assert.equal(typeof storeId, 'string');
  assert.ok(parserClasses.some(c => c.name === 'Named'));
  assert.ok(parserClasses.some(c => c.name === 'Mode' && c.kind === 'enumeration'));
  const accessorFiles = JSON.parse(await call('project_db', {
    query: "MATCH (f:File) WHERE f.language = 'ts' OR f.language = 'tsx' RETURN f.parseStatus AS status",
  }));
  assert.equal(accessorFiles.length, 2);
  assert.ok(accessorFiles.every(f => f.status === 'current'));
  const accessorMethods = JSON.parse(await call('project_db', {
    query: "MATCH (c:Class)-[:CONTAINS]->(f:Function) WHERE f.name = 'accessor' RETURN c.name AS owner",
  }));
  assert.deepEqual(accessorMethods.map(m => m.owner).sort(), ['AccessorView', 'Accessors']);
  const parserTask = JSON.parse(await call('create_task', {
    title: 'Preserve anonymous class links through incremental updates', targetNodes: ['Store'],
    description: 'The file-derived Store class must retain its task relationship when its implementation changes.',
    workInstructions: 'Change Store fields, run an incremental build, and verify that this task still points to the same class identity.',
  }));

  const initialParserLinks = JSON.parse(await call('project_db', {
    query: "MATCH (t:Task)-[:AFFECTS]->(c:Class) RETURN t.taskId AS taskId, elementId(c) AS id",
  }));
  assert.ok(initialParserLinks.some(row => row.taskId === parserTask.taskId && row.id === storeId));

  step("Checking the unified Context API on the fresh project");
  const contextResult = await getJson(`http://127.0.0.1:${port}/api/context?db=project_db`, 10_000);
  if (contextResult.status !== 200
      || !Array.isArray(contextResult.json.knowledge)
      || !Array.isArray(contextResult.json.epics)
      || !Array.isArray(contextResult.json.tasks)) {
    throw new Error(`Context API is unavailable or malformed: HTTP ${contextResult.status} ${JSON.stringify(contextResult.json)}`);
  }
  assert.ok(contextResult.json.tasks.some(task => task.name === 'Preserve planning work after the first build'));
  assert.ok(contextResult.json.knowledge.some(item => item.name === 'Planning decision'));
  const markdownNode = contextResult.json.knowledge.find(item => item.name === 'Markdown rule');
  assert.equal(markdownNode?.id, 'knowledge-doc:smoke-rule');
  const markdownDetail = await getJson(`http://127.0.0.1:${port}/api/node/detail?db=project_db&nodeId=${encodeURIComponent(markdownNode.id)}`);
  assert.equal(markdownDetail.json.node.sourcePath, 'docs/knowledge/rule.md');
  const markdownSave = await fetch(`http://127.0.0.1:${port}/api/knowledge`, {
    method: 'PATCH', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({db:'project_db', nodeId:markdownNode.id, content:'Must not be accepted'}),
  });
  assert.equal(markdownSave.status, 409);
  await call('create_knowledge', {name:'Editable second',content:'Second original'});
  const knowledgeId = contextResult.json.knowledge.find(item => item.name === 'Planning decision').id;
  const knowledgeSave = await fetch(`http://127.0.0.1:${port}/api/knowledge`, {
    method:'PATCH', headers:{'Content-Type':'application/json'},
    body:JSON.stringify({db:'project_db',nodeId:knowledgeId,content:'Saved by exact identity'}),
  });
  assert.equal(knowledgeSave.status, 200);
  assert.equal((await knowledgeSave.json()).nodeId, knowledgeId);
  assert.ok(contextResult.json.epics.some(item => item.name === 'Preserve the planning epic'));

  step("Verifying read-only queries still allow dedicated annotation, task and knowledge writes");
  const nodes = JSON.parse(await call('project_db', {
    query: "MATCH (f:Function) WHERE f.name = 'double' RETURN elementId(f) AS id",
  }));
  assert.equal(nodes.length, 1);
  const targetNode = nodes[0].id;
  await call('propose_annotation', {
    targetNode, tag: 'domain:smoke', evidence: 'The double function multiplies its input by two.',
  });
  const annotations = JSON.parse(await call('list_annotations', { targetNode }));
  assert.ok(annotations.annotations.some(item => item.tag === 'domain:smoke'));
  const linkedTask = JSON.parse(await call('create_task', {
    title: 'Verify dedicated writes with read-only queries', targetNodes: ['double', 'src/math.js'],
    description: 'Verify that an agent can attach a task to existing code after a read-only query, without granting raw queries write access.',
    workInstructions: 'Read the double function, attach this task to it, and verify that its AFFECTS relationship is persisted.',
  }));
  const links = JSON.parse(await call('link_knowledge', { knowledgeName: 'Planning decision', targetNodes: ['double', 'src/math.js'] }));
  assert.equal(links.edgesCreated, 2);
  const fileKnowledge = JSON.parse(await call('get_knowledge_for_node', { db: 'project_db', nodeName: 'src/math.js' }));
  assert.ok(fileKnowledge.knowledge.some(item => item.name === 'Planning decision' && typeof item.nodeId === 'string'));
  const tasks = JSON.parse(await call('project_db', {
    query: "MATCH (t:Task)-[:AFFECTS]->(f:Function) WHERE f.name = 'double' RETURN t.title AS name",
  }));
  assert.ok(tasks.some(task => task.name === 'Verify dedicated writes with read-only queries'));
  for (const name of ['project_db', 'codevis_db']) {
    for (const query of ['ALTER TABLE CodeNode ADD injected STRING', '// "\nMATCH (n) SET n.name = \'changed\' RETURN n.name // "']) {
      const result = await mcp.callTool({ name, arguments: { query } });
      assert.ok(result.isError, `${name} accepted a mutation`);
    }
  }
  const queryResponse = await fetch(`http://127.0.0.1:${port}/api/graph/query`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ db: 'project_db', query: 'RETURN 1 AS value' }),
  });
  assert.equal(queryResponse.status, 200, await queryResponse.text());

  step("Checking installed epic membership across MCP and dashboard requests");
  const epic = JSON.parse(await call('create_epic', {
    db: 'project_db', title: 'Verify epic membership across transports',
    description: 'Verify that dashboard and MCP membership requests use the installed daemon transaction and preserve task ordering on retries.',
    workInstructions: 'Add two tasks, retry the first membership, reorder the epic, and remove its member through the dashboard.',
  }));
  const membershipUrl = taskId => `http://127.0.0.1:${port}/api/epics/${encodeURIComponent(epic.epicId)}/tasks/${encodeURIComponent(taskId)}?db=project_db`;
  await call('add_task_to_epic', { db: 'project_db', epicId: epic.epicId, taskId: parserTask.taskId });
  let membershipResponse = await fetch(membershipUrl(linkedTask.taskId), { method: 'PUT' });
  assert.equal(membershipResponse.status, 200, await membershipResponse.text());
  membershipResponse = await fetch(membershipUrl(parserTask.taskId), { method: 'PUT' });
  assert.equal(membershipResponse.status, 200, await membershipResponse.text());
  const epicDetail = await getJson(`http://127.0.0.1:${port}/api/epics/${encodeURIComponent(epic.epicId)}?db=project_db`);
  assert.deepEqual(epicDetail.json.dependencies.map(edge => [edge.from, edge.to]), [[parserTask.taskId, linkedTask.taskId]]);
  await call('set_epic_task_order', { db: 'project_db', epicId: epic.epicId, taskIds: [linkedTask.taskId, parserTask.taskId] });
  membershipResponse = await fetch(membershipUrl(parserTask.taskId), { method: 'DELETE' });
  assert.equal(membershipResponse.status, 200, await membershipResponse.text());

  step("Checking concurrent MCP/dashboard comments and real rename/rebuild preservation");
  const commentBase = `http://127.0.0.1:${port}/api/tasks/${encodeURIComponent(linkedTask.taskId)}/comments?db=project_db`;
  await Promise.all([
    call('add_task_comment', { db:'project_db', taskId:linkedTask.taskId, text:'MCP concurrent comment' }),
    (async()=>{
      const response=await fetch(commentBase, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({text:'Dashboard concurrent comment'}) });
      assert.equal(response.status,200,await response.text());
    })(),
  ]);
  const taskDetail = await getJson(`http://127.0.0.1:${port}/api/tasks/${encodeURIComponent(linkedTask.taskId)}?db=project_db`);
  assert.ok(taskDetail.json.comments.some(comment=>comment.text==='MCP concurrent comment'));
  assert.ok(taskDetail.json.comments.some(comment=>comment.text==='Dashboard concurrent comment'));
  assert.equal(taskDetail.json.affectedNodes.length, 2);
  const affectedFile = taskDetail.json.affectedNodes.find(node=>node.label==='File');
  assert.equal(affectedFile?.name, 'src/math.js');
  assert.equal(affectedFile?.file, 'src/math.js');
  assert.equal(typeof affectedFile?.id, 'string');
  const listedTask = JSON.parse(await call('list_tasks', {db: 'project_db', status: 'all'}))
    .find(task=>task.taskId === linkedTask.taskId);
  assert.equal(listedTask.affectedNodes.length, 2);
  assert.ok(listedTask.affectedNodes.some(node=>node.id === affectedFile.id && node.file === 'src/math.js'));
  const unlinkedTask = JSON.parse(await call('list_tasks', {db: 'project_db', status: 'all'}))
    .find(task=>task.title === 'Preserve planning work after the first build');
  assert.deepEqual(unlinkedTask.affectedNodes, []);
  await writeFile(join(sourceDir,'math.js'), 'export function doubled(value) { return value * 2; }\n');
  await writeFile(join(sourceDir,'Store.js'), 'export default class { next = 2; run() { return this.next; } }\n');
  await writeFile(join(sourceDir,'Accessors.ts'), 'class Accessors { static accessor next = 2; accessor() { return Accessors.next; } }\n');
  await writeFile(join(sourceDir,'AccessorView.tsx'), 'class AccessorView { static accessor next = 2; accessor() { return AccessorView.next; } }\n');
  await writeFile(join(sourceDir,'types.cpp'), 'typedef struct { int z; } Renamed;\nenum class Mode { Fast, Safe };\n');
  await writeFile(join(sourceDir,'index.js'), "import { doubled } from './math.js';\nimport { format } from './format.js';\nexport function main() { return format(doubled(21)); }\nmain();\n");
  const baselinePath = join(projectDir, 'quality-baseline.json');
  await writeFile(baselinePath, 'keep the previous baseline');
  await assert.rejects(() => run(npxCommand, [...npxPrefix, '--no-install', 'codevis', 'quality', '--json', '--max-parse-errors', '0', '--write-baseline', baselinePath], {
    cwd: sourceDir, capture: true, env: { CODEVIS_PROJECT_DIR: '' },
    likelyCause: 'A stale graph must fail the installed quality gate.',
  }), /graph-freshness/);
  assert.equal(await readFile(baselinePath, 'utf8'), 'keep the previous baseline');
  assert.match(await call('update_graph_smart', {target:'project_db'}), /Update finished successfully/);
  const parserLinks = JSON.parse(await call('project_db', {
    query: "MATCH (t:Task)-[:AFFECTS]->(c:Class) RETURN t.taskId AS taskId, elementId(c) AS id",
  }));
  assert.ok(parserLinks.some(row => row.taskId === parserTask.taskId && row.id === storeId));
  const parserFields = JSON.parse(await call('project_db', {
    query: "MATCH (c:Class)-[:DECLARES]->(v:Variable) RETURN c.name AS owner, v.name AS name",
  }));
  assert.deepEqual(parserFields.map(row => `${row.owner}.${row.name}`).sort(), ['AccessorView.next', 'Accessors.next', 'Mode.Fast', 'Mode.Safe', 'Renamed.z', 'Store.next']);
  const afterRename = JSON.parse(await call('list_annotations', {}));
  const keptTag=afterRename.annotations.find(item=>item.tag==='domain:smoke');
  assert.ok(keptTag && !keptTag.targetMissing);
  assert.equal(keptTag.targetName,'doubled');
  const keptLinks=JSON.parse(await call('project_db', {
    query:"MATCH (f:File {path:'src/math.js'}) MATCH (t:Task)-[:AFFECTS]->(f) MATCH (k:Knowledge)-[:APPLIES_TO]->(f) RETURN t.taskId AS taskId, k.name AS knowledge",
  }));
  assert.ok(keptLinks.some(item=>item.taskId===linkedTask.taskId && item.knowledge==='Planning decision'));

  step('Recovering a pending rebuild journal through the installed incremental command');
  const recoveryFile = join(projectDir, '.codevis', 'ladybug-target.rebuild-recovery.json');
  const recordedIdentity = JSON.parse(await readFile(join(projectDir, '.codevis', '.workspace-project_db.json'), 'utf8'));
  const targetFile = JSON.parse(await call('project_db', {
    query: "MATCH (f:File {path:'src/math.js'}) RETURN elementId(f) AS uid",
  }))[0].uid;
  await writeFile(recoveryFile, JSON.stringify({ version: 1, identity: recordedIdentity.fingerprint, backup: {
    locks: [], touched: [], knowledge: [], annotations: [],
    affects: [{ taskId: linkedTask.taskId, uid: targetFile, path: 'src/math.js', nodeLabels: ['File'] }],
  } }));
  // Simulate the persisted state after a failed rebuild severed the link.
  const severed = await fetch(`http://127.0.0.1:${testEnv.LADYBUG_DAEMON_PORT}/cypher`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ db: 'target', cypher: 'MATCH (t:CodeNode)-[r:AFFECTS]->(f:CodeNode) WHERE t.taskId=$taskId AND f.uid=$uid DELETE r',
      params: { taskId: linkedTask.taskId, uid: targetFile } }),
  });
  assert.ok(!(await severed.json()).error);
  const recoveredBuild = await call('update_graph_smart', { target: 'project_db' });
  assert.match(recoveredBuild, /Completing interrupted full rebuild/);
  assert.match(recoveredBuild, /Update finished successfully/);
  const recoveredLinks = JSON.parse(await call('project_db', {
    query: "MATCH (t:Task)-[:AFFECTS]->(f:File {path:'src/math.js'}) RETURN t.taskId AS taskId",
  }));
  assert.ok(recoveredLinks.some(row => row.taskId === linkedTask.taskId));
  assert.equal(existsSync(recoveryFile), false, 'completed recovery must remove the journal');

  if (process.argv.includes('--browser')) {
    step('Checking Spec editor workspace isolation in the packed dashboard browser');
    const { verifySpecWorkspaceLifetime } = await import('./spec-browser.mjs');
    await verifySpecWorkspaceLifetime(`http://127.0.0.1:${port}`, process.env.CODEVIS_AUDIT_SCREENSHOT);
  }

  if (process.argv.includes('--inspect')) {
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try { await prompt.question(`[smoke] Inspect http://127.0.0.1:${port}, then press Enter to clean up. `); }
    finally { prompt.close(); }
  }

  step("Shutting down the dashboard and cleaning up");
  await mcp.close();
  mcp = undefined;
  // The dashboard is not the only process holding the temp directory: the graph
  // daemon spawns itself on demand and keeps the database files open, so a
  // straight rmdir hits EBUSY on Windows. Give it a moment to release them.
  await stopGraphDaemon();
  await stopDashboard();
  await cleanup();
  await new Promise(resolvePromise => registry.close(resolvePromise));
  console.log("\n[smoke] Fresh-install smoke test passed.");
  // Exit explicitly. Every check has passed at this point, and a handle left
  // behind by a killed child must not turn a green run into a hang that CI
  // reports as a timeout — which is exactly how the first three runs ended.
  process.exit(0);
} catch (error) {
  console.error(`\n[smoke] FAILED: ${error.message}`);
  await mcp?.close().catch(() => {});
  await stopGraphDaemon().catch(() => {});
  await stopDashboard().catch(() => {});
  await cleanup().catch(() => {});
  registry?.close();
  process.exit(1);
}

/**
 * Stop the graph daemon that the build/dashboard started for this project.
 *
 * It writes its pid into <project>/.codevis/.ladybug-daemon.pid and holds the
 * database files open, which is what makes the temp directory undeletable on
 * Windows. Missing pidfile or already-dead process is fine — this is best
 * effort.
 */
async function stopGraphDaemon() {
  if (!projectDir) return;
  const cli = join(projectDir, 'node_modules/codevis/bin/codevis.mjs');
  if (!existsSync(cli)) return;
  await run(process.execPath, [cli, 'stop'], {
    cwd: join(projectDir, 'src'), capture: true, timeout: 20000,
    env: { CODEVIS_PROJECT_DIR: '' },
    likelyCause: 'The installed stop command could not cleanly shut down the test services.',
  });
}

/**
 * Remove the temp directory, and treat a failure as a warning rather than a
 * test failure: by this point every assertion has already passed, and a leftover
 * directory in the OS temp folder is not a reason to report a broken package.
 */
async function cleanup() {
  if (!tempRoot) return;
  try {
    await rm(tempRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 });
    tempRoot = undefined;
  } catch (e) {
    console.warn(`[smoke] NOTE: could not remove ${tempRoot} (${e.code}). Harmless — delete it by hand if it bothers you.`);
    tempRoot = undefined;
  }
}

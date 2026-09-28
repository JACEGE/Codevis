#!/usr/bin/env node
/**
 * Builds the offline demo of the dashboard: a static bundle (frontend/dist-demo)
 * that replays a recorded bridge, so it can be hosted anywhere and opened on a
 * phone without CodeVis installed.
 *
 *   node scripts/demo/build-demo.mjs
 *
 * Steps: copy examples/harbor-library to a temp project, build its graph, seed
 * Tasks and Knowledge through the MCP server, start its dashboard, record every
 * response the UI needs (Puppeteer), then run `vite build --mode demo` and copy
 * the recording next to it. The runtime side lives in frontend/src/demo.
 */

import { spawn, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { selectDashboardView } from '../smoke/dashboard-navigation.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const cli = join(repoRoot, 'bin/codevis.mjs');
const example = join(repoRoot, 'examples/harbor-library');
const outDir = join(repoRoot, 'frontend/dist-demo');
const settle = (ms = 1500) => new Promise(r => setTimeout(r, ms));

const VIEWS = ['Task board', 'CodeFlow', 'Ideas', 'Specs', 'Knowledge', 'Inspector', 'Pathfinder', 'Queries', 'Classes', 'Diagrams', 'Docs', 'Settings'];
const CLASS_TOGGLES = [
    ['onlyConnected', 'true'], ['includeUses', 'false'], ['groupByDirectory', 'true'],
    ['includeMethods', 'false'], ['compact', 'true'], ['memberVisibility', 'all'], ['includeTests', null],
];
const DETAIL_LABELS = new Set(['Function', 'Method', 'Class', 'File', 'Interface', 'Knowledge', 'Task']);
const FLOW_LABELS = new Set(['Flow', 'Change', 'Phase', 'Requirement', 'AcceptanceCriterion', 'SourceAnalysis', 'ArchitectureDecision', 'TestCase', 'Function', 'Class', 'File', 'Task']);

function run(args, cwd) {
    const result = spawnSync(process.execPath, [cli, ...args], { cwd, stdio: 'inherit', env: { ...process.env, CODEVIS_PROJECT_DIR: cwd } });
    if (result.status !== 0) throw new Error(`codevis ${args.join(' ')} failed with ${result.status}`);
}

function prepareProject() {
    // The folder name is what the dashboard shows as the project name.
    const project = join(mkdtempSync(join(tmpdir(), 'codevis-demo-')), 'harbor-library');
    mkdirSync(project);
    cpSync(join(example, 'src'), join(project, 'src'), { recursive: true });
    cpSync(join(example, 'tests'), join(project, 'tests'), { recursive: true });
    cpSync(join(example, 'README.md'), join(project, 'README.md'));
    // Written directly instead of `codevis init`, which would also install a
    // published codevis package into the temp project.
    writeFileSync(join(project, 'codevis.config.cjs'), `module.exports = ${JSON.stringify({
        workMode: 'code', extractors: { ros: false }, autoUpdate: { enabled: false }, locking: { enabled: false },
        knowledge: { paths: [] }, workspaces: { project_db: { sourceDir: ['src', 'tests'], exclude: [] } },
    }, null, 2)};\n`);
    spawnSync('git', ['init', '-q'], { cwd: project });
    run(['build', 'full'], project);
    return project;
}

async function seed(project) {
    const transport = new StdioClientTransport({
        command: process.execPath, args: [cli, 'start'], cwd: project, stderr: 'ignore',
        env: { ...process.env, CODEVIS_PROJECT_DIR: project, CODEVIS_AGENT_ID: 'demo-lead', CODEVIS_ROLE: 'lead' },
    });
    const client = new Client({ name: 'codevis-demo-seed', version: '1.0.0' });
    await client.connect(transport);
    try {
        const calls = JSON.parse(readFileSync(join(example, 'demo-seed.json'), 'utf8'));
        let reviewTaskId = null;
        for (const { name, args, completeAfterCreate } of calls) {
            const result = await client.callTool({ name, arguments: args });
            const text = result.content?.map(c => c.text).join('\n') ?? '';
            if (result.isError) throw new Error(`${name} failed: ${text}`);
            if (completeAfterCreate) reviewTaskId = JSON.parse(text).taskId;
        }
        // One finished task, so the board shows the review column in use.
        if (reviewTaskId) {
            const result = await client.callTool({ name: 'complete_task', arguments: {
                db: 'project_db', taskId: reviewTaskId, agentId: 'demo-lead', summary: 'Implemented and tested.',
            } });
            if (result.isError) throw new Error('complete_task failed: ' + result.content?.[0]?.text);
        }
        await seedFlow(client, JSON.parse(readFileSync(join(example, 'demo-flow.json'), 'utf8')));
    } finally {
        await client.close();
    }
}

/** Walks one CodeFlow through its phases; each gate must pass, like a real agent run. */
async function seedFlow(client, flow) {
    const call = async (name, args) => {
        const result = await client.callTool({ name, arguments: { db: 'project_db', ...args } });
        const text = result.content?.map(c => c.text).join('\n') ?? '';
        if (result.isError) throw new Error(`${name} ${args.operation || ''} failed: ${text}`);
        return JSON.parse(text);
    };
    const slug = flow.create.slug;
    await call('flow_write', { operation: 'create', agent: 'Lead', ...flow.create });
    let context = await call('flow_read', { operation: 'read', slug, view: 'context' });
    const write = async (operation, payload = {}) => {
        let result;
        // Windows can briefly lock a freshly written artifact (virus scanners
        // in %TEMP%): EBUSY. Re-read the revision and try again.
        for (let attempt = 1; ; attempt++) {
            try {
                result = await call('flow_write', { operation, slug, agent: 'Lead', expectedRevision: context.change.revision, ...payload });
                break;
            } catch (error) {
                if (!/EBUSY|EPERM/.test(error.message) || attempt >= 5) throw error;
                await settle(1000 * attempt);
                const before = context.change.revision;
                context = await call('flow_read', { operation: 'read', slug, view: 'context' });
                // The write may have landed before the failing read: do not apply it twice.
                if (context.change.revision > before) { result = { status: 'OK' }; break; }
            }
        }
        if (result.status === 'GATE_BLOCKED') throw new Error(`CodeFlow gate blocked ${context.instructions.phase}: ${JSON.stringify(result.gate?.failures)}`);
        context = await call('flow_read', { operation: 'read', slug, view: 'context' });
    };
    for (const { phase, complete = true, taskLinks = [], ...payload } of flow.steps) {
        if (context.instructions.phase !== phase) throw new Error(`CodeFlow expected phase ${phase}, is ${context.instructions.phase}`);
        if (taskLinks.length) {
            const tasks = await call('project_db', { query: 'MATCH (t:Task) RETURN elementId(t) AS id, t.title AS title' });
            payload.links = [...(payload.links || []), ...taskLinks.flatMap(({ title, implements: requirements }) => {
                const task = tasks.find(t => t.title === title);
                if (!task) throw new Error('CodeFlow task not found: ' + title);
                return requirements.map(to => ({ from: { nodeId: task.id }, type: 'IMPLEMENTS', to }));
            })];
        }
        await write('submit', payload);
        if (complete) await write('complete');
    }
}

function startDashboard(project) {
    return new Promise((resolveUrl, reject) => {
        const child = spawn(process.execPath, [cli, 'dashboard', '--no-open', '--no-watch'], {
            cwd: project, env: { ...process.env, CODEVIS_PROJECT_DIR: project }, stdio: ['ignore', 'pipe', 'pipe'],
        });
        let output = '';
        const timer = setTimeout(() => reject(new Error('Dashboard did not start:\n' + output)), 120_000);
        const onData = chunk => {
            output += chunk;
            const match = /\[ONLINE\]\s+(http:\/\/\S+)/.exec(output.replace(/\x1b\[[0-9;]*m/g, ''));
            if (match) { clearTimeout(timer); resolveUrl(match[1]); }
        };
        child.stdout.on('data', onData);
        child.stderr.on('data', onData);
        child.once('exit', code => { clearTimeout(timer); reject(new Error(`Dashboard exited with ${code}:\n${output}`)); });
    });
}

async function record(baseUrl) {
    const http = new Map();
    const socketIn = [];
    const browser = await puppeteer.launch({ headless: true, protocolTimeout: 900_000 });
    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1500, height: 1000 });
        page.setDefaultTimeout(60_000);
        await page.setCacheEnabled(false);
        const cdp = await page.createCDPSession();
        await cdp.send('Network.enable', { maxTotalBufferSize: 200_000_000, maxResourceBufferSize: 100_000_000 });
        // socket.io text frames: 42["event", ...args]
        cdp.on('Network.webSocketFrameReceived', ({ response }) => {
            const match = /^42\d*(\[.*)$/s.exec(response.payloadData);
            if (match) try { socketIn.push(JSON.parse(match[1])); } catch {}
        });
        page.on('response', async response => {
            const url = new URL(response.url());
            const request = response.request();
            if (!url.pathname.startsWith('/api/') || request.method() === 'OPTIONS') return;
            try {
                const body = request.postData() || null;
                http.set(`${request.method()} ${url.pathname}${url.search} ${body || ''}`, {
                    method: request.method(), path: url.pathname, search: url.search, body, status: response.status(),
                    contentType: response.headers()['content-type'] || 'application/json', text: await response.text(),
                });
            } catch {}
        });

        await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => document.querySelector('.workspace-header'));
        await settle(4000);
        for (const view of VIEWS) {
            try { await selectDashboardView(page, view); await settle(2500); }
            catch (error) { console.warn(`[demo] view ${view} not recorded: ${error.message}`); }
        }

        // Per-node data for everything a visitor can click, fetched from inside
        // the page so the listener records it like any UI request. Subgraphs
        // and routes are computed in the browser from the graph instead.
        const graph = socketIn.filter(([event]) => event === 'graph:init').at(-1)?.[1];
        const ids = (graph?.nodes || []).filter(n => (n.labels || []).some(l => DETAIL_LABELS.has(l))).map(n => n.id);
        const flowIds = (graph?.nodes || []).filter(n => (n.labels || []).some(l => FLOW_LABELS.has(l))).map(n => n.id);
        const variants = [[]];
        CLASS_TOGGLES.forEach((a, i) => { variants.push([a]); CLASS_TOGGLES.slice(i + 1).forEach(b => variants.push([a, b])); });
        await page.evaluate(async (ids, variants, flowIds) => {
            const db = 'project_db';
            const post = (path, body) => fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
            for (const id of ids) {
                const q = encodeURIComponent(id);
                await Promise.all([
                    fetch(`/api/node/detail?nodeId=${q}&db=${db}`),
                    fetch(`/api/node/source?nodeId=${q}&db=${db}`),
                    fetch(`/api/node/source?nodeId=${q}&db=${db}&full=1`),
                    fetch(`/api/annotations?nodeId=${q}&db=${db}`),
                    fetch(`/api/expand?nodeId=${q}&direction=out`),
                    fetch(`/api/expand?nodeId=${q}&direction=in`),
                    fetch(`/api/expand-ast?nodeId=${q}`),
                    post('/api/impact', { nodeId: id, db, profile: 'balanced' }),
                ].map(p => p.catch(() => null)));
            }
            // CodeFlow: detail, quality view, every phase artifact, traces, test results.
            const { changes = [] } = await (await fetch(`/api/flows?db=${db}`)).json();
            for (const { slug } of changes) {
                const flow = `/api/flows/${encodeURIComponent(slug)}`;
                const detail = await (await fetch(`${flow}?db=${db}`)).text();
                await fetch(`${flow}?view=quality&db=${db}`).catch(() => null);
                const paths = [...new Set([...detail.matchAll(/"path":"(docs\/codevis\/[^"]+\.md)"/g)].map(m => m[1]))];
                for (const path of paths) await fetch(`${flow}?view=artifact&path=${encodeURIComponent(path)}&db=${db}`).catch(() => null);
            }
            for (const id of flowIds) {
                await fetch(`/api/flows/trace/${encodeURIComponent(id)}?db=${db}`).catch(() => null);
                await fetch(`/api/flows/test-results/${encodeURIComponent(id)}?db=${db}`).catch(() => null);
            }
            const { queries } = await (await fetch('/api/graph/predefined-queries')).json();
            for (const { query } of queries) await post('/api/graph/query', { query, db }).catch(() => null);
            for (const variant of variants) {
                const params = new URLSearchParams({ db, includeTests: 'false' });
                for (const [key, value] of variant) value === null ? params.delete(key) : params.set(key, value);
                await fetch(`/api/diagram/class?${params}`).catch(() => null);
            }
        }, ids, variants, flowIds);
        await settle(3000);
    } finally {
        await browser.close();
    }
    return { recordedAt: new Date().toISOString(), http: [...http.values()], socketIn };
}

const project = prepareProject();
let fixtures;
try {
    await seed(project);
    const url = await startDashboard(project);
    console.log(`[demo] recording ${url}`);
    fixtures = await record(url);
} finally {
    spawnSync(process.execPath, [cli, 'stop'], { cwd: project, stdio: 'ignore', env: { ...process.env, CODEVIS_PROJECT_DIR: project } });
    try { rmSync(dirname(project), { recursive: true, force: true }); } catch {}
}

const vite = spawnSync('npx', ['vite', 'build', '--mode', 'demo'], { cwd: join(repoRoot, 'frontend'), stdio: 'inherit', shell: process.platform === 'win32' });
if (vite.status !== 0) throw new Error('vite build --mode demo failed');
// Recorded responses contain the temp project's absolute path, which names the
// local user account. Publish a neutral path instead, in every escaping depth.
let recorded = JSON.stringify(fixtures);
const variants = [project, project.replace(/\\/g, '/')];
for (let depth = 0; depth < 3; depth++) variants.push(...variants.slice(-2).map(v => JSON.stringify(v).slice(1, -1)));
for (const variant of [...new Set(variants)].sort((a, b) => b.length - a.length)) recorded = recorded.split(variant).join('/demo/harbor-library');
writeFileSync(join(outDir, 'demo-fixtures.json'), recorded);
// The Docs view shows the README, which embeds these screenshots.
mkdirSync(join(outDir, 'docs'), { recursive: true });
cpSync(join(repoRoot, 'docs/screenshots'), join(outDir, 'docs/screenshots'), { recursive: true });
console.log(`[demo] ${fixtures.http.length} responses, ${(statSync(join(outDir, 'demo-fixtures.json')).size / 1e6).toFixed(1)} MB -> ${outDir}`);

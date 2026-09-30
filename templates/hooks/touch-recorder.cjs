#!/usr/bin/env node
/**
 * CodeVis Touch Recorder — PostToolUse Hook (CommonJS, including in ESM projects)
 *
 * Attributes an Edit/Write/MultiEdit made with the client's own tools to the
 * Task it was made for: which lines changed, recorded in
 * .claude/touch-journal.jsonl. sync_task/complete_task replay the journal
 * after re-parsing and write Task-[:TOUCHED]->Function on the current
 * functions. See lib/touch-journal.cjs.
 *
 * Task resolution, most explicit first:
 *   CODEVIS_TASK_ID=<taskId>             → that task
 *   the task this (sub)agent claimed     → that task (see below)
 *   CODEVIS_AGENT_ID / teammate name     → the agent's only in_progress task
 *   neither                              → nothing is recorded
 *
 * Subagents share the parent's process and environment, so the environment
 * cannot tell them apart; the hook input can. Claude Code sends `agent_id`
 * with every tool call made inside a subagent, MCP calls included. The same
 * hook therefore also runs after claim_task/get_next_task and remembers which
 * task that agent took (.claude/agent-tasks/<agent>.json, one file per agent
 * so parallel subagents never overwrite each other), and forgets it after
 * complete_task. Calls outside any subagent are keyed by session.
 * An unidentified session (a person, or a lead making a quick fix) is never
 * credited to someone else's running task. Anything ambiguous records
 * nothing: inventing history is worse than a gap.
 *
 * Documentary only. The hook never blocks the edit and prints nothing; any
 * failure just means this edit is not attributed.
 */

const { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync } = require('fs');
const { resolve, relative } = require('path');

const TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);
const TASK_TOOL = /^mcp__codevis_[a-z]+__(claim_task|get_next_task|complete_task)$/;
const TIMEOUT_MS = Number(process.env.CODEVIS_TOUCH_TIMEOUT_MS || 4000);

const agentId = process.env.CODEVIS_AGENT_ID
    || (process.env.CLAUDE_CODE_TEAMMATE_NAME ? `worker-${process.env.CLAUDE_CODE_TEAMMATE_NAME}` : null);

// Resolve a CodeVis module from a checkout (CodeVis itself), a local install,
// or the package this template ships in.
function loadCodevis(projectDir, file) {
    for (const candidate of [resolve(projectDir, file), `codevis/${file}`, resolve(__dirname, '../..', file)]) {
        try { return require(candidate); } catch { /* try next */ }
    }
    return null;
}

function workspaces(projectDir) {
    const preferred = process.env.CODEVIS_TASK_DB;
    if (preferred) return [preferred];
    const names = ['project_db'];
    try {
        const config = require(resolve(projectDir, 'codevis.config.cjs'));
        if (config.workspaces?.codevis_db) names.push('codevis_db');
    } catch { /* default only */ }
    return names;
}

async function resolveTask(session) {
    const result = await session.run(
        `MATCH (t:Task {assignedTo: $agentId, status: 'in_progress'}) RETURN t.taskId AS taskId LIMIT 2`,
        { agentId },
    );
    return result.records.length === 1 ? result.records[0].get('taskId') : null;
}

// ── Which task each (sub)agent claimed ──────────────────────────────────────

function agentKey(data) {
    const key = data.agent_id ? `agent-${data.agent_id}` : data.session_id ? `session-${data.session_id}` : null;
    return key && key.replace(/[^A-Za-z0-9_.-]/g, '_');
}

function claimsDir(projectDir) { return resolve(projectDir, '.claude/agent-tasks'); }

function readClaim(projectDir, data) {
    const key = agentKey(data);
    if (!key) return null;
    try { return JSON.parse(readFileSync(resolve(claimsDir(projectDir), `${key}.json`), 'utf8')); } catch { return null; }
}

/** The tool result as plain text: MCP results arrive as content blocks or strings. */
function responseText(response) {
    if (typeof response === 'string') return response;
    const blocks = Array.isArray(response) ? response : Array.isArray(response?.content) ? response.content : [response];
    return blocks.map(block => typeof block === 'string' ? block : block?.text ?? JSON.stringify(block ?? '')).join('\n');
}

function trackTaskTool(data, projectDir) {
    const tool = TASK_TOOL.exec(data.tool_name)?.[1];
    const key = agentKey(data);
    if (!tool || !key) return;
    const text = responseText(data.tool_response).replace(/\\"/g, '"');
    const dir = claimsDir(projectDir);
    if (tool === 'complete_task') {
        // Only a completion that happened releases the claims. A refused or
        // failed call (NOT_OWNER, ERROR) used to delete them too, so the
        // agent still working on the task lost its edit attribution. A task
        // completed with warnings (skipped docs) or already done is finished
        // too: keeping its claim credited later edits to a closed task.
        if (!/"status"\s*:\s*"(OK|OK_WITH_WARNINGS|ALREADY_DONE)"/.test(text)) return;
        const taskId = data.tool_input?.taskId;
        for (const name of existsSync(dir) ? readdirSync(dir) : []) {
            try {
                if (JSON.parse(readFileSync(resolve(dir, name), 'utf8')).taskId === taskId) rmSync(resolve(dir, name), { force: true });
            } catch { /* unreadable entry: leave it */ }
        }
        return;
    }
    // Only a successful claim assigns the task; a conflict leaves the agent where it was.
    if (!/"status"\s*:\s*"OK"/.test(text)) return;
    const taskId = data.tool_input?.taskId || /"taskId"\s*:\s*"([^"]+)"/.exec(text)?.[1];
    if (!taskId) return;
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, `${key}.json`), JSON.stringify({
        taskId,
        agentId: data.tool_input?.agentId || agentId || (data.agent_type ? `${data.agent_type}-${data.agent_id}` : null),
        agentType: data.agent_type || null,
        at: Date.now(),
    }) + '\n');
}

async function record(data) {
    const projectDir = process.env.CLAUDE_PROJECT_DIR || process.env.CODEVIS_PROJECT_DIR || process.cwd();
    if (TASK_TOOL.test(data.tool_name || '')) return trackTaskTool(data, projectDir);
    if (!TOOLS.has(data.tool_name) || !data.tool_input?.file_path) return;
    const journal = loadCodevis(projectDir, 'lib/touch-journal.cjs');
    if (!journal) return;

    const absolute = resolve(projectDir, data.tool_input.file_path);
    const file = relative(projectDir, absolute).replace(/\\/g, '/');
    if (file.startsWith('..') || file.startsWith('.claude/') || file.startsWith('.codevis/')) return;
    let content = '';
    try { content = readFileSync(absolute, 'utf8'); } catch { return; }
    const ranges = journal.changedRanges({
        toolName: data.tool_name, toolInput: data.tool_input, toolResponse: data.tool_response || {}, content,
    });
    if (!ranges.length) return;

    const claim = process.env.CODEVIS_TASK_ID ? null : readClaim(projectDir, data);
    // No identity and no explicit task: nothing to attribute, skip the graph.
    if (!agentId && !process.env.CODEVIS_TASK_ID && !claim) return;
    // The graph is only asked WHICH task this is. No TOUCHED edge is written
    // here: the graph still holds pre-edit line numbers, so a field inserted
    // above a function was credited to that function. sync_task/complete_task
    // replay the journal after re-parsing, against current spans.
    let taskId = process.env.CODEVIS_TASK_ID || claim?.taskId || null;
    const ladybug = !taskId && existsSync(resolve(projectDir, 'codevis.config.cjs')) ? loadCodevis(projectDir, 'server/ladybug-driver.cjs') : null;
    for (const db of ladybug ? workspaces(projectDir) : []) {
        const driver = ladybug.workspace(db);
        const session = driver.session();
        try {
            taskId = await resolveTask(session);
            if (taskId) break;
        } catch (error) {
            process.stderr.write(`touch-recorder: ${db} unavailable (${error.message})\n`);
        } finally {
            await session.close();
            await driver.close();
        }
    }
    if (!taskId) return;
    journal.appendJournal(projectDir, {
        taskId, agentId: claim?.agentId || agentId, file, kind: data.tool_name, at: Date.now(),
        sessionId: data.session_id || null, ranges: journal.withSnippets(ranges, content),
    });
}

if (require.main === module) {
    let input = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', chunk => { input += chunk; });
    process.stdin.on('end', async () => {
        const timer = setTimeout(() => process.exit(0), TIMEOUT_MS);
        try { await record(JSON.parse(input)); }
        catch (error) { process.stderr.write(`touch-recorder: ${error.message}\n`); }
        clearTimeout(timer);
        process.exit(0);
    });
}

module.exports = { record };

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
 *   CODEVIS_AGENT_ID / teammate name     → the agent's only in_progress task
 *   neither                              → nothing is recorded
 * An unidentified session (a person, or a lead making a quick fix) is never
 * credited to someone else's running task. Anything ambiguous records
 * nothing: inventing history is worse than a gap.
 *
 * Documentary only. The hook never blocks the edit and prints nothing; any
 * failure just means this edit is not attributed.
 */

const { existsSync, readFileSync } = require('fs');
const { resolve, relative } = require('path');

const TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);
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

async function record(data) {
    if (!TOOLS.has(data.tool_name) || !data.tool_input?.file_path) return;
    const projectDir = process.env.CLAUDE_PROJECT_DIR || process.env.CODEVIS_PROJECT_DIR || process.cwd();
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

    // No identity and no explicit task: nothing to attribute, skip the graph.
    if (!agentId && !process.env.CODEVIS_TASK_ID) return;
    // The graph is only asked WHICH task this is. No TOUCHED edge is written
    // here: the graph still holds pre-edit line numbers, so a field inserted
    // above a function was credited to that function. sync_task/complete_task
    // replay the journal after re-parsing, against current spans.
    let taskId = process.env.CODEVIS_TASK_ID || null;
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
        taskId, agentId, file, kind: data.tool_name, at: Date.now(),
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

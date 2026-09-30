const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const journal = require('../lib/touch-journal.cjs');
const { recordTouchedRanges } = require('../tools/lib/task-context.cjs');
const { openTestDb } = require('./helpers/ladybug-session.cjs');

const HOOK = path.resolve(__dirname, '../templates/hooks/touch-recorder.cjs');

function tempProject(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codevis-touch-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}

test('patch ranges cover added and replaced lines, and pure deletions by their neighbours', () => {
    assert.deepEqual(journal.rangesFromPatch([{ newStart: 10, lines: [' a', '-b', '+c', '+d', ' e'] }]), [{ start: 11, end: 12 }]);
    assert.deepEqual(journal.rangesFromPatch([{ newStart: 5, lines: [' a', '-gone', ' b'] }]), [{ start: 5, end: 6 }]);
    assert.deepEqual(journal.rangesFromPatch([
        { newStart: 1, lines: ['+x'] },
        { newStart: 20, lines: [' a', '+y', '+z'] },
    ]), [{ start: 1, end: 1 }, { start: 21, end: 22 }]);
});

test('without a patch, ranges come from the inserted text or the whole written file', () => {
    const content = 'a\nb\nnew one\nnew two\nc\nnew one\n';
    assert.deepEqual(journal.changedRanges({ toolName: 'Edit', toolInput: { new_string: 'new one\nnew two' }, content }), [{ start: 3, end: 4 }]);
    assert.deepEqual(journal.changedRanges({ toolName: 'Edit', toolInput: { new_string: 'new one', replace_all: true }, content }),
        [{ start: 3, end: 3 }, { start: 6, end: 6 }]);
    assert.deepEqual(journal.changedRanges({ toolName: 'Write', toolInput: {}, content: 'x\ny\n' }), [{ start: 1, end: 2 }]);
});

test('a range is found again after later edits shift it, and falls back to its lines when ambiguous', () => {
    const snippet = 'function renew(loan) {\n  loan.renewCount += 1;\n}';
    const moved = '// header\n// more\n// even more\n' + snippet + '\n';
    assert.deepEqual(journal.relocate({ start: 1, end: 3, snippet }, moved), { start: 4, end: 6 });
    assert.deepEqual(journal.relocate({ start: 7, end: 7, snippet: '}' }, moved), { start: 7, end: 7 });
});

test('journal keeps other tasks when one task is consumed', (t) => {
    const root = tempProject(t);
    journal.appendJournal(root, { taskId: 'a', file: 'x.js', ranges: [] });
    journal.appendJournal(root, { taskId: 'b', file: 'y.js', ranges: [] });
    journal.removeJournalEntries(root, 'a');
    assert.deepEqual(journal.readJournal(root).map(e => e.taskId), ['b']);
    assert.deepEqual(journal.journalFiles(root, 'b'), ['y.js']);
});

test('two tasks editing one file in parallel touch only their own functions', async (t) => {
    const root = tempProject(t);
    const { session, cleanup } = await openTestDb();
    t.after(cleanup);
    const source = [
        'function borrow() {', '  return 1;', '}', '',
        'function giveBack() {', '  return 2;', '}', '',
        'function renew() {', '  return 3;', '}', '',
    ].join('\n');
    fs.writeFileSync(path.join(root, 'circulation.js'), source);
    await session.run(`
        CREATE (:Task {taskId: 'task-a'}) CREATE (:Task {taskId: 'task-b'})
        CREATE (:File {path: 'circulation.js'})
        CREATE (:Function {name: 'borrow', file: 'circulation.js', startLine: 1, endLine: 3})
        CREATE (:Function {name: 'giveBack', file: 'circulation.js', startLine: 5, endLine: 7})
        CREATE (:Function {name: 'renew', file: 'circulation.js', startLine: 9, endLine: 11})`);
    const lines = source.split('\n');
    journal.appendJournal(root, { taskId: 'task-a', file: 'circulation.js', kind: 'Edit', ranges: journal.withSnippets([{ start: 2, end: 2 }], source) });
    journal.appendJournal(root, { taskId: 'task-b', file: 'circulation.js', kind: 'Edit', ranges: journal.withSnippets([{ start: 10, end: 10 }], source) });
    assert.equal(lines[9], '  return 3;');

    for (const taskId of ['task-a', 'task-b']) {
        await journal.applyJournal(root, taskId, (file, ranges, kind) => recordTouchedRanges(session, { taskId, kind, file, ranges }));
    }
    const touched = await session.run(`
        MATCH (t:Task)-[:TOUCHED]->(f:Function) RETURN t.taskId AS taskId, f.name AS name ORDER BY taskId, name`);
    assert.deepEqual(touched.records.map(r => [r.get('taskId'), r.get('name')]), [['task-a', 'borrow'], ['task-b', 'renew']]);
    const files = await session.run(`MATCH (t:Task)-[:TOUCHED]->(:File {path: 'circulation.js'}) RETURN count(t) AS n`);
    assert.equal(Number(files.records[0].get('n')), 2);
});

test('the hook journals an Edit for an explicitly bound task without a graph', async (t) => {
    const root = tempProject(t);
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src/app.js'), 'const a = 1;\nconst b = 2;\n');
    const output = await new Promise((resolve, reject) => {
        const child = execFile(process.execPath, [HOOK], {
            env: { ...process.env, CLAUDE_PROJECT_DIR: root, CODEVIS_TASK_ID: 'task-42', CODEVIS_AGENT_ID: 'worker-x' },
            timeout: 10000,
        }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
        child.stdin.end(JSON.stringify({
            session_id: 's1', tool_name: 'Edit',
            tool_input: { file_path: path.join(root, 'src/app.js'), old_string: 'const b = 1;', new_string: 'const b = 2;' },
            tool_response: { structuredPatch: [{ newStart: 1, lines: [' const a = 1;', '-const b = 1;', '+const b = 2;'] }] },
        }));
    });
    assert.equal(output, '', 'PostToolUse hook stays silent');
    const [entry] = journal.readJournal(root, 'task-42');
    assert.equal(entry.file, 'src/app.js');
    assert.equal(entry.agentId, 'worker-x');
    assert.deepEqual(entry.ranges.map(({ start, end }) => ({ start, end })), [{ start: 2, end: 2 }]);
    assert.equal(entry.ranges[0].snippet, 'const b = 2;');
});

test('an unidentified session is never credited to a running task', async (t) => {
    const root = tempProject(t);
    fs.writeFileSync(path.join(root, 'quick.js'), 'const fix = 1;\n');
    const env = { ...process.env, CLAUDE_PROJECT_DIR: root };
    for (const key of ['CODEVIS_TASK_ID', 'CODEVIS_AGENT_ID', 'CLAUDE_CODE_TEAMMATE_NAME']) delete env[key];
    await new Promise((resolve, reject) => {
        const child = execFile(process.execPath, [HOOK], { env, timeout: 10000 }, error => (error ? reject(error) : resolve()));
        child.stdin.end(JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: path.join(root, 'quick.js'), new_string: 'const fix = 1;' } }));
    });
    assert.deepEqual(journal.readJournal(root), []);
});

test('CRLF files are matched although the tool input uses LF', () => {
    const content = 'a\r\nb\r\nnew one\r\nnew two\r\nc\r\n';
    assert.deepEqual(journal.changedRanges({ toolName: 'Edit', toolInput: { new_string: 'new one\nnew two' }, content }), [{ start: 3, end: 4 }]);
    const [range] = journal.withSnippets([{ start: 3, end: 4 }], content);
    assert.equal(range.snippet, 'new one\nnew two');
    const shifted = 'x\r\ny\r\n' + 'function renewLimit() {\r\n  return true;\r\n}\r\n';
    assert.deepEqual(journal.relocate({ start: 1, end: 2, snippet: 'function renewLimit() {\n  return true;' }, shifted), { start: 3, end: 4 });
});

test('parallel subagents are credited to the task each of them claimed', async (t) => {
    const root = tempProject(t);
    fs.writeFileSync(path.join(root, 'a.js'), 'const a = 1;\n');
    fs.writeFileSync(path.join(root, 'b.js'), 'const b = 1;\n');
    const env = { ...process.env, CLAUDE_PROJECT_DIR: root };
    for (const key of ['CODEVIS_TASK_ID', 'CODEVIS_AGENT_ID', 'CLAUDE_CODE_TEAMMATE_NAME']) delete env[key];
    const hook = (input) => new Promise((resolve, reject) => {
        const child = execFile(process.execPath, [HOOK], { env, timeout: 10000 }, error => (error ? reject(error) : resolve()));
        child.stdin.end(JSON.stringify({ session_id: 'lead', ...input }));
    });
    const claimed = (taskId, agentId) => ({ content: [{ type: 'text', text: JSON.stringify({ status: 'OK', taskId, assignedTo: agentId }) }] });
    // Two subagents of one session claim different tasks; a third one's claim conflicts.
    await hook({ agent_id: 'sa1', agent_type: 'CodeVis Worker', tool_name: 'mcp__codevis_graph__claim_task', tool_input: { taskId: 'task-a', agentId: 'worker-a' }, tool_response: claimed('task-a', 'worker-a') });
    await hook({ agent_id: 'sa2', agent_type: 'CodeVis Worker', tool_name: 'mcp__codevis_worker__get_next_task', tool_input: { agentId: 'worker-b' }, tool_response: claimed('task-b', 'worker-b') });
    await hook({ agent_id: 'sa3', tool_name: 'mcp__codevis_graph__claim_task', tool_input: { taskId: 'task-a', agentId: 'worker-c' }, tool_response: { content: [{ type: 'text', text: '{"status":"CONFLICT"}' }] } });
    await hook({ agent_id: 'sa2', tool_name: 'Edit', tool_input: { file_path: path.join(root, 'b.js'), new_string: 'const b = 1;' } });
    await hook({ agent_id: 'sa1', tool_name: 'Edit', tool_input: { file_path: path.join(root, 'a.js'), new_string: 'const a = 1;' } });
    await hook({ agent_id: 'sa3', tool_name: 'Edit', tool_input: { file_path: path.join(root, 'a.js'), new_string: 'const a = 1;' } });
    // The lead itself never claimed anything: its own edit is not credited to a subagent's task.
    await hook({ tool_name: 'Edit', tool_input: { file_path: path.join(root, 'a.js'), new_string: 'const a = 1;' } });

    const entries = journal.readJournal(root).map(e => ({ taskId: e.taskId, agentId: e.agentId, file: e.file }));
    assert.deepEqual(entries, [
        { taskId: 'task-b', agentId: 'worker-b', file: 'b.js' },
        { taskId: 'task-a', agentId: 'worker-a', file: 'a.js' },
    ]);
    // A refused completion keeps the claim: the agent still works on the task.
    await hook({ agent_id: 'sa9', tool_name: 'mcp__codevis_graph__complete_task', tool_input: { taskId: 'task-a' }, tool_response: '{"status":"NOT_OWNER"}' });
    await hook({ agent_id: 'sa1', tool_name: 'Edit', tool_input: { file_path: path.join(root, 'a.js'), new_string: 'const a = 1;' } });
    assert.equal(journal.readJournal(root).length, 3);
    // Completing a task forgets the claim; later edits by that agent are not credited to it.
    await hook({ agent_id: 'sa1', tool_name: 'mcp__codevis_graph__complete_task', tool_input: { taskId: 'task-a' }, tool_response: '{"status":"OK"}' });
    await hook({ agent_id: 'sa1', tool_name: 'Edit', tool_input: { file_path: path.join(root, 'a.js'), new_string: 'const a = 1;' } });
    assert.equal(journal.readJournal(root).length, 3);
    // Completing with warnings (e.g. skipped docs) finishes the task as well.
    await hook({ agent_id: 'sa2', tool_name: 'mcp__codevis_graph__complete_task', tool_input: { taskId: 'task-b' }, tool_response: { content: [{ type: 'text', text: '{"status":"OK_WITH_WARNINGS","skippedFiles":[]}' }] } });
    await hook({ agent_id: 'sa2', tool_name: 'Edit', tool_input: { file_path: path.join(root, 'b.js'), new_string: 'const b = 1;' } });
    assert.equal(journal.readJournal(root).length, 3, 'no edit is credited to a task completed with warnings');
});

test('journal cleanup does not drop entries appended concurrently by other agents', async () => {
    const { spawn } = require('node:child_process');
    const fsx = require('node:fs'), osx = require('node:os'), pathx = require('node:path');
    const journal = require('../lib/touch-journal.cjs');
    const dir = fsx.mkdtempSync(pathx.join(osx.tmpdir(), 'codevis-journal-race-'));
    const lib = require.resolve('../lib/touch-journal.cjs');
    const PER_WRITER = 150;
    try {
        const writers = [1, 2, 3].map(n => new Promise((done, fail) => {
            const child = spawn(process.execPath, ['-e', `
                const j = require(${JSON.stringify(lib)});
                for (let i = 0; i < ${PER_WRITER}; i++) j.appendJournal(${JSON.stringify(dir)}, { taskId: 'keep-${n}', file: 'a.js', i });
            `], { stdio: 'inherit' });
            child.on('exit', code => code === 0 ? done() : fail(new Error(`writer exited ${code}`)));
        }));
        let running = true;
        Promise.all(writers).finally(() => { running = false; });
        while (running) {
            journal.appendJournal(dir, { taskId: 'drop', file: 'a.js' });
            journal.removeJournalEntries(dir, 'drop');
            await new Promise(r => setImmediate(r));
        }
        await Promise.all(writers);
        const kept = journal.readJournal(dir).filter(e => String(e.taskId).startsWith('keep-'));
        assert.equal(kept.length, 3 * PER_WRITER);
    } finally {
        fsx.rmSync(dir, { recursive: true, force: true });
    }
});

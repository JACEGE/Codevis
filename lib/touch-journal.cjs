'use strict';
/**
 * Attribution of raw file edits (Claude Code's Edit/Write/MultiEdit) to the
 * Task they were made for.
 *
 * The MCP edit tools already record Task-[:TOUCHED]->Function. Edits made with
 * the client's own tools bypass them, and a git diff cannot separate the work
 * of several agents in one checkout. The PostToolUse hook
 * (templates/hooks/touch-recorder.cjs) therefore records, per edit, which
 * lines changed and for which task, in .claude/touch-journal.jsonl.
 * complete_task/sync_task replay the journal after re-parsing the files, so
 * TOUCHED edges land on the functions as they are now, including functions
 * that did not exist in the graph when the edit happened.
 */
const fs = require('node:fs');
const path = require('node:path');

const JOURNAL = '.claude/touch-journal.jsonl';
const MAX_SNIPPET = 2000;
const MIN_SNIPPET = 24;

function lineOf(content, index) {
    let line = 1;
    for (let i = 0; i < index; i++) if (content.charCodeAt(i) === 10) line++;
    return line;
}

// CRLF files: the tool input uses \n, the file on disk \r\n. Line numbers
// are the same either way, so compare with \n only.
const lf = (text) => String(text ?? '').replace(/\r\n/g, '\n');

function countLines(text) {
    if (!text) return 0;
    return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

/** Changed line ranges in the NEW file from a unified-diff style structuredPatch. */
function rangesFromPatch(hunks) {
    const lines = new Set();
    for (const hunk of hunks || []) {
        let current = Number(hunk.newStart) || 1;
        let deleted = false;
        // A pure deletion leaves no new line behind: attribute the lines it
        // collapsed between, so the enclosing function is still found.
        const closeDeletion = () => { if (deleted) { lines.add(Math.max(1, current - 1)); lines.add(current); } deleted = false; };
        for (const line of hunk.lines || []) {
            if (line.startsWith('+')) { lines.add(current); current++; deleted = false; }
            else if (line.startsWith('-')) deleted = true;
            else { closeDeletion(); current++; }
        }
        closeDeletion();
    }
    const sorted = [...lines].sort((a, b) => a - b);
    const ranges = [];
    for (const line of sorted) {
        const last = ranges.at(-1);
        if (last && line <= last.end + 1) last.end = Math.max(last.end, line);
        else ranges.push({ start: line, end: line });
    }
    return ranges;
}

function rangesOfText(content, text, all) {
    if (!text) return [];
    const ranges = [];
    for (let index = content.indexOf(text); index >= 0; index = all ? content.indexOf(text, index + text.length) : -1) {
        const start = lineOf(content, index);
        ranges.push({ start, end: start + Math.max(1, countLines(text)) - 1 });
        if (!all) break;
    }
    return ranges;
}

/**
 * Which lines of `content` (the file after the edit) the tool call changed.
 * Prefers the structuredPatch Claude Code reports; falls back to locating the
 * inserted text, and for a whole-file Write to the whole file.
 */
function changedRanges({ toolName, toolInput = {}, toolResponse = {}, content: raw = '' }) {
    const content = lf(raw);
    const patch = toolResponse.structuredPatch;
    if (Array.isArray(patch) && patch.length) return rangesFromPatch(patch);
    if (toolName === 'Edit') return rangesOfText(content, lf(toolInput.new_string), toolInput.replace_all === true);
    if (toolName === 'MultiEdit') return (toolInput.edits || []).flatMap(edit => rangesOfText(content, lf(edit.new_string), edit.replace_all === true));
    if (toolName === 'Write') return content ? [{ start: 1, end: Math.max(1, countLines(content)) }] : [];
    return [];
}

/** The text of each range, kept so the range can be found again after later edits shift it. */
function withSnippets(ranges, content) {
    const lines = lf(content).split('\n');
    return ranges.map(range => ({ ...range, snippet: lines.slice(range.start - 1, range.end).join('\n').slice(0, MAX_SNIPPET) }));
}

/** Current position of a recorded range: its snippet if that is distinctive and unique, else the recorded lines. */
function relocate(range, raw) {
    const content = lf(raw);
    const snippet = lf(range.snippet);
    if (snippet.trim().length >= MIN_SNIPPET) {
        const first = content.indexOf(snippet);
        if (first >= 0 && content.indexOf(snippet, first + 1) < 0) {
            const start = lineOf(content, first);
            return { start, end: start + Math.max(1, countLines(snippet)) - 1 };
        }
    }
    return { start: range.start, end: range.end };
}

function journalPath(projectDir) { return path.join(projectDir, JOURNAL); }

function appendJournal(projectDir, entry) {
    const file = journalPath(projectDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(entry) + '\n');
}

function readJournal(projectDir, taskId) {
    let text;
    try { text = fs.readFileSync(journalPath(projectDir), 'utf8'); } catch { return []; }
    const entries = [];
    for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try { const entry = JSON.parse(line); if (taskId == null || entry.taskId === taskId) entries.push(entry); } catch { /* torn line */ }
    }
    return entries;
}

/** Drop a task's entries once they are applied; other tasks' entries stay. */
function removeJournalEntries(projectDir, taskId) {
    const file = journalPath(projectDir);
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
    const keep = text.split('\n').filter(line => {
        if (!line.trim()) return false;
        try { return JSON.parse(line).taskId !== taskId; } catch { return false; }
    });
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, keep.length ? keep.join('\n') + '\n' : '');
    fs.renameSync(tmp, file);
}

/**
 * Replay a task's journal: relocate every range in the current file and
 * record TOUCHED on the File and every Function/Class/Component it overlaps.
 * `recordRanges(file, ranges, kind)` does the graph write (task-context.cjs).
 */
async function applyJournal(projectDir, taskId, recordRanges) {
    const entries = readJournal(projectDir, taskId);
    let touched = 0;
    for (const entry of entries) {
        let content = null;
        try { content = fs.readFileSync(path.resolve(projectDir, entry.file), 'utf8'); } catch { continue; }
        const ranges = (entry.ranges || []).map(range => relocate(range, content));
        touched += await recordRanges(entry.file, ranges, entry.kind || 'Edit');
    }
    return { entries: entries.length, touched };
}

function journalFiles(projectDir, taskId) {
    return [...new Set(readJournal(projectDir, taskId).map(entry => entry.file))];
}

module.exports = {
    JOURNAL, changedRanges, rangesFromPatch, withSnippets, relocate,
    appendJournal, readJournal, removeJournalEntries, applyJournal, journalFiles,
};

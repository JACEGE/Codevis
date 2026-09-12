#!/usr/bin/env node
/**
 * CodeVis Lock Guard — PreToolUse Hook (CommonJS, including in ESM projects)
 * (v4: role-aware, no absence-bypass, live graph check)
 *
 * Queries the embedded graph DB directly for lock status — no stale manifest,
 * deterministic. Falls back to the .claude/locks.json manifest, which the MCP
 * layer rewrites on every lock/unlock (syncLockManifest in
 * tools/lib/graph-sync.ts), if the DB is unreachable; that fallback carries no
 * line ranges, so overlap detection degrades to brace counting.
 *
 * Identity resolution, most explicit first:
 *   CODEVIS_AGENT_ID=<id>       → that agent
 *   CLAUDE_CODE_TEAMMATE_NAME   → worker-<name>
 *   nothing                     → unidentified: owns nothing, so every lock is
 *                                 foreign and blocks
 *
 * v3 returned allow() outright when no agent id was set, so the guard was
 * disabled by the *absence* of a variable rather than by any decision — and a
 * lead could silently overwrite a function a worker was midway through. Holding
 * no identity now means holding no locks. To get through a lock you do not own,
 * use force_unlock: it is deliberate, and it leaves a trace.
 */

const { readFileSync, existsSync } = require('fs');
const { resolve, relative } = require('path');

const agentId = process.env.CODEVIS_AGENT_ID
    || (process.env.CLAUDE_CODE_TEAMMATE_NAME ? `worker-${process.env.CLAUDE_CODE_TEAMMATE_NAME}` : null);

let input = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', async () => {
    try {
        const data = JSON.parse(input);
        const toolName = data.tool_name;
        const toolInput = data.tool_input || {};
        const filePath = toolInput.file_path;

        if (!filePath || !['Edit', 'Write'].includes(toolName)) {
            allow();
            return;
        }

        const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
        if (!isLockingEnabled(projectDir)) {
            allow();
            return;
        }
        // Graph paths are ALWAYS forward slashes — path.relative() emits
        // backslashes on Windows, and an un-normalized path matches zero
        // locks (silently bypassing this guard).
        const relPath = relative(projectDir, resolve(projectDir, filePath)).replace(/\\/g, '/');

        // Try the live DB check first, fall back to manifest
        const locks = await getLocksForFile(relPath, projectDir);

        // null means the lock state could not be read at all. Unknown is not
        // the same as empty — refuse rather than wave the edit through.
        if (locks === null) {
            deny(`lock-guard: lock state for '${relPath}' is unreadable — blocking for safety.`);
            return;
        }
        if (locks.length === 0) {
            deny(`Scope required: claim '${relPath}' with claim_task or expand_task_scope before editing.`);
            return;
        }

        // An unidentified caller owns nothing, so every lock here is foreign.
        const foreignLocks = locks.filter(l => l.lockedBy !== agentId);

        // Write replaces the whole file, so it desyncs the graph even for locks
        // we hold ourselves — always refuse and point at the AST-safe path.
        if (toolName === 'Write') {
            if (foreignLocks.length === 0 && !existsSync(resolve(projectDir, filePath))) {
                allow();
                return;
            }
            deny(`BLOCKED: File '${relPath}' has locked functions: ${locks.map(l => `'${l.name}' (${l.lockedBy})`).join(', ')}. Use edit_code_patch or rewrite_function instead.`);
            return;
        }

        const oldString = toolInput.old_string || '';

        // A raw Edit on a locked function desyncs the graph even when we hold
        // the lock ourselves — the AST path is what keeps node ranges correct.
        // So own locks block too; only the remedy differs.
        for (const lock of locks) {
            // File and ASTNode nodes land in the manifest with name: null. Left
            // in, `oldString.includes(null)` coerces to the substring "null" and
            // blocks any edit that happens to contain that word. They are
            // handled as file-level reservations below instead.
            if (!lock.name) continue;
            if (oldString.includes(lock.name) || oldString.includes(`function ${lock.name}`)) {
                deny(lock.lockedBy === agentId
                    ? `BLOCKED: Edit touches '${lock.name}', which you hold the lock on. Use edit_code_patch or rewrite_function so the graph stays in sync.`
                    : `BLOCKED: Edit touches '${lock.name}' (locked by '${lock.lockedBy}'${agentId ? `, not '${agentId}'` : '; you hold no lock'}). Use edit_code_patch or rewrite_function, or force_unlock if you must take it over.`);
                return;
            }
        }

        // A nameless foreign lock is a File-level reservation: someone holds the
        // whole file, and there is no line range to be surgical about.
        const fileLevel = foreignLocks.find(l => !l.name);
        if (fileLevel) {
            deny(`BLOCKED: '${relPath}' is reserved at file level by '${fileLevel.lockedBy}'${agentId ? `, not '${agentId}'` : '; you hold no lock'}. Use edit_code_patch or rewrite_function, or force_unlock if you must take it over.`);
            return;
        }

        if (foreignLocks.length === 0) {
            // Only our own locks in this file, and the edit does not name any of
            // them. Allowed — but graph-aware edit tools keep the graph in sync.
            warn(`lock-guard: editing '${relPath}' where '${agentId}' holds ${locks.length} lock(s) — prefer edit_code_patch or rewrite_function.`);
            allow();
            return;
        }

        // Slow path: check if edit overlaps with a foreign-locked function's line range
        try {
            const fileContent = readFileSync(resolve(projectDir, filePath), 'utf-8');
            const editIdx = fileContent.indexOf(oldString);
            if (editIdx === -1) {
                allow(); // Can't find old_string — Edit tool will error anyway
                return;
            }

            const editLine = fileContent.slice(0, editIdx).split('\n').length;
            const editEndLine = editLine + oldString.split('\n').length - 1;

            // Check against foreign locks that have line ranges from the graph
            for (const lock of foreignLocks) {
                if (lock.startLine && lock.endLine) {
                    if (editLine <= lock.endLine && editEndLine >= lock.startLine) {
                        deny(`BLOCKED: Edit at lines ${editLine}-${editEndLine} overlaps '${lock.name}' (lines ${lock.startLine}-${lock.endLine}), locked by '${lock.lockedBy}'.`);
                        return;
                    }
                }
            }

            // If no line-range data (fallback), use brace-counting as last resort
            if (foreignLocks.some(l => !l.startLine)) {
                const rangeBlock = checkBraceOverlap(fileContent, foreignLocks, editLine, editEndLine);
                if (rangeBlock) {
                    deny(rangeBlock);
                    return;
                }
            }
        } catch {
            deny('lock-guard: file read failed — blocking for safety.');
            return;
        }

        allow();
    } catch (err) {
        process.stderr.write(`lock-guard error: ${err.message}\n`);
        deny('lock-guard internal error — blocking for safety.');
    }
});

// ── Live DB query (primary) + manifest fallback ──────────────
//
// Returns [] for "no locks here" and null for "could not determine", which the
// caller must not conflate.

// Resolve the embedded-DB compat client. This used to be a hard
// `require('neo4j-driver')`, which threw on every invocation once the Neo4j
// opt-in was dropped — the "live, deterministic" path below never ran and the
// guard silently degraded to the manifest on every single edit.
function loadGraphDriver(projectDir) {
    const candidates = [
        resolve(projectDir, 'server/ladybug-driver.cjs'),
        'codevis/server/ladybug-driver.cjs',
    ];
    for (const candidate of candidates) {
        try { return require(candidate); } catch { /* try next */ }
    }
    return null;
}

function isLockingEnabled(projectDir) {
    const override = String(process.env.CODEVIS_LOCKING || '').trim().toLowerCase();
    if (['1', 'true', 'yes', 'on', 'enabled'].includes(override)) return true;
    if (['0', 'false', 'no', 'off', 'disabled'].includes(override)) return false;
    try {
        const configPath = resolve(projectDir, 'codevis.config.cjs');
        return existsSync(configPath) && require(configPath)?.locking?.enabled === true;
    } catch {
        return false;
    }
}

async function getLocksForFile(relPath, projectDir) {
    // Try the live DB first — deterministic, always fresh.
    // CODEVIS_LOCK_SOURCE=manifest skips it: needed where no daemon may be
    // started (tests, sandboxes), and it makes the fallback path testable
    // without relying on the live query being broken.
    try {
        const configPath = resolve(projectDir, 'codevis.config.cjs');
        if (process.env.CODEVIS_LOCK_SOURCE !== 'manifest' && existsSync(configPath)) {
            const config = require(configPath);
            const ws = config.workspaces?.meta;
            const ladybug = ws ? loadGraphDriver(projectDir) : null;
            if (ladybug) {
                const driver = ladybug.driver((ws.dbUri || ws.neo4jUri), ladybug.auth.basic(ws.auth.user, ws.auth.pass));
                const session = driver.session();
                try {
                    // Expired locks must not block: lock_subgraph sets a TTL and
                    // nothing rewrites the node when it lapses, so filtering has
                    // to happen at read time.
                    const result = await session.run(
                        `MATCH (f) WHERE (f:Function OR f:TaskScope)
                           AND (f.file = $file OR f.file = $scopeFile) AND f.locked = true
                           AND (f.lockExpires IS NULL OR f.lockExpires > $now)
                         RETURN CASE WHEN f:TaskScope THEN null ELSE f.name END AS name,
                                f.lockedBy AS lockedBy, f.lockGroup AS lockGroup,
                                f.startLine AS startLine, f.endLine AS endLine`,
                        { file: relPath, scopeFile: process.platform === 'win32' ? relPath.toLowerCase() : relPath, now: Date.now() }
                    );
                    return result.records.map(r => ({
                        name: r.get('name'),
                        lockedBy: r.get('lockedBy'),
                        lockGroup: r.get('lockGroup'),
                        startLine: toNum(r.get('startLine')),
                        endLine: toNum(r.get('endLine')),
                    }));
                } finally {
                    await session.close();
                    await driver.close();
                }
            }
        }
    } catch (err) {
        process.stderr.write(`lock-guard: graph DB unavailable (${err.message}), falling back to manifest\n`);
    }

    // Fallback: read locks.json manifest
    const manifestPath = resolve(projectDir, '.claude/locks.json');
    if (!existsSync(manifestPath)) return [];
    let parsed;
    try {
        parsed = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    } catch (err) {
        warn(`lock-guard: ${manifestPath} is unreadable (${err.message})`);
        return null;
    }
    const entries = parsed[relPath] || (process.platform === 'win32' ? parsed[relPath.toLowerCase()] : undefined);
    if (!Array.isArray(entries)) return [];
    return entries.filter(e => e.lockExpires == null || Number(e.lockExpires) > Date.now()).map(e => ({
        name: e.name,
        lockedBy: e.lockedBy,
        lockGroup: e.lockGroup,
        startLine: toNum(e.startLine),
        endLine: toNum(e.endLine),
    }));
}

function toNum(val) {
    if (val == null) return null;
    if (typeof val.toNumber === 'function') return val.toNumber();
    if (typeof val === 'number') return val;
    const n = Number(val);
    return Number.isFinite(n) ? n : null;
}

function warn(message) {
    process.stderr.write(`${message}\n`);
}

// ── Brace-counting fallback for line-range overlap detection ────

function checkBraceOverlap(fileContent, foreignLocks, editLine, editEndLine) {
    const lines = fileContent.split('\n');
    const funcNameSet = new Set(foreignLocks.filter(l => !l.startLine).map(l => l.name));
    let currentFunc = null;
    let braceDepth = 0;
    let funcStart = 0;
    let inStr = false, strCh = '', inBC = false, templateDepth = 0;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        const funcMatch = line.match(/(?:async\s+)?(?:function\s+|const\s+|let\s+|var\s+)(\w+)\s*[=(]/);
        const methodMatch = line.match(/^\s*(?:async\s+)?(\w+)\s*\(/);
        const detectedName = funcMatch?.[1] || methodMatch?.[1];

        if (detectedName && funcNameSet.has(detectedName) && !currentFunc) {
            currentFunc = detectedName;
            funcStart = i;
            braceDepth = 0;
        }

        if (currentFunc) {
            let inLC = false;
            for (let j = 0; j < line.length; j++) {
                const ch = line[j], nx = line[j + 1];
                if (inLC) continue;
                if (inBC) { if (ch === '*' && nx === '/') { inBC = false; j++; } continue; }
                if (inStr) {
                    if (ch === '\\') { j++; continue; }
                    if (strCh === '`' && ch === '$' && nx === '{') { templateDepth++; inStr = false; j++; continue; }
                    if (ch === strCh) inStr = false;
                    continue;
                }
                if (templateDepth > 0 && ch === '}') { templateDepth--; inStr = true; strCh = '`'; continue; }
                if (ch === '/' && nx === '/') { inLC = true; continue; }
                if (ch === '/' && nx === '*') { inBC = true; j++; continue; }
                if (ch === '"' || ch === "'" || ch === '`') { inStr = true; strCh = ch; continue; }
                if (ch === '{') braceDepth++;
                if (ch === '}') braceDepth--;
            }
            if (braceDepth <= 0 && i > funcStart) {
                const funcEnd = i + 1;
                if (editLine <= funcEnd && editEndLine >= funcStart) {
                    const lock = foreignLocks.find(l => l.name === currentFunc);
                    return `BLOCKED: Edit at lines ${editLine}-${editEndLine} overlaps '${currentFunc}' (lines ${funcStart}-${funcEnd}), locked by '${lock?.lockedBy}'.`;
                }
                currentFunc = null;
                inStr = false; strCh = ''; inBC = false; templateDepth = 0;
            }
        }
    }
    return null;
}

function allow() {
    console.log(JSON.stringify({
        hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" }
    }));
    process.exit(0);
}

function deny(reason) {
    console.log(JSON.stringify({
        hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason }
    }));
    process.exit(0);
}

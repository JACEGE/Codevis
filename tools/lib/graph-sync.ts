import { readFileSync, writeFileSync, renameSync, statSync, existsSync } from "fs";
import { randomUUID } from "crypto";
import { resolve } from "path";
import { getLanguageAndQuery, getParserInstance, EDIT_LANG_CONFIGS } from "./treesitter.js";
import { graphInt } from "./graph.js";
import { createRequire } from "node:module";
import { projectRoot } from "./project-root.js";
const { getSyncFiles } = createRequire(import.meta.url)('./task-context.cjs');
const { syncGraphFile } = createRequire(import.meta.url)('../../server/graph-file-sync.cjs');


// ── Lock manifest: write locks.json for fast hook lookups ─────────
export async function syncLockManifest(driver: any) {
    try {
        const session = driver.session();
        try {
            const result = await session.run(
                `MATCH (f) WHERE f.locked = true
                 RETURN CASE WHEN f:TaskScope THEN null ELSE f.name END AS name,
                        f.file AS file, f.lockedBy AS lockedBy, f.lockGroup AS lockGroup, f.lockExpires AS lockExpires`
            );
            const now = Date.now();
            const locks: Record<string, Array<{ name: string; lockedBy: string; lockGroup: string; lockExpires: number | null }>> = {};
            for (const r of result.records) {
                const file = r.get("file");
                if (!file) continue;
                // Filter out expired locks
                const lockExpires = r.get("lockExpires");
                const expires = lockExpires != null ? graphInt(lockExpires) : null;
                if (expires && expires < now) continue; // Skip expired locks
                if (!locks[file]) locks[file] = [];
                locks[file].push({
                    name: r.get("name"),
                    lockedBy: r.get("lockedBy"),
                    lockGroup: r.get("lockGroup"),
                    lockExpires: expires,
                });
            }
            // Navigate to project root for lock manifest
            const projectDir = projectRoot();
            const manifestPath = resolve(projectDir, ".claude/locks.json");
            const tmpManifest = manifestPath + `.${randomUUID()}.tmp`;
            writeFileSync(tmpManifest, JSON.stringify(locks, null, 2));
            renameSync(tmpManifest, manifestPath);
        } finally {
            await session.close();
        }
    } catch (err: any) {
        process.stderr.write(`[syncLockManifest] Failed to sync locks.json: ${err?.message || err}\n`);
    }
}

// ── Incremental graph sync: re-parse a single file after edits ──────
function extractSyncFunctions(content: string, lang: any, funcQuery: any) {
    const parser = getParserInstance();
    parser.setLanguage(lang);
    const tree = parser.parse(content);
    if (tree.rootNode.hasError) return null;
    const functions: Array<{ name: string; startLine: number; endLine: number; snippet: string }> = [];
    const seen = new Set<number>();
    for (const match of funcQuery.matches(tree.rootNode)) {
        const capture = match.captures.find((c: any) => c.name === 'func_name');
        if (!capture || seen.has(capture.node.startIndex)) continue;
        seen.add(capture.node.startIndex);
        let node = capture.node.parent;
        if (node?.type === 'variable_declarator') node = node.parent;
        if (!node) continue;
        functions.push({ name: capture.node.text, startLine: node.startPosition.row + 1,
            endLine: node.endPosition.row + 1, snippet: (node.text || '').slice(0, 200) });
    }
    return functions;
}

const CALL_KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'new', 'throw',
    'await', 'function', 'class', 'const', 'let', 'var', 'console', 'require', 'import']);

async function prepareFileSync(absolutePath: string, relFile: string, ext: string, taskId?: string) {
    const { lang, funcQuery } = await getLanguageAndQuery(ext);
    const mtime = statSync(absolutePath).mtimeMs;
    const content = readFileSync(absolutePath, 'utf8');
    if (statSync(absolutePath).mtimeMs !== mtime) throw syncError('File changed while preparing graph synchronization', 'FILE_CHANGED');
    const functions = extractSyncFunctions(content, lang, funcQuery);
    if (!functions) throw syncError('Cannot synchronize source with syntax errors', 'SYNTAX_ERROR');
    const lines = content.split('\n');
    return { file:relFile, mtime, mode:taskId === undefined ? 'sync' : 'commit', taskId,
        functions:functions.map(fn => {
            const calls = new Set<string>();
            const pattern = /\b([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/g;
            const body = lines.slice(fn.startLine - 1, fn.endLine).join('\n');
            let match;
            while ((match = pattern.exec(body)) !== null) {
                if (match[1] !== fn.name && !CALL_KEYWORDS.has(match[1])) calls.add(match[1]);
            }
            return { ...fn, calls:[...calls] };
        }),
    };
}

async function publishFileSync(snapshot: any, driver: any) {
    const session = driver.session();
    try {
        // Real clients send one request. In-process embedders use the same
        // transaction implementation; there is no non-atomic fallback.
        return typeof session.syncGraphFileAtomic === 'function'
            ? await session.syncGraphFileAtomic(snapshot) : await syncGraphFile(session, snapshot);
    } finally { await session.close(); }
}

function syncError(message: string, code: string) {
    const error: any = new Error(message);
    error.code = code;
    return error;
}

/**
 * Structured outcome of synchronizing one file into the graph.
 * - ok: the file was parsed and published.
 * - skipped: the file cannot be synchronized by design (unsupported language,
 *   deleted file). This is not an error: nothing is wrong with the task.
 * - otherwise a real failure; `code` is 'SYNTAX_ERROR' for unparsable source.
 */
// Flat shape (not a discriminated union): the project compiles without
// strictNullChecks, where union narrowing on `ok` does not apply.
export type FileSyncOutcome = {
    ok: boolean;
    result?: any;
    skipped?: boolean;
    /** 'UNSUPPORTED_EXTENSION' | 'FILE_MISSING' when skipped; 'SYNTAX_ERROR' or another failure code otherwise. */
    code?: string;
    reason?: string;
};

const FILE_SYNC_ATTEMPTS = 3;
const missingFile = (): FileSyncOutcome =>
    ({ ok: false, skipped: true, code: 'FILE_MISSING', reason: 'File no longer exists on disk; skipped.' });

async function runFileSync(absolutePath: string, relFile: string, ext: string, driver: any, taskId?: string): Promise<FileSyncOutcome> {
    if (!Object.prototype.hasOwnProperty.call(EDIT_LANG_CONFIGS, ext)) {
        return { ok: false, skipped: true, code: 'UNSUPPORTED_EXTENSION',
            reason: `Graph sync does not support '${ext || '(no extension)'}' files; skipped.` };
    }
    let lastError: any = null;
    for (let attempt = 1; attempt <= FILE_SYNC_ATTEMPTS; attempt++) {
        if (!existsSync(absolutePath)) return missingFile();
        try {
            return { ok: true, result: await publishFileSync(await prepareFileSync(absolutePath, relFile, ext, taskId), driver) };
        } catch (error: any) {
            lastError = error;
            // A concurrent writer changed or replaced the file between reads:
            // retry with the new content. Every other failure is deterministic.
            if (error?.code === 'FILE_CHANGED' || error?.code === 'ENOENT') continue;
            break;
        }
    }
    if (lastError?.code === 'ENOENT') return missingFile();
    const reason = String(lastError?.message || lastError);
    process.stderr.write(`[file-sync] ${relFile}: ${reason}\n`);
    return { ok: false, code: lastError?.code || 'SYNC_ERROR', reason };
}

/** Synchronize one file and report why it was skipped or failed. */
export function syncFileToGraphDetailed(absolutePath: string, relFile: string, ext: string, driver: any) {
    return runFileSync(absolutePath, relFile, ext, driver);
}

/** Commit-synchronize one file for a task and report why it was skipped or failed. */
export function commitSyncFileDetailed(absolutePath: string, relFile: string, ext: string, driver: any, taskId: string) {
    return runFileSync(absolutePath, relFile, ext, driver, taskId);
}

/** Compatibility wrapper: the publish result, or null when the file was not synchronized. */
export async function syncFileToGraph(absolutePath: string, relFile: string, ext: string, driver: any) {
    const outcome = await syncFileToGraphDetailed(absolutePath, relFile, ext, driver);
    return outcome.ok ? outcome.result : null;
}


// ── External-change detection: compare disk mtime vs last-seen mtime in graph ──
// Returns { changed: false } if the file matches the graph's last-seen mtime.
// Returns { changed: true, resynced: true } after auto-resync on mismatch.
// Returns { changed: true, resynced: false, error } if resync failed.
// Returns { changed: true, functionMissing: true } if after resync the requested
// functionName no longer exists on disk (user renamed/deleted it).
export async function checkAndResyncIfChanged(
    absolutePath: string,
    relFile: string,
    ext: string,
    driver: any,
    functionName?: string
): Promise<{
    changed: boolean;
    resynced?: boolean;
    functionMissing?: boolean;
    error?: string;
}> {
    // ── 1. Read current mtime from disk ──────────────────────────────
    let currentMtime: number;
    try {
        currentMtime = statSync(absolutePath).mtimeMs;
    } catch (err: any) {
        // File doesn't exist — treat as changed/missing
        return { changed: true, resynced: false, error: `Cannot stat file: ${err.message}` };
    }

    // ── 2. Read lastSeenMtime from graph ─────────────────────────────
    const session = driver.session();
    let lastSeenMtime: number | null = null;
    try {
        const result = await session.run(
            `MATCH (f:File {path: $file}) RETURN f.lastSeenMtime AS mtime`,
            { file: relFile }
        );
        if (result.records.length > 0) {
            const raw = result.records[0].get("mtime");
            lastSeenMtime = raw != null ? Number(raw) : null;
        }
    } finally {
        await session.close();
    }

    // The schema stores integer milliseconds; tolerate only that precision loss.
    // A timestamp can move backwards after a checkout or file restoration.
    if (lastSeenMtime !== null && Math.abs(currentMtime - lastSeenMtime) < 1) {
        return { changed: false };
    }

    // ── 4. External change detected — log and resync ──────────────────
    const t1 = lastSeenMtime ?? 0;
    const t2 = currentMtime;
    process.stderr.write(
        `[external-change] File ${relFile}: mtime changed from ${t1} to ${t2}, auto-resync triggered\n`
    );

    try {
        const syncResult = await syncFileToGraph(absolutePath, relFile, ext, driver);
        if (!syncResult) {
            return { changed: true, resynced: false, error: "syncFileToGraph returned null" };
        }

        // ── 5. If a specific function was requested, verify it still exists ──
        if (functionName) {
            const checkSession = driver.session();
            try {
                const fnResult = await checkSession.run(
                    `MATCH (n:Function {name: $name, file: $file}) WHERE NOT coalesce(n.removedFromDisk, false) RETURN n.name AS name LIMIT 1`,
                    { name: functionName, file: relFile }
                );
                if (fnResult.records.length === 0) {
                    process.stderr.write(
                        `[external-change] FILE_CHANGED_EXTERNALLY: Function '${functionName}' no longer exists in '${relFile}' after resync.\n`
                    );
                    return { changed: true, resynced: true, functionMissing: true };
                }
            } finally {
                await checkSession.close();
            }
        }

        return { changed: true, resynced: true };
    } catch (err: any) {
        return { changed: true, resynced: false, error: err.message };
    }
}


// ── Two-Tier Graph Sync ───────────────────────────────────────────────────────
// Live-Sync: <50ms. Only updates startLine/endLine/bodySnippet. No structural
// changes — no new nodes, no tombstones, no IPv6 recomputation.
// Called after every edit_code_patch / rewrite_function.

export async function liveSyncFile(
    absolutePath: string,
    relFile: string,
    ext: string,
    driver: any
): Promise<{ updatedCount: number; durationMs: number } | null> {
    const t0 = Date.now();
    try {
        const { lang, funcQuery } = await getLanguageAndQuery(ext);
        const content = readFileSync(absolutePath, "utf-8");
        const diskFuncs = extractSyncFunctions(content, lang, funcQuery);
        if (!diskFuncs) return null;

        if (diskFuncs.length === 0) return { updatedCount: 0, durationMs: Date.now() - t0 };

        const session = driver.session();
        try {
            // Only update metadata for EXISTING nodes — no create, no tombstone
            await session.run(
                `UNWIND $funcs AS f
                 MATCH (n:Function {name: f.name, file: $file})
                 WHERE NOT coalesce(n.removedFromDisk, false)
                 SET n.startLine = f.startLine, n.endLine = f.endLine, n.bodySnippet = f.snippet`,
                { funcs: diskFuncs, file: relFile }
            );
            const durationMs = Date.now() - t0;
            process.stderr.write(
                `[live-sync] File ${relFile}: updated ${diskFuncs.length} functions in ${durationMs}ms\n`
            );
            return { updatedCount: diskFuncs.length, durationMs };
        } finally {
            await session.close();
        }
    } catch (err: any) {
        process.stderr.write(`[live-sync] Error for ${relFile}: ${err?.message || err}\n`);
        return null;
    }
}

// ── Commit-Sync ───────────────────────────────────────────────────────────────
// The daemon owns one transaction and serializes publication across clients.
// - Creates new Function nodes with CREATED edge to the task
// - Tombstones removed nodes with REMOVED edge to the task
// - Resyncs CALLS edges
// - Updates lastSeenMtime

export async function commitSyncFile(
    absolutePath: string, relFile: string, ext: string, driver: any, taskId: string
): Promise<{ created: string[]; removed: string[]; updated: number; callsResynced: number; durationMs: number } | null> {
    const start = Date.now();
    const outcome = await commitSyncFileDetailed(absolutePath, relFile, ext, driver, taskId);
    return outcome.ok ? { ...outcome.result, durationMs:Date.now() - start } : null;
}

// ── Commit-Sync for a full Wave ───────────────────────────────────────────────
// Iterates over all files touched by tasks in the wave and runs commitSyncFile
// for each. Sets wave.waveStatus to 'committed' on success.

export async function commitSyncWave(
    waveId: number,
    driver: any
): Promise<{
    status: "OK" | "PARTIAL_FAIL";
    filesProcessed: number;
    created: number;
    removed: number;
    failedFiles: string[];
    skippedFiles: Array<{ file: string; reason: string }>;
    durationMs: number;
}> {
    const t0 = Date.now();
    const session = driver.session();
    let touchedFiles: Array<{ file: string; taskId: string }> = [];
    const projectDir = projectRoot();

    try {
        // Collect all files touched by tasks in this wave
        touchedFiles = await getSyncFiles(session, { waveId, projectRoot: projectDir });
    } finally {
        await session.close();
    }

    if (touchedFiles.length === 0) {
        process.stderr.write(`[wave] Wave ${waveId}: no touched files found\n`);
    }

    // Deduplicate files (use most recent taskId per file)
    const fileMap = new Map<string, string>();
    for (const { file, taskId } of touchedFiles) {
        if (!fileMap.has(file)) fileMap.set(file, taskId);
    }

    process.stderr.write(
        `[wave] Wave ${waveId} committing, files=[${[...fileMap.keys()].join(", ")}]\n`
    );

    const { resolve: pathResolve, extname } = await import("path");
    let totalCreated = 0;
    let totalRemoved = 0;
    const failedFiles: string[] = [];
    const skippedFiles: Array<{ file: string; reason: string }> = [];

    for (const [file, taskId] of fileMap.entries()) {
        const absolutePath = pathResolve(projectDir, file);
        const ext = extname(file);
        try {
            const outcome = await commitSyncFileDetailed(absolutePath, file, ext, driver, taskId);
            if (outcome.ok) {
                totalCreated += outcome.result.created.length;
                totalRemoved += outcome.result.removed.length;
            } else if (outcome.skipped) {
                // Unsupported languages and deleted files can never sync;
                // they must not hold the wave in 'syncing' forever.
                skippedFiles.push({ file, reason: outcome.reason });
            } else {
                failedFiles.push(file);
            }
        } catch (err: any) {
            process.stderr.write(`[wave] commitSyncFile failed for ${file}: ${err?.message}\n`);
            failedFiles.push(file);
        }
    }

    // Update wave status
    const waveSession = driver.session();
    try {
        if (failedFiles.length === 0) {
            await waveSession.run(
                `MATCH (t:Task {wave: $waveId}) SET t.waveStatus = 'committed'`,
                { waveId }
            );
            process.stderr.write(
                `[wave] Wave ${waveId} committed successfully\n`
            );
        } else {
            // Leave wave in 'syncing' — retry possible
            await waveSession.run(
                `MATCH (t:Task {wave: $waveId}) SET t.waveStatus = 'syncing'`,
                { waveId }
            );
            process.stderr.write(
                `[wave] Wave ${waveId} partial failure, failed files: [${failedFiles.join(", ")}]\n`
            );
        }
    } finally {
        await waveSession.close();
    }

    const durationMs = Date.now() - t0;
    process.stderr.write(
        `[commit-sync] Wave ${waveId}, files=[${[...fileMap.keys()].join(", ")}], ` +
        `created=${totalCreated}, removed=${totalRemoved}, durationMs=${durationMs}\n`
    );

    return {
        status: failedFiles.length === 0 ? "OK" : "PARTIAL_FAIL",
        filesProcessed: fileMap.size,
        created: totalCreated,
        removed: totalRemoved,
        failedFiles,
        skippedFiles,
        durationMs,
    };
}

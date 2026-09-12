import { readFileSync, readdirSync, rmSync, existsSync } from "fs";
import { createHash } from "crypto";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "node:module";
import { assertFileScope } from "./scope-guard.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Per-file mutex for concurrent edits (cross-process via mkdir) ────
const fileMutexes = new Map<string, Promise<void>>();
const projectDir = process.env.CODEVIS_PROJECT_DIR || resolve(__dirname, "../..");
export const LOCK_DIR = resolve(projectDir, ".claude/filelocks");
const { acquireDirectoryLock, STALE_LOCK_MS: staleLockMs } = createRequire(import.meta.url)('../../lib/directory-lock.cjs');
const { resolvePhysicalPath } = createRequire(import.meta.url)('../../lib/file-publication.cjs');
export const STALE_LOCK_MS = staleLockMs;

function canonicalFilePath(filePath: string): string {
    const canonical = resolvePhysicalPath(filePath);
    return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}

export function getFileLockPath(filePath: string): string {
    const digest = createHash('sha256').update(canonicalFilePath(filePath)).digest('hex');
    return resolve(LOCK_DIR, digest + '.lock');
}

export async function acquireFileLock(filePath: string, maxWaitMs = 5000): Promise<() => void> {
    return acquireDirectoryLock(getFileLockPath(filePath), maxWaitMs);
}

export async function withFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
    filePath = canonicalFilePath(filePath);
    // Process-local serialization (fast path)
    const prev = fileMutexes.get(filePath) || Promise.resolve();
    let releaseFn: () => void;
    const next = new Promise<void>(r => { releaseFn = r; });
    fileMutexes.set(filePath, next);
    await prev;

    // Cross-process file lock
    let releaseFileLock: (() => void) | null = null;
    try {
        releaseFileLock = await acquireFileLock(filePath);
        await assertFileScope(filePath);
        return await fn();
    } finally {
        releaseFileLock?.();
        if (fileMutexes.get(filePath) === next) fileMutexes.delete(filePath);
        releaseFn!();
    }
}

/** Hold the complete, canonical file set through validation, commit and rollback. */
export async function withFileLocks<T>(filePaths: string[], fn: () => Promise<T>): Promise<T> {
    const paths = [...new Set(filePaths.map(canonicalFilePath))].sort();
    const acquire = (index: number): Promise<T> => index === paths.length
        ? fn() : withFileLock(paths[index], () => acquire(index + 1));
    return acquire(0);
}

// Cleanup own file locks on exit
export function cleanupFileLocks() {
    try {
        if (existsSync(LOCK_DIR)) {
            for (const entry of readdirSync(LOCK_DIR)) {
                if (!entry.endsWith('.lock')) continue;
                const lockPath = resolve(LOCK_DIR, entry);
                try {
                    const pidFile = resolve(lockPath, "pid");
                    if (existsSync(pidFile)) {
                        const pid = parseInt(readFileSync(pidFile, "utf-8").split("\n")[0], 10);
                        if (pid === process.pid) rmSync(lockPath, { recursive: true, force: true });
                    }
                } catch { /* dieser eine Eintrag ist unlesbar — die anderen trotzdem prüfen */ }
            }
        }
    } catch {
        // Läuft aus einem Shutdown-Handler. Hier gibt es nichts mehr zu
        // retten: ein Wurf verhindert bloß, dass die übrigen Handler laufen,
        // und eine Meldung erreicht niemanden mehr. Was liegen bleibt, räumt
        // der nächste Start über die Altersprüfung in staleLockIdentity() weg.
    }
}

export function registerCleanupHandlers() {
    process.on("exit", cleanupFileLocks);
    process.on("SIGTERM", () => { cleanupFileLocks(); process.exit(0); });
    process.on("SIGINT", () => { cleanupFileLocks(); process.exit(0); });
}

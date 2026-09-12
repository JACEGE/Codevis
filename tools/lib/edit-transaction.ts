import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { withFileLocks } from './file-ops.js';
const { resolvePhysicalPath, publishStagedFile } = createRequire(import.meta.url)('../../lib/file-publication.cjs');

export interface FileSnapshot { file: string; path: string; original: string; content: string }

/** Caller holds the file mutex and has completed asynchronous scope checks. */
export function replaceFileSnapshot(snapshot: FileSnapshot): void {
    snapshot = { ...snapshot, path: resolvePhysicalPath(snapshot.path) };
    if (!existsSync(snapshot.path) || readFileSync(snapshot.path, 'utf8') !== snapshot.original) {
        throw Object.assign(new Error(`File changed before replacement: ${snapshot.file}`), { status: 'CONFLICT' });
    }
    const temporary = `${snapshot.path}.edit_tmp.${randomUUID()}`;
    try {
        writeFileSync(temporary, snapshot.content, { encoding: 'utf8', flag: 'wx' });
        publishStagedFile(temporary, snapshot.path);
    } finally {
        try { rmSync(temporary, { force: true }); } catch { /* preserve the original error */ }
    }
}

/** Optimistic snapshot validation plus coordinated commit/rollback, not a DB transaction. */
export async function commitFileSnapshots(snapshots: FileSnapshot[],
    backup: (file: string, content: string) => { backupToken: string },
    beforeCommit?: (snapshot: FileSnapshot) => Promise<void>) {
    snapshots = snapshots.map(snapshot => ({ ...snapshot, path: resolvePhysicalPath(snapshot.path) }));
    return withFileLocks(snapshots.map(s => s.path), async () => {
        const staged = snapshots.map(s => ({ ...s, temporary: `${s.path}.rename_tmp.${randomUUID()}` }));
        const backups: Array<{ file: string; backupToken: string }> = [];
        const committed: typeof staged = [];
        const validate = () => {
            for (const s of staged) {
                if (!existsSync(s.path) || readFileSync(s.path, 'utf8') !== s.original) {
                    throw Object.assign(new Error(`File changed during rename: ${s.file}`), { status: 'CONFLICT' });
                }
            }
        };
        try {
            validate();
            for (const s of staged) {
                backups.push({ file: s.file, backupToken: backup(s.file, s.original).backupToken });
                writeFileSync(s.temporary, s.content, 'utf8');
            }
            for (const s of staged) await beforeCommit?.(s);
            // Scope checks can await the daemon. Validate after all of them,
            // then publish without yielding to another asynchronous operation.
            validate();
            for (const s of staged) {
                publishStagedFile(s.temporary, s.path);
                committed.push(s);
            }
            return backups;
        } catch (error: any) {
            const rollbackErrors: string[] = [];
            for (const s of [...committed].reverse()) {
                try {
                    if (readFileSync(s.path, 'utf8') !== s.content) throw new Error('A newer edit prevents rollback');
                    writeFileSync(s.temporary, s.original, 'utf8');
                    publishStagedFile(s.temporary, s.path);
                } catch (rollbackError: any) { rollbackErrors.push(`${s.file}: ${rollbackError.message}`); }
            }
            throw Object.assign(error, { backups, rolledBack: rollbackErrors.length === 0, rollbackErrors });
        } finally {
            for (const s of staged) { try { rmSync(s.temporary, { force: true }); } catch { /* retain backups */ } }
        }
    });
}

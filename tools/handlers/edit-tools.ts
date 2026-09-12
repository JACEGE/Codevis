import type { ToolHandler, ToolModule } from "../lib/graph.js";
import { graphInt, pickDbDriver } from "../lib/graph.js";
import { EDIT_LANG_CONFIGS, getLanguageAndQuery, getParserInstance, findFunctionInAST } from "../lib/treesitter.js";
import { withFileLock, withFileLocks, getFileLockPath } from "../lib/file-ops.js";
import { commitFileSnapshots, replaceFileSnapshot, type FileSnapshot } from "../lib/edit-transaction.js";
import { rewriteMovedImports, assertMoveDestination } from "../lib/move-imports.js";
import { planSemanticRename } from "../lib/semantic-rename.js";
import { liveSyncFile } from "../lib/graph-sync.js";
import { syncFileToGraph, checkAndResyncIfChanged } from "../lib/graph-sync.js";
import { checkCrossLocks, ipv6SubnetPrefix } from "../lib/locks.js";
import { logger } from "../lib/logger.js";
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "fs";
import { resolve, dirname, extname, basename } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { createHash, randomUUID } from "crypto";
import { withScopeGuard, assertFileScope } from "../lib/scope-guard.js";
import { lineAfterImports } from "../lib/insertion-position.js";

const { recordTouchedNodes } = createRequire(import.meta.url)("../lib/task-context.cjs");
const { backupOwner, createBackupToken, backupFileMatches } = createRequire(import.meta.url)("../lib/edit-backups.cjs");
const { resolvePhysicalPath, publishStagedFile } = createRequire(import.meta.url)("../../lib/file-publication.cjs");

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = process.env.CODEVIS_PROJECT_DIR || resolve(__dirname, "../..");

function createEditBackup(file: string, agentId: string, content: string): {
    backupDir: string;
    backupToken: string;
    backupPath: string;
} {
    const backupDir = resolve(PROJECT_ROOT, ".claude/backups");
    mkdirSync(backupDir, { recursive: true });
    const backupToken = createBackupToken(file, agentId, PROJECT_ROOT);
    const backupPath = resolve(backupDir, backupToken + ".bak");
    writeFileSync(backupPath, content, { encoding: 'utf-8', flag: 'wx' });
    return { backupDir, backupToken, backupPath };
}

async function recordEditTouch(driver: any, args: any, kind: string, targets: any[], taskId?: string): Promise<void> {
    const touchSession = driver.session();
    try {
        await recordTouchedNodes(touchSession, { taskId: taskId ?? args.taskId, agentId: args.agentId, kind, targets });
    } catch (error: any) {
        // TOUCHED is documentary: failure to record history must not turn a
        // completed filesystem edit into a reported edit failure.
        logger.warn(`${kind}: could not record TOUCHED`, { error: error.message });
    } finally {
        await touchSession.close();
    }
}

// Extra dirs allowed by the path-traversal check, taken from
// codevis.config.cjs target.sourceDir so external project trees
// (e.g. when CodeVis is registered as a user-scope MCP server)
// can still be opened by read_function and friends.
function loadAllowedExtraDirs(): string[] {
    try {
        const req = createRequire(import.meta.url);
        const cfg = req(resolve(PROJECT_ROOT, "codevis.config.cjs"));
        const projectSources = (cfg?.workspaces?.project_db || cfg?.workspaces?.target)?.sourceDir;
        const codevisSources = (cfg?.workspaces?.codevis_db || cfg?.workspaces?.meta)?.sourceDir;
        const list: string[] = [projectSources, codevisSources]
            .flatMap((raw) => Array.isArray(raw) ? raw : (raw ? [raw] : []));
        return list
            .map((p) => resolve(PROJECT_ROOT, p))
            .filter((p) => p !== PROJECT_ROOT);
    } catch {
        return [];
    }
}
const ALLOWED_EXTRA_DIRS: string[] = loadAllowedExtraDirs();

function isPathAllowed(absolutePath: string, allowInstalledCodevis = false): boolean {
    // Normalize to forward slashes before comparing — on Windows resolve()
    // returns backslash paths and a "+ '/'" prefix check never matches,
    // which rejected every legitimate file as path traversal.
    const norm = (p: string) => {
        const physical = resolvePhysicalPath(p).replace(/\\/g, "/");
        return process.platform === 'win32' ? physical.toLowerCase() : physical;
    };
    const a = norm(absolutePath);
    const root = norm(PROJECT_ROOT);
    const installedCodevis = /\/node_modules\/codevis(?:\/|$)/i;
    if (!allowInstalledCodevis && (installedCodevis.test(absolutePath.replace(/\\/g, '/')) || installedCodevis.test(a))) return false;
    if (a === root || a.startsWith(root + "/")) return true;
    for (const dir of ALLOWED_EXTRA_DIRS) {
        const d = norm(dir);
        if (a === d || a.startsWith(d + "/")) return true;
    }
    return false;
}

// ── detectFunctionChanges ─────────────────────────────────────────────────────
/**
 * Compare the parsed old and new trees to detect name changes and signature
 * changes for the named function.
 *
 * Called AFTER syntax check, BEFORE file write so that on NAME_CHANGED the
 * backup can be discarded without touching disk.
 *
 * Signature-change detection:
 *   - Parameter list changes (add/remove/reorder required params)
 *   - Return-type annotation changes
 *   - Adding `async` is treated as a signature change (callers need `await`)
 *
 * Edge cases:
 *   - Adding an optional param with a default value does NOT trigger the
 *     warning because the param text itself changes.  This is intentional —
 *     callers that omit the new param still compile.  Workers can suppress the
 *     warning by accepting it explicitly.
 *   - If the function is found in newTree under a different name the helper
 *     returns nameChanged=true (worker renamed it).
 */
function detectFunctionChanges(
    oldTree: any,
    newTree: any,
    functionName: string,
    funcQuery: any
): { nameChanged: boolean; signatureChanged: boolean; signatureDiff?: string } {
    function extractSig(tree: any): { params: string; returnType: string; isAsync: boolean } | null {
        let funcNode = findFunctionInAST(tree, funcQuery, functionName)?.node;
        if (!funcNode) return null;
        if (['lexical_declaration', 'variable_declaration'].includes(funcNode.type)) {
            funcNode = funcNode.namedChildren.find((node: any) => node.type === 'variable_declarator'
                && node.childForFieldName('name')?.text === functionName);
        }
        if (['variable_declarator', 'pair', 'field_definition', 'public_field_definition'].includes(funcNode?.type)) {
            funcNode = funcNode.childForFieldName('value');
        }
        while (funcNode?.type === 'parenthesized_expression') funcNode = funcNode.namedChildren[0];
        if (!funcNode) return null;
        return {
            params: (funcNode.childForFieldName('parameters') || funcNode.childForFieldName('parameter'))?.text ?? '',
            returnType: funcNode.childForFieldName('return_type')?.text ?? '',
            isAsync: funcNode.children.some((node: any) => node.type === 'async'),
        };
    }

    const newSig = extractSig(newTree);
    if (!newSig) {
        // Function not found in new tree — it was renamed or deleted
        return { nameChanged: true, signatureChanged: false };
    }

    const oldSig = extractSig(oldTree);
    if (!oldSig) {
        // No old sig to compare against — treat as no change
        return { nameChanged: false, signatureChanged: false };
    }

    const paramsChanged = oldSig.params !== newSig.params;
    const retChanged = oldSig.returnType !== newSig.returnType;
    const asyncChanged = oldSig.isAsync !== newSig.isAsync;
    const signatureChanged = paramsChanged || retChanged || asyncChanged;

    const signatureDiff = signatureChanged
        ? [
            paramsChanged ? `params: "${oldSig.params}" → "${newSig.params}"` : null,
            retChanged    ? `returnType: "${oldSig.returnType}" → "${newSig.returnType}"` : null,
            asyncChanged  ? `async: ${oldSig.isAsync} → ${newSig.isAsync}` : null,
          ].filter(Boolean).join(", ")
        : undefined;

    return { nameChanged: false, signatureChanged, ...(signatureDiff !== undefined ? { signatureDiff } : {}) };
}

// ── Tree-sitter-based safe identifier rename ──────────────────────────────────
/**
 * Collect byte-offset ranges of REAL references to `oldName` under `root`,
 * so a rename never touches strings, comments, or property accesses.
 *
 * Skipped:
 *   - string / template / comment tokens (identifiers never live inside them,
 *     but we bail out of those subtrees defensively)
 *   - the property side of a member/attribute access (`obj.oldName`, Python `o.oldName`)
 *
 * Included when `includeMethodDecl` is true (declaration file only):
 *   - a `property_identifier` that is the NAME of a `method_definition`
 *   - a `this.oldName` self-reference inside the method body
 *
 * Offsets are absolute in the source the tree was parsed from.
 */
function collectRenameOffsets(root: any, oldName: string, includeMethodDecl: boolean): Array<{ start: number; end: number }> {
    const edits: Array<{ start: number; end: number }> = [];
    const visit = (node: any) => {
        const t = node.type;
        if (t === "string" || t === "template_string" || t === "comment" || t === "string_fragment") {
            return; // never rewrite inside string/comment content
        }
        if (node.text === oldName) {
            if (t === "identifier") {
                const p = node.parent;
                const isMemberProperty =
                    !!p &&
                    (p.type === "member_expression" || p.type === "attribute") &&
                    (p.childForFieldName?.("property") === node || p.childForFieldName?.("attribute") === node);
                if (!isMemberProperty) edits.push({ start: node.startIndex, end: node.endIndex });
            } else if (includeMethodDecl && t === "property_identifier") {
                const p = node.parent;
                if (p && p.type === "method_definition" && p.childForFieldName?.("name") === node) {
                    edits.push({ start: node.startIndex, end: node.endIndex });
                } else if (p && p.type === "member_expression" && p.childForFieldName?.("property") === node) {
                    const obj = p.childForFieldName?.("object");
                    if (obj && obj.type === "this") edits.push({ start: node.startIndex, end: node.endIndex });
                }
            }
        }
        for (const child of node.children || []) visit(child);
    };
    visit(root);
    return edits;
}

/** Apply rename offsets to `source`, splicing right-to-left so earlier offsets stay valid. */
function applyRenameOffsets(source: string, edits: Array<{ start: number; end: number }>, newName: string): string {
    const sorted = [...edits].sort((a, b) => b.start - a.start);
    let text = source;
    for (const e of sorted) {
        text = text.slice(0, e.start) + newName + text.slice(e.end);
    }
    return text;
}

const handlers: Record<string, ToolHandler> = {
    // ── rewrite_function ───────────────────────────────────────────────────────
    // Full-body replacement. DESTRUCTIVE — replaces the entire function AST node.
    // Before writing, performs:
    //   1. Subnet cross-lock check  (blocks if any inner node is locked by another agent)
    //   2. Name-change detection    (rejects if function was renamed in newBody)
    //   3. Signature-change warning (warns but does not reject)
    rewrite_function: async (args, ctx) => {
        const syntaxTrees: any[] = [];
        args.agentId = args.agentId || ctx.defaultAgentId;
        const driver = pickDbDriver(ctx, args, "codevis_db");
        const session = driver.session();

        try {
            // 1. Resolve file path
            const baseDir = PROJECT_ROOT;
            const absolutePath = resolvePhysicalPath(resolve(baseDir, args.file));
            if (!isPathAllowed(resolve(baseDir, args.file))) {
                return { content: [{ type: "text", text: JSON.stringify({ status: "ERROR", error: "Path traversal detected — file must be inside an allowed project directory." }) }], isError: true } as any;
            }
            const ext = extname(args.file);

            // 1b. External-change detection
            const mtimeCheck = await checkAndResyncIfChanged(absolutePath, args.file, ext, driver, args.functionName);
            if (mtimeCheck.changed) {
                if (mtimeCheck.functionMissing) {
                    return { content: [{ type: "text", text: JSON.stringify({ status: "FILE_CHANGED_EXTERNALLY", error: `Function '${args.functionName}' no longer exists in '${args.file}'. User may have renamed/removed it.` }) }], isError: true } as any;
                }
                if (!mtimeCheck.resynced) {
                    process.stderr.write(`[external-change] Warning: resync failed for '${args.file}': ${mtimeCheck.error}\n`);
                }
            }

            // 2. Per-file mutex: serialize edits to the same file
            const editResult = await withFileLock(absolutePath, async () => {
                // 2a. Lock check
                const lockResult = await session.run(
                    `MATCH (f {name: $functionName, file: $file}) WHERE f:Function OR f:Class OR f:Component
                     RETURN f.locked AS locked, f.lockedBy AS lockedBy, f.lockGroup AS lockGroup, f.ipv6 AS ipv6, f.startLine AS startLine`,
                    { functionName: args.functionName, file: args.file }
                );

                if (lockResult.records.length === 0) {
                    return { status: "NOT_FOUND", error: `Function '${args.functionName}' not found in graph for file '${args.file}'.` };
                }

                // Disambiguate by startLine hint
                let lockRec: any = lockResult.records[0];
                if (lockResult.records.length > 1 && args.startLine) {
                    const hint = typeof args.startLine === "number" ? args.startLine : parseInt(args.startLine, 10);
                    if (isNaN(hint)) return { status: "ERROR", error: `Invalid startLine: '${args.startLine}' is not a number.` };
                    lockRec = lockResult.records.reduce((best: any, rec: any) => {
                        const sl = graphInt(rec.get("startLine"));
                        const bestSl = graphInt(best.get("startLine"));
                        return Math.abs((sl || 0) - hint) < Math.abs((bestSl || 0) - hint) ? rec : best;
                    });
                }
                const locked = (lockRec as any).get("locked");
                const lockedBy = (lockRec as any).get("lockedBy");

                if (ctx.lockingEnabled && (!locked || locked === false)) {
                    return { status: "NOT_LOCKED", error: `Function '${args.functionName}' is not locked. Lock it first via lock_subgraph or create_task.` };
                }
                if (ctx.lockingEnabled && lockedBy !== args.agentId) {
                    return { status: "LOCKED_BY_OTHER", error: `Function '${args.functionName}' is locked by '${lockedBy}', not '${args.agentId}'.` };
                }

                // 2b. Subnet cross-lock check (strict: rewrite is blocked if any inner node
                //     belongs to another agent — they own a sub-scope we'd overwrite)
                const targetIpv6 = (lockRec as any).get("ipv6");
                if (ctx.lockingEnabled && targetIpv6) {
                    const subnetPrefix = ipv6SubnetPrefix(targetIpv6);
                    const crossCheck = await checkCrossLocks(session, subnetPrefix, args.agentId);
                    if (crossCheck.conflict) {
                        logger.warn("rewrite_function blocked by inner node lock", {
                            agent: args.agentId,
                            function: args.functionName,
                            subnet: subnetPrefix,
                            conflictNode: crossCheck.conflictNode,
                            conflictAgent: crossCheck.conflictAgent,
                        });
                        return {
                            status: "REWRITE_BLOCKED",
                            error: `Inner node '${crossCheck.conflictNode}' is locked by '${crossCheck.conflictAgent}'. Either use edit_code_patch for surgical changes, or coordinate with ${crossCheck.conflictAgent}.`,
                        };
                    }
                }

                // Set editInProgress to prevent force_unlock during edit
                const editProgressQuery = targetIpv6
                    ? `MATCH (f {ipv6: $ipv6}) SET f.editInProgress = true, f.editInProgressSince = timestamp()`
                    : `MATCH (f {name: $functionName, file: $file}) WHERE f:Function OR f:Class OR f:Component SET f.editInProgress = true, f.editInProgressSince = timestamp()`;
                await session.run(editProgressQuery, { functionName: args.functionName, file: args.file, ipv6: targetIpv6 });

                try {
                    // 2c. Read current file + create backup
                    const fileContent = readFileSync(absolutePath, "utf-8");
                    const { backupDir, backupToken, backupPath } = createEditBackup(args.file, args.agentId, fileContent);

                    // 2d. Parse with tree-sitter
                    const { lang, funcQuery } = await getLanguageAndQuery(ext);
                    getParserInstance().setLanguage(lang);
                    const oldTree = getParserInstance().parse(fileContent);
                    syntaxTrees.push(oldTree);

                    // Find the target function in AST
                    const graphStartLine = args.startLine || graphInt((lockRec as any).get("startLine"));
                    const target = findFunctionInAST(oldTree, funcQuery, args.functionName, graphStartLine);
                    if (!target) {
                        rmSync(backupPath, { force: true });
                        return { status: "AST_MISMATCH", error: `Function '${args.functionName}' exists in graph but not found in file on disk. Run update_graph_smart to resync.` };
                    }

                    const oldStartLine = target.startLine;
                    const oldEndLine = target.endLine;
                    if (target.node?.type === 'variable_declarator') {
                        rmSync(backupPath, { force: true });
                        return { status: 'GROUPED_DECLARATION', error: 'Split the grouped declaration before rewriting one function, or use edit_code_patch. No files were modified.' };
                    }

                    // 2e. Splice new body
                    const before = fileContent.slice(0, target.startIndex);
                    const after = fileContent.slice(target.endIndex);
                    const newContent = before + args.newBody + after;

                    // 2f. Syntax check
                    const checkTree = getParserInstance().parse(newContent);
                    syntaxTrees.push(checkTree);
                    if (checkTree.rootNode.hasError) {
                        rmSync(backupPath, { force: true });
                        return { status: "SYNTAX_ERROR", error: `New code has syntax errors. Edit rejected. Original file unchanged.`, backupToken: null };
                    }

                    // 2g. Name-change + signature-change detection (before write — rollback still possible)
                    const changeDetection = detectFunctionChanges(oldTree, checkTree, args.functionName, funcQuery);
                    if (changeDetection.nameChanged) {
                        rmSync(backupPath, { force: true });
                        logger.warn("rewrite_function: NAME_CHANGED detected, rollback", {
                            agent: args.agentId,
                            function: args.functionName,
                        });
                        return {
                            status: "NAME_CHANGED",
                            error: `Function '${args.functionName}' was renamed or removed in newBody. Use rename_function for renames. Edit rejected.`,
                        };
                    }

                    // 2h. Atomic write: tmp file + rename
                    await assertFileScope(absolutePath);
                    replaceFileSnapshot({ file: args.file, path: absolutePath, original: fileContent, content: newContent });

                    // 2i. Re-parse to get updated line numbers for ALL functions
                    const allMatches = funcQuery.matches(checkTree.rootNode);
                    const updatedFunctions: Array<{ name: string; startLine: number; endLine: number; snippet: string }> = [];
                    for (const match of allMatches) {
                        const nameCapture = match.captures.find((c: any) => c.name === "func_name");
                        if (!nameCapture) continue;
                        let funcNode = nameCapture.node.parent;
                        if (funcNode?.type === "variable_declarator") funcNode = funcNode.parent;
                        if (!funcNode) continue;
                        const startLine = funcNode.startPosition.row + 1;
                        const endLine = funcNode.endPosition.row + 1;
                        const bodyText = funcNode.text || "";
                        const snippet = bodyText.length > 200 ? bodyText.slice(0, 200) + "..." : bodyText;
                        updatedFunctions.push({ name: nameCapture.node.text, startLine, endLine, snippet });
                    }

                    // 2j. Update graph metadata
                    try {
                        if (updatedFunctions.length > 0) {
                            await session.run(
                                `UNWIND $funcs AS f
                                 MATCH (n:Function {name: f.name, file: $file})
                                 SET n.startLine = f.startLine, n.endLine = f.endLine, n.bodySnippet = f.snippet`,
                                { funcs: updatedFunctions, file: args.file }
                            );
                        }
                    } catch (graphErr: any) {
                        try {
                            replaceFileSnapshot({ file: args.file, path: absolutePath, original: newContent, content: fileContent });
                        } catch (rollbackError: any) {
                            return { status: 'GRAPH_ERROR', rolledBack: false, backupToken,
                                error: `Graph update failed: ${graphErr.message}. Rollback failed: ${rollbackError.message}. Backup retained.` };
                        }
                        rmSync(backupPath, { force: true });
                        return { status: "GRAPH_ERROR", error: `File edit rolled back due to graph update failure: ${graphErr.message}`, backupToken: null };
                    }

                    // Calculate line delta
                    const newTarget = findFunctionInAST(checkTree, funcQuery, args.functionName, graphStartLine);
                    const newStartLine = newTarget?.startLine || oldStartLine;
                    const newEndLine = newTarget?.endLine || oldEndLine;
                    const oldLines = oldEndLine - oldStartLine + 1;
                    const newLines = newEndLine - newStartLine + 1;

                    // Cleanup old backups (> 1h, only this agent's)
                    try {
                        const { readdirSync } = await import("fs");
                        for (const f of readdirSync(backupDir)) {
                            if (f.endsWith(".bak")) {
                                const parts = f.split("_");
                                const ts = parseInt(parts[0] ?? "", 10);
                                const backupAgent = parts[1] ?? "";
                                if (!isNaN(ts) && Date.now() - ts > 3600000 && (backupAgent === backupOwner(args.agentId) || backupAgent === args.agentId)) {
                                    rmSync(resolve(backupDir, f), { force: true });
                                }
                            }
                        }
                    } catch {}

                    const warnings: string[] = [];
                    if (changeDetection.signatureChanged && changeDetection.signatureDiff) {
                        warnings.push(`Signature changed: callers may be affected. Diff: ${changeDetection.signatureDiff}`);
                        logger.warn("rewrite_function: signature changed", {
                            agent: args.agentId,
                            function: args.functionName,
                            signatureDiff: changeDetection.signatureDiff,
                        });
                    }

                    logger.info("rewrite_function: OK", {
                        agent: args.agentId,
                        function: args.functionName,
                        subnet: targetIpv6 ? ipv6SubnetPrefix(targetIpv6) : null,
                        blockersFound: 0,
                        oldLines,
                        newLines,
                        lineDelta: newLines - oldLines,
                    });

                    return {
                        status: "OK",
                        file: args.file,
                        functionName: args.functionName,
                        oldRange: { startLine: oldStartLine, endLine: oldEndLine },
                        newRange: { startLine: newStartLine, endLine: newEndLine },
                        lineDelta: newLines - oldLines,
                        functionsUpdated: updatedFunctions.length,
                        backupToken,
                        ...(warnings.length > 0 ? { warnings } : {}),
                    };
                } finally {
                    // Clear editInProgress flag
                    const clearQuery = targetIpv6
                        ? `MATCH (f {ipv6: $ipv6}) SET f.editInProgress = null, f.editInProgressSince = null`
                        : `MATCH (f {name: $functionName, file: $file}) WHERE f:Function OR f:Class OR f:Component SET f.editInProgress = null, f.editInProgressSince = null`;
                    await session.run(clearQuery, { functionName: args.functionName, file: args.file, ipv6: targetIpv6 }).catch(() => {});
                }
            });

            // Incremental graph sync (non-blocking)
            if (editResult.status === "OK") {
                const syncResult = await syncFileToGraph(absolutePath, args.file, ext, driver).catch((err: any) => ({ error: err.message }));
                if (syncResult && (syncResult as any).error) (editResult as any).syncWarning = (syncResult as any).error;
                await recordEditTouch(driver, args, args.__codevisTouchKind || "rewrite_function", [{ name: args.functionName, file: args.file }]);
            }

            return { content: [{ type: "text", text: JSON.stringify(editResult, null, 2) }], isError: editResult.status !== "OK" } as any;
        } catch (error: any) {
            return { content: [{ type: "text", text: `rewrite_function error: ${error.message}` }], isError: true } as any;
        } finally {
            for (const tree of syntaxTrees) tree?.delete();
            await session.close();
        }
    },

    // ── edit_function (deprecated alias → rewrite_function) ───────────────────
    edit_function: async (args, ctx) => {
        logger.warn("edit_function is deprecated. Use rewrite_function for full-body rewrites, or edit_code_patch for targeted changes.", {
            agent: args.agentId || ctx.defaultAgentId,
            function: args.functionName,
        });
        return (handlers as any).rewrite_function({ ...args, __codevisTouchKind: "edit_function" }, ctx);
    },

    // ── edit_code_patch ───────────────────────────────────────────────────────
    // Token-efficient targeted edit: sends only delta (oldString → newString).
    // Steps:
    //   1. Lock-check: agent must hold lock on functionName
    //   2. tree-sitter parse → find function byte-range
    //   3. Search oldString within that range (0→CODE_NOT_FOUND, 2+→NOT_UNIQUE)
    //   4. Cross-lock check for the specific match position (point check)
    //   5. Splice: before + newString + after
    //   6. Syntax check via tree-sitter
    //   7. Name-change detection (rejects renames)
    //   8. Atomic write + backup
    //   9. Graph live-sync
    edit_code_patch: async (args, ctx) => {
        const syntaxTrees: any[] = [];
        args.agentId = args.agentId || ctx.defaultAgentId;
        const driver = pickDbDriver(ctx, args, "codevis_db");
        const session = driver.session();

        try {
            const baseDir = PROJECT_ROOT;
            const absolutePath = resolvePhysicalPath(resolve(baseDir, args.file));
            if (!isPathAllowed(resolve(baseDir, args.file))) {
                return { content: [{ type: "text", text: JSON.stringify({ status: "ERROR", error: "Path traversal detected — file must be inside an allowed project directory." }) }], isError: true } as any;
            }
            const ext = extname(args.file);

            // External-change detection
            const mtimeCheck = await checkAndResyncIfChanged(absolutePath, args.file, ext, driver, args.functionName);
            if (mtimeCheck.changed && mtimeCheck.functionMissing) {
                return { content: [{ type: "text", text: JSON.stringify({ status: "FILE_CHANGED_EXTERNALLY", error: `Function '${args.functionName}' no longer exists in '${args.file}'.` }) }], isError: true } as any;
            }

            const patchResult = await withFileLock(absolutePath, async () => {
                // 1. Lock check
                const lockResult = await session.run(
                    `MATCH (f {name: $functionName, file: $file}) WHERE f:Function OR f:Class OR f:Component
                     RETURN f.locked AS locked, f.lockedBy AS lockedBy, f.ipv6 AS ipv6, f.startLine AS startLine`,
                    { functionName: args.functionName, file: args.file }
                );

                if (lockResult.records.length === 0) {
                    return { status: "NOT_FOUND", error: `Function '${args.functionName}' not found in graph for file '${args.file}'.` };
                }

                let lockRec: any = lockResult.records[0];
                if (lockResult.records.length > 1 && args.startLine) {
                    const hint = typeof args.startLine === "number" ? args.startLine : parseInt(args.startLine, 10);
                    if (!isNaN(hint)) {
                        lockRec = lockResult.records.reduce((best: any, rec: any) => {
                            const sl = graphInt(rec.get("startLine"));
                            const bestSl = graphInt(best.get("startLine"));
                            return Math.abs((sl || 0) - hint) < Math.abs((bestSl || 0) - hint) ? rec : best;
                        });
                    }
                }

                const locked = (lockRec as any).get("locked");
                const lockedBy = (lockRec as any).get("lockedBy");
                if (ctx.lockingEnabled && (!locked || locked === false)) {
                    return { status: "NOT_LOCKED", error: `Function '${args.functionName}' is not locked. Lock it first.` };
                }
                if (ctx.lockingEnabled && lockedBy !== args.agentId) {
                    return { status: "LOCKED_BY_OTHER", error: `Function '${args.functionName}' is locked by '${lockedBy}', not '${args.agentId}'.` };
                }

                // 2. Parse file and find function byte-range
                const fileContent = readFileSync(absolutePath, "utf-8");
                const { lang, funcQuery } = await getLanguageAndQuery(ext);
                getParserInstance().setLanguage(lang);
                const oldTree = getParserInstance().parse(fileContent);
                syntaxTrees.push(oldTree);

                const graphStartLine = args.startLine || graphInt((lockRec as any).get("startLine"));
                const target = findFunctionInAST(oldTree, funcQuery, args.functionName, graphStartLine);
                if (!target) {
                    return { status: "AST_MISMATCH", error: `Function '${args.functionName}' not found in file AST. Run update_graph_smart to resync.` };
                }

                // 3. Search oldString within the function's character range
                const funcText = fileContent.slice(target.startIndex, target.endIndex);
                const firstIdx = funcText.indexOf(args.oldString);
                if (firstIdx === -1) {
                    logger.warn("edit_code_patch: CODE_NOT_FOUND", {
                        agent: args.agentId,
                        function: args.functionName,
                        oldStringLen: args.oldString.length,
                    });
                    return {
                        status: "CODE_NOT_FOUND",
                        error: `oldString not found within function '${args.functionName}'. Check indentation and whitespace — matching is exact.`,
                    };
                }
                const secondIdx = funcText.indexOf(args.oldString, firstIdx + 1);
                if (secondIdx !== -1) {
                    logger.warn("edit_code_patch: NOT_UNIQUE", {
                        agent: args.agentId,
                        function: args.functionName,
                        oldStringLen: args.oldString.length,
                    });
                    return {
                        status: "NOT_UNIQUE",
                        error: `oldString appears more than once in function '${args.functionName}'. Add more surrounding context to make it unique.`,
                    };
                }

                // 4. Cross-lock check: does the match position fall inside a subnet locked by another agent?
                //    We check the /64 subnet of the function itself, but since edit_code_patch is
                //    surgical we use a point-based check: query all nodes in the file whose line
                //    range covers the match line, locked by a different agent.
                const matchAbsoluteIndex = target.startIndex + firstIdx;
                const matchLine = fileContent.slice(0, matchAbsoluteIndex).split("\n").length; // 1-based

                const pointLockCheck = ctx.lockingEnabled ? await session.run(
                    // A null agentId owns nothing, so every lock is foreign to it.
                    // Left bare, 'f.lockedBy <> null' yields NULL rather than TRUE
                    // and silently filters every conflict away.
                    `MATCH (f {file: $file}) WHERE (f:Function OR f:Class OR f:Component)
                       AND f.locked = true AND ($agentId IS NULL OR f.lockedBy <> $agentId)
                       AND f.startLine <= $line AND f.endLine >= $line
                     RETURN f.name AS name, f.lockedBy AS lockedBy LIMIT 1`,
                    { file: args.file, agentId: args.agentId, line: matchLine }
                ) : { records: [] };
                if (pointLockCheck.records.length > 0) {
                    const r: any = pointLockCheck.records[0];
                    logger.warn("edit_code_patch: CROSS_LOCK_CONFLICT", {
                        agent: args.agentId,
                        function: args.functionName,
                        matchLine,
                        conflictNode: r.get("name"),
                        conflictAgent: r.get("lockedBy"),
                    });
                    return {
                        status: "CROSS_LOCK_CONFLICT",
                        error: `Match at line ${matchLine} falls inside '${r.get("name")}' which is locked by '${r.get("lockedBy")}'. Coordinate with that agent or use a different scope.`,
                    };
                }

                // 5. Splice: before + newString + after (relative to full file)
                const matchAbsEnd = matchAbsoluteIndex + args.oldString.length;
                const newContent =
                    fileContent.slice(0, matchAbsoluteIndex) +
                    args.newString +
                    fileContent.slice(matchAbsEnd);

                // 6. Syntax check
                getParserInstance().setLanguage(lang);
                const checkTree = getParserInstance().parse(newContent);
                syntaxTrees.push(checkTree);
                if (checkTree.rootNode.hasError) {
                    return { status: "SYNTAX_ERROR", error: `Patched code has syntax errors. Edit rejected. File unchanged.` };
                }

                // 7. Name-change detection (before write)
                const changeDetection = detectFunctionChanges(oldTree, checkTree, args.functionName, funcQuery);
                if (changeDetection.nameChanged) {
                    logger.warn("edit_code_patch: NAME_CHANGED detected, rollback", {
                        agent: args.agentId,
                        function: args.functionName,
                    });
                    return {
                        status: "NAME_CHANGED",
                        error: `Patch would rename or remove function '${args.functionName}'. Use rename_function for renames. Edit rejected.`,
                    };
                }

                // 8. Backup + atomic write
                const { backupDir, backupToken, backupPath } = createEditBackup(args.file, args.agentId, fileContent);

                await assertFileScope(absolutePath);
                replaceFileSnapshot({ file: args.file, path: absolutePath, original: fileContent, content: newContent });

                // 9. Graph live-sync: update line numbers for all functions
                const allMatches = funcQuery.matches(checkTree.rootNode);
                const updatedFunctions: Array<{ name: string; startLine: number; endLine: number; snippet: string }> = [];
                for (const match of allMatches) {
                    const nameCapture = match.captures.find((c: any) => c.name === "func_name");
                    if (!nameCapture) continue;
                    let funcNode = nameCapture.node.parent;
                    if (funcNode?.type === "variable_declarator") funcNode = funcNode.parent;
                    if (!funcNode) continue;
                    const startLine = funcNode.startPosition.row + 1;
                    const endLine = funcNode.endPosition.row + 1;
                    const bodyText = funcNode.text || "";
                    updatedFunctions.push({
                        name: nameCapture.node.text,
                        startLine,
                        endLine,
                        snippet: bodyText.length > 200 ? bodyText.slice(0, 200) + "..." : bodyText,
                    });
                }
                try {
                    if (updatedFunctions.length > 0) {
                        await session.run(
                            `UNWIND $funcs AS f
                             MATCH (n:Function {name: f.name, file: $file})
                             SET n.startLine = f.startLine, n.endLine = f.endLine, n.bodySnippet = f.snippet`,
                            { funcs: updatedFunctions, file: args.file }
                        );
                    }
                } catch (graphErr: any) {
                    try {
                        replaceFileSnapshot({ file: args.file, path: absolutePath, original: newContent, content: fileContent });
                    } catch (rollbackError: any) {
                        return { status: 'GRAPH_ERROR', rolledBack: false, backupToken,
                            error: `Graph update failed: ${graphErr.message}. Rollback failed: ${rollbackError.message}. Backup retained.` };
                    }
                    rmSync(backupPath, { force: true });
                    return { status: "GRAPH_ERROR", error: `File patched but graph update failed, rolled back: ${graphErr.message}` };
                }

                // Cleanup old backups
                try {
                    const { readdirSync } = await import("fs");
                    for (const f of readdirSync(backupDir)) {
                        if (f.endsWith(".bak")) {
                            const parts = f.split("_");
                            const ts = parseInt(parts[0] ?? "", 10);
                            const backupAgent = parts[1] ?? "";
                            if (!isNaN(ts) && Date.now() - ts > 3600000 && (backupAgent === backupOwner(args.agentId) || backupAgent === args.agentId)) {
                                rmSync(resolve(backupDir, f), { force: true });
                            }
                        }
                    }
                } catch {}

                const oldLineCount = args.oldString.split("\n").length;
                const newLineCount = args.newString.split("\n").length;

                const warnings: string[] = [];
                if (changeDetection.signatureChanged && changeDetection.signatureDiff) {
                    warnings.push(`Signature changed: callers may be affected. Diff: ${changeDetection.signatureDiff}`);
                    logger.warn("edit_code_patch: signature changed", {
                        agent: args.agentId,
                        function: args.functionName,
                        signatureDiff: changeDetection.signatureDiff,
                    });
                }

                logger.info("edit_code_patch: OK", {
                    agent: args.agentId,
                    function: args.functionName,
                    oldLen: args.oldString.length,
                    newLen: args.newString.length,
                    deltaLines: newLineCount - oldLineCount,
                    syntaxOk: true,
                });

                return {
                    status: "OK",
                    file: args.file,
                    functionName: args.functionName,
                    matchLine,
                    deltaLines: newLineCount - oldLineCount,
                    backupToken,
                    ...(warnings.length > 0 ? { warnings } : {}),
                };
            });

            // Incremental graph sync (non-blocking)
            if (patchResult.status === "OK") {
                const syncResult = await syncFileToGraph(absolutePath, args.file, ext, driver).catch((err: any) => ({ error: err.message }));
                if (syncResult && (syncResult as any).error) (patchResult as any).syncWarning = (syncResult as any).error;
                await recordEditTouch(driver, args, "edit_code_patch", [{ name: args.functionName, file: args.file }]);
            }

            return { content: [{ type: "text", text: JSON.stringify(patchResult, null, 2) }], isError: patchResult.status !== "OK" } as any;
        } catch (error: any) {
            return { content: [{ type: "text", text: `edit_code_patch error: ${error.message}` }], isError: true } as any;
        } finally {
            for (const tree of syntaxTrees) tree?.delete();
            await session.close();
        }
    },

    insert_code: async (args, ctx) => {
        args.agentId = args.agentId || ctx.defaultAgentId;
        try {
            const baseDir = PROJECT_ROOT;
            const absolutePath = resolvePhysicalPath(resolve(baseDir, args.file));
            if (!isPathAllowed(resolve(baseDir, args.file))) {
                return { content: [{ type: "text", text: JSON.stringify({ status: "ERROR", error: "Path traversal detected — file must be inside an allowed project directory." }) }], isError: true } as any;
            }
            const ext = extname(args.file);

            // Lock check: reject if inserting before/after a function locked by another agent
            if (ctx.lockingEnabled && args.anchorFunction && (args.position === "before_function" || args.position === "after_function")) {
                const drv = pickDbDriver(ctx, args, "codevis_db");
                const sess = drv.session();
                try {
                    const lockRes = await sess.run(
                        // $agentId IS NULL: see the note in edit_code_patch — a
                        // bare <> against null matches nothing at all.
                        `MATCH (f {name: $name, file: $file}) WHERE (f:Function OR f:Class OR f:Component)
                         AND f.locked = true AND ($agentId IS NULL OR f.lockedBy <> $agentId)
                         RETURN f.lockedBy AS lockedBy LIMIT 1`,
                        { name: args.anchorFunction, file: args.file, agentId: args.agentId }
                    );
                    if (lockRes.records.length > 0) {
                        return { content: [{ type: "text", text: JSON.stringify({ status: "LOCKED_BY_OTHER", error: `Anchor function '${args.anchorFunction}' is locked by '${lockRes.records[0].get("lockedBy")}'. Cannot insert adjacent to a foreign-locked function.` }) }], isError: true } as any;
                    }
                } finally {
                    await sess.close();
                }
            }

            const result = await withFileLock(absolutePath, async () => {
                const fileContent = readFileSync(absolutePath, "utf-8");
                const lines = fileContent.split("\n");
                let insertIndex: number; // line index (0-based) to insert BEFORE

                if (args.position === "end_of_file") {
                    insertIndex = lines.length;
                } else if (args.position === "at_line") {
                    insertIndex = Math.max(0, Math.min((args.atLine || 1) - 1, lines.length));
                } else if (args.position === "after_imports") {
                    if (Object.hasOwn(EDIT_LANG_CONFIGS, ext)) {
                        const { lang } = await getLanguageAndQuery(ext);
                        getParserInstance().setLanguage(lang);
                        const tree = getParserInstance().parse(fileContent);
                        if (!tree) throw new Error('Parser returned no syntax tree.');
                        try {
                            insertIndex = lineAfterImports(tree);
                        } finally {
                            tree.delete();
                        }
                    } else {
                        // Preserve the existing fallback for files without a grammar.
                        insertIndex = 0;
                        for (let i = 0; i < lines.length; i++) {
                            if (/^\s*(import\s|const\s+\w+\s*=\s*require|from\s+['"])/.test(lines[i])) insertIndex = i + 1;
                        }
                    }
                    // If no imports found, skip past shebang and directive prologues
                    if (insertIndex === 0) {
                        for (let i = 0; i < Math.min(lines.length, 5); i++) {
                            const trimmed = lines[i].trim();
                            if (trimmed.startsWith('#!') || trimmed === '"use strict";' || trimmed === "'use strict';" ||
                                trimmed === '"use client";' || trimmed === '"use server";') {
                                insertIndex = i + 1;
                            } else break;
                        }
                    }
                } else if ((args.position === "before_function" || args.position === "after_function") && args.anchorFunction) {
                    const { lang, funcQuery } = await getLanguageAndQuery(ext);
                    getParserInstance().setLanguage(lang);
                    const tree = getParserInstance().parse(fileContent);
                    try {
                        const target = findFunctionInAST(tree, funcQuery, args.anchorFunction);
                        if (!target) {
                            return { status: "ANCHOR_NOT_FOUND", error: `Function '${args.anchorFunction}' not found in AST.` };
                        }
                        insertIndex = args.position === "before_function"
                            ? target.startLine - 1
                            : target.endLine;
                    } finally { tree?.delete(); }
                } else {
                    insertIndex = lines.length;
                }

                // Check if insert target line falls within a foreign-locked function
                const targetLine = insertIndex + 1; // 1-based
                if (ctx.lockingEnabled) {
                    const insertDrv = pickDbDriver(ctx, args, "codevis_db");
                    const lockSession = insertDrv.session();
                    try {
                    const lockedFuncs = await lockSession.run(
                        `MATCH (f {file: $file}) WHERE (f:Function OR f:Class OR f:Component) AND f.locked = true AND ($agentId IS NULL OR f.lockedBy <> $agentId)
                         RETURN f.name AS name, f.startLine AS startLine, f.endLine AS endLine, f.lockedBy AS lockedBy`,
                        { file: args.file, agentId: args.agentId }
                    );
                    for (const rec of lockedFuncs.records) {
                        const sl = graphInt(rec.get("startLine"));
                        const el = graphInt(rec.get("endLine"));
                        if (sl && el && targetLine >= sl && targetLine <= el) {
                            return { status: "LOCKED", error: `Cannot insert at line ${targetLine}: falls within '${rec.get("name")}' (lines ${sl}-${el}), locked by '${rec.get("lockedBy")}'.` };
                        }
                    }
                    } finally {
                        await lockSession.close();
                    }
                }

                lines.splice(insertIndex, 0, args.code);
                const newContent = lines.join("\n");
                // An unsupported language may skip validation; a broken parser
                // for a supported language must fail before changing the file.
                if (Object.hasOwn(EDIT_LANG_CONFIGS, ext)) {
                    const { lang } = await getLanguageAndQuery(ext);
                    getParserInstance().setLanguage(lang);
                    const tree = getParserInstance().parse(newContent);
                    if (!tree) throw new Error('Parser returned no syntax tree.');
                    try {
                        if (tree.rootNode.hasError) return {
                            status: "SYNTAX_ERROR", error: "Inserted code breaks file syntax. Original file unchanged.", backupToken: null,
                        };
                    } finally {
                        tree.delete();
                    }
                }

                await assertFileScope(absolutePath);
                if (readFileSync(absolutePath, 'utf8') !== fileContent) {
                    return { status: 'CONFLICT', error: 'File changed during insertion. Original edit was kept.' };
                }
                const { backupToken } = createEditBackup(args.file, args.agentId, fileContent);
                const tmpPath = absolutePath + `.edit_tmp.${randomUUID()}`;
                try {
                    writeFileSync(tmpPath, newContent, { encoding: 'utf-8', flag: 'wx' });
                    publishStagedFile(tmpPath, absolutePath);
                } finally {
                    rmSync(tmpPath, { force: true });
                }

                return {
                    status: "OK",
                    file: args.file,
                    insertedAtLine: insertIndex + 1,
                    linesInserted: args.code.split("\n").length,
                    backupToken,
                };
            });

            // Incremental graph sync after insert
            if (result.status === "OK") {
                const drv = pickDbDriver(ctx, args, "codevis_db");
                await syncFileToGraph(absolutePath, args.file, extname(args.file), drv).catch(() => {});
                const targets = args.anchorFunction
                    ? [{ name: args.anchorFunction, file: args.file }]
                    : [{ file: args.file, allInFile: true }];
                await recordEditTouch(drv, args, "insert_code", targets);
            }

            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], isError: result.status !== "OK" } as any;
        } catch (error: any) {
            return { content: [{ type: "text", text: `insert_code error: ${error.message}` }], isError: true } as any;
        }
    },

    read_function: async (args, ctx) => {
        const syntaxTrees: any[] = [];
        try {
            const baseDir = PROJECT_ROOT;
            const absolutePath = resolvePhysicalPath(resolve(baseDir, args.file));
            if (!isPathAllowed(absolutePath, true)) {
                return { content: [{ type: "text", text: JSON.stringify({ status: "ERROR", error: "Path traversal detected — file must be inside an allowed project directory." }) }], isError: true } as any;
            }
            const ext = extname(args.file);

            const fileContent = readFileSync(absolutePath, "utf-8");
            const { lang, funcQuery } = await getLanguageAndQuery(ext);
            getParserInstance().setLanguage(lang);
            const tree = getParserInstance().parse(fileContent);
            syntaxTrees.push(tree);

            const target = findFunctionInAST(tree, funcQuery, args.functionName, args.startLine);
            if (!target) {
                return { content: [{ type: "text", text: JSON.stringify({ status: "NOT_FOUND", error: `Function '${args.functionName}' not found in '${args.file}' via tree-sitter.` }) }], isError: true } as any;
            }

            // Get lock status from graph (use startLine to disambiguate)
            const drv = pickDbDriver(ctx, args, "codevis_db");
            const session = drv.session();
            let lockInfo: any = { locked: false };
            try {
                const lockRes = await session.run(
                    `MATCH (f {name: $name, file: $file}) WHERE f:Function OR f:Class OR f:Component
                     RETURN f.locked AS locked, f.lockedBy AS lockedBy, f.lockGroup AS lockGroup, f.startLine AS startLine`,
                    { name: args.functionName, file: args.file }
                );
                if (lockRes.records.length > 0) {
                    let r = lockRes.records[0];
                    const hint = typeof args.startLine === "number" ? args.startLine : parseInt(String(args.startLine), 10);
                    if (lockRes.records.length > 1 && !isNaN(hint)) {
                        r = lockRes.records.reduce((best: any, rec: any) => {
                            const sl = graphInt(rec.get("startLine"));
                            const bestSl = graphInt(best.get("startLine"));
                            return Math.abs((sl || 0) - hint) < Math.abs((bestSl || 0) - hint) ? rec : best;
                        });
                    }
                    lockInfo = { locked: r.get("locked") || false, lockedBy: r.get("lockedBy"), lockGroup: r.get("lockGroup") };
                }
            } finally {
                await session.close();
            }

            return {
                content: [{
                    type: "text",
                    text: JSON.stringify({
                        status: "OK",
                        file: args.file,
                        functionName: args.functionName,
                        startLine: target.startLine,
                        endLine: target.endLine,
                        source: target.node.text,
                        lock: lockInfo,
                    }, null, 2)
                }]
            };
        } catch (error: any) {
            return { content: [{ type: "text", text: `read_function error: ${error.message}` }], isError: true } as any;
        } finally {
            for (const tree of syntaxTrees) tree?.delete();
        }
    },

    rollback_edit: async (args, ctx) => {
        args.agentId = args.agentId || ctx.defaultAgentId;
        try {
            const backupDir = resolve(PROJECT_ROOT, ".claude/backups");
            const backupPath = resolve(backupDir, args.backupToken + ".bak");
            // Normalize separators before the containment check: on Windows
            // resolve() yields backslashes, so a `+ "/"` check is ALWAYS false and
            // used to reject every rollback here as "path traversal" — the tool
            // was dead on this platform. (isPathAllowed above already does this.)
            const normBackup = backupPath.replace(/\\/g, "/");
            const normDir = backupDir.replace(/\\/g, "/");
            if (normBackup !== normDir && !normBackup.startsWith(normDir + "/")) {
                return { content: [{ type: "text", text: JSON.stringify({ status: "ERROR", error: "Invalid backup token — path traversal detected." }) }], isError: true } as any;
            }
            if (!existsSync(backupPath)) {
                return { content: [{ type: "text", text: JSON.stringify({ status: "NOT_FOUND", error: `Backup '${args.backupToken}' not found. It may have expired (>1h).` }) }], isError: true } as any;
            }

            const baseDir = PROJECT_ROOT;
            const absolutePath = resolvePhysicalPath(resolve(baseDir, args.file));
            if (!isPathAllowed(resolve(baseDir, args.file))) {
                return { content: [{ type: "text", text: JSON.stringify({ status: "ERROR", error: "Path traversal detected — file must be inside an allowed project directory." }) }], isError: true } as any;
            }
            // Verify the agent has the right to rollback (must hold a lock on a function in this file)
            if (ctx.lockingEnabled) {
                const rlSession = pickDbDriver(ctx, args, "codevis_db").session();
                try {
                const lockCheck = await rlSession.run(
                    `MATCH (f {file: $file}) WHERE (f:Function OR f:Class OR f:Component) AND f.locked = true AND f.lockedBy = $agentId
                     RETURN count(f) AS c`,
                    { file: args.file, agentId: args.agentId }
                );
                const hasLock = graphInt(lockCheck.records[0]?.get("c")) > 0;
                if (!hasLock) {
                    return { content: [{ type: "text", text: JSON.stringify({ status: "NOT_AUTHORIZED", error: `Agent '${args.agentId}' does not hold any locks in '${args.file}'. Rollback denied.` }) }], isError: true } as any;
                }
                } finally {
                    await rlSession.close();
                }
            }

            return await withFileLock(absolutePath, async () => {
                const matches = backupFileMatches(args.backupToken, args.file, PROJECT_ROOT);
                if (matches !== true) {
                    return { content: [{ type: 'text', text: JSON.stringify({
                        status: matches === false ? 'BACKUP_FILE_MISMATCH' : 'UNBOUND_BACKUP',
                        error: matches === false ? 'This backup belongs to a different file. No files were changed.'
                            : 'This legacy backup has no verifiable file identity. Inspect and restore it manually; no files were changed.',
                        backupPath,
                    }) }], isError: true } as any;
                }
                const backupContent = readFileSync(backupPath, "utf-8");
                const temporary = `${absolutePath}.rollback_tmp.${randomUUID()}`;
                try {
                    writeFileSync(temporary, backupContent, { encoding: 'utf-8', flag: 'wx' });
                    publishStagedFile(temporary, absolutePath);
                } finally {
                    try { rmSync(temporary, { force: true }); } catch { /* preserve the recovery backup */ }
                }

                const drv = pickDbDriver(ctx, args, "codevis_db");
                const synced = await syncFileToGraph(absolutePath, args.file, extname(args.file), drv);
                await recordEditTouch(drv, args, "rollback_edit", [{ file: args.file, allInFile: true }]);
                if (!synced) {
                    return { content: [{ type: 'text', text: JSON.stringify({
                        status: 'GRAPH_SYNC_FAILED', file: args.file, fileRestored: true,
                        backupToken: args.backupToken,
                        error: 'File restored, but graph synchronization failed. Backup retained; repair the graph before continuing.',
                    }) }], isError: true } as any;
                }
                rmSync(backupPath, { force: true });
                return { content: [{ type: "text", text: JSON.stringify({ status: "OK", file: args.file, message: "File restored from backup. Graph synced." }) }] };
            });
        } catch (error: any) {
            return { content: [{ type: "text", text: `rollback_edit error: ${error.message}` }], isError: true } as any;
        }
    },

    // ── rename_function ───────────────────────────────────────────────────────
    // Atomically renames a function in the graph and on disk.
    // - Mutates the existing node (name, uid, ipv6) so all CALLS/APPLIES_TO/AFFECTS edges stay intact.
    // - Cascades IPv6 re-addressing to all subnet children (inner functions, effects, states).
    // - Optionally updates all call-sites across the project (updateCallers: true by default).
    // - Rejects if newName already exists in the same file (NAME_CONFLICT).
    // - Rejects if another agent holds any lock in the function's subnet (CROSS_LOCK_CONFLICT).
    rename_function: async (args, ctx) => {
        const syntaxTrees: any[] = [];
        args.agentId = args.agentId || ctx.defaultAgentId;
        const driver = pickDbDriver(ctx, args, "codevis_db");
        const session = driver.session();
        let renameBackups: Array<{ file: string; backupToken: string }> = [];
        let filesCommitted = false;

        try {
            const baseDir = PROJECT_ROOT;
            const absolutePath = resolvePhysicalPath(resolve(baseDir, args.file));
            if (!isPathAllowed(resolve(baseDir, args.file))) {
                return { content: [{ type: "text", text: JSON.stringify({ status: "ERROR", error: "Path traversal detected." }) }], isError: true } as any;
            }
            const ext = extname(args.file);

            // ── 1. Pre-checks ────────────────────────────────────────────────
            // 1a. Load the target node
            const nodeResult = await session.run(
                `MATCH (n {name: $oldName, file: $file}) WHERE n:Function OR n:Class OR n:Component
                 RETURN n.locked AS locked, n.lockedBy AS lockedBy, n.ipv6 AS ipv6,
                        n.uid AS uid, n.startLine AS startLine, n.lockGroup AS lockGroup`,
                { oldName: args.oldName, file: args.file }
            );
            if (nodeResult.records.length === 0) {
                return { content: [{ type: "text", text: JSON.stringify({ status: "NOT_FOUND", error: `Function '${args.oldName}' not found in graph for file '${args.file}'.` }) }], isError: true } as any;
            }
            const rec = nodeResult.records[0];
            const locked = rec.get("locked");
            const lockedBy = rec.get("lockedBy");
            if (ctx.lockingEnabled && (!locked || locked === false)) {
                return { content: [{ type: "text", text: JSON.stringify({ status: "NOT_LOCKED", error: `Function '${args.oldName}' is not locked. Lock it before renaming.` }) }], isError: true } as any;
            }
            if (ctx.lockingEnabled && lockedBy !== args.agentId) {
                return { content: [{ type: "text", text: JSON.stringify({ status: "LOCKED_BY_OTHER", error: `Function '${args.oldName}' is locked by '${lockedBy}', not '${args.agentId}'.` }) }], isError: true } as any;
            }

            // 1b. Cross-lock check: no other agent in the same subnet
            const targetIpv6: string = rec.get("ipv6") || "";
            if (ctx.lockingEnabled && targetIpv6) {
                const subnetPrefix = ipv6SubnetPrefix(targetIpv6);
                const crossCheck = await checkCrossLocks(session, subnetPrefix, args.agentId);
                if (crossCheck.conflict) {
                    logger.warn("rename_function blocked by inner node lock", {
                        agent: args.agentId, oldName: args.oldName, conflictNode: crossCheck.conflictNode, conflictAgent: crossCheck.conflictAgent,
                    });
                    return { content: [{ type: "text", text: JSON.stringify({ status: "CROSS_LOCK_CONFLICT", error: `Inner node '${crossCheck.conflictNode}' is locked by '${crossCheck.conflictAgent}'. Coordinate before renaming.` }) }], isError: true } as any;
                }
            }

            // 1c. newName must not exist in the same file
            const conflictResult = await session.run(
                `MATCH (n {name: $newName, file: $file}) WHERE n:Function OR n:Class OR n:Component RETURN count(n) AS c`,
                { newName: args.newName, file: args.file }
            );
            const conflictCount = conflictResult.records[0]?.get("c")?.toNumber?.() ?? 0;
            if (conflictCount > 0) {
                return { content: [{ type: "text", text: JSON.stringify({ status: "NAME_CONFLICT", error: `Function '${args.newName}' already exists in '${args.file}'.` }) }], isError: true } as any;
            }

            // 1d. Validate identifier
            if (!/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(args.newName)) {
                return { content: [{ type: "text", text: JSON.stringify({ status: "INVALID_NAME", error: `'${args.newName}' is not a valid identifier.` }) }], isError: true } as any;
            }

            // ── 2. Find callers (before file edit, while old name is still searchable) ─
            const updateCallers = args.updateCallers !== false;
            let callerFiles: Array<{ file: string; callerName: string }> = [];
            if (updateCallers) {
                const callersResult = await session.run(
                    `MATCH (caller)-[:CALLS]->(target {name: $oldName, file: $file})
                     RETURN caller.file AS callerFile, caller.name AS callerName`,
                    { oldName: args.oldName, file: args.file }
                );
                callerFiles = callersResult.records.map((r: any) => ({
                    file: r.get("callerFile"),
                    callerName: r.get("callerName"),
                }));
                if (callerFiles.length > 20) {
                    logger.warn("rename_function: >20 call-sites found", {
                        agent: args.agentId, oldName: args.oldName, count: callerFiles.length,
                    });
                }
            }

            // ── 3. File edits ────────────────────────────────────────────────
            const useSemanticRename = /\.[cm]?[jt]sx?$/i.test(ext);
            const semanticInputs = new Map<string, { file: string; path: string; original: string }>();
            // Discover every required claim before the first write. A scope
            // conflict in a caller must not leave the declaration half-renamed.
            for (const file of new Set([args.file, ...callerFiles.map(c => c.file)].filter(Boolean))) {
                await assertFileScope(resolvePhysicalPath(resolve(baseDir, file)));
            }
            const renameResult = await withFileLock(absolutePath, async () => {
                const fileContent = readFileSync(absolutePath, "utf-8");
                if (useSemanticRename) {
                    semanticInputs.set(absolutePath, { file: args.file, path: absolutePath, original: fileContent });
                    return { status: 'OK', original: fileContent, newContent: fileContent };
                }

                // Parse AST to find exact declaration range
                const { lang, funcQuery } = await getLanguageAndQuery(ext);
                getParserInstance().setLanguage(lang);
                const tree = getParserInstance().parse(fileContent);
                syntaxTrees.push(tree);
                const graphStartLine = graphInt(rec.get("startLine")) || undefined;
                const target = findFunctionInAST(tree, funcQuery, args.oldName, graphStartLine);
                if (!target) {
                    return { status: "AST_MISMATCH", error: `Function '${args.oldName}' not found in file AST. Run update_graph_smart to resync.` };
                }

                // Replace the declaration name + recursive self-calls — but ONLY
                // real references (tree-sitter), never strings/comments/property
                // accesses. Offsets from collectRenameOffsets are absolute in
                // fileContent and all fall inside the declaration node.
                const declEdits = collectRenameOffsets(target.node, args.oldName, true);
                let newContent: string;
                if (declEdits.length > 0) {
                    newContent = applyRenameOffsets(fileContent, declEdits, args.newName);
                } else {
                    // Fallback for exotic declaration forms the AST walk misses:
                    // scope the blind rename to the function's own text only.
                    const funcText = target.node.text;
                    const renamedText = funcText.replace(
                        new RegExp(`\\b${args.oldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g"),
                        args.newName
                    );
                    newContent = fileContent.slice(0, target.startIndex) + renamedText + fileContent.slice(target.endIndex);
                }

                // Syntax check
                const checkTree = getParserInstance().parse(newContent);
                syntaxTrees.push(checkTree);
                if (checkTree.rootNode.hasError) {
                    return { status: "SYNTAX_ERROR", error: "Renamed file has syntax errors. Edit rejected." };
                }

                // Prepare only; all files are validated together before commit.
                return { status: "OK", original: fileContent, newContent };
            });

            if (renameResult.status !== "OK") {
                return { content: [{ type: "text", text: JSON.stringify(renameResult) }], isError: true } as any;
            }

            // ── 4. Update callers in other files ─────────────────────────────
            // Blind `\b`-regex over the whole caller file rewrote strings, comments
            // and property accesses (`myMap.get`, the word "get" in a string, …).
            // Instead: parse each caller with tree-sitter and rename ONLY real
            // identifier references. Every modified caller is backed up (so it can
            // be rolled back) and its token returned. If ANY caller fails to parse,
            // we abort and write no caller file at all.
            let callersUpdated = 0;
            const pending: Array<{ file: string; absPath: string; original: string; updated: string }> = [];
            if (updateCallers && callerFiles.length > 0) {

                // Phase A: read + parse + compute every caller's new content. No writes yet.
                const callerFilesSeen = new Set<string>();
                let parseError: { file: string; error: string } | null = null;

                for (const { file: callerFile } of callerFiles) {
                    const callerAbsPath = resolvePhysicalPath(resolve(baseDir, callerFile));
                    const key = process.platform === 'win32' ? callerAbsPath.toLowerCase() : callerAbsPath;
                    const declarationKey = process.platform === 'win32' ? absolutePath.toLowerCase() : absolutePath;
                    if (callerFilesSeen.has(key) || key === declarationKey) continue;
                    callerFilesSeen.add(key);
                    if (!isPathAllowed(resolve(baseDir, callerFile))) throw new Error(`Caller path is not allowed: ${callerFile}`);

                    let callerContent: string;
                    try {
                        callerContent = readFileSync(callerAbsPath, "utf-8");
                    } catch (err: any) {
                        parseError = { file: callerFile, error: `Cannot read caller file: ${err.message}` };
                        break;
                    }

                    const callerExt = extname(callerFile);
                    if (useSemanticRename) {
                        if (!/\.[cm]?[jt]sx?$/i.test(callerExt)) throw new Error(`Unsupported semantic caller: ${callerFile}`);
                        semanticInputs.set(callerAbsPath, { file: callerFile, path: callerAbsPath, original: callerContent });
                        continue;
                    }
                    try {
                        const { lang: callerLang, funcQuery: _q } = await getLanguageAndQuery(callerExt);
                        getParserInstance().setLanguage(callerLang);
                        const callerTree = getParserInstance().parse(callerContent);
                        syntaxTrees.push(callerTree);
                        if (callerTree.rootNode.hasError) {
                            parseError = { file: callerFile, error: `Caller file has pre-existing syntax errors; refusing blind rename.` };
                            break;
                        }
                        const edits = collectRenameOffsets(callerTree.rootNode, args.oldName, false);
                        const updated = applyRenameOffsets(callerContent, edits, args.newName);
                        if (updated !== callerContent) {
                            pending.push({ file: callerFile, absPath: callerAbsPath, original: callerContent, updated });
                        }
                    } catch (err: any) {
                        // Unsupported extension / tree-sitter load failure → cannot
                        // guarantee a safe rename, so abort the whole caller phase.
                        parseError = { file: callerFile, error: `Cannot parse caller file: ${err.message}` };
                        break;
                    }
                }

                if (parseError) {
                    return { content: [{ type: "text", text: JSON.stringify({
                        status: "CALLER_PARSE_ERROR",
                        error: `Caller '${parseError.file}' could not be safely renamed: ${parseError.error}. No files were modified.`,
                    }) }], isError: true } as any;
                }
            }

            const snapshots: FileSnapshot[] = useSemanticRename
                ? planSemanticRename([...semanticInputs.values()], absolutePath, args.oldName, args.newName, graphInt(rec.get('startLine')) || undefined)
                : [
                { file: args.file, path: absolutePath, original: renameResult.original!, content: renameResult.newContent! },
                ...pending.map(p => ({ file: p.file, path: p.absPath, original: p.original, content: p.updated })),
            ];
            renameBackups = await commitFileSnapshots(snapshots,
                (file, content) => createEditBackup(file, args.agentId, content),
                snapshot => assertFileScope(snapshot.path));
            filesCommitted = true;
            callersUpdated = snapshots.slice(1).filter(s => s.original !== s.content).length;
            const callerBackupTokens = renameBackups.slice(1);

            // ── 5. Graph migration (atomic Cypher transaction) ────────────────
            // Compute new UID and IPv6 for the renamed node
            const newUid = createHash("sha256").update(`Function::${args.newName}::${args.file}`).digest("hex").substring(0, 16);
            // Compute new IPv6: keep file-prefix (groups 0-2), replace decl-segment (group 3) with new uid hex
            const oldIpv6Groups = targetIpv6 ? targetIpv6.split(":") : [];
            let newIpv6 = targetIpv6;
            let oldPrefix = "";
            let newPrefix = "";
            if (oldIpv6Groups.length >= 4 && targetIpv6) {
                const newDeclHex = parseInt(newUid.substring(0, 4), 16) || 0;
                const newDeclHex4 = newDeclHex.toString(16).padStart(4, "0");
                const newIpv6Groups = [...oldIpv6Groups];
                newIpv6Groups[3] = newDeclHex4;
                // Zero out deeper segments (children will be re-addressed)
                for (let i = 4; i < newIpv6Groups.length; i++) newIpv6Groups[i] = "0000";
                newIpv6 = newIpv6Groups.join(":");
                // Subnet prefix = first 4 groups + ":"
                oldPrefix = oldIpv6Groups.slice(0, 4).join(":") + ":";
                newPrefix = newIpv6Groups.slice(0, 4).join(":") + ":";
            }

            // Update the node itself
            await session.run(
                `MATCH (n {name: $oldName, file: $file}) WHERE n:Function OR n:Class OR n:Component
                 SET n.name = $newName,
                     n.uid = $newUid,
                     n.nodeId = $newUid,
                     n.ipv6 = $newIpv6,
                     n.renamedFrom = $oldName,
                     n.renamedAt = timestamp()`,
                { oldName: args.oldName, file: args.file, newName: args.newName, newUid, newIpv6 }
            );

            // Cascade IPv6 to subnet children (inner functions, effects, states)
            let cascadedCount = 0;
            if (oldPrefix && newPrefix && oldPrefix !== newPrefix) {
                const childResult = await session.run(
                    `MATCH (n) WHERE n.ipv6 STARTS WITH $oldPrefix
                       AND NOT (n:File OR n:Task OR n:Knowledge)
                     SET n.ipv6 = $newPrefix + substring(n.ipv6, $prefixLen)
                     RETURN count(n) AS c`,
                    { oldPrefix, newPrefix, prefixLen: oldPrefix.length }
                );
                cascadedCount = childResult.records[0]?.get("c")?.toNumber?.() ?? 0;
            }

            // Re-sync line numbers after file edits
            await syncFileToGraph(absolutePath, args.file, ext, driver).catch(() => {});

            await recordEditTouch(driver, args, "rename_function", [{ name: args.newName, file: args.file }]);

            logger.info("rename_function: OK", {
                agent: args.agentId,
                oldName: args.oldName,
                newName: args.newName,
                file: args.file,
                callersUpdated,
                cascadedIpv6: cascadedCount,
            });

            return {
                content: [{
                    type: "text",
                    text: JSON.stringify({
                        status: "OK",
                        file: args.file,
                        oldName: args.oldName,
                        newName: args.newName,
                        callersUpdated,
                        cascadedIpv6: cascadedCount,
                        backupToken: renameBackups[0]?.backupToken,
                        callerBackupTokens,
                        message: `[rename_function] ${args.oldName} → ${args.newName} (${args.file}): ${callersUpdated} callers updated, ${cascadedCount} subnet nodes re-addressed`,
                    }, null, 2)
                }]
            } as any;
        } catch (error: any) {
            return { content: [{ type: "text", text: JSON.stringify({ status: error.status || 'ERROR', error: error.message,
                filesCommitted, backups: error.backups || renameBackups,
                rolledBack: error.rolledBack, rollbackErrors: error.rollbackErrors }) }], isError: true } as any;
        } finally {
            for (const tree of syntaxTrees) tree?.delete();
            await session.close();
        }
    },

    // ── move_function ─────────────────────────────────────────────────────────
    // Moves a function to a different file, preserving all graph edges and lock state.
    // - Updates node.file, node.uid, node.ipv6 in-place (no tombstone).
    // - Migrates CONTAINS edge from sourceFile to targetFile.
    // - Cascades file+IPv6 changes to all inner-function children.
    // - Optionally updates import statements in all files that imported from sourceFile (updateImports: true).
    // - Auto-creates targetFile if it doesn't exist and has a valid extension.
    move_function: async (args, ctx) => {
        const syntaxTrees: any[] = [];
        args.agentId = args.agentId || ctx.defaultAgentId;
        const driver = pickDbDriver(ctx, args, "codevis_db");
        const session = driver.session();
        const moveBackups: Array<{ file: string; backupToken: string; existed: boolean }> = [];
        let filesCommitted = false;

        try {
            const baseDir = PROJECT_ROOT;
            const srcAbsPath = resolvePhysicalPath(resolve(baseDir, args.sourceFile));
            const tgtAbsPath = resolvePhysicalPath(resolve(baseDir, args.targetFile));
            const canonical = (p: string) => process.platform === 'win32' ? p.toLowerCase() : p;
            if (canonical(srcAbsPath) === canonical(tgtAbsPath)) {
                return { content: [{ type: "text", text: JSON.stringify({ status: "ERROR", error: "Source and target must be different files." }) }], isError: true } as any;
            }
            if (!isPathAllowed(resolve(baseDir, args.sourceFile)) || !isPathAllowed(resolve(baseDir, args.targetFile))) {
                return { content: [{ type: "text", text: JSON.stringify({ status: "ERROR", error: "Path traversal detected." }) }], isError: true } as any;
            }

            // ── 1. Pre-checks ────────────────────────────────────────────────
            const nodeResult = await session.run(
                `MATCH (n {name: $name, file: $sourceFile}) WHERE n:Function OR n:Class OR n:Component
                 RETURN n.locked AS locked, n.lockedBy AS lockedBy, n.ipv6 AS ipv6,
                        n.uid AS uid, n.startLine AS startLine`,
                { name: args.functionName, sourceFile: args.sourceFile }
            );
            if (nodeResult.records.length === 0) {
                return { content: [{ type: "text", text: JSON.stringify({ status: "NOT_FOUND", error: `Function '${args.functionName}' not found in graph for file '${args.sourceFile}'.` }) }], isError: true } as any;
            }
            const rec = nodeResult.records[0];
            const locked = rec.get("locked");
            const lockedBy = rec.get("lockedBy");
            if (ctx.lockingEnabled && (!locked || locked === false)) {
                return { content: [{ type: "text", text: JSON.stringify({ status: "NOT_LOCKED", error: `Function '${args.functionName}' is not locked. Lock it before moving.` }) }], isError: true } as any;
            }
            if (ctx.lockingEnabled && lockedBy !== args.agentId) {
                return { content: [{ type: "text", text: JSON.stringify({ status: "LOCKED_BY_OTHER", error: `Function '${args.functionName}' is locked by '${lockedBy}', not '${args.agentId}'.` }) }], isError: true } as any;
            }

            // 1b. Cross-lock check
            const sourceIpv6: string = rec.get("ipv6") || "";
            if (ctx.lockingEnabled && sourceIpv6) {
                const subnetPrefix = ipv6SubnetPrefix(sourceIpv6);
                const crossCheck = await checkCrossLocks(session, subnetPrefix, args.agentId);
                if (crossCheck.conflict) {
                    return { content: [{ type: "text", text: JSON.stringify({ status: "CROSS_LOCK_CONFLICT", error: `Inner node '${crossCheck.conflictNode}' is locked by '${crossCheck.conflictAgent}'. Coordinate before moving.` }) }], isError: true } as any;
                }
            }

            // 1c. Must not already exist in targetFile
            const targetConflict = await session.run(
                `MATCH (n {name: $name, file: $targetFile}) WHERE n:Function OR n:Class OR n:Component RETURN count(n) AS c`,
                { name: args.functionName, targetFile: args.targetFile }
            );
            if ((targetConflict.records[0]?.get("c")?.toNumber?.() ?? 0) > 0) {
                return { content: [{ type: "text", text: JSON.stringify({ status: "NAME_CONFLICT", error: `Function '${args.functionName}' already exists in targetFile '${args.targetFile}'.` }) }], isError: true } as any;
            }

            // 1d. Warn about private dependencies in sourceFile
            const privateDepsResult = await session.run(
                `MATCH (n {name: $name, file: $sourceFile})-[:CALLS]->(dep {file: $sourceFile})
                 WHERE NOT (dep)<-[:CONTAINS]-(:File)-[:IMPORTS]->(:File)
                 RETURN dep.name AS depName`,
                { name: args.functionName, sourceFile: args.sourceFile }
            );
            const privateDeps = privateDepsResult.records.map((r: any) => r.get("depName") as string);

            // ── 2. Find importers of sourceFile (for import-update) ──────────
            const updateImports = args.updateImports !== false;
            let importerFiles: string[] = [];
            if (updateImports) {
                const importersResult = await session.run(
                    `MATCH (importer:File)-[:IMPORTS]->(src:File {path: $sourceFile})
                     RETURN importer.path AS importerPath`,
                    { sourceFile: args.sourceFile }
                );
                importerFiles = importersResult.records.map((r: any) => r.get("importerPath") as string);
            }

            // ── 3. File operations ───────────────────────────────────────────
            // Reject missing importer claims before removing anything from source.
            for (const file of new Set([args.sourceFile, args.targetFile, ...importerFiles].filter(Boolean))) {
                await assertFileScope(resolvePhysicalPath(resolve(baseDir, file)));
            }
            const srcExt = extname(args.sourceFile);
            const tgtExt = extname(args.targetFile);

            let importsUpdated = 0;
            const importerPaths = [...new Set(importerFiles.map(file => resolvePhysicalPath(resolve(baseDir, file))))];
            for (const file of importerFiles) {
                if (!isPathAllowed(resolve(baseDir, file))) throw new Error(`Importer path is not allowed: ${file}`);
            }
            // Read source, extract function text via AST
            const moveResult = await withFileLocks([srcAbsPath, tgtAbsPath, ...importerPaths], async () => {
                const srcContent = readFileSync(srcAbsPath, "utf-8");
                const { lang, funcQuery } = await getLanguageAndQuery(srcExt);
                getParserInstance().setLanguage(lang);
                const srcTree = getParserInstance().parse(srcContent);
                syntaxTrees.push(srcTree);
                const graphStartLine = graphInt(rec.get("startLine")) || undefined;
                const target = findFunctionInAST(srcTree, funcQuery, args.functionName, graphStartLine);
                if (!target) {
                    return { status: "AST_MISMATCH", error: `Function '${args.functionName}' not found in source AST.` };
                }

                // Moving only the inner declaration leaves a dangling "export"
                // in the source and drops the target's public export.
                const declaration = target.node.parent?.type === 'export_statement' ? target.node.parent : target.node;
                if (target.node.type === 'variable_declarator' || ((target.node.type === 'lexical_declaration' || target.node.type === 'variable_declaration')
                    && target.node.namedChildren.filter((node: any) => node.type === 'variable_declarator').length > 1)) {
                    throw new Error('Split the multi-declarator statement before moving one function. No files were modified.');
                }
                const movedExport = declaration.children.some((node: any) => node.type === 'default') ? 'default' : 'named';
                const funcText = declaration.text;

                // Remove from source
                // Trim leading blank line before the function if present
                let removeStart = declaration.startIndex;
                if (removeStart > 0 && srcContent[removeStart - 1] === "\n") {
                    removeStart--;
                }
                const newSrcContent = srcContent.slice(0, removeStart) + srcContent.slice(declaration.endIndex);

                const targetExisted = existsSync(tgtAbsPath);
                const tgtContent = targetExisted ? readFileSync(tgtAbsPath, "utf-8") : "";
                assertMoveDestination(tgtContent, tgtAbsPath, movedExport);
                const separator = tgtContent.length > 0 && !tgtContent.endsWith("\n\n") ? "\n\n" : "";
                const importSnapshots: Array<{ file: string; path: string; original: string; content: string; existed: boolean }> = [];
                for (const file of importerPaths) {
                    if (canonical(file) === canonical(srcAbsPath)) continue;
                    const content = readFileSync(file, 'utf8');
                    const updated = rewriteMovedImports(content, file, srcAbsPath, tgtAbsPath, args.functionName, undefined, movedExport);
                    if (updated !== content) {
                        importSnapshots.push({ file, path: file, original: content, content: updated, existed: true });
                    }
                }
                const newTgtContent = tgtContent + separator + funcText + "\n";
                importsUpdated = importSnapshots.length;
                const operationId = randomUUID();
                // Use an invocation-specific backup namespace, including for
                // distinct paths whose sanitized names would otherwise collide.
                for (const item of [
                    { file: args.sourceFile, content: srcContent, existed: true },
                    { file: args.targetFile, content: tgtContent, existed: targetExisted },
                    ...importSnapshots.map(item => ({ file: item.file, content: item.original, existed: true })),
                ]) {
                    const saved = createEditBackup(item.file, args.agentId, item.content);
                    moveBackups.push({ file: item.file, backupToken: saved.backupToken, existed: item.existed });
                }
                const staged = [
                    { path: tgtAbsPath, original: tgtContent, content: newTgtContent, existed: targetExisted },
                    ...importSnapshots,
                    { path: srcAbsPath, original: srcContent, content: newSrcContent, existed: true },
                ].map(item => ({ ...item, temporary: `${item.path}.move_tmp.${operationId}` }));
                const committed: typeof staged = [];
                try {
                    mkdirSync(dirname(tgtAbsPath), { recursive: true });
                    // All staging must finish before either original is changed.
                    for (const item of staged) writeFileSync(item.temporary, item.content, "utf-8");
                    for (const item of staged) await assertFileScope(item.path);
                    // Check again after the asynchronous AST load and staging:
                    // file locks coordinate CodeVis, not external editors.
                    for (const item of staged) {
                        if (existsSync(item.path) !== item.existed
                            || (item.existed && readFileSync(item.path, "utf-8") !== item.original)) {
                            throw new Error(`CONFLICT: ${item.path} changed while preparing the move.`);
                        }
                    }
                    // Destination first: a process stop between these renames
                    // can duplicate a function, but cannot erase its only copy.
                    for (const item of staged) {
                        publishStagedFile(item.temporary, item.path);
                        committed.push(item);
                    }
                    filesCommitted = true;
                    return { status: "OK", funcText, backupToken: moveBackups[0].backupToken };
                } catch (error: any) {
                    const rollbackErrors: string[] = [];
                    for (const item of [...committed].reverse()) {
                        try {
                            if (readFileSync(item.path, "utf-8") !== item.content) {
                                throw new Error('File changed after commit; refusing to overwrite a newer edit.');
                            }
                            if (item.existed) {
                                writeFileSync(item.temporary, item.original, "utf-8");
                                publishStagedFile(item.temporary, item.path);
                            } else rmSync(item.path);
                        } catch (rollbackError: any) {
                            rollbackErrors.push(`${item.path}: ${rollbackError.message}`);
                        }
                    }
                    return { status: "ERROR", error: error.message, rolledBack: rollbackErrors.length === 0,
                        rollbackErrors, backupToken: moveBackups[0]?.backupToken, backups: moveBackups };
                } finally {
                    for (const item of staged) {
                        try { rmSync(item.temporary, { force: true }); } catch { /* backups remain available */ }
                    }
                }
            });

            if (moveResult.status !== "OK") {
                return { content: [{ type: "text", text: JSON.stringify(moveResult) }], isError: true } as any;
            }

            // ── 5. Graph migration ───────────────────────────────────────────
            // Compute new UID and IPv6 for the moved node (file segment changes)
            const newUid = createHash("sha256").update(`Function::${args.functionName}::${args.targetFile}`).digest("hex").substring(0, 16);

            // Compute new IPv6: need targetFile's uid for the file-segment
            const tgtFileResult = await session.run(
                `MERGE (f:File {path: $path}) RETURN f.uid AS uid, f.ipv6 AS ipv6`,
                { path: args.targetFile }
            );
            const tgtFileUid: string = tgtFileResult.records[0]?.get("uid") || "";
            const tgtFileIpv6: string = tgtFileResult.records[0]?.get("ipv6") || "";

            // File IPv6 format: fd00:PPPP:FFFF:0000:... — use group index 2 for file segment
            // Node IPv6: fd00:PPPP:FFFF:DDDD:... — preserve projectId (group 1), new FFFF (group 2), new DDDD from newUid
            const oldIpv6Groups = sourceIpv6 ? sourceIpv6.split(":") : [];
            let newIpv6 = sourceIpv6;
            let oldChildPrefix = "";
            let newChildPrefix = "";

            if (oldIpv6Groups.length >= 4 && sourceIpv6) {
                // File segment from targetFile's ipv6 (group 2), or compute from tgtFileUid
                let newFileHex4: string;
                if (tgtFileIpv6) {
                    newFileHex4 = tgtFileIpv6.split(":")[2] || "0000";
                } else if (tgtFileUid) {
                    const fileHex = parseInt(tgtFileUid.substring(0, 4), 16) || 0;
                    newFileHex4 = fileHex.toString(16).padStart(4, "0");
                } else {
                    const syntheticUid = createHash("sha256").update(`File::${args.targetFile}::`).digest("hex").substring(0, 16);
                    const fileHex = parseInt(syntheticUid.substring(0, 4), 16) || 0;
                    newFileHex4 = fileHex.toString(16).padStart(4, "0");
                }
                const newDeclHex = parseInt(newUid.substring(0, 4), 16) || 0;
                const newDeclHex4 = newDeclHex.toString(16).padStart(4, "0");
                const newIpv6Groups = [...oldIpv6Groups];
                newIpv6Groups[2] = newFileHex4;
                newIpv6Groups[3] = newDeclHex4;
                for (let i = 4; i < newIpv6Groups.length; i++) newIpv6Groups[i] = "0000";
                newIpv6 = newIpv6Groups.join(":");
                oldChildPrefix = oldIpv6Groups.slice(0, 4).join(":") + ":";
                newChildPrefix = newIpv6Groups.slice(0, 4).join(":") + ":";
            }

            // Update node: change file, uid, ipv6
            await session.run(
                `MATCH (n {name: $name, file: $sourceFile}) WHERE n:Function OR n:Class OR n:Component
                 SET n.file = $targetFile,
                     n.uid = $newUid,
                     n.nodeId = $newUid,
                     n.ipv6 = $newIpv6,
                     n.movedFrom = $sourceFile,
                     n.movedAt = timestamp()`,
                { name: args.functionName, sourceFile: args.sourceFile, targetFile: args.targetFile, newUid, newIpv6 }
            );

            // Migrate CONTAINS edge: oldFile → newFile
            await session.run(
                `MATCH (oldFile:File {path: $sourceFile})-[r:CONTAINS]->(n {name: $name, file: $targetFile})
                 DELETE r
                 WITH n
                 MERGE (newFile:File {path: $targetFile})
                 MERGE (newFile)-[:CONTAINS]->(n)`,
                { sourceFile: args.sourceFile, targetFile: args.targetFile, name: args.functionName }
            );

            // Cascade file+IPv6 to subnet children (inner functions, effects, states)
            let cascadedCount = 0;
            if (oldChildPrefix && newChildPrefix && oldChildPrefix !== newChildPrefix) {
                const childResult = await session.run(
                    `MATCH (n) WHERE n.ipv6 STARTS WITH $oldPrefix
                       AND NOT (n:File OR n:Task OR n:Knowledge)
                     SET n.file = $targetFile,
                         n.ipv6 = $newPrefix + substring(n.ipv6, $prefixLen)
                     RETURN count(n) AS c`,
                    { oldPrefix: oldChildPrefix, newPrefix: newChildPrefix, prefixLen: oldChildPrefix.length, targetFile: args.targetFile }
                );
                cascadedCount = childResult.records[0]?.get("c")?.toNumber?.() ?? 0;
            }

            // Re-sync both files
            await syncFileToGraph(srcAbsPath, args.sourceFile, srcExt, driver).catch(() => {});
            await syncFileToGraph(tgtAbsPath, args.targetFile, tgtExt, driver).catch(() => {});

            await recordEditTouch(driver, args, "move_function", [{ name: args.functionName, file: args.targetFile }], args.taskId);

            const warnings: string[] = [];
            if (privateDeps.length > 0) {
                warnings.push(`Function depends on non-exported helpers in sourceFile: ${privateDeps.join(", ")}. Move or export them first.`);
            }

            logger.info("move_function: OK", {
                agent: args.agentId,
                functionName: args.functionName,
                sourceFile: args.sourceFile,
                targetFile: args.targetFile,
                importsUpdated,
                cascadedCount,
            });

            return {
                content: [{
                    type: "text",
                    text: JSON.stringify({
                        status: "OK",
                        functionName: args.functionName,
                        sourceFile: args.sourceFile,
                        targetFile: args.targetFile,
                        importsUpdated,
                        cascadedIpv6: cascadedCount,
                        backupToken: moveResult.backupToken,
                        backups: moveBackups,
                        ...(warnings.length > 0 ? { warnings } : {}),
                        message: `[move_function] ${args.functionName}: ${args.sourceFile} → ${args.targetFile}, ${importsUpdated} imports updated, ${cascadedCount} cascaded ipv6 changes`,
                    }, null, 2)
                }]
            } as any;
        } catch (error: any) {
            return { content: [{ type: "text", text: JSON.stringify({ status: "ERROR", error: error.message,
                filesCommitted, backupToken: moveBackups[0]?.backupToken, backups: moveBackups }) }], isError: true } as any;
        } finally {
            for (const tree of syntaxTrees) tree?.delete();
            await session.close();
        }
    },

};

// Wave 5: multi_file_edit handler merged into handlers map at module load
Object.assign(handlers, {
    // ── multi_file_edit ───────────────────────────────────────────────────────
    // Atomic cross-file edit: all edits succeed or none commit.
    // Phase 1: Stage — write each edit to a tmp file + syntax-check
    // Phase 2: Commit — if ALL syntax checks pass, rename all tmp→real atomically
    //          (POSIX rename is atomic per file; we hold file mutex across ALL files)
    // Phase 3: Rollback — if any commit-phase rename fails, restore from backups
    //
    // Deadlock prevention: file mutexes are acquired in sorted (alphabetical) order.
    multi_file_edit: async (args, ctx) => {
        args.agentId = args.agentId || ctx.defaultAgentId;
        const driver = pickDbDriver(ctx, args, "codevis_db");

        if (!args.edits || !Array.isArray(args.edits) || args.edits.length === 0) {
            return { content: [{ type: "text", text: JSON.stringify({ status: "ERROR", error: "edits array is required and must be non-empty." }) }], isError: true } as any;
        }

        if (args.edits.length > 10) {
            process.stderr.write(`[multi-file] Task ${args.taskId}: WARNING: ${args.edits.length} files in one transaction (>5 is risky)\n`);
        }

        const baseDir = PROJECT_ROOT;

        // Deduplicate + sort file paths alphabetically (deadlock prevention)
        const fileSet = new Set<string>();
        for (const edit of args.edits) {
            if (!edit.file) return { content: [{ type: "text", text: JSON.stringify({ status: "ERROR", error: "Each edit must have a 'file' field." }) }], isError: true } as any;
            if (!isPathAllowed(resolve(baseDir, edit.file))) {
                return { content: [{ type: "text", text: JSON.stringify({ status: "ERROR", error: `Path traversal detected in file: ${edit.file}` }) }], isError: true } as any;
            }
            fileSet.add(edit.file);
        }
        const sortedFiles = [...fileSet].sort();

        process.stderr.write(
            `[multi-file] Task ${args.taskId}: staging ${args.edits.length} edits across ${sortedFiles.length} files, syntax-check...\n`
        );

        // ── Phase 1: Stage all edits (tmp files + syntax check) ──────────────
        // We do NOT hold file mutexes yet — we just write tmp files and check syntax.
        // If any check fails, cleanup tmp files and return STAGING_FAIL.

        const session = driver.session();
        const backupDir = resolve(PROJECT_ROOT, ".claude/backups");
        mkdirSync(backupDir, { recursive: true });

        // One staged entry PER FILE (not per edit). Multiple edits targeting the
        // same file are merged into a single progressively-updated content, so the
        // second edit no longer overwrites the first (data-loss fix).
        type StagedEdit = {
            file: string;
            absolutePath: string;
            ext: string;
            functionNames: string[];
            originalContent: string;
            newContent: string;
            tmpPath: string;
            backupPath: string;
        };

        const staged: StagedEdit[] = [];
        const stagingErrors: Array<{ file: string; functionName: string; error: string }> = [];

        try {
            // Use the physical lock identity so directory aliases and Windows
            // case variants cannot stage competing replacements for one file.
            type FileGroup = { file: string; absolutePath: string; ext: string; edits: any[] };
            const groups = new Map<string, FileGroup>();
            for (const edit of args.edits) {
                const absolutePath = resolvePhysicalPath(resolve(baseDir, edit.file));
                const identity = getFileLockPath(absolutePath);
                let g = groups.get(identity);
                if (!g) {
                    g = { file: edit.file, absolutePath, ext: extname(edit.file), edits: [] };
                    groups.set(identity, g);
                }
                g.edits.push(edit);
            }

            // Unique tmp-path counter — a constant ".multi_tmp" suffix collides when
            // two files (or retries) stage at once; the index makes each write unique.
            let tmpCounter = 0;
            const invocationId = randomUUID();

            for (const group of groups.values()) {
                const { absolutePath, ext } = group;

                // Read current file content ONCE per file
                let originalContent: string;
                try {
                    originalContent = readFileSync(absolutePath, "utf-8");
                } catch (err: any) {
                    for (const edit of group.edits) {
                        stagingErrors.push({ file: edit.file, functionName: edit.functionName, error: `Cannot read file: ${err.message}` });
                    }
                    continue;
                }

                const { lang, funcQuery } = await getLanguageAndQuery(ext);
                getParserInstance().setLanguage(lang);

                // Apply each edit against the progressively-updated working buffer.
                // Re-parsing between edits keeps byte offsets correct after prior splices.
                let working = originalContent;
                let fileHadError = false;
                const functionNames: string[] = [];

                for (const edit of group.edits) {
                    // Lock check
                    const lockResult = await session.run(
                        `MATCH (f {name: $functionName, file: $file}) WHERE f:Function OR f:Class OR f:Component
                         RETURN f.locked AS locked, f.lockedBy AS lockedBy, f.startLine AS startLine`,
                        { functionName: edit.functionName, file: edit.file }
                    );
                    if (lockResult.records.length === 0) {
                        stagingErrors.push({ file: edit.file, functionName: edit.functionName, error: `Function '${edit.functionName}' not found in graph.` });
                        fileHadError = true;
                        continue;
                    }
                    const lockRec = lockResult.records[0];
                    if (ctx.lockingEnabled && !lockRec.get("locked")) {
                        stagingErrors.push({ file: edit.file, functionName: edit.functionName, error: `Function '${edit.functionName}' is not locked.` });
                        fileHadError = true;
                        continue;
                    }
                    if (ctx.lockingEnabled && lockRec.get("lockedBy") !== args.agentId) {
                        stagingErrors.push({ file: edit.file, functionName: edit.functionName, error: `Function '${edit.functionName}' is locked by '${lockRec.get("lockedBy")}', not '${args.agentId}'.` });
                        fileHadError = true;
                        continue;
                    }

                    // Find the function in the CURRENT working buffer (offsets shift
                    // after earlier edits to the same file).
                    // Another request can use the shared parser during session.run.
                    getParserInstance().setLanguage(lang);
                    const oldTree = getParserInstance().parse(working);
                    if (!oldTree) throw new Error('Parser returned no syntax tree.');
                    try {
                        const graphStartLine = graphInt(lockRec.get("startLine"));
                        const target = findFunctionInAST(oldTree, funcQuery, edit.functionName, graphStartLine);
                        if (!target) {
                            stagingErrors.push({ file: edit.file, functionName: edit.functionName, error: `Function '${edit.functionName}' not found in AST.` });
                            fileHadError = true;
                            continue;
                        }

                        const funcText = working.slice(target.startIndex, target.endIndex);
                        const matchIdx = funcText.indexOf(edit.oldString);
                        if (matchIdx === -1) {
                            stagingErrors.push({ file: edit.file, functionName: edit.functionName, error: `oldString not found in '${edit.functionName}'.` });
                            fileHadError = true;
                            continue;
                        }
                        if (funcText.indexOf(edit.oldString, matchIdx + 1) !== -1) {
                            stagingErrors.push({ file: edit.file, functionName: edit.functionName, error: `oldString not unique in '${edit.functionName}'.` });
                            fileHadError = true;
                            continue;
                        }

                        const absMatchIdx = target.startIndex + matchIdx;
                        working =
                            working.slice(0, absMatchIdx) +
                            edit.newString +
                            working.slice(absMatchIdx + edit.oldString.length);
                        functionNames.push(edit.functionName);
                    } finally {
                        oldTree.delete();
                    }
                }

                // Don't stage a file that had any edit error — the whole transaction
                // aborts below anyway, but we must not write a partially-applied file.
                if (fileHadError) continue;

                // Syntax check the fully-merged content once
                getParserInstance().setLanguage(lang);
                const checkTree = getParserInstance().parse(working);
                if (!checkTree) throw new Error('Parser returned no syntax tree.');
                let hasError: boolean;
                try { hasError = checkTree.rootNode.hasError; } finally { checkTree.delete(); }
                if (hasError) {
                    stagingErrors.push({ file: group.file, functionName: functionNames.join(","), error: `Syntax error in patched content.` });
                    continue;
                }

                // Write to a UNIQUE tmp file (staged, not committed)
                const backupToken = createBackupToken(group.file, args.agentId, PROJECT_ROOT);
                const backupPath = resolve(backupDir, backupToken + ".bak");
                const tmpPath = absolutePath + `.multi_tmp.${invocationId}.${tmpCounter++}`;
                writeFileSync(tmpPath, working, "utf-8");

                staged.push({
                    file: group.file, absolutePath, ext,
                    functionNames,
                    originalContent, newContent: working, tmpPath, backupPath,
                });
            }

            if (stagingErrors.length > 0) {
                // Cleanup all tmp files
                for (const s of staged) {
                    try { rmSync(s.tmpPath, { force: true }); } catch { /* ignore */ }
                }
                process.stderr.write(
                    `[multi-file] Task ${args.taskId}: staging FAILED for ${stagingErrors.length} edits, rolling back all\n`
                );
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify({
                            status: "STAGING_FAIL",
                            taskId: args.taskId,
                            stagingErrors,
                            note: "No files were modified.",
                        }, null, 2)
                    }],
                    isError: true,
                } as any;
            }

            // ── Phase 2: Commit — acquire file mutexes in sorted order + rename ──
            // Write backups first, then rename all tmp→real.
            const committed: string[] = [];
            const commitErrors: string[] = [];

            // Build staged list sorted by absolutePath (alphabetical) for deadlock prevention
            const sortedStaged = [...staged].sort((a, b) => a.absolutePath.localeCompare(b.absolutePath));

            // Canonical deduplication prevents recursive acquisition of the same
            // lock. Keep the full lock set until commit or rollback completes.
            const commitResult = await withFileLocks(sortedStaged.map(s => s.absolutePath), async () => {
                // Complete every asynchronous scope check before the final
                // snapshot comparison; publication must not yield after it.
                for (const s of sortedStaged) await assertFileScope(s.absolutePath);
                for (const s of sortedStaged) {
                    let current: string | undefined;
                    try { current = readFileSync(s.absolutePath, 'utf8'); } catch { /* removed or unreadable */ }
                    if (current !== s.originalContent) {
                        return { content: [{ type: 'text', text: JSON.stringify({
                            status: 'CONFLICT', file: s.file, error: 'File changed during staging; retry against current content.',
                        }) }], isError: true } as any;
                    }
                }
                try {
                    for (const s of sortedStaged) {
                        writeFileSync(s.backupPath, s.originalContent, { encoding: 'utf-8', flag: 'wx' });
                        publishStagedFile(s.tmpPath, s.absolutePath);
                        committed.push(s.file);
                    }
                } catch (err: any) {
                    commitErrors.push(`Commit failed: ${err.message}`);
                }

                if (commitErrors.length > 0) {
                    // Phase 3: Rollback — restore any committed files from backup
                    process.stderr.write(
                        `[multi-file] Task ${args.taskId}: commit FAILED (${commitErrors.join("; ")}), rolling back ${committed.length} files\n`
                    );
                    const rollbackErrors: string[] = [];
                    for (const s of sortedStaged) {
                        if (committed.includes(s.file) && existsSync(s.backupPath)) {
                            const rollbackTmp = s.absolutePath + `.rollback_tmp.${randomUUID()}`;
                            try {
                                if (readFileSync(s.absolutePath, 'utf8') !== s.newContent) {
                                    throw new Error('A newer edit prevents rollback; original backup retained.');
                                }
                                writeFileSync(rollbackTmp, s.originalContent, "utf-8");
                                publishStagedFile(rollbackTmp, s.absolutePath);
                                process.stderr.write(`[multi-file] Rolled back ${s.file}\n`);
                            } catch (rbErr: any) {
                                rollbackErrors.push(`${s.file}: ${rbErr.message}`);
                                process.stderr.write(`[multi-file] ROLLBACK FAILED for ${s.file}: ${rbErr.message}\n`);
                            } finally {
                                try { rmSync(rollbackTmp, { force: true }); } catch { /* best effort */ }
                            }
                        }
                        // Cleanup tmp and backup
                        try { rmSync(s.tmpPath, { force: true }); } catch { /* ignore */ }
                        // Keep backups for manual recovery if rollback itself fails.
                    }
                    return {
                        content: [{
                            type: "text",
                            text: JSON.stringify({
                                status: "PARTIAL_FAIL",
                                taskId: args.taskId,
                                committed,
                                commitErrors,
                                rollbackErrors,
                                backupPaths: sortedStaged.filter(s => existsSync(s.backupPath)).map(s => s.backupPath),
                                note: rollbackErrors.length ? "Rollback incomplete; backups retained." : "All committed files have been rolled back.",
                            }, null, 2)
                        }],
                        isError: true,
                    } as any;
                }
                return null;
            });
            if (commitResult) return commitResult;

            // ── Phase 4: Live-sync all committed files ────────────────────────
            const syncResults: Record<string, any> = {};
            for (const s of sortedStaged) {
                const syncResult = await liveSyncFile(s.absolutePath, s.file, s.ext, driver).catch(() => null);
                syncResults[s.file] = syncResult ? `updated ${syncResult.updatedCount} functions` : "sync-skipped";
            }

            await recordEditTouch(
                driver,
                args,
                "multi_file_edit",
                sortedStaged.flatMap(s => s.functionNames.map(name => ({ name, file: s.file }))),
                args.taskId,
            );

            process.stderr.write(
                `[multi-file] Task ${args.taskId}: committed ${committed.length} files successfully\n`
            );

            logger.info("multi_file_edit: OK", {
                agent: args.agentId,
                taskId: args.taskId,
                files: committed,
                editCount: args.edits.length,
            });

            return {
                content: [{
                    type: "text",
                    text: JSON.stringify({
                        status: "OK",
                        taskId: args.taskId,
                        committed,
                        editCount: args.edits.length,
                        syncResults,
                        backupTokens: sortedStaged.map(s => ({
                            file: s.file,
                            // basename, not split("/"): on Windows backupPath is
                            // backslash-separated, so split("/") returns the whole
                            // path and the emitted token would be un-rollback-able.
                            token: basename(s.backupPath).replace(".bak", ""),
                        })),
                    }, null, 2)
                }]
            } as any;
        } finally {
            for (const entry of staged) {
                try { rmSync(entry.tmpPath, { force: true }); } catch { /* best effort */ }
            }
            await session.close();
        }
    },
}); // end Object.assign(handlers, multi_file_edit)



const definitions = [
    {
        name: "edit_code_patch",
        description: "Your default editing tool for all targeted code changes. Sends only the delta (oldString→newString), preserving everything else. " +
            "Use for bug fixes, small features, targeted refactors. " +
            "When locking.enabled=true, the agent must hold a lock on functionName. " +
            "oldString must be unique within the function (add surrounding context if not). " +
            "Rejects renames (NAME_CHANGED) and cross-lock conflicts (CROSS_LOCK_CONFLICT). " +
            "For major restructuring of entire functions, use rewrite_function instead.",
        inputSchema: {
            type: "object",
            properties: {
                file: { type: "string", description: "Relative file path as stored in the graph." },
                functionName: { type: "string", description: "Name of the function to patch (scope for uniqueness check + lock check)." },
                oldString: { type: "string", description: "Exact string to replace (must appear exactly once in the function — whitespace-sensitive)." },
                newString: { type: "string", description: "Replacement string." },
                agentId: { type: "string", description: "Agent ID. Must hold the lock on functionName when locking is enabled." },
                startLine: { type: "number", description: "Optional: startLine from graph node. Disambiguates when multiple functions share the same name." },
                db: { type: "string", description: "Database: 'project_db' (current repository) or 'codevis_db' (CodeVis self-graph).", enum: ["project_db", "codevis_db"] }
            },
            required: ["file", "functionName", "oldString", "newString", "agentId"]
        }
    },
    {
        name: "rewrite_function",
        description: "DESTRUCTIVE — replaces entire function body. Use ONLY for major restructuring. " +
            "For targeted changes, use edit_code_patch. " +
            "Blocked (REWRITE_BLOCKED) if any inner node of the function's subnet is locked by another agent. " +
            "Detects renames (NAME_CHANGED) and signature changes (warning, not rejection). " +
            "Serializes concurrent edits to the same file via per-file mutex.",
        inputSchema: {
            type: "object",
            properties: {
                file: { type: "string", description: "Relative file path as stored in the graph (e.g. 'scripts/graph_builder.js')." },
                functionName: { type: "string", description: "Name of the function to rewrite (must match graph node name)." },
                newBody: { type: "string", description: "Complete new function source code (including signature, braces — replaces the entire AST node)." },
                agentId: { type: "string", description: "Agent ID. Must hold the lock on this function when locking is enabled." },
                startLine: { type: "number", description: "Optional: startLine from graph node. Used to disambiguate when multiple functions share the same name in a file." },
                db: { type: "string", description: "Database: 'project_db' (current repository) or 'codevis_db' (CodeVis self-graph).", enum: ["project_db", "codevis_db"] }
            },
            required: ["file", "functionName", "newBody", "agentId"]
        }
    },
    {
        name: "edit_function",
        description: "DEPRECATED — use rewrite_function (full-body rewrites) or edit_code_patch (targeted changes) instead. " +
            "This alias delegates to rewrite_function and logs a deprecation warning.",
        inputSchema: {
            type: "object",
            properties: {
                file: { type: "string", description: "Relative file path as stored in the graph (e.g. 'scripts/graph_builder.js')." },
                functionName: { type: "string", description: "Name of the function to edit (must match graph node name)." },
                newBody: { type: "string", description: "Complete new function source code (including signature, braces — replaces the entire AST node)." },
                agentId: { type: "string", description: "Agent ID. Must hold the lock on this function when locking is enabled." },
                startLine: { type: "number", description: "Optional: startLine from graph node. Used to disambiguate when multiple functions share the same name in a file." },
                db: { type: "string", description: "Database: 'project_db' (current repository) or 'codevis_db' (CodeVis self-graph).", enum: ["project_db", "codevis_db"] }
            },
            required: ["file", "functionName", "newBody", "agentId"]
        }
    },
    {
        name: "insert_code",
        description: "Insert new code at a specific location in a file (e.g. new imports, new functions, new exports). " +
            "Uses the per-file mutex for safe concurrent access. " +
            "For editing EXISTING functions, use edit_code_patch (targeted) or rewrite_function (full rewrite) instead.",
        inputSchema: {
            type: "object",
            properties: {
                file: { type: "string", description: "Relative file path." },
                code: { type: "string", description: "The code to insert." },
                position: { type: "string", enum: ["after_imports", "before_function", "after_function", "end_of_file", "at_line"], description: "Where to insert." },
                anchorFunction: { type: "string", description: "Function name to insert before/after (for before_function/after_function)." },
                atLine: { type: "number", description: "Line number for at_line position." },
                agentId: { type: "string", description: "Agent ID for audit trail." },
            },
            required: ["file", "code", "position", "agentId"]
        }
    },
    {
        name: "read_function",
        description: "Read a single function's source code from a file using tree-sitter. " +
            "Returns the complete function text, line range, and lock status. " +
            "Use this before edit_code_patch or rewrite_function to see the current state.",
        inputSchema: {
            type: "object",
            properties: {
                file: { type: "string", description: "Relative file path (e.g. 'scripts/graph_builder.js')." },
                functionName: { type: "string", description: "Name of the function to read." },
                startLine: { type: "number", description: "Optional: startLine from graph node. Disambiguates when multiple functions share the same name." },
                db: { type: "string", description: "Database for lock status check.", enum: ["project_db", "codevis_db"] }
            },
            required: ["file", "functionName"]
        }
    },
    {
        name: "rollback_edit",
        description: "Rollback a previous edit_code_patch or rewrite_function operation using the backupToken they returned. " +
            "Restores the file to its pre-edit state.",
        inputSchema: {
            type: "object",
            properties: {
                backupToken: { type: "string", description: "The backupToken returned by edit_function." },
                file: { type: "string", description: "Relative file path (must match the original edit)." },
                agentId: { type: "string", description: "Agent ID performing the rollback." },
            },
            required: ["backupToken", "file", "agentId"]
        }
    },
    {
        name: "rename_function",
        description: "Atomically rename a function across the graph and on disk. " +
            "Mutates the existing graph node (preserving all CALLS/APPLIES_TO/AFFECTS edges and lock state). " +
            "Re-computes uid and ipv6 for the node and cascades IPv6 re-addressing to all subnet children. " +
            "Optionally updates all call-sites across the project (updateCallers: true by default). " +
            "Rejects if newName already exists in the same file (NAME_CONFLICT) or the identifier is invalid. " +
            "Blocked if another agent holds a lock in the function's subnet (CROSS_LOCK_CONFLICT). " +
            "When locking.enabled=true, the agent must hold the lock on oldName.",
        inputSchema: {
            type: "object",
            properties: {
                file: { type: "string", description: "Relative file path where the function lives." },
                oldName: { type: "string", description: "Current function name (must match graph node)." },
                newName: { type: "string", description: "New function name (must be a valid identifier, must not already exist in the file)." },
                agentId: { type: "string", description: "Agent ID. Must hold the lock on oldName when locking is enabled." },
                updateCallers: { type: "boolean", description: "If true (default), update all call-sites in the project. Set to false to skip caller updates." },
                db: { type: "string", description: "Database: 'project_db' (current repository) or 'codevis_db' (CodeVis self-graph).", enum: ["project_db", "codevis_db"] }
            },
            required: ["file", "oldName", "newName", "agentId"]
        }
    },
    {
        name: "move_function",
        description: "Move a function to a different file while preserving all graph edges, locks, and history. " +
            "Updates node.file, node.uid, node.ipv6 in-place — no tombstone created. " +
            "Migrates the CONTAINS edge from sourceFile to targetFile. " +
            "Cascades file and IPv6 changes to all inner-function children. " +
            "Optionally updates import statements in all dependent files (updateImports: true by default). " +
            "Auto-creates targetFile if it does not exist (valid extension required). " +
            "Warns if the function depends on non-exported private helpers in sourceFile. " +
            "When locking.enabled=true, the agent must hold the lock on functionName in sourceFile.",
        inputSchema: {
            type: "object",
            properties: {
                sourceFile: { type: "string", description: "Relative path of the file currently containing the function." },
                targetFile: { type: "string", description: "Relative path of the destination file." },
                functionName: { type: "string", description: "Name of the function to move." },
                agentId: { type: "string", description: "Agent ID. Must hold the lock on functionName in sourceFile when locking is enabled." },
                updateImports: { type: "boolean", description: "If true (default), update import statements in all dependent files." },
                db: { type: "string", description: "Database: 'project_db' (current repository) or 'codevis_db' (CodeVis self-graph).", enum: ["project_db", "codevis_db"] }
            },
            required: ["sourceFile", "targetFile", "functionName", "agentId"]
        }
    },

    {
        name: "multi_file_edit",
        description: "Atomic cross-file edit: apply multiple code patches across multiple files as a single transaction. " +
            "Phase 1 (staging): all patches are syntax-checked against tmp files. If any fails, nothing is written. " +
            "Phase 2 (commit): all tmp files are renamed to real files atomically (POSIX rename per file). " +
            "Phase 3 (rollback): if commit fails mid-way, already-committed files are restored from backups. " +
            "File mutexes are acquired in alphabetical order to prevent deadlock. " +
            "Use for cross-cutting changes (rename across callers, refactor shared interface, etc.). " +
            "When locking.enabled=true, all functions being edited must be locked by the calling agent.",
        inputSchema: {
            type: "object",
            properties: {
                taskId: { type: "string", description: "Task ID for logging and commit-sync linkage." },
                agentId: { type: "string", description: "Agent ID. Must hold locks on all edited functions." },
                edits: {
                    type: "array",
                    description: "List of patches to apply atomically.",
                    items: {
                        type: "object",
                        properties: {
                            file: { type: "string", description: "Relative file path." },
                            functionName: { type: "string", description: "Function name containing the change." },
                            oldString: { type: "string", description: "Exact string to replace (must be unique within function)." },
                            newString: { type: "string", description: "Replacement string." },
                        },
                        required: ["file", "functionName", "oldString", "newString"]
                    }
                },
                db: { type: "string", description: "Database: 'project_db' (current repository) or 'codevis_db' (CodeVis self-graph).", enum: ["project_db", "codevis_db"] }
            },
            required: ["taskId", "agentId", "edits"]
        }
    },

];

// All writes, including dynamic importer edits and new files, pass the same
// file-scope check inside withFileLock. Node flags are only a compatibility
// projection and may be stale after parsing; the durable TaskScope is authority.
for (const definition of definitions) {
    if (["read_function", "recover_stale_edit"].includes(definition.name)) continue;
    definition.inputSchema.properties.taskId ??= {
        type: "string",
        description: "Task receiving the edit history; required for attribution when this agent has multiple active tasks.",
    };
}

for (const [name, handler] of Object.entries(handlers)) {
    if (["read_function", "recover_stale_edit"].includes(name)) continue;
    handlers[name] = async (args, ctx) => {
        if (!ctx.lockingEnabled) return handler(args, ctx);
        const agentId = args.agentId || ctx.defaultAgentId;
        const driver = pickDbDriver(ctx, args);
        return withScopeGuard({ driver, root: PROJECT_ROOT, agentId, taskId: args.taskId }, async () => {
            try {
                for (const file of [args.file, args.targetFile, ...(args.edits || []).map((e: any) => e.file)].filter(Boolean)) {
                    await assertFileScope(resolve(PROJECT_ROOT, file));
                }
                return await handler({ ...args, agentId }, { ...ctx, lockingEnabled: false });
            } catch (error: any) {
                return { content: [{ type: "text", text: JSON.stringify({ status: error.code || "ERROR", error: error.message }) }], isError: true };
            }
        });
    };
}

export const editTools: ToolModule = { definitions, handlers };

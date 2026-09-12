/** Best-effort MCP operation history; direct filesystem edits are outside its scope. */
import { appendFileSync, mkdirSync, statSync, renameSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { ToolHandler, ServerContext, GraphDriver } from './graph.js';
import { pickDbName } from './graph.js';

const PROJECT_ROOT = process.env.CODEVIS_PROJECT_DIR || resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const LOG_DIR = resolve(PROJECT_ROOT, '.claude/logs');
const LOG_TO_GRAPH = process.env.LOG_TO_GRAPH === 'true';
const MAX_LOG_BYTES = 100 * 1024 * 1024;

// This identifies one MCP server process, not a host application's chat session.
export const mcpSessionId = randomUUID();

export interface LogEntry {
    timestamp: string;
    operationId: string;
    mcpSessionId: string;
    pid: number;
    agent: string | null;
    taskId: string | null;
    db: string;
    operation: string;
    params: Record<string, unknown>;
    result: 'ok' | 'error';
    durationMs: number;
    error?: string;
}

const SENSITIVE_PATTERNS = [
    /passw(ord)?/i,
    /secret/i,
    /token/i,
    /auth/i,
    /credential/i,
    /api[_-]?key/i,
    /private[_-]?key/i,
];

function isSensitiveKey(key: string): boolean {
    return SENSITIVE_PATTERNS.some(p => p.test(key));
}

export function sanitizeParams(params: Record<string, unknown>): Record<string, unknown> {
    const ancestors = new WeakSet<object>();
    const sanitize = (value: unknown): unknown => {
        if (typeof value === 'string') return value.length > 2000 ? value.slice(0, 2000) + '?[truncated]' : value;
        if (value === null || typeof value !== 'object') return value;
        if (ancestors.has(value)) return '[Circular]';
        ancestors.add(value);
        const result = Array.isArray(value)
            ? value.map(sanitize)
            : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, isSensitiveKey(key) ? '[REDACTED]' : sanitize(item)]));
        ancestors.delete(value);
        return result;
    };
    return sanitize(params) as Record<string, unknown>;
}

// ── JSONL file sink ───────────────────────────────────────────────────────────

function getLogFilePath(): string {
    const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    return resolve(LOG_DIR, `${date}.jsonl`);
}

function writeToFile(entry: Record<string, unknown>): void {
    try {
        mkdirSync(LOG_DIR, { recursive: true });
        const filePath = getLogFilePath();

        // Rotation: if file > MAX_LOG_BYTES, rename to .old and start fresh
        try {
            const stats = statSync(filePath);
            if (stats.size >= MAX_LOG_BYTES) {
                renameSync(filePath, filePath + ".old");
            }
        } catch {
            // File doesn't exist yet — that's fine
        }

        appendFileSync(filePath, JSON.stringify(entry) + "\n", "utf-8");
    } catch {
        // Logger failures must never propagate to the handler
    }
}

// ── Graph sink ────────────────────────────────────────────────────────────────

async function writeToGraph(entry: LogEntry, driver: GraphDriver): Promise<void> {
    const session = driver.session();
    try {
        // Match before writing: Ladybug does not support OPTIONAL MATCH after CREATE.
        await session.run(
            `OPTIONAL MATCH (t:Task {taskId: $taskId})
             CREATE (l:LogEntry {
                uid: $operationId, sessionId: $sessionId, timestamp: $timestamp,
                agent: $agent, taskId: $taskId, operation: $operation,
                result: $result, durationMs: $durationMs, error: $error
             })
             WITH l, t WHERE t IS NOT NULL
             MERGE (l)-[:LOG_OF]->(t)`,
            {
                operationId: entry.operationId, sessionId: entry.mcpSessionId,
                timestamp: Date.parse(entry.timestamp), agent: entry.agent,
                taskId: entry.taskId, operation: entry.operation,
                result: entry.result, durationMs: entry.durationMs, error: entry.error ?? null,
            },
        );
    } finally {
        await session.close();
    }
}

function extractAgentId(args: Record<string, unknown>, ctx: ServerContext): string | null {
    for (const value of [args.agentId, args.callerAgentId, args.createdBy, ctx.defaultAgentId, process.env.CODEVIS_AGENT_ID]) {
        if (typeof value === 'string' && value.trim()) return value;
    }
    // assignedTo and targetAgentId name the subject, not necessarily the caller.
    return null;
}

/** Register at the MCP boundary so aliases and nested handlers log only once. */
export function logOperation(operation: string, handler: ToolHandler): ToolHandler {
    return async (args, ctx) => {
        const start = Date.now();
        const operationId = randomUUID();
        const agent = extractAgentId(args, ctx);
        const taskId = typeof args.taskId === 'string' ? args.taskId : null;
        let db = 'unknown';
        try {
            db = ['codevis_db', 'meta_db'].includes(operation) ? 'codevis_db'
                : ['project_db', 'tool_db'].includes(operation) ? 'project_db' : pickDbName(args);
        } catch { /* The handler owns argument validation. */ }
        let params: Record<string, unknown> = {};
        try { params = sanitizeParams(args); } catch { /* Logging must not prevent a handler call. */ }
        let result: 'ok' | 'error' = 'ok';
        let error: string | undefined;
        try {
            const response: any = await handler(args, ctx);
            if (response.isError) {
                result = 'error';
                error = String(response.content?.[0]?.text ?? '').slice(0, 300);
            }
            return { ...response, _meta: { ...response._meta, codevisOperation: { operationId, mcpSessionId, pid: process.pid } } };
        } catch (err) {
            result = 'error';
            error = (err instanceof Error ? err.message : String(err)).slice(0, 300);
            throw err;
        } finally {
            const entry: LogEntry = {
                timestamp: new Date().toISOString(), operationId, mcpSessionId, pid: process.pid,
                agent, taskId, db, operation, params, result, durationMs: Date.now() - start,
                ...(error !== undefined ? { error } : {}),
            };
            writeToFile(entry as unknown as Record<string, unknown>);
            if (LOG_TO_GRAPH) {
                const driver = db === 'codevis_db' ? ctx.metaDriver : db === 'project_db' ? ctx.targetDriver : null;
                if (driver) writeToGraph(entry, driver).catch(() => {});
            }
        }
    };
}

type LogLevel = 'info' | 'warn' | 'error';
function writeManualEntry(level: LogLevel, message: string, context?: Record<string, unknown>): void {
    const entry = {
        timestamp: new Date().toISOString(), mcpSessionId, pid: process.pid, level, message,
        ...(context ? { context: sanitizeParams(context) } : {}),
    };
    writeToFile(entry);
    process.stderr.write(`[codevis:${level}] ${message}\n`);
}

export const logger = {
    info: (message: string, context?: Record<string, unknown>) => writeManualEntry('info', message, context),
    warn: (message: string, context?: Record<string, unknown>) => writeManualEntry('warn', message, context),
    error: (message: string, context?: Record<string, unknown>) => writeManualEntry('error', message, context),
} as const;

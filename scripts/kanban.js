#!/usr/bin/env node
/**
 * CodeVis Kanban Board — Live terminal dashboard for agent task tracking.
 *
 * Usage:
 *   node scripts/kanban.js              # One-shot display
 *   node scripts/kanban.js --watch      # Auto-refresh every 3s
 *   node scripts/kanban.js --watch 5    # Auto-refresh every 5s
 *
 * Shows:
 *   - Task status across all agents (from the graph)
 *   - Active locks per agent
 *   - Recent team activity (from .claude/team-activity.jsonl)
 */

// Embedded Ladybug DB via the driver-compatible compat client.
const ladybug = require('../server/ladybug-driver.cjs');
const { readFileSync, existsSync } = require('fs');
const { resolve } = require('path');

const path = require('path');
const projectDir = process.env.CODEVIS_PROJECT_DIR || path.resolve(__dirname, '..');
const { withInternalWorkspaceAliases } = require('../lib/workspace-names.cjs');
const config = withInternalWorkspaceAliases(require(path.resolve(projectDir, 'codevis.config.cjs')));
// Use target workspace (external projects) or meta (self-analysis)
const meta = config.workspaces.target || config.workspaces.meta;

const WATCH = process.argv.includes('--watch');
const INTERVAL = parseInt(process.argv[process.argv.indexOf('--watch') + 1]) || 3;

const COLORS = {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    dim: '\x1b[2m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    white: '\x1b[37m',
    bgRed: '\x1b[41m',
    bgGreen: '\x1b[42m',
    bgYellow: '\x1b[43m',
    bgBlue: '\x1b[44m',
    bgMagenta: '\x1b[45m',
};

const STATUS_COLORS = {
    open: COLORS.white,
    todo: COLORS.cyan,
    backlog: COLORS.dim,
    in_progress: COLORS.yellow,
    blocked: COLORS.red,
    needs_info: COLORS.yellow,
    review: COLORS.magenta,
    done: COLORS.green,
};

const STATUS_ICONS = {
    open: '○',
    todo: '◐',
    backlog: '◌',
    in_progress: '◉',
    blocked: '✕',
    needs_info: '?',
    review: '◈',
    done: '●',
};

const PRIO_COLORS = {
    critical: COLORS.bgRed + COLORS.white,
    high: COLORS.red,
    medium: COLORS.yellow,
    low: COLORS.dim,
};

async function render() {
    const driver = ladybug.driver((meta.dbUri || meta.neo4jUri), ladybug.auth.basic(meta.auth.user, meta.auth.pass));
    const session = driver.session();

    try {
        // Fetch tasks
        const taskResult = await session.run(`
            MATCH (t:Task)
            OPTIONAL MATCH (t)-[:AFFECTS]->(n)
            RETURN t.taskId AS id, t.title AS title, t.status AS status,
                   t.priority AS priority, t.assignedTo AS assignedTo,
                   t.createdBy AS createdBy, t.summary AS summary,
                   count(n) AS affectedNodes
            ORDER BY
                CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
                id
        `);

        // Fetch locks
        const lockResult = await session.run(`
            MATCH (n) WHERE n.locked = true
            RETURN n.lockedBy AS agent, n.lockGroup AS lockGroup, count(n) AS nodeCount
            ORDER BY agent
        `);

        // Clear screen
        if (WATCH) process.stdout.write('\x1b[2J\x1b[H');

        const width = process.stdout.columns || 100;
        const line = '─'.repeat(width);

        // Header
        console.log(`${COLORS.bold}${COLORS.cyan}╔${'═'.repeat(width - 2)}╗${COLORS.reset}`);
        console.log(`${COLORS.bold}${COLORS.cyan}║${center('CodeVis Agent Kanban Board', width - 2)}║${COLORS.reset}`);
        console.log(`${COLORS.bold}${COLORS.cyan}╚${'═'.repeat(width - 2)}╝${COLORS.reset}`);
        console.log(`  ${COLORS.dim}${new Date().toLocaleTimeString('de-DE')}${WATCH ? ` (refresh: ${INTERVAL}s)` : ''}${COLORS.reset}`);
        console.log();

        // Tasks by status
        const tasks = taskResult.records.map(r => ({
            id: r.get('id'),
            title: r.get('title'),
            status: r.get('status') || 'open',
            priority: r.get('priority') || 'medium',
            assignedTo: r.get('assignedTo'),
            createdBy: r.get('createdBy'),
            summary: r.get('summary'),
            affectedNodes: toNum(r.get('affectedNodes')),
        }));

        const columns = ['backlog', 'open', 'in_progress', 'blocked', 'needs_info', 'review', 'done'];
        const grouped = {};
        for (const col of columns) grouped[col] = [];
        for (const t of tasks) {
            const col = columns.includes(t.status) ? t.status : 'open';
            grouped[col].push(t);
        }

        // Column headers
        const colWidth = Math.floor((width - 4) / columns.length);
        let headerLine = '  ';
        for (const col of columns) {
            const icon = STATUS_ICONS[col] || '○';
            const color = STATUS_COLORS[col] || COLORS.white;
            const label = `${icon} ${col.toUpperCase()} (${grouped[col].length})`;
            headerLine += color + COLORS.bold + padRight(label, colWidth) + COLORS.reset;
        }
        console.log(headerLine);
        console.log(`  ${COLORS.dim}${line}${COLORS.reset}`);

        // Task rows
        const maxRows = Math.max(...columns.map(c => grouped[c].length), 1);
        for (let row = 0; row < maxRows; row++) {
            let taskLine = '  ';
            for (const col of columns) {
                const t = grouped[col][row];
                if (t) {
                    const prioColor = PRIO_COLORS[t.priority] || '';
                    const prio = `[${t.priority.charAt(0).toUpperCase()}]`;
                    const agent = t.assignedTo ? ` @${t.assignedTo}` : '';
                    const title = truncate(t.title, Math.max(1, colWidth - prio.length - 1 - agent.length));
                    taskLine += `${prioColor}${prio}${COLORS.reset} ${title}${COLORS.dim}${agent}${COLORS.reset}`;
                    taskLine += ' '.repeat(Math.max(0, colWidth - prio.length - 1 - visLen(title) - agent.length));
                } else {
                    taskLine += ' '.repeat(colWidth);
                }
            }
            console.log(taskLine);
        }

        // Lock summary
        console.log();
        console.log(`  ${COLORS.bold}${COLORS.blue}Active Locks${COLORS.reset}`);
        console.log(`  ${COLORS.dim}${line}${COLORS.reset}`);

        const locks = lockResult.records.map(r => ({
            agent: r.get('agent'),
            lockGroup: r.get('lockGroup'),
            nodeCount: toNum(r.get('nodeCount')),
        }));

        if (locks.length === 0) {
            console.log(`  ${COLORS.dim}No active locks${COLORS.reset}`);
        } else {
            const byAgent = {};
            for (const l of locks) {
                if (!byAgent[l.agent]) byAgent[l.agent] = { total: 0, groups: [] };
                byAgent[l.agent].total += l.nodeCount;
                byAgent[l.agent].groups.push(`${l.lockGroup}(${l.nodeCount})`);
            }
            for (const [agent, data] of Object.entries(byAgent)) {
                console.log(`  ${COLORS.yellow}@${agent}${COLORS.reset} — ${data.total} nodes locked [${COLORS.dim}${data.groups.join(', ')}${COLORS.reset}]`);
            }
        }

        // Recent activity
        const activityFile = resolve(projectDir, '.claude/team-activity.jsonl');
        if (existsSync(activityFile)) {
            const lines = readFileSync(activityFile, 'utf-8').trim().split('\n').slice(-5);
            if (lines.length > 0 && lines[0]) {
                console.log();
                console.log(`  ${COLORS.bold}${COLORS.magenta}Recent Activity${COLORS.reset}`);
                console.log(`  ${COLORS.dim}${line}${COLORS.reset}`);
                for (const l of lines) {
                    try {
                        const e = JSON.parse(l);
                        const time = new Date(e.timestamp).toLocaleTimeString('de-DE');
                        const icon = e.event === 'task_created' ? '+' : '✓';
                        console.log(`  ${COLORS.dim}${time}${COLORS.reset} ${icon} ${e.subject || e.taskId} ${COLORS.dim}(@${e.teammate})${COLORS.reset}`);
                    } catch {}
                }
            }
        }

        console.log();

    } finally {
        await session.close();
        await driver.close();
    }
}

function toNum(val) {
    if (val == null) return 0;
    if (typeof val.toNumber === 'function') return val.toNumber();
    if (typeof val.low === 'number') return val.low;
    return Number(val) || 0;
}

function center(str, width) {
    const pad = Math.max(0, width - str.length);
    const left = Math.floor(pad / 2);
    return ' '.repeat(left) + str + ' '.repeat(pad - left);
}

function padRight(str, width) {
    const vis = visLen(str);
    return str + ' '.repeat(Math.max(0, width - vis));
}

function truncate(str, maxLen) {
    if (str.length <= maxLen) return str;
    return str.slice(0, maxLen - 1) + '…';
}

function visLen(str) {
    // Strip ANSI escape codes for visual length
    return str.replace(/\x1b\[[0-9;]*m/g, '').length;
}

async function main() {
    if (WATCH) {
        while (true) {
            try {
                await render();
            } catch (err) {
                console.error(`${COLORS.red}Error: ${err.message}${COLORS.reset}`);
            }
            await new Promise(r => setTimeout(r, INTERVAL * 1000));
        }
    } else {
        await render();
    }
}

main().catch(err => {
    console.error(err.message);
    process.exit(1);
});

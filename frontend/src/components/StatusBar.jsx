
import { useState, useEffect } from 'react';
import { version } from '../../../package.json';

import BRIDGE_URL from '../bridgeUrl';
import { matchesWorkspace, workspaceRequestId } from '../kanban/realtimeModel';

const STATUS_COLORS = {
    backlog: "var(--muted)",
    todo: "var(--info)",
    in_progress: "var(--warning)",
    review: "var(--violet)",
    blocked: "var(--danger)",
    needs_info: "var(--warning)",
    done: "var(--success)",
};

const AGENT_PALETTE = ["var(--info)", "var(--warning)", '#e855a0', '#55e8a0', "var(--violet)", "var(--warning)"];

// Compact node count: 12000 -> "12k", 49537 -> "50k".
const fmtK = (n) => (n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`);

function StatusBar({ force2d = false, capped = null, db: dbProp, socket, connected = null } = {}) {
    const [tasks, setTasks] = useState([]);
    const [lockCount, setLockCount] = useState(0);
    // Footer follows the active graph (DB toggle). Hardcoding 'meta' showed
    // "locks 0 / tasks 0/0" while the real locks/tasks live in 'target'.
    const [db, setDb] = useState(dbProp || 'project_db');
    useEffect(() => {
        if (dbProp) { setDb(dbProp); return; }
        let cancelled = false;
        fetch(`${BRIDGE_URL}/api/status`)
            .then(r => (r.ok ? r.json() : null))
            .then(cfg => { if (!cancelled && cfg && cfg.activeDb) setDb(cfg.activeDb); })
            .catch(() => {});
        return () => { cancelled = true; };
    }, [dbProp]);

    useEffect(() => {
        setTasks([]);
        let live = true;
        let requestId;
        setLockCount(0);
        const requestTasks = () => {
            requestId = workspaceRequestId();
            socket?.emit('tasks:request', { db, requestId });
        };
        const onTasksInit = (data, meta) => {
            if (matchesWorkspace(meta, db) && meta.requestId === requestId) setTasks(data);
        };
        const onTaskStatusChanged = (updated) => {
            if (!matchesWorkspace(updated, db)) return;
            setTasks(prev => prev.map(t =>
                t.taskId === updated.taskId ? { ...t, ...updated } : t
            ));
        };
        const onTaskCreated = (task) => {
            if (!matchesWorkspace(task, db)) return;
            setTasks(prev => {
                if (prev.some(t => t.taskId === task.taskId)) return prev;
                return [...prev, task];
            });
        };
        const onLocksChanged = (event) => {
            if (!matchesWorkspace(event, db)) return;
            setLockCount(event.count);
            requestTasks();
        };

        if (socket) {
            socket.on('connect', requestTasks);
            socket.on('tasks:init', onTasksInit);
            socket.on('task:status-changed', onTaskStatusChanged);
            socket.on('task:created', onTaskCreated);
            socket.on('locks:changed', onLocksChanged);
            if (socket.connected) requestTasks();
        }

        // Initial lock count fetch
        fetch(`${BRIDGE_URL}/api/locks?db=${encodeURIComponent(db)}`)
            .then(r => r.ok ? r.json() : null)
            .then(data => {
                if (live && data && Array.isArray(data)) setLockCount(data.length);
            })
            .catch(() => {});

        return () => {
            socket?.off('connect', requestTasks);
            live = false;
            socket?.off('tasks:init', onTasksInit);
            socket?.off('task:status-changed', onTaskStatusChanged);
            socket?.off('task:created', onTaskCreated);
            socket?.off('locks:changed', onLocksChanged);
        };
    }, [db, socket]);

    // Derived stats
    const inProgress = tasks.filter(t => t.status === 'in_progress');
    const done = tasks.filter(t => t.status === 'done');
    const total = tasks.length;
    const progressPct = total > 0 ? Math.round((done.length / total) * 100) : 0;

    // Active agents: unique assignedTo from in_progress tasks
    const activeAgents = [...new Set(
        inProgress.map(t => t.assignedTo).filter(Boolean)
    )];

    const styles = {
        bar: {
            display: 'flex',
            alignItems: 'center',
            height: '100%',
            padding: '0 12px',
            fontSize: '11px',
            fontFamily: "'JetBrains Mono', 'Inter', monospace",
            color: "var(--muted)",
            overflow: 'hidden',
        },
        section: {
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            paddingRight: '14px',
            marginRight: '14px',
            borderRight: "1px solid var(--border)",
            whiteSpace: 'nowrap',
        },
        sectionLast: {
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            whiteSpace: 'nowrap',
        },
        dot: (color) => ({
            width: '6px',
            height: '6px',
            borderRadius: '50%',
            backgroundColor: color,
            flexShrink: 0,
        }),
        label: {
            color: "var(--muted)",
            fontSize: '10px',
            textTransform: 'uppercase',
            letterSpacing: '0.5px',
        },
        value: {
            color: "var(--text)",
            fontWeight: 600,
        },
        agentBadge: (color) => ({
            fontSize: '10px',
            padding: '0 5px',
            borderRadius: '3px',
            backgroundColor: color + '1a',
            color: color,
            fontWeight: 600,
        }),
        progressTrack: {
            width: '60px',
            height: '4px',
            backgroundColor: "var(--border)",
            borderRadius: '2px',
            overflow: 'hidden',
        },
        progressFill: {
            height: '100%',
            width: `${progressPct}%`,
            backgroundColor: progressPct === 100 ? "var(--success)" : "var(--warning)",
            borderRadius: '2px',
            transition: 'width 0.4s ease',
        },
        spacer: {
            flex: 1,
        },
        brand: {
            fontSize: '11px',
            fontWeight: 700,
            color: "var(--text)",
            letterSpacing: '0.5px',
        },
    };

    return (
        <div style={styles.bar}>
            {/* Brand */}
            <div style={styles.section}>
                <span style={styles.brand}>CodeVis</span>
            </div>

            {/* Connection */}
            <div style={styles.section}>
                <span style={styles.dot(connected == null ? "var(--warning)" : connected ? "var(--success)" : "var(--danger)")} />
                <span style={{ color: connected == null ? "var(--warning)" : connected ? "var(--success)" : "var(--danger)" }}>
                    {connected == null ? 'Connecting' : connected ? 'Bridge' : 'Offline'}
                </span>
            </div>

            {/* Active Agents */}
            <div style={styles.section}>
                <span style={styles.label}>Agents</span>
                {activeAgents.length === 0 ? (
                    <span style={styles.value}>—</span>
                ) : (
                    activeAgents.map((agent, i) => {
                        const color = AGENT_PALETTE[i % AGENT_PALETTE.length];
                        return (
                            <span key={agent} style={styles.agentBadge(color)}>
                                {agent}
                            </span>
                        );
                    })
                )}
            </div>

            {/* Lock Count */}
            <div style={styles.section}>
                <span style={styles.label}>Locks</span>
                <span style={{
                    ...styles.value,
                    color: lockCount > 0 ? "var(--warning)" : 'var(--muted, #888)',
                }}>
                    {lockCount}
                </span>
            </div>

            {/* Task Progress */}
            <div style={styles.section}>
                <span style={styles.label}>Tasks</span>
                <span style={styles.value}>{done.length}/{total}</span>
                <div style={styles.progressTrack}>
                    <div style={styles.progressFill} />
                </div>
                <span style={{
                    ...styles.value,
                    color: progressPct === 100 ? "var(--success)" : 'var(--text, #1a1a1a)',
                }}>
                    {progressPct}%
                </span>
            </div>

            {/* In-Progress Task Titles */}
            {inProgress.length > 0 && (
                <div style={styles.section}>
                    <span style={styles.dot(STATUS_COLORS.in_progress)} />
                    <span style={styles.label}>Running</span>
                    <span style={{ ...styles.value, color: STATUS_COLORS.in_progress }}>
                        {inProgress.length}
                    </span>
                    {inProgress.slice(0, 2).map(t => (
                        <span key={t.taskId} title={t.title} style={{
                            fontSize: '10px',
                            color: "var(--muted)",
                            maxWidth: '120px',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                        }}>
                            {t.title}
                        </span>
                    ))}
                    {inProgress.length > 2 && (
                        // The bar shows two titles; everything beyond that used to
                        // collapse into a bare "+N" with no way to find out what N
                        // stood for. The rest are listed on hover, capped so the
                        // native tooltip cannot grow past a screenful.
                        <span
                            style={{ ...styles.label, cursor: 'help' }}
                            title={(() => {
                                const rest = inProgress.slice(2);
                                const shown = rest.slice(0, 10).map(t => t.title);
                                if (rest.length > 10) shown.push(`…and ${rest.length - 10} more`);
                                return shown.join('\n');
                            })()}
                        >
                            +{inProgress.length - 2}
                        </span>
                    )}
                </div>
            )}

            {/* Render-mode indicator: only when the 3D->2D fallback kicked in
                or Level 3 was capped. Full explanation on hover (title). */}
            {(force2d || capped) && (
                <div
                    style={styles.section}
                    title={[
                        force2d && '3D disabled on large graphs — 2D for performance',
                        capped && `Level 3 capped: ${capped.shown.toLocaleString()} of ${capped.total.toLocaleString()} nodes`,
                    ].filter(Boolean).join(' · ')}
                >
                    <span style={{ ...styles.value, color: "var(--warning)" }}>
                        {[
                            force2d && '2D',
                            capped && `${fmtK(capped.shown)}/${fmtK(capped.total)}`,
                        ].filter(Boolean).join('·')}
                    </span>
                </div>
            )}

            <div style={styles.spacer} />

            {/* Right: version */}
            <div style={styles.sectionLast}>
                <span style={styles.label}>v{version}</span>
            </div>
        </div>
    );
}

export default StatusBar;

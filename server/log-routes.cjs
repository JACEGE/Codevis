const fs = require('fs');
const path = require('path');

function requestedDate(value, now = new Date()) {
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
        ? value
        : now.toISOString().slice(0, 10);
}

function requestedLimit(value) {
    const parsed = parseInt(value, 10);
    return !Number.isNaN(parsed) && parsed > 0 ? Math.min(parsed, 5000) : 200;
}

function readLogEntries(logDir, query, fileSystem = fs) {
    const date = requestedDate(query.date);
    const logFile = path.resolve(logDir, `${date}.jsonl`);
    if (!fileSystem.existsSync(logFile)) return { date, entries: [], total: 0 };

    const entries = [];
    for (const line of fileSystem.readFileSync(logFile, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        let entry;
        try { entry = JSON.parse(line); } catch { continue; }
        if (typeof query.agent === 'string' && query.agent && entry.agent !== query.agent) continue;
        if (typeof query.taskId === 'string' && query.taskId && entry.taskId !== query.taskId) continue;
        if (typeof query.op === 'string' && query.op && entry.operation !== query.op) continue;
        entries.push(entry);
    }
    const limit = requestedLimit(query.limit);
    return { date, entries: entries.slice(-limit).reverse(), total: entries.length };
}

function listLogDates(logDir, fileSystem = fs) {
    if (!fileSystem.existsSync(logDir)) return [];
    return fileSystem.readdirSync(logDir)
        .filter((file) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(file))
        .map((file) => file.replace('.jsonl', ''))
        .sort()
        .reverse();
}

function registerLogRoutes(app, { logDir }) {
    app.get('/api/logs', (req, res) => {
        try {
            res.json(readLogEntries(logDir, req.query));
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });
    app.get('/api/logs/dates', (_req, res) => {
        try {
            res.json({ dates: listLogDates(logDir) });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });
}

module.exports = { listLogDates, readLogEntries, registerLogRoutes, requestedDate, requestedLimit };

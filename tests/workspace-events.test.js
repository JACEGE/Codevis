const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const { createServer } = require('node:http');
const { Server } = require('socket.io');
const WebSocket = require('ws');
const { subscribeWorkspace, emitWorkspace } = require('../server/workspace-events.cjs');

test('Knowledge PATCH honors query db and emits to the workspace captured before awaiting the write', async () => {
    const sourceCallback = require('./helpers/source-callback.cjs');
    const selected = [], events = [];
    let finish;
    const globals = { activeDb: 'project_db', KNOWLEDGE_CATEGORIES: [], io: {},
        getTaskDriver: db => { selected.push(db); return { session: () => ({ workspace: db, close: async () => {} }) }; },
        updateKnowledge: () => new Promise(resolve => { finish = resolve; }),
        emitWorkspace: (_io, db) => events.push(db),
    };
    const handler = sourceCallback('server/bridge.js', '/api/knowledge', globals, 'patch');
    const res = { status() { return this; }, json() {} };
    const queryWrite = handler({ body: { content: 'note', nodeId: 'knowledge:1' }, query: { db: 'codevis_db' } }, res);
    finish({ content: 'note' }); await queryWrite;
    assert.equal(selected[0], 'codevis_db');
    const defaultWrite = handler({ body: { content: 'note', nodeId: 'knowledge:1' }, query: {} }, res);
    globals.activeDb = 'codevis_db';
    finish({ content: 'note' }); await defaultWrite;
    assert.deepEqual(events, ['codevis_db', 'project_db']);
});

test('real Socket.IO room broadcasts stay inside the subscribed database', async () => {
    const server = createServer();
    const io = new Server(server);
    io.on('connection', socket => {
        socket.on('subscribe', db => socket.emit('subscribed', subscribeWorkspace(socket, db)));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const clients = [];
    const connect = async db => {
        const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/socket.io/?EIO=4&transport=websocket`);
        clients.push(ws);
        const events = new EventEmitter();
        const received = [];
        ws.on('message', message => {
            const value = String(message);
            if (value.startsWith('0')) ws.send('40');
            else if (value.startsWith('40')) ws.send('42' + JSON.stringify(['subscribe', db]));
            else if (value.startsWith('42')) {
                const [event, payload] = JSON.parse(value.slice(2));
                received.push({ event, payload }); events.emit(event, payload);
            }
        });
        await once(events, 'subscribed', { signal: AbortSignal.timeout(3000) });
        return { ws, events, received };
    };
    const flush = async clients => {
        const waits = clients.map(client => once(client.events, 'barrier', { signal: AbortSignal.timeout(3000) }));
        io.emit('barrier'); await Promise.all(waits);
    };
    try {
        const project = await connect('target');
        const self = await connect('codevis_db');
        emitWorkspace(io, 'meta', 'task:created', { taskId: 'self-only' });
        emitWorkspace(io, 'project_db', 'idea:created', { ideaId: 'project-only' });
        await flush([project, self]);
        assert.equal(project.received.some(item => item.event === 'task:created'), false);
        assert.deepEqual(self.received.find(item => item.event === 'task:created').payload, { taskId: 'self-only', db: 'codevis_db' });
        assert.equal(self.received.some(item => item.event === 'idea:created'), false);
        assert.equal(project.received.find(item => item.event === 'idea:created').payload.db, 'project_db');
        const subscribed = once(project.events, 'subscribed');
        project.ws.send('42' + JSON.stringify(['subscribe', 'meta'])); await subscribed;
        emitWorkspace(io, 'target', 'task:deleted', { taskId: 'old-db' });
        await flush([project, self]);
        assert.equal(project.received.some(item => item.event === 'task:deleted'), false);
    } finally {
        clients.forEach(client => client.terminate());
        await new Promise(resolve => io.close(resolve));
    }
});

test('Kanban ignores foreign events, old database snapshots and completed stale polls', async () => {
    const { subscribeKanbanWorkspace } = await import('../frontend/src/kanban/workspaceSubscription.js');
    const socket = new EventEmitter();
    socket.connected = true;
    const requests = [];
    socket.on('tasks:request', request => requests.push(request));
    let tasks = [], ideas = [], detail = { taskId: 'same-id', comments: [] };
    let resolvePoll;
    const options = {
        socket, setConnected() {},
        setTasks: next => { tasks = typeof next === 'function' ? next(tasks) : next; },
        setIdeas: next => { ideas = typeof next === 'function' ? next(ideas) : next; },
        setTaskDetail: next => { detail = typeof next === 'function' ? next(detail) : next; },
        fetchTasks: () => new Promise(resolve => { resolvePoll = resolve; }),
    };
    const old = subscribeKanbanWorkspace({ ...options, db: 'project_db' });
    const oldRequest = requests.at(-1);
    const polling = old.poll();
    old.dispose();
    const current = subscribeKanbanWorkspace({ ...options, db: 'codevis_db' });
    try {
        const request = requests.at(-1);
        socket.emit('tasks:init', [{ taskId: 'same-id', title: 'Self task' }], request);
        socket.emit('tasks:init', [{ taskId: 'foreign' }], oldRequest);
        socket.emit('task:created', { db: 'project_db', taskId: 'foreign' });
        socket.emit('task:deleted', { db: 'project_db', taskId: 'same-id' });
        socket.emit('task:status-changed', { db: 'project_db', taskId: 'same-id', title: 'Wrong title' });
        socket.emit('task:comments-changed', { db: 'project_db', taskId: 'same-id', comments: ['foreign'] });
        socket.emit('idea:created', { db: 'project_db', ideaId: 'foreign' });
        resolvePoll([{ taskId: 'late-poll' }]); await polling;
        assert.deepEqual(tasks, [{ taskId: 'same-id', title: 'Self task' }]);
        assert.deepEqual(detail.comments, []);
        assert.deepEqual(ideas, []);
        socket.emit('task:created', { db: 'codevis_db', taskId: 'new-self' });
        assert.equal(tasks.length, 2);
        current.requestTasks();
        socket.emit('tasks:init', [{ taskId: 'obsolete-request' }], request);
        assert.equal(tasks.length, 2);
    } finally { current.dispose(); }
});

test('a late poll cannot undo a newer live task change or a newer poll', async () => {
    const { subscribeKanbanWorkspace } = await import('../frontend/src/kanban/workspaceSubscription.js');
    const socket = new EventEmitter(); socket.connected = true;
    let tasks = []; const requests = [];
    const subscription = subscribeKanbanWorkspace({db: 'project_db', socket, setConnected() {}, setIdeas() {}, setTaskDetail() {},
        setTasks: value => { tasks = typeof value === 'function' ? value(tasks) : value; },
        fetchTasks: () => new Promise(resolve => requests.push(resolve)),
    });
    try {
        const poll = subscription.poll();
        socket.emit('task:status-changed', {db: 'project_db', taskId: 'A', status: 'done'});
        requests[0]([{taskId: 'A', status: 'backlog'}]); await poll;
        assert.equal(tasks[0].status, 'done');
        const old = subscription.poll(); const newer = subscription.poll();
        requests[2]([{taskId: 'A', status: 'review'}]); await newer;
        requests[1]([{taskId: 'A', status: 'backlog'}]); await old;
        assert.equal(tasks[0].status, 'review');
    } finally {subscription.dispose();}
});

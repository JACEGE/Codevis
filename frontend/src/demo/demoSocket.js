/**
 * Stand-in for socket.io-client in the demo build (aliased in vite.config.js).
 * Replays the events a bridge sends on connect and answers the few requests
 * the dashboard emits, from the recording installed by installDemo.js.
 */

class DemoSocket {
    constructor() {
        this.handlers = new Map();
        this.connected = false;
        this.id = 'demo';
        setTimeout(() => this.open(), 50);
    }

    recorded(event) {
        return window.__CODEVIS_DEMO__?.events.get(event);
    }

    open() {
        if (this.closed) return;
        this.connected = true;
        this.fire('connect');
        for (const event of ['config:status', 'graph:init', 'graph:nodeIds']) {
            const args = this.recorded(event);
            if (args) this.fire(event, ...args);
        }
    }

    fire(event, ...args) {
        for (const handler of [...(this.handlers.get(event) || [])]) {
            try { handler(...args); } catch (error) { console.error('[demo socket]', event, error); }
        }
    }

    on(event, handler) {
        if (!this.handlers.has(event)) this.handlers.set(event, new Set());
        this.handlers.get(event).add(handler);
        return this;
    }

    once(event, handler) {
        const wrapper = (...args) => { this.off(event, wrapper); handler(...args); };
        return this.on(event, wrapper);
    }

    off(event, handler) {
        if (!event) this.handlers.clear();
        else if (!handler) this.handlers.delete(event);
        else this.handlers.get(event)?.delete(handler);
        return this;
    }

    removeAllListeners(event) { return this.off(event); }

    emit(event, data) {
        const reply = { 'tasks:request': 'tasks:init', 'ideas:request': 'ideas:init' }[event];
        if (reply) {
            const args = this.recorded(reply);
            if (args) setTimeout(() => this.fire(reply, args[0], { ...(args[1] || {}), requestId: data?.requestId }), 30);
        } else if (event === 'graph:setLevel') {
            const args = this.recorded('graph:init');
            if (args) setTimeout(() => this.fire('graph:init', ...args), 30);
        }
        return this;
    }

    connect() { if (!this.connected) setTimeout(() => this.open(), 0); return this; }

    disconnect() {
        this.closed = true;
        this.connected = false;
        return this;
    }

    close() { return this.disconnect(); }
}

export function io() { return new DemoSocket(); }
export default io;

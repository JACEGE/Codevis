const test = require('node:test');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const path = require('node:path');
const frontendRequire = createRequire(path.resolve(__dirname, '../frontend/package.json'));
const React = frontendRequire('react');
const { createRoot } = frontendRequire('react-dom/client');
const { JSDOM } = frontendRequire('jsdom');

test('hiding and showing a graph pauses resources without rebuilding layout or resetting the camera', async () => {
    const dom = new JSDOM('<div id="root"></div>');
    const originals = new Map(['window', 'document', 'Worker', 'requestAnimationFrame', 'cancelAnimationFrame', 'IS_REACT_ACT_ENVIRONMENT'].map(key => [key, global[key]]));
    global.window = dom.window;
    global.document = dom.window.document;
    global.IS_REACT_ACT_ENVIRONMENT = true;
    const workers = [], frames = new Map();
    let frameId = 0, cameraFits = 0, paused = false;
    global.Worker = class {
        constructor() { this.messages = []; workers.push(this); }
        postMessage(message) { this.messages.push(message); }
        terminate() { this.terminated = true; }
    };
    global.requestAnimationFrame = fn => { frames.set(++frameId, fn); return frameId; };
    global.cancelAnimationFrame = id => frames.delete(id);
    const graphRef = { current: {
        d3Force: () => ({ strength() {} }),
        pauseAnimation() { paused = true; }, resumeAnimation() { paused = false; },
        zoomToFit() { cameraFits++; },
    } };
    const graphData = { nodes: [{ id: 'node', x: 12, y: 24, z: 0 }], links: [] };
    const { default: useForceLayout } = await import('../frontend/src/hooks/useForceLayout.js');
    function Graph({ active, frozen = false }) {
        useForceLayout({ graphRef, graphData, nodeCount: 1, viewMode: '2d', nodeBaseSize: 4, active, frozen });
        return null;
    }
    const root = createRoot(document.getElementById('root'));
    const render = props => React.act(() => root.render(React.createElement(Graph, props)));
    try {
        await render({ active: true });
        assert.equal(workers.length, 1);
        assert.equal(frames.size, 1);
        for (let i = 0; i < 3; i++) {
            await render({ active: false });
            assert.equal(paused, true);
            assert.equal(frames.size, 0);
            assert.equal(workers[0].messages.at(-1).type, 'pause');
            await render({ active: true });
            assert.equal(paused, false);
            assert.equal(frames.size, 1);
            assert.equal(workers[0].messages.at(-1).type, 'resume');
        }
        assert.equal(workers.length, 1);
        assert.equal(workers[0].terminated, undefined);
        assert.equal(workers[0].messages.filter(m => m.type === 'init').length, 1);
        assert.equal(cameraFits, 0);
        assert.equal(graphData.nodes[0].x, 12);
        await render({ active: true, frozen: true });
        assert.equal(paused, false, 'frozen layout must still allow pan and zoom');
        assert.equal(workers[0].messages.at(-1).type, 'pause');
    } finally {
        await React.act(() => root.unmount());
        assert.equal(workers[0].terminated, true);
        assert.equal(frames.size, 0);
        dom.window.close();
        for (const [key, value] of originals) {
            if (value === undefined) delete global[key]; else global[key] = value;
        }
    }
});

test('worker pause/resume retains the simulation and its cooling progress', async () => {
    const fs = require('node:fs');
    const vm = require('node:vm');
    const { pathToFileURL } = require('node:url');
    const forces = await import(pathToFileURL(frontendRequire.resolve('d3-force-3d')).href);
    const source = fs.readFileSync(path.resolve(__dirname, '../frontend/src/utils/forceWorker.js'), 'utf8')
        .replace(/import\s*\{[\s\S]*?\}\s*from 'd3-force-3d';/, '');
    const context = vm.createContext({ ...forces, self: { postMessage() {} } });
    vm.runInContext(source, context);
    const send = data => context.self.onmessage({ data });
    try {
        send({ type: 'init', nodes: [{ id: 'one', x: 12, y: 24 }], links: [], paused: true });
        const simulation = vm.runInContext('sim', context);
        simulation.alpha(0.25);
        send({ type: 'resume' });
        send({ type: 'pause' });
        assert.equal(vm.runInContext('sim', context), simulation);
        assert.equal(simulation.alpha(), 0.25, 'resuming must not reheat the graph');
        assert.equal(simulation.nodes()[0].x, 12);
    } finally { send({ type: 'stop' }); }
});

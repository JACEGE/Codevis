const test = require('node:test');
const assert = require('node:assert/strict');
require('../lib/tsx-userinfo-preload.cjs');
require('tsx/cjs/api').register();
const { bridgeTools, __setGraphBuilderRunnerForTests } = require('../tools/handlers/bridge-tools.ts');

const update = () => bridgeTools.handlers.update_graph_smart({ target: 'codevis_db' }, {});
const parse = result => JSON.parse(result.content[0].text);

test('a concurrent update reports BUSY without an error and the flag resets afterwards', async t => {
    let finish;
    const restore = __setGraphBuilderRunnerForTests((_file, _args, options) => {
        assert.ok(options.timeout > 0, 'the builder must run with a timeout');
        return new Promise(resolve => { finish = resolve; });
    });
    t.after(restore);
    const first = update();
    const busy = await update();
    assert.equal(busy.isError, undefined);
    assert.equal(parse(busy).status, 'BUSY');
    assert.ok(parse(busy).retryAfterMs > 0);
    finish({ stdout: 'ok', stderr: '' });
    assert.match((await first).content[0].text, /Update finished successfully/);
    finish = null;
    const second = update();
    finish({ stdout: 'ok', stderr: '' });
    assert.equal((await second).isError, undefined);
});

test('a build lock held by another process maps to BUSY', async t => {
    t.after(__setGraphBuilderRunnerForTests(async () => {
        const error = new Error('Command failed');
        error.stderr = 'Error: Another CodeVis build is already running (pid 42, target).';
        throw error;
    }));
    const result = await update();
    assert.equal(result.isError, undefined);
    assert.equal(parse(result).status, 'BUSY');
});

test('a timed-out build is reported once and does not leave the tool blocked', async t => {
    let calls = 0;
    t.after(__setGraphBuilderRunnerForTests(async () => {
        calls++;
        if (calls === 1) { const error = new Error('timeout'); error.killed = true; error.signal = 'SIGTERM'; throw error; }
        return { stdout: 'ok', stderr: '' };
    }));
    const timedOut = await update();
    assert.equal(parse(timedOut).status, 'TIMEOUT');
    assert.match((await update()).content[0].text, /Update finished successfully/);
});

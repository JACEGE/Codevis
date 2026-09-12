import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';

const browser = await puppeteer.launch({ headless: true });
try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1500, height: 1100 });
    const pending = [];
    const errors = [];
    const task = { taskId: 'rollback-browser-fixture', title: 'Rollback verification task', status: 'backlog' };
    page.on('pageerror', error => errors.push(error.message));
    await page.setRequestInterception(true);
    page.on('request', request => {
        const { pathname } = new URL(request.url());
        if (pathname.startsWith('/socket.io/')) return request.abort();
        if (request.method() === 'PATCH' && pathname === `/api/tasks/${task.taskId}/status`) {
            pending.push(request);
            return;
        }
        // Isolate the fixture and intercept every write, including error reports.
        if (!['GET', 'HEAD'].includes(request.method())) return request.respond({ status: 500, body: 'Test write intercepted' });
        if (pathname === '/api/tasks') {
            if (pending.length) return request.abort();
            return request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify([task]) });
        }
        if (pathname === '/api/epics') return request.respond({ status: 200, contentType: 'application/json', body: '[]' });
        return request.continue();
    });
    await page.goto(`${process.argv[2] || 'http://localhost:4362'}/?view=kanban`, { waitUntil: 'domcontentloaded' });
    const cardSelector = '[draggable="true"]';
    await page.waitForSelector(`${cardSelector} input[type="checkbox"]`, { timeout: 20000 });
    await page.click(`${cardSelector} input[type="checkbox"]`);
    const select = await page.$('select:has(option[value="todo"])');
    assert.ok(select, 'Bulk status control must be visible');
    await select.select('todo');
    await page.evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Move').click());
    const waitForCount = async count => {
        const deadline = Date.now() + 5000;
        while (pending.length < count && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
        assert.equal(pending.length, count);
    };
    await waitForCount(1);
    const waitForColumn = async label => {
        await page.waitForFunction(label => {
            const header = document.querySelector(`button[aria-label="Collapse ${label}"]`);
            return header?.parentElement.parentElement.querySelector('[draggable="true"]')?.textContent.includes('rollback-browser-fixture');
        }, {}, label);
    };
    await waitForColumn('To Do');
    await page.evaluate(() => {
        window.testDrag = new DataTransfer();
        document.querySelector('[draggable="true"]').dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: window.testDrag }));
    });
    await page.evaluate(() => {
        const target = document.querySelector('button[aria-label$="In Progress"]').parentElement.parentElement;
        target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: window.testDrag }));
    });
    await waitForCount(2);
    await waitForColumn('In Progress');
    const failure = { status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Simulated failed task move' }) };
    await pending[0].respond(failure);
    await page.waitForFunction(() => document.body.innerText.includes('0 of 1 moved'));
    await waitForColumn('In Progress');
    await pending[1].respond(failure);
    await waitForColumn('Backlog');
    assert.deepEqual(errors, []);
    if (process.argv[3]) await page.screenshot({ path: process.argv[3], fullPage: true });
    console.log('[task rollback] Failed bulk + drag moves restored Backlog. Fixture reads and all writes were intercepted.');
} finally {
    await browser.close();
}

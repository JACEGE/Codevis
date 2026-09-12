import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';

const browser = await puppeteer.launch({ headless: true, args: ['--enable-unsafe-swiftshader'] });
try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 1100 });
    const pending = [];
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setRequestInterception(true);
    page.on('request', request => {
        if (request.method() === 'PATCH' && new URL(request.url()).pathname.startsWith('/api/ideas/')) {
            pending.push(request); // Never send test mutations to the live database.
        } else request.continue();
    });
    await page.goto(process.argv[2] || 'http://localhost:4362', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.workspace-header');
    await page.evaluate(() => {
        const button = [...document.querySelectorAll('.workspace-header button')].find(node => node.textContent.trim() === 'Kanban');
        if (!button) throw new Error('Kanban tab missing');
        button.click();
    });
    // The first priority select belongs to the composer; the second is a real idea.
    await page.waitForFunction(() => document.querySelectorAll('select[aria-label="Priority"]').length > 1);
    const select = (await page.$$('select[aria-label="Priority"]'))[1];
    const original = await select.evaluate(node => node.value);
    const choices = await select.evaluate((node, original) => [...node.options].map(option => option.value).filter(value => value !== original), original);
    assert.ok(choices.length >= 2);
    const waitForRequests = async count => {
        const deadline = Date.now() + 5000;
        while (pending.length < count && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
        assert.equal(pending.length, count);
    };
    await select.select(choices[0]);
    await waitForRequests(1);
    await select.select(choices[1]);
    await waitForRequests(2);
    const failure = { status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Simulated offline save' }) };
    await pending[0].respond(failure);
    await page.waitForFunction(() => document.body.innerText.includes('Simulated offline save'));
    assert.equal(await select.evaluate(node => node.value), choices[1]);
    await pending[1].respond(failure);
    await page.waitForFunction(original => document.querySelectorAll('select[aria-label="Priority"]')[1]?.value === original, {}, original);
    const card = await select.evaluateHandle(node => node.parentElement.parentElement.parentElement);
    if (process.argv[3]) await card.asElement().screenshot({ path: process.argv[3] });
    assert.deepEqual(errors, []);
    console.log('[idea rollback] Two failed UI edits restored the original priority. Both writes were intercepted.');
} finally {
    await browser.close();
}

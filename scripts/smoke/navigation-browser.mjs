import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';

const browser = await puppeteer.launch({ headless: true, args: ['--enable-unsafe-swiftshader'] });
try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewport({ width: 1440, height: 1000 });
    await page.goto(process.argv[2] || 'http://localhost:4362', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.navigation-history', { visible: true });
    const status = await page.evaluate(() => fetch('/api/status').then(response => response.json()));
    await page.waitForFunction(db => document.querySelector('.workspace-db')?.textContent === db, { timeout: 60000 }, status.activeDb);
    const state = () => page.evaluate(() => {
        const header = [...document.querySelectorAll('.workspace-header')].find(node => node.getClientRects().length);
        return {
            tab: header.querySelector('[aria-current="page"]').textContent.trim(),
            back: !header.querySelector('[aria-label="Go back"]').disabled,
            forward: !header.querySelector('[aria-label="Go forward"]').disabled,
        };
    });
    const click = async label => {
        await page.evaluate(label => {
            const header = [...document.querySelectorAll('.workspace-header')].find(node => node.getClientRects().length);
            const button = [...header.querySelectorAll('button')].find(node => node.getAttribute('aria-label') === label || node.textContent.trim() === label);
            if (!button || button.disabled) throw new Error(`Navigation button unavailable: ${label}`);
            button.click();
        }, label);
    };
    const tab = async label => {
        await click(label);
        await page.waitForFunction(label => [...document.querySelectorAll('.workspace-header')]
            .some(header => header.getClientRects().length && header.querySelector('[aria-current="page"]')?.textContent.trim() === label), {}, label);
    };
    assert.equal((await state()).back, false);
    await tab('Context');
    await tab('Docs');
    await click('Go back');
    await page.waitForFunction(() => [...document.querySelectorAll('[aria-current="page"]')].some(node => node.getClientRects().length && node.textContent.trim() === 'Context'));
    assert.equal((await state()).forward, true);
    await click('Go forward');
    await page.waitForFunction(() => [...document.querySelectorAll('[aria-current="page"]')].some(node => node.getClientRects().length && node.textContent.trim() === 'Docs'));
    await click('Go back');
    await tab('Inspector');
    assert.equal((await state()).forward, false);
    await click('Go back');
    await page.waitForFunction(() => [...document.querySelectorAll('[aria-current="page"]')].some(node => node.getClientRects().length && node.textContent.trim() === 'Context'));
    await tab('Context');
    assert.equal((await state()).forward, true);
    await page.waitForFunction(() => !document.body.innerText.includes('Loading context'));
    const contextItems = await page.$$('[title="Open in Inspector"]');
    if (contextItems.length >= 2) {
        const inspect = async index => {
            await page.waitForSelector('[title="Open in Inspector"]');
            const name = await page.evaluate(index => {
                const button = document.querySelectorAll('[title="Open in Inspector"]')[index];
                const name = button.firstElementChild.textContent;
                button.click();
                return name;
            }, index);
            await page.waitForFunction(name => document.querySelector('.inspector-node-name')?.textContent === name, {}, name);
            return name;
        };
        const first = await inspect(0);
        await tab('Context');
        const second = await inspect(1);
        await click('Go back');
        await click('Go back');
        await page.waitForFunction(name => document.querySelector('.inspector-node-name')?.textContent === name, {}, first);
        await click('Go forward');
        await click('Go forward');
        await page.waitForFunction(name => document.querySelector('.inspector-node-name')?.textContent === name, {}, second);
        console.log('Node selections restored in Inspector in both directions.');
    }
    await page.setViewport({ width: 760, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    if (process.argv[3]) await page.screenshot({ path: process.argv[3] });
    assert.deepEqual(errors, []);
    console.log('Navigation browser smoke passed: fullscreen replay, forward branching, duplicate tabs, responsive header.');
} finally {
    await browser.close();
}

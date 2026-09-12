import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';

// Run against the actual packed dashboard. The held response reproduces a
// workspace switch from another client while a diagram is still loading.
export async function verifySpecWorkspaceLifetime(baseUrl, screenshot) {
    const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1440, height: 1000 });
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        const diagram = '@startuml\nclass BrowserAuditService\n@enduml';
        const imported = await fetch(`${baseUrl}/api/spec/import`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ diagram, specId: 'browser-lifetime', kind: 'class', db: 'project_db' }) });
        assert.equal(imported.status, 200, await imported.text());
        // The live dashboard can keep network requests open. Wait for the
        // actual navigation control rather than requiring network silence.
        await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => [...document.querySelectorAll('nav button')]
            .some(button => button.textContent.trim() === 'Spec'));
        await page.evaluate(() => [...document.querySelectorAll('nav button')].find(b => b.textContent.trim() === 'Spec').click());
        await page.waitForSelector('button[title="Reopen this diagram + its overlay (no Claude run)"]');
        let release, started;
        const held = new Promise(resolve => { started = resolve; });
        await page.setRequestInterception(true);
        page.on('request', request => {
            if (request.url().includes('/api/spec/get?')) {
                release = () => request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({
                    ok: true, specId: 'browser-lifetime', source: diagram, title: 'OLD WORKSPACE',
                }) });
                started();
            } else request.continue();
        });
        await page.click('button[title="Reopen this diagram + its overlay (no Claude run)"]');
        await held;
        const switched = await fetch(`${baseUrl}/api/switch-db`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ db: 'codevis_db' }) });
        assert.equal(switched.status, 200);
        await page.waitForFunction(() => !document.querySelector('button[title="Reopen this diagram + its overlay (no Claude run)"]'));
        await release();
        // A second round trip ensures the released response and React update
        // have had an opportunity to run before checking the new editor.
        await page.evaluate(async () => { await fetch('/api/status'); await new Promise(requestAnimationFrame); });
        assert.equal(await page.$eval('textarea.spec-input', el => el.value), '');
        assert.equal(await page.evaluate(() => [...document.querySelectorAll('button')].some(b => b.textContent.includes('Sync changes'))), false);
        await page.evaluate(() => [...document.querySelectorAll('nav button')].find(b => b.textContent.trim() === 'Docs').click());
        const localGuideSelector = '.codevis-docs a[href="#doc=docs%2FUSER_WORKFLOW.md"]';
        await page.waitForSelector(localGuideSelector);
        assert.equal(await page.$('.codevis-docs a[href="https://github.com/JACEGE/Codevis/blob/main/docs/USER_WORKFLOW.md"]'), null);
        await page.$eval(localGuideSelector, link => {
            link.closest('details').open = true;
            link.click();
        });
        await page.waitForSelector('.codevis-docs-header button');
        await page.waitForSelector('#user-workflow');
        assert.deepEqual(errors, []);
        if (screenshot) await page.screenshot({ path: screenshot, fullPage: true });
    } finally { await browser.close(); }
}

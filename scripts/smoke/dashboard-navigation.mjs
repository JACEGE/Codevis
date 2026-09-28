const groups = { CodeFlow: 'work', 'Task board': 'work', Ideas: 'work', Specs: 'work', Knowledge: 'analyze', Inspector: 'analyze', Pathfinder: 'analyze', Queries: 'analyze', Classes: 'model', Diagrams: 'model', Docs: 'system', Settings: 'system' };

export async function selectDashboardView(page, label) {
    const group = groups[label];
    if (!group) throw new Error('Unknown dashboard view: ' + label);
    await page.waitForFunction(() => [...document.querySelectorAll('.workspace-header')].some(node => node.getClientRects().length));
    await page.evaluate(group => {
        const header = [...document.querySelectorAll('.workspace-header')].find(node => node.getClientRects().length);
        const button = header?.querySelector('[data-group="' + group + '"]');
        if (!button) throw new Error('Dashboard section not found: ' + group);
        if (button.getAttribute('aria-pressed') !== 'true') button.click();
    }, group);
    await page.waitForFunction(label => [...document.querySelectorAll('.workspace-header .app-nav-item')].some(node => node.getClientRects().length && node.textContent.trim() === label), {}, label);
    await page.evaluate(label => [...document.querySelectorAll('.workspace-header .app-nav-item')].find(node => node.getClientRects().length && node.textContent.trim() === label).click(), label);
    await page.waitForFunction(label => [...document.querySelectorAll('.workspace-header [aria-current="page"]')].some(node => node.getClientRects().length && node.textContent.trim() === label), {}, label);
}

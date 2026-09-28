import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer';
import paths from '../server/codevis-paths.cjs';
import { selectDashboardView } from './smoke/dashboard-navigation.mjs';

// Usage: node scripts/capture-doc-screenshots.mjs <dashboard-url> [flow-title] [spec-title]
// Prepare Harbor Library with indexed source, reservation Tasks, Knowledge,
// a saved Spec and a Development Flow containing TC-001 before capturing.
// Use a separate fictional project. This script navigates and fills an unsaved
// idea draft; it never submits work, advances gates or changes project content.
const dashboardUrl = process.argv[2] || `http://127.0.0.1:${paths.BRIDGE_PORT}`;
const flowTitle = process.argv[3] || 'Reserve available books';
const specTitle = process.argv[4] || 'Library reservations';
const outputDir = path.resolve('docs/screenshots');
await fs.mkdir(outputDir, { recursive: true });
const browser = await puppeteer.launch({ executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined, headless: true, protocolTimeout: 120_000, timeout: 120_000 });
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(60_000);
  await page.setViewport({ width: 1600, height: 1100, deviceScaleFactor: 1 });
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('codevis.theme', 'light');
    localStorage.setItem('codevis.viewMode', '3d');
  });
  // The dashboard keeps WebSocket/polling traffic alive: do not await networkidle.
  await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.body.innerText.includes('harbor-library'));
  const settle = () => new Promise(resolve => setTimeout(resolve, 1000));
  const click = async (text, selector = 'button') => {
    await page.waitForFunction((text, selector) => [...document.querySelectorAll(selector)].some(n => n.getClientRects().length && (n.textContent.trim() === text || n.getAttribute('aria-label') === text || n.title === text)), {}, text, selector);
    await page.evaluate((text, selector) => [...document.querySelectorAll(selector)].find(n => n.getClientRects().length && (n.textContent.trim() === text || n.getAttribute('aria-label') === text || n.title === text)).click(), text, selector);
    await settle();
  };
  const view = async label => { await selectDashboardView(page, label); await settle(); };
  const capture = async filename => {
    await page.mouse.move(1540, 145);
    await settle();
    if (await page.evaluate(() => document.documentElement.dataset.theme) !== 'light') throw new Error('Expected light theme');
    await page.screenshot({ path: path.join(outputDir, filename), fullPage: false });
    console.log('[screenshots] captured ' + filename);
  };

  await view('Task board');
  await page.waitForFunction(() => document.body.innerText.includes('Implement book reservations'));
  await page.select('select[aria-label="Graph perspective"]', 'code');
  await click('Collapse', 'button');
  await click('Fit graph');
  await page.mouse.move(390, 650);
  await page.mouse.wheel({ deltaY: 350 });
  await settle();
  await capture('overview.png');

  await view('CodeFlow');
  await page.waitForSelector('.change-catalogue-item');
  await page.evaluate(title => [...document.querySelectorAll('.change-catalogue-item')].find(n => n.querySelector('strong')?.textContent === title)?.click(), flowTitle);
  await page.waitForSelector('#flow-node-search');
  await page.type('#flow-node-search', 'TC-001');
  await page.keyboard.press('Enter');
  await click('Focus relationships');
  await click('Overview');
  await capture('codeflow.png');

  await view('Ideas');
  await page.type('textarea[aria-label="Braindump draft"]', 'Help readers plan their next library visit.\n\nShow which books are available, keep a seasonal reading list, and make opening hours easy to find. Start with a simple catalogue experience before adding notifications.');
  await capture('braindump.png');

  await view('Knowledge');
  await capture('knowledge.png');

  await view('Specs');
  await page.waitForFunction(title => [...document.querySelectorAll('button')].some(n => n.textContent.includes(title)), {}, specTitle);
  await page.evaluate(title => [...document.querySelectorAll('button')].find(n => n.textContent.includes(title)).click(), specTitle);
  await page.waitForFunction(() => document.body.innerText.includes('CONFORMS'));
  await capture('spec.png');

  await view('Queries');
  await page.type('textarea', 'MATCH (t:Task)-[:AFFECTS]->(f) RETURN elementId(f) AS uid, f.name AS name, f.file AS file, t.title AS task LIMIT 10');
  await click('Run');
  await page.waitForFunction(() => document.body.innerText.includes('reserveBook'));
  await capture('explore.png');
  await view('Classes');
  await page.waitForSelector('svg', { visible: true });
  await page.waitForFunction(() => document.body.innerText.includes('ReservationService'));
  await capture('classes.png');
  await view('Settings');
  await click('Full view');
  await capture('settings.png');
  await view('Docs');
  await click('Introduction', 'summary');
  await capture('documentation.png');
} finally {
  await browser.close();
}
console.log('[screenshots] Review every image before committing.');

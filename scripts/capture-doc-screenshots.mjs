import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer';
import paths from '../server/codevis-paths.cjs';

const dashboardUrl = process.argv[2] || `http://127.0.0.1:${paths.BRIDGE_PORT}`;
const outputDir = path.resolve('docs/screenshots');
await fs.mkdir(outputDir, { recursive: true });

const browser = await puppeteer.launch({
  headless: true,
  protocolTimeout: 120_000,
  timeout: 120_000,
});
const page = await browser.newPage();
page.setDefaultTimeout(60_000);
page.setDefaultNavigationTimeout(60_000);
await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: 1 });
await page.evaluateOnNewDocument(() => {
  localStorage.setItem('codevis.theme', 'light');
  localStorage.setItem('codevis.viewMode', '3d');
});
// The dashboard deliberately keeps WebSocket and polling traffic alive, so a
// network-idle condition is not a reliable readiness signal.
await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
await page.waitForSelector('button', { visible: true, timeout: 60_000 });
await page.addStyleTag({ content: '.xterm-screen, .xterm-helper-textarea { visibility: hidden !important; }' });
await new Promise((resolve) => setTimeout(resolve, 5_000));

async function selectTab(label) {
  const clicked = await page.evaluate((wanted) => {
    const button = [...document.querySelectorAll('button')]
      .find((candidate) => candidate.textContent.trim() === wanted);
    button?.click();
    return Boolean(button);
  }, label);
  if (!clicked) throw new Error(`Navigation tab not found: ${label}`);
  await new Promise((resolve) => setTimeout(resolve, 1_500));
}

async function capture(filename) {
  const theme = await page.evaluate(() => document.documentElement.dataset.theme);
  if (theme !== 'light') throw new Error(`Expected light theme before ${filename}, got ${theme || 'unset'}`);
  await page.screenshot({
    path: path.join(outputDir, filename),
    type: 'png',
    fullPage: false,
    timeout: 120_000,
  });
  console.log(`[screenshots] captured ${filename}`);
}

await selectTab('Kanban');
await capture('overview.png');
await selectTab('Brain');
await capture('braindump.png');
await selectTab('Context');
await capture('knowledge.png');
await selectTab('Spec');
await capture('spec.png');
await selectTab('Explore');
await capture('explore.png');
await selectTab('Classes');
await page.waitForSelector('svg', { visible: true, timeout: 30_000 });
await new Promise((resolve) => setTimeout(resolve, 750));
await capture('classes.png');
await selectTab('Settings');
await capture('settings.png');
await selectTab('Docs');
await capture('documentation.png');

await browser.close();
console.log(`[screenshots] Captured README screenshots in light mode from ${dashboardUrl}`);

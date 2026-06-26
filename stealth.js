'use strict';

const puppeteerExtra = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { USER_AGENT } = require('./config');

puppeteerExtra.use(StealthPlugin());

// Browser launch args that suppress automation signals.
const LAUNCH_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-accelerated-2d-canvas',
  '--disable-gpu',
  '--window-size=1366,768',
];

async function launchBrowser() {
  const headless = process.env.HEADLESS !== 'false';
  const browser = await puppeteerExtra.launch({
    headless,
    slowMo: headless ? 0 : 50,   // slow down interactions when headed so you can follow along
    args: LAUNCH_ARGS,
    defaultViewport: { width: 1366, height: 768 },
  });
  return browser;
}

// Apply per-page stealth patches that the plugin doesn't cover automatically.
async function stealthPage(page) {
  await page.setUserAgent(USER_AGENT);
  await page.setViewport({ width: 1366, height: 768 });
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

  // Remove the `webdriver` property at the JS level as a belt-and-suspenders measure.
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
}

async function createWorkerPage(browser) {
  const page = await browser.newPage();
  await stealthPage(page);
  return page;
}

module.exports = { launchBrowser, stealthPage, createWorkerPage };

'use strict';

const readline = require('readline');
const { BASE_URL, LOGIN_PATH, SESSION_CHECK_PATH, DELAYS } = require('./config');
const { randomDelay, SessionExpiredError } = require('./utils');
const { stealthPage } = require('./stealth');

// ---------------------------------------------------------------------------
// Terminal prompts
// ---------------------------------------------------------------------------

function promptLine(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// Prompt for a password without echoing characters to the terminal.
function promptPassword(question) {
  return new Promise((resolve, reject) => {
    process.stdout.write(question);
    let password = '';

    const restoreAndResolve = (value) => {
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
      process.stdin.pause();
      process.stdin.removeListener('data', onData);
      process.stdout.write('\n');
      resolve(value);
    };

    const onData = (buf) => {
      const char = buf.toString('utf8');
      switch (char) {
        case '\r':
        case '\n':
        case '': // Ctrl-D
          restoreAndResolve(password);
          break;
        case '': // Ctrl-C
          restoreAndResolve('');
          reject(new Error('Cancelled by user'));
          break;
        case '': // Backspace
          password = password.slice(0, -1);
          break;
        default:
          password += char;
      }
    };

    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', onData);
  });
}

async function promptCredentials() {
  const email    = await promptLine('WellnessLiving email: ');
  const password = await promptPassword('WellnessLiving password: ');
  if (!email || !password) {
    throw new Error('Email and password are required.');
  }
  return { email, password };
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

async function login(browser, email, password) {
  const page = await browser.newPage();
  await stealthPage(page);

  const loginUrl = `${BASE_URL}${LOGIN_PATH}`;
  console.log(`[auth] Navigating to login page: ${loginUrl}`);

  await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  console.log(`[auth] Landed on: ${page.url()}`);
  await randomDelay(DELAYS.AFTER_NAVIGATION.MIN, DELAYS.AFTER_NAVIGATION.MAX);

  // Wait explicitly for the email field — the form renders synchronously in the HTML
  // so domcontentloaded is enough, but waitForSelector is the safe guarantee.
  let emailField;
  try {
    emailField = await page.waitForSelector('input[name="login"]', { timeout: 10000 });
  } catch {
    // Dump visible text to help diagnose unexpected page states.
    const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 400));
    throw new Error(
      `[auth] email field (input[name="login"]) not found on ${page.url()}.\n` +
      `Page preview: ${bodyText}`
    );
  }
  await emailField.click({ clickCount: 3 });
  await emailField.type(email, { delay: 60 });

  // Fill password
  const passwordField = await page.waitForSelector('input[name="pwd"]', { timeout: 5000 });
  await passwordField.click({ clickCount: 3 });
  await passwordField.type(password, { delay: 60 });

  // Submit — the form uses an AJAX handler that triggers a JS redirect, so
  // waitForNavigation races with the context being destroyed. Instead we click
  // and poll page.url() (CDP-level, safe across navigations) until we leave /login.
  const submitBtn = await page.waitForSelector('button[name="b_submit"]', { timeout: 5000 });
  await submitBtn.click();

  const deadline = Date.now() + 30000;
  while (page.url().toLowerCase().includes('/login')) {
    if (Date.now() > deadline) {
      const screenshotPath = './login-failure.png';
      try { await page.screenshot({ path: screenshotPath, fullPage: true }); } catch (_) {}
      throw new Error(
        `[auth] Login timed out — still on login page after 30s.\n` +
        `  Screenshot saved to: ${screenshotPath}\n` +
        `  Check credentials or look for a CAPTCHA in the screenshot.`
      );
    }
    await new Promise((r) => setTimeout(r, 400));
  }

  // Wait for the destination page to settle before we start making requests.
  try {
    await page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 10000 });
  } catch (_) {
    // Navigation already finished — that's fine.
  }

  await randomDelay(DELAYS.AFTER_LOGIN.MIN, DELAYS.AFTER_LOGIN.MAX);
  console.log('[auth] Login successful.');
  return page;
}

// ---------------------------------------------------------------------------
// Session validation
// ---------------------------------------------------------------------------

// Returns true if the current session is still authenticated.
async function checkSession(page) {
  try {
    const result = await page.evaluate(async (url) => {
      const res = await fetch(url, { redirect: 'follow', credentials: 'include' });
      return { status: res.status, url: res.url };
    }, `${BASE_URL}${SESSION_CHECK_PATH}`);

    return result.status !== 401 && !result.url.toLowerCase().includes('login');
  } catch {
    return false;
  }
}

// Re-authenticate on the existing page without opening a new tab.
async function reAuthenticate(page, email, password) {
  console.log('[auth] Session expired — re-authenticating...');
  const loginUrl = `${BASE_URL}${LOGIN_PATH}`;
  await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await randomDelay(DELAYS.AFTER_NAVIGATION.MIN, DELAYS.AFTER_NAVIGATION.MAX);

  const emailField = await page.waitForSelector('input[name="login"]', { timeout: 10000 });
  if (!emailField) throw new SessionExpiredError('Re-auth: email field not found');
  await emailField.click({ clickCount: 3 });
  await emailField.type(email, { delay: 60 });

  const passwordField = await page.waitForSelector('input[name="pwd"]', { timeout: 5000 });
  if (!passwordField) throw new SessionExpiredError('Re-auth: password field not found');
  await passwordField.click({ clickCount: 3 });
  await passwordField.type(password, { delay: 60 });

  const submitBtn = await page.waitForSelector('button[name="b_submit"]', { timeout: 5000 });
  if (!submitBtn) throw new SessionExpiredError('Re-auth: submit button not found');

  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 30000 }),
    submitBtn.click(),
  ]);

  if (page.url().toLowerCase().includes('login')) {
    throw new Error('[auth] Re-authentication failed — credentials may have changed.');
  }

  await randomDelay(DELAYS.AFTER_LOGIN.MIN, DELAYS.AFTER_LOGIN.MAX);
  console.log('[auth] Re-authentication successful.');
}

module.exports = { promptCredentials, login, checkSession, reAuthenticate };

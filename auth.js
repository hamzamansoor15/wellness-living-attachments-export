'use strict';

const readline = require('readline');
const { BASE_URL, LOGIN_PATH, SESSION_CHECK_PATH, DELAYS } = require('./config');
const { randomDelay, SessionExpiredError } = require('./utils');
const { stealthPage } = require('./stealth');

// Selectors tried in order — first match wins.
// ASSUMPTION: WellnessLiving uses these field names. If login fails, inspect the
// login page source and update these arrays accordingly.
const EMAIL_SELECTORS    = ['input[name="s_user"]', 'input[type="email"]', '#s_user', 'input[name="email"]', 'input[name="username"]'];
const PASSWORD_SELECTORS = ['input[name="s_password"]', 'input[type="password"]', '#s_password', 'input[name="password"]'];
const SUBMIT_SELECTORS   = ['button[type="submit"]', 'input[type="submit"]', '.a-button-login', '.button-submit', '[data-testid="login-submit"]'];

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
// Selector helpers
// ---------------------------------------------------------------------------

async function findFirst(page, selectors) {
  for (const sel of selectors) {
    const el = await page.$(sel);
    if (el) return el;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

async function login(browser, email, password) {
  const page = await browser.newPage();
  await stealthPage(page);

  const loginUrl = `${BASE_URL}${LOGIN_PATH}`;
  console.log(`[auth] Navigating to login page: ${loginUrl}`);

  await page.goto(loginUrl, { waitUntil: 'networkidle0', timeout: 30000 });
  await randomDelay(DELAYS.AFTER_NAVIGATION.MIN, DELAYS.AFTER_NAVIGATION.MAX);

  // Fill email
  const emailField = await findFirst(page, EMAIL_SELECTORS);
  if (!emailField) {
    throw new Error(`[auth] Could not find email field. Try inspecting the login page and updating EMAIL_SELECTORS in auth.js.`);
  }
  await emailField.click({ clickCount: 3 });
  await emailField.type(email, { delay: 60 });

  // Fill password
  const passwordField = await findFirst(page, PASSWORD_SELECTORS);
  if (!passwordField) {
    throw new Error(`[auth] Could not find password field. Update PASSWORD_SELECTORS in auth.js.`);
  }
  await passwordField.click({ clickCount: 3 });
  await passwordField.type(password, { delay: 60 });

  // Submit and wait for navigation
  const submitBtn = await findFirst(page, SUBMIT_SELECTORS);
  if (!submitBtn) {
    throw new Error(`[auth] Could not find submit button. Update SUBMIT_SELECTORS in auth.js.`);
  }

  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 30000 }),
    submitBtn.click(),
  ]);

  const currentUrl = page.url();
  if (currentUrl.toLowerCase().includes('login')) {
    // Still on login page — check for an error message to give a better hint.
    const errorText = await page.evaluate(() => {
      const el = document.querySelector('.error, .alert, [class*="error"], [class*="alert"]');
      return el ? el.innerText.trim() : null;
    });
    throw new Error(
      `[auth] Login failed — still on login page after submission.${errorText ? ` Server message: "${errorText}"` : ''}`
    );
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
  await page.goto(loginUrl, { waitUntil: 'networkidle0', timeout: 30000 });
  await randomDelay(DELAYS.AFTER_NAVIGATION.MIN, DELAYS.AFTER_NAVIGATION.MAX);

  const emailField = await findFirst(page, EMAIL_SELECTORS);
  if (!emailField) throw new SessionExpiredError('Re-auth: email field not found');
  await emailField.click({ clickCount: 3 });
  await emailField.type(email, { delay: 60 });

  const passwordField = await findFirst(page, PASSWORD_SELECTORS);
  if (!passwordField) throw new SessionExpiredError('Re-auth: password field not found');
  await passwordField.click({ clickCount: 3 });
  await passwordField.type(password, { delay: 60 });

  const submitBtn = await findFirst(page, SUBMIT_SELECTORS);
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

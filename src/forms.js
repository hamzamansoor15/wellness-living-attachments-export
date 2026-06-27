'use strict';

const fs = require('fs');
const path = require('path');
const {
  BASE_URL,
  K_BUSINESS,
  USER_AGENT,
  FORMS_DATE_START,
  FORMS_DATE_END,
  DELAYS,
} = require('./config');
const {
  randomDelay,
  sanitizeFilename,
  getClientDir,
  withRetry,
  logError,
  cookieHeader,
  SessionExpiredError,
} = require('./utils');

// ---------------------------------------------------------------------------
// Sidebar navigation
// ---------------------------------------------------------------------------

async function findFormsHref(page) {
  return page.evaluate(() => {
    const byClass = document.querySelector('a.js-item--profile-form');
    if (byClass) return byClass.href;
    const link = Array.from(document.querySelectorAll('a[href]')).find(
      (a) =>
        a.href.includes('profile-form-response') ||
        (a.href.includes('report-view') && a.textContent.trim() === 'Forms')
    );
    return link ? link.href : null;
  });
}

async function navigateToFormsPage(page, uid) {
  let formsHref = await findFormsHref(page);

  if (!formsHref) {
    const profileUrl = `${BASE_URL}/Wl/Profile/Client.html?uid=${uid}&k_business=${K_BUSINESS}`;
    await page.goto(profileUrl, { waitUntil: 'networkidle0', timeout: 30000 });
    if (page.url().toLowerCase().includes('login')) {
      throw new SessionExpiredError(`Session expired loading profile for uid ${uid}`);
    }
    await randomDelay(DELAYS.AFTER_NAVIGATION.MIN, DELAYS.AFTER_NAVIGATION.MAX);
    formsHref = await findFormsHref(page);
  }

  if (!formsHref) {
    const expanded = await page.evaluate(() => {
      const title = Array.from(
        document.querySelectorAll('.js-chapter-title, .css-chapter-title')
      ).find((el) => el.textContent.trim() === 'Documents');
      if (title) { title.click(); return true; }
      const fallback = Array.from(document.querySelectorAll('a, button, li, div, span')).find(
        (el) => el.children.length <= 3 && (el.textContent || '').trim() === 'Documents'
      );
      if (fallback) { fallback.click(); return true; }
      return false;
    });
    if (expanded) {
      await randomDelay(700, 1300);
      formsHref = await findFormsHref(page);
    }
  }

  if (!formsHref) return false;

  console.log(`  [forms] uid=${uid} — navigating to forms page`);
  await page.goto(formsHref, { waitUntil: 'networkidle0', timeout: 30000 });
  if (page.url().toLowerCase().includes('login')) {
    throw new SessionExpiredError(`Session expired on forms page for uid ${uid}`);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Date range picker
// ---------------------------------------------------------------------------

async function setDateRange(page) {
  await page.waitForSelector('.js-navigate-calendar', { timeout: 10000 });
  await page.$eval('.js-navigate-calendar', (el) => el.click());
  await page.waitForSelector('.daterangepicker', { visible: true, timeout: 8000 });
  await randomDelay(400, 700);

  try {
    await page.$eval('.js-ranges .chosen-single', (el) => el.click());
    await randomDelay(200, 400);
    await page.evaluate(() => {
      const li = Array.from(document.querySelectorAll('.js-ranges .chosen-results li'))
        .find((el) => el.textContent.trim() === 'Custom');
      if (li) li.click();
    });
    await randomDelay(400, 700);
  } catch {
    // Already in custom/range mode — continue.
  }

  // Triple-click selects all existing text; typing replaces it.
  // WL expects yyyy-mm-dd (the format FORMS_DATE_START/END are already in).
  await page.click('.js-date-start', { clickCount: 3 });
  await page.keyboard.type(FORMS_DATE_START, { delay: 50 });

  await page.click('.js-date-end', { clickCount: 3 });
  await page.keyboard.type(FORMS_DATE_END, { delay: 50 });

  await randomDelay(300, 500);
  await page.$eval('.js-btn-apply', (el) => el.click());
  await page.waitForNetworkIdle({ timeout: 15000 }).catch(() => randomDelay(2000, 4000));
  try {
    await page.waitForSelector(
      'tr.js-content-row, .css-wl-first-table-list-empty, .rs-report-no-data',
      { timeout: 15000 }
    );
  } catch { /* empty or slow */ }
}

// ---------------------------------------------------------------------------
// Row metadata scraping
// ---------------------------------------------------------------------------

async function getRowInfo(row) {
  return row.evaluate((tr) => {
    try {
      const info = JSON.parse(tr.getAttribute('data-info') || '{}');
      return info.a_action_field || null;
    } catch { return null; }
  });
}

// ---------------------------------------------------------------------------
// PDF export via new browser tab
// ---------------------------------------------------------------------------

// WL's gear menu triggers direct file downloads — WL generates the PDF/CSV
// server-side and serves them as binary responses. Fetch with session cookies.
//   PDF → /en-print/Wl/Quiz/Response/Response.html?is_pdf=1&...
//   CSV → /Wl/Quiz/Response/Response.html?is_csv=1&...

async function fetchFormFile(cookieStr, url, destPath, label) {
  const response = await fetch(url, {
    headers: {
      Cookie: cookieStr,
      'User-Agent': USER_AGENT,
      Accept: '*/*',
    },
    redirect: 'follow',
  });

  if (response.url.toLowerCase().includes('login')) {
    throw new SessionExpiredError(`Session expired fetching ${label}`);
  }
  if (!response.ok) {
    throw new Error(`${label} download failed with HTTP ${response.status}`);
  }

  fs.writeFileSync(destPath, Buffer.from(await response.arrayBuffer()));
}

async function exportFormAsPdf(cookieStr, kQuizResponse, safeBase, formsDir) {
  const url =
    `${BASE_URL}/en-print/Wl/Quiz/Response/Response.html` +
    `?is_pdf=1&k_business=${K_BUSINESS}&k_quiz_response=${kQuizResponse}`;
  const pdfPath = path.join(path.resolve(formsDir), safeBase + '.pdf');
  await fetchFormFile(cookieStr, url, pdfPath, `PDF k_quiz_response=${kQuizResponse}`);
  return safeBase + '.pdf';
}

async function exportFormAsCsv(cookieStr, kQuizResponse, safeBase, formsDir) {
  const url =
    `${BASE_URL}/Wl/Quiz/Response/Response.html` +
    `?is_csv=1&k_business=${K_BUSINESS}&k_quiz_response=${kQuizResponse}`;
  const csvPath = path.join(path.resolve(formsDir), safeBase + '.csv');
  await fetchFormFile(cookieStr, url, csvPath, `CSV k_quiz_response=${kQuizResponse}`);
  return safeBase + '.csv';
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

async function downloadForms(page, client, downloadDir) {
  const formsDir = path.join(getClientDir(downloadDir, client), 'forms');
  fs.mkdirSync(formsDir, { recursive: true });

  let navigated = false;
  try {
    navigated = await navigateToFormsPage(page, client.uid);
  } catch (err) {
    if (err instanceof SessionExpiredError) throw err;
    logError('Forms page navigation failed', err, { uid: client.uid });
  }

  if (!navigated) {
    console.log(`  [forms] uid=${client.uid} — Forms section not found; skipping`);
    return { found: 0, downloaded: 0 };
  }

  try {
    await setDateRange(page);
    console.log(
      `  [forms] uid=${client.uid} — date range set to ${FORMS_DATE_START} → ${FORMS_DATE_END}`
    );
  } catch (err) {
    console.warn(`  [forms] uid=${client.uid} — date picker failed: ${err.message}; using default year`);
  }

  const cookieStr = cookieHeader(await page.cookies());

  let totalFound = 0;
  let downloaded = 0;
  let safeguard = 0;

  while (safeguard++ < 50) {
    const rowElements = await page.$$('tr.js-content-row');
    if (rowElements.length === 0) break;

    const rowInfos = await Promise.all(rowElements.map(getRowInfo));

    for (let i = 0; i < rowInfos.length; i++) {
      const info = rowInfos[i];
      if (!info || info.id_status !== '1' || !info.k_quiz_response || info.k_quiz_response === 'none') {
        continue;
      }

      totalFound++;
      const formTitle = info.text_quiz_title || `form_${info.k_quiz_response}`;
      const safeBase = sanitizeFilename(`${formTitle}_${info.k_quiz_response}`);

      try {
        await withRetry(async () => {
          const pdfFile = await exportFormAsPdf(cookieStr, info.k_quiz_response, safeBase, formsDir);
          console.log(`    [forms] Exported: ${pdfFile}`);
        });
        downloaded++;
      } catch (err) {
        logError('Form PDF export failed', err, { uid: client.uid, k_quiz_response: info.k_quiz_response, formTitle });
        console.error(`    [forms] PDF failed: ${formTitle} — ${err.message}`);
      }

      try {
        await withRetry(async () => {
          const csvFile = await exportFormAsCsv(cookieStr, info.k_quiz_response, safeBase, formsDir);
          console.log(`    [forms] Exported: ${csvFile}`);
        });
      } catch (err) {
        logError('Form CSV export failed', err, { uid: client.uid, k_quiz_response: info.k_quiz_response, formTitle });
        console.error(`    [forms] CSV failed: ${formTitle} — ${err.message}`);
      }

      if (i < rowInfos.length - 1) {
        await randomDelay(DELAYS.BETWEEN_DOWNLOADS.MIN, DELAYS.BETWEEN_DOWNLOADS.MAX);
      }
    }

    const wentNext = await page.evaluate(() => {
      const btn = document.querySelector(
        '.js-table-list-next:not(.css-disabled), .js-report-next-page:not([disabled])'
      );
      if (!btn) return false;
      btn.click();
      return true;
    });
    if (!wentNext) break;
    await page.waitForNetworkIdle({ timeout: 10000 }).catch(() => randomDelay(1500, 2500));
  }

  console.log(`  [forms] uid=${client.uid} — ${totalFound} completed form(s) found, ${downloaded} exported`);
  return { found: totalFound, downloaded };
}

module.exports = { downloadForms };

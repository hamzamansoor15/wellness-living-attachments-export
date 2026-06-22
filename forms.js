'use strict';

const fs = require('fs');
const path = require('path');
const {
  BASE_URL,
  FORMS_REPORT_PATH,
  FORM_VIEW_PATH,
  K_BUSINESS,
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
  safeWriteFile,
  SessionExpiredError,
} = require('./utils');
const { stealthPage } = require('./stealth');

// ---------------------------------------------------------------------------
// Report-render API
// ---------------------------------------------------------------------------

// Builds the query string for the form list endpoint.
function buildReportUrl(uid, pageNum = 1) {
  const params = new URLSearchParams({
    'a-ajax':         '1',
    'i_container':    '0',
    'sid_report':     'profile-form-response',
    'uid_customer':   uid,
    'k_business':     K_BUSINESS,
    'dt_start':       FORMS_DATE_START,
    'dt_end':         FORMS_DATE_END,
    'i_page':         String(pageNum),
    's_sort':         '+text_create,-text_status,-text_complete',
  });
  return `${BASE_URL}${FORMS_REPORT_PATH}?${params.toString()}`;
}

// Extracts the rows array from the report-render JSON response.
// ASSUMPTION: WellnessLiving returns rows under one of these keys.
// Add a console.log(JSON.stringify(data, null, 2)) call here during debugging
// if you get 0 forms for a client you know has forms.
function extractRows(data) {
  if (!data || typeof data !== 'object') return [];

  // Try common WL response shapes in priority order.
  const candidates = [
    data.a_row,
    data.a_data,
    data.rows,
    data.data?.rows,
    data.data?.a_row,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate) && candidate.length > 0) return candidate;
  }

  // If the top-level value is already an array, assume it's the rows directly.
  if (Array.isArray(data)) return data;

  return [];
}

// Fetches all completed form responses for a client across all pages.
// Uses page.evaluate() so the browser's session cookies are sent automatically.
async function fetchFormList(page, uid) {
  let pageNum = 1;
  const allRows = [];

  while (true) {
    const url = buildReportUrl(uid, pageNum);

    // eslint-disable-next-line no-await-in-loop
    const data = await page.evaluate(async (fetchUrl) => {
      const res = await fetch(fetchUrl, { credentials: 'include' });

      // A redirect to login shows as a non-JSON response or a 401.
      if (res.status === 401) return { __session_expired: true };
      if (!res.headers.get('content-type')?.includes('json')) {
        return { __non_json: true, status: res.status };
      }

      return res.json();
    }, url);

    if (data.__session_expired) {
      throw new SessionExpiredError(`Session expired fetching form list for uid ${uid}`);
    }

    if (data.__non_json) {
      throw new Error(
        `[forms] Non-JSON response (HTTP ${data.status}) from report-render for uid ${uid}. ` +
        `Check that the API endpoint and parameters are correct.`
      );
    }

    const rows = extractRows(data);
    allRows.push(...rows);

    // Stop when there are no more pages.
    const hasNext = data.is_next === true || data.b_next === true || data.has_next === true;
    if (!hasNext || rows.length === 0) break;
    pageNum++;
  }

  return allRows;
}

// ---------------------------------------------------------------------------
// PDF export for a single form response
// ---------------------------------------------------------------------------

// Opens a new browser tab, navigates to the form response view, and generates a PDF.
// ASSUMPTION: The form response is viewable at FORM_VIEW_PATH with k_quiz_response
// and k_business query params. Verify by opening a completed form in WellnessLiving
// and copying the URL from your browser address bar, then update FORM_VIEW_PATH in config.js.
async function exportFormAsPdf(browser, formTitle, kQuizResponse, destDir) {
  const viewUrl =
    `${BASE_URL}${FORM_VIEW_PATH}` +
    `?k_quiz_response=${encodeURIComponent(kQuizResponse)}` +
    `&k_business=${K_BUSINESS}`;

  const pdfPage = await browser.newPage();
  await stealthPage(pdfPage);

  try {
    await pdfPage.goto(viewUrl, { waitUntil: 'networkidle0', timeout: 30000 });

    // Detect session expiry on the new tab.
    if (pdfPage.url().toLowerCase().includes('login')) {
      throw new SessionExpiredError(`Session expired opening form response ${kQuizResponse}`);
    }

    await randomDelay(DELAYS.AFTER_NAVIGATION.MIN, DELAYS.AFTER_NAVIGATION.MAX);

    const filename = sanitizeFilename(`${formTitle}_${kQuizResponse}`) + '.pdf';
    const filepath = path.join(destDir, filename);

    await pdfPage.pdf({
      path: filepath,
      format: 'A4',
      printBackground: true,
      margin: { top: '1.5cm', right: '1.5cm', bottom: '1.5cm', left: '1.5cm' },
    });

    return filename;
  } finally {
    await pdfPage.close();
  }
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

// Returns { found, downloaded }.
// `found` counts all rows returned by the API (including incomplete ones).
// `downloaded` counts only rows where k_quiz_response was valid and PDF was saved.
async function downloadForms(browser, page, client, downloadDir) {
  const formsDir = path.join(getClientDir(downloadDir, client), 'forms');
  fs.mkdirSync(formsDir, { recursive: true });

  // --- Fetch the form list ---
  let allRows;
  await withRetry(async () => {
    allRows = await fetchFormList(page, client.uid);
  });

  const completedForms = allRows.filter(
    (row) => row.k_quiz_response && row.k_quiz_response !== 'none'
  );

  const found = allRows.length;

  if (completedForms.length === 0) {
    console.log(`  [forms] uid=${client.uid} — ${found} rows total, 0 completed forms to export`);
    return { found, downloaded: 0 };
  }

  console.log(
    `  [forms] uid=${client.uid} — ${found} row(s) total, ` +
    `${completedForms.length} completed form(s) to export`
  );

  // --- Export each completed form as PDF ---
  let downloaded = 0;

  for (let i = 0; i < completedForms.length; i++) {
    const row = completedForms[i];

    // ASSUMPTION: form title is under `text_title`. Other common keys tried as fallback.
    const formTitle =
      row.text_title ||
      row.title ||
      row.s_title ||
      row.text_name ||
      `form_${row.k_quiz_response}`;

    try {
      await withRetry(async () => {
        const filename = await exportFormAsPdf(
          browser,
          formTitle,
          row.k_quiz_response,
          formsDir
        );
        console.log(`    [forms] Exported: ${filename}`);
      });
      downloaded++;
    } catch (err) {
      logError('Form PDF export failed', err, {
        uid: client.uid,
        k_quiz_response: row.k_quiz_response,
        formTitle,
      });
    }

    if (i < completedForms.length - 1) {
      await randomDelay(DELAYS.BETWEEN_DOWNLOADS.MIN, DELAYS.BETWEEN_DOWNLOADS.MAX);
    }
  }

  console.log(`  [forms] uid=${client.uid} — ${downloaded}/${completedForms.length} exported`);
  return { found, downloaded };
}

module.exports = { downloadForms };

'use strict';

const fs = require('fs');
const path = require('path');
const {
  BASE_URL,
  ATTACHMENTS_PATH,
  K_BUSINESS,
  DELAYS,
} = require('./config');
const {
  randomDelay,
  sanitizeFilename,
  getClientDir,
  withRetry,
  logError,
  downloadFile,
  cookieHeader,
  NotFoundError,
  SessionExpiredError,
} = require('./utils');

// CSS class of the attachment table — from the PRD.
const TABLE_SELECTOR = '.css-wl-first-table-list';

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

async function navigateToAttachmentList(page, uid) {
  const url = `${BASE_URL}${ATTACHMENTS_PATH}?k_business=${K_BUSINESS}&uid=${uid}`;
  await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });

  // Detect redirect to login (session expiry).
  if (page.url().toLowerCase().includes('login')) {
    throw new SessionExpiredError(`Redirected to login on attachment page for uid ${uid}`);
  }
}

// ---------------------------------------------------------------------------
// Link extraction
// ---------------------------------------------------------------------------

// Returns an array of unique absolute download URLs for all drive-download links.
async function extractDownloadLinks(page) {
  return page.evaluate(() => {
    const anchors = Array.from(document.querySelectorAll('a[href]'));
    const hrefs = anchors
      .map((a) => a.href)
      .filter((href) => href.includes('drive-download'));
    return [...new Set(hrefs)];
  });
}

// Returns true when the page shows a "no attachments" indicator.
async function pageIsEmpty(page) {
  return page.evaluate(() => {
    // Check for common WL empty-state patterns.
    const text = document.body.innerText.toLowerCase();
    return (
      text.includes('no documents') ||
      text.includes('no attachments') ||
      text.includes('no files') ||
      text.includes('no records') ||
      document.querySelectorAll('table tr').length <= 1    // header row only
    );
  });
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

// Returns { found, downloaded }.
// Throws SessionExpiredError if the session dies mid-client — index.js handles re-auth.
async function downloadAttachments(page, client, downloadDir) {
  const attachmentsDir = path.join(getClientDir(downloadDir, client), 'attachments');
  fs.mkdirSync(attachmentsDir, { recursive: true });

  // --- Navigate (with retry) ---
  await withRetry(async () => {
    await navigateToAttachmentList(page, client.uid);
  });

  await randomDelay(DELAYS.AFTER_NAVIGATION.MIN, DELAYS.AFTER_NAVIGATION.MAX);

  // --- Wait for table or confirm empty ---
  let links = [];
  try {
    await page.waitForSelector(TABLE_SELECTOR, { timeout: 15000 });
    links = await extractDownloadLinks(page);
  } catch (err) {
    // Selector timeout — check if the page legitimately has no attachments.
    const empty = await pageIsEmpty(page);
    if (!empty) {
      // Unexpected state — surface it as an error so the retry wrapper can catch it.
      throw new Error(
        `[attachments] Table selector "${TABLE_SELECTOR}" not found and page does not look empty for uid ${client.uid}. ` +
        `Check that the selector is still correct.`
      );
    }
    // Genuinely empty — fall through with links = [].
  }

  if (links.length === 0) {
    console.log(`  [attachments] uid=${client.uid} — 0 attachments found`);
    return { found: 0, downloaded: 0 };
  }

  console.log(`  [attachments] uid=${client.uid} — ${links.length} attachment(s) found`);

  // --- Download each file ---
  const cookies = await page.cookies();
  const cookieStr = cookieHeader(cookies);
  let downloaded = 0;

  for (let i = 0; i < links.length; i++) {
    const link = links[i];
    try {
      await withRetry(async () => {
        const filename = await downloadFile(link, cookieStr, attachmentsDir);
        console.log(`    [attachments] Downloaded: ${filename}`);
      });
      downloaded++;
    } catch (err) {
      if (err instanceof NotFoundError) {
        console.warn(`    [attachments] 404 — skipping: ${link}`);
        logError('Attachment 404', err, { uid: client.uid, url: link });
      } else {
        logError('Attachment download failed', err, { uid: client.uid, url: link });
      }
    }

    if (i < links.length - 1) {
      await randomDelay(DELAYS.BETWEEN_DOWNLOADS.MIN, DELAYS.BETWEEN_DOWNLOADS.MAX);
    }
  }

  console.log(`  [attachments] uid=${client.uid} — ${downloaded}/${links.length} downloaded`);
  return { found: links.length, downloaded };
}

module.exports = { downloadAttachments };

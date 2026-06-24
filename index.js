'use strict';

const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');

const {
  DOWNLOAD_DIR,
  CLIENTS_CSV,
  PROGRESS_CSV,
  DELAYS,
  SESSION_REFRESH_INTERVAL,
} = require('./config');
const { randomDelay, logError, SessionExpiredError } = require('./utils');
const { launchBrowser } = require('./stealth');
const { promptCredentials, login, checkSession, reAuthenticate } = require('./auth');
const { loadProgress, saveProgress, makeRow } = require('./progress');
const { downloadAttachments } = require('./attachments');
const { downloadForms } = require('./forms');

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const RETRY_ERRORS_ONLY = process.argv.includes('--retry-errors');

// ---------------------------------------------------------------------------
// clients.csv parsing
// ---------------------------------------------------------------------------

function loadClients(filepath) {
  if (!fs.existsSync(filepath)) {
    throw new Error(`clients.csv not found at: ${filepath}`);
  }

  const content = fs.readFileSync(filepath, 'utf8').trim();
  let records;
  try {
    records = parse(content, { columns: true, skip_empty_lines: true });
  } catch (err) {
    throw new Error(`Failed to parse ${filepath}: ${err.message}`);
  }

  const clients = [];
  for (const record of records) {
    const uid  = String(record.uid  || '').trim();
    const name = String(record.name || '').trim();

    if (!uid || !name) {
      console.warn(`[index] Skipping malformed row: ${JSON.stringify(record)}`);
      continue;
    }

    clients.push({ uid, name });
  }

  if (clients.length === 0) {
    throw new Error('clients.csv is empty or contains no valid rows.');
  }

  return clients;
}

// ---------------------------------------------------------------------------
// Client filtering
// ---------------------------------------------------------------------------

function shouldProcess(client, progressMap) {
  const existing = progressMap.get(client.uid);

  if (!existing) {
    // New client — always process unless we're in retry-errors-only mode.
    return !RETRY_ERRORS_ONLY;
  }

  if (existing.status === 'done') return false;       // already completed
  if (existing.status === 'skipped') return false;    // explicitly skipped

  if (RETRY_ERRORS_ONLY) {
    return existing.status === 'error';               // only errors when flag set
  }

  return true;                                        // status=error: always retry
}

// ---------------------------------------------------------------------------
// Per-client processing
// ---------------------------------------------------------------------------

async function processClient(browser, page, client, downloadDir, progressMap, email, password) {
  console.log(`\n[index] Processing client: ${client.name} (uid=${client.uid})`);
  fs.mkdirSync(downloadDir, { recursive: true });

  let attachmentsFound = 0;
  let attachmentsDownloaded = 0;
  let formsFound = 0;
  let formsDownloaded = 0;

  // --- Attachments ---
  try {
    const result = await downloadAttachments(page, client, downloadDir);
    attachmentsFound      = result.found;
    attachmentsDownloaded = result.downloaded;
  } catch (err) {
    if (err instanceof SessionExpiredError) {
      await reAuthenticate(page, email, password);
      // Retry after re-auth.
      const result = await downloadAttachments(page, client, downloadDir);
      attachmentsFound      = result.found;
      attachmentsDownloaded = result.downloaded;
    } else {
      throw err;
    }
  }

  // --- Forms ---
  try {
    const result = await downloadForms(page, client, downloadDir);
    formsFound      = result.found;
    formsDownloaded = result.downloaded;
  } catch (err) {
    if (err instanceof SessionExpiredError) {
      await reAuthenticate(page, email, password);
      // Retry after re-auth.
      const result = await downloadForms(page, client, downloadDir);
      formsFound      = result.found;
      formsDownloaded = result.downloaded;
    } else {
      throw err;
    }
  }

  return {
    status:                 'done',
    attachments_found:      attachmentsFound,
    attachments_downloaded: attachmentsDownloaded,
    forms_found:            formsFound,
    forms_downloaded:       formsDownloaded,
    error:                  '',
    timestamp:              new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // --- Startup banner ---
  console.log('=== WellnessLiving → Jane App Migration Export ===');
  if (RETRY_ERRORS_ONLY) {
    console.log('[index] Mode: retry errors only (--retry-errors)');
  }

  // --- Load inputs ---
  let clients;
  try {
    clients = loadClients(CLIENTS_CSV);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  console.log(`[index] Loaded ${clients.length} client(s) from clients.csv`);

  const progressMap = loadProgress(PROGRESS_CSV);
  console.log(`[index] Loaded ${progressMap.size} existing progress entries`);

  const toProcess = clients.filter((c) => shouldProcess(c, progressMap));
  if (toProcess.length === 0) {
    console.log('[index] Nothing to do — all clients are already done.');
    return;
  }
  console.log(`[index] ${toProcess.length} client(s) to process`);

  // --- Credentials ---
  let email, password;
  try {
    ({ email, password } = await promptCredentials());
  } catch (err) {
    console.error(`\n[index] ${err.message}`);
    process.exit(1);
  }

  // --- Browser launch ---
  let browser, page;
  try {
    browser = await launchBrowser();
    page    = await login(browser, email, password);
  } catch (err) {
    console.error(`[index] Login failed: ${err.message}`);
    if (browser) await browser.close();
    process.exit(1);
  }

  // --- Main loop ---
  let clientsProcessed = 0;

  for (const client of toProcess) {
    // Periodic session health check.
    if (clientsProcessed > 0 && clientsProcessed % SESSION_REFRESH_INTERVAL === 0) {
      console.log('[index] Checking session validity...');
      const valid = await checkSession(page);
      if (!valid) {
        console.log('[index] Session invalid — re-authenticating...');
        await reAuthenticate(page, email, password);
      }
    }

    try {
      const result = await processClient(
        browser, page, client, DOWNLOAD_DIR, progressMap, email, password
      );

      progressMap.set(client.uid, makeRow(client.uid, client.name, result));
      console.log(
        `[index] ✓ ${client.name} — ` +
        `attachments: ${result.attachments_downloaded}/${result.attachments_found}, ` +
        `forms: ${result.forms_downloaded}/${result.forms_found}`
      );
    } catch (err) {
      logError('Client failed after retries', err, { uid: client.uid, name: client.name });
      progressMap.set(client.uid, makeRow(client.uid, client.name, {
        status: 'error',
        error:  err.message,
        timestamp: new Date().toISOString(),
      }));
      console.error(`[index] ✗ ${client.name} (uid=${client.uid}) — error: ${err.message}`);
    }

    // Persist progress after every client so interruptions lose at most one client.
    saveProgress(PROGRESS_CSV, progressMap);
    clientsProcessed++;

    // Delay before the next client (skip after the last one).
    if (clientsProcessed < toProcess.length) {
      await randomDelay(DELAYS.BETWEEN_CLIENTS.MIN, DELAYS.BETWEEN_CLIENTS.MAX);
    }
  }

  // --- Teardown ---
  await browser.close();

  const done    = [...progressMap.values()].filter((r) => r.status === 'done').length;
  const errors  = [...progressMap.values()].filter((r) => r.status === 'error').length;

  console.log('\n=== Run complete ===');
  console.log(`  Clients done:   ${done}`);
  console.log(`  Clients errors: ${errors}`);
  if (errors > 0) {
    console.log('  Re-run with --retry-errors to retry failed clients.');
  }
}

main().catch((err) => {
  console.error('[index] Unhandled fatal error:', err);
  process.exit(1);
});

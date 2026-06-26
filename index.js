'use strict';

const fs = require('fs');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');
const { parse } = require('csv-parse/sync');

// ---------------------------------------------------------------------------
// Per-worker logging
// ---------------------------------------------------------------------------

const LOGS_DIR = './logs';
const workerStorage = new AsyncLocalStorage();

// Intercept all console calls. When inside a worker context, prefix stdout
// with the worker tag and mirror the line to the worker's log file.
const _log   = console.log.bind(console);
const _error = console.error.bind(console);
const _warn  = console.warn.bind(console);

function formatLine(level, args) {
  const ts  = new Date().toISOString();
  const msg = args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
  return level === 'log' ? `[${ts}] ${msg}` : `[${ts}] [${level.toUpperCase()}] ${msg}`;
}

function intercept(original, level) {
  return (...args) => {
    const store = workerStorage.getStore();
    if (store) {
      const line = formatLine(level, args);
      original(`[W${store.workerId}] ${args.join(' ')}`);
      store.stream.write(line + '\n');
    } else {
      original(...args);
    }
  };
}

console.log   = intercept(_log,   'log');
console.error = intercept(_error, 'error');
console.warn  = intercept(_warn,  'warn');

const {
  DOWNLOAD_DIR,
  CLIENTS_CSV,
  PROGRESS_CSV,
  DELAYS,
  WORKER_COUNT,
} = require('./config');
const { randomDelay, logError, SessionExpiredError } = require('./utils');
const { launchBrowser, createWorkerPage } = require('./stealth');
const { promptCredentials, login, reAuthenticate } = require('./auth');
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
    return !RETRY_ERRORS_ONLY;
  }

  if (existing.status === 'done') return false;
  if (existing.status === 'skipped') return false;

  if (RETRY_ERRORS_ONLY) {
    return existing.status === 'error';
  }

  return true;
}

// ---------------------------------------------------------------------------
// Per-client processing
// ---------------------------------------------------------------------------

async function processClient(page, client, downloadDir) {
  console.log(`\n[index] Processing client: ${client.name} (uid=${client.uid})`);
  fs.mkdirSync(downloadDir, { recursive: true });

  const attachResult = await downloadAttachments(page, client, downloadDir);
  const formsResult  = await downloadForms(page, client, downloadDir);

  return {
    status:                 'done',
    attachments_found:      attachResult.found,
    attachments_downloaded: attachResult.downloaded,
    forms_found:            formsResult.found,
    forms_downloaded:       formsResult.downloaded,
    error:                  '',
    timestamp:              new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('=== WellnessLiving → Jane App Migration Export ===');
  if (RETRY_ERRORS_ONLY) {
    console.log('[index] Mode: retry errors only (--retry-errors)');
  }

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

  let email, password;
  try {
    ({ email, password } = await promptCredentials());
  } catch (err) {
    console.error(`\n[index] ${err.message}`);
    process.exit(1);
  }

  let browser, loginPage;
  try {
    browser   = await launchBrowser();
    loginPage = await login(browser, email, password);
  } catch (err) {
    console.error(`[index] Login failed: ${err.message}`);
    if (browser) await browser.close();
    process.exit(1);
  }

  // ---------------------------------------------------------------------------
  // Shared worker state
  // ---------------------------------------------------------------------------

  // Remaining clients — queue.shift() is safe because Node.js is single-threaded:
  // only one worker can be in a synchronous call at a time, so two workers can
  // never dequeue the same client.
  const queue = [...toProcess];

  // Re-auth mutex: all workers share the same promise so only one re-auth runs
  // at a time and the rest wait for it to finish.
  let reAuthPromise = null;

  // Write lock: ensures concurrent workers don't interleave CSV writes.
  let saveLock = Promise.resolve();

  function saveProgressSerialized() {
    saveLock = saveLock.then(() => saveProgress(PROGRESS_CSV, progressMap));
    return saveLock;
  }

  async function safeReAuthenticate(page) {
    if (!reAuthPromise) {
      reAuthPromise = reAuthenticate(page, email, password)
        .finally(() => { reAuthPromise = null; });
    }
    return reAuthPromise;
  }

  // ---------------------------------------------------------------------------
  // Worker
  // ---------------------------------------------------------------------------

  async function runWorker(page, workerId) {
    const tag = `[worker-${workerId}]`;

    while (true) {
      const client = queue.shift();
      if (!client) break;

      try {
        const result = await processClient(page, client, DOWNLOAD_DIR);
        progressMap.set(client.uid, makeRow(client.uid, client.name, result));
        console.log(
          `${tag} ✓ ${client.name} — ` +
          `attachments: ${result.attachments_downloaded}/${result.attachments_found}, ` +
          `forms: ${result.forms_downloaded}/${result.forms_found}`
        );
      } catch (err) {
        if (err instanceof SessionExpiredError) {
          // Re-auth and put the client back so it gets retried.
          console.log(`${tag} Session expired during ${client.name} — re-authenticating and re-queueing`);
          await safeReAuthenticate(page);
          queue.unshift(client);
        } else {
          logError('Client failed', err, { uid: client.uid, name: client.name });
          progressMap.set(client.uid, makeRow(client.uid, client.name, {
            status:    'error',
            error:     err.message,
            timestamp: new Date().toISOString(),
          }));
          console.error(`${tag} ✗ ${client.name} (uid=${client.uid}) — ${err.message}`);
        }
      }

      saveProgressSerialized();
      await randomDelay(DELAYS.BETWEEN_CLIENTS.MIN, DELAYS.BETWEEN_CLIENTS.MAX);
    }

    console.log(`${tag} Queue empty — worker done`);
  }

  // ---------------------------------------------------------------------------
  // Launch workers
  // ---------------------------------------------------------------------------

  // Reuse the login page as the first worker tab; open WORKER_COUNT-1 more.
  console.log(`[index] Spawning ${WORKER_COUNT} worker tab(s)...`);
  const extraPages = await Promise.all(
    Array.from({ length: WORKER_COUNT - 1 }, () => createWorkerPage(browser))
  );
  const workerPages = [loginPage, ...extraPages];

  // Create per-worker log files.
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  const workerStreams = workerPages.map((_, i) =>
    fs.createWriteStream(path.join(LOGS_DIR, `worker-${i + 1}.log`), { flags: 'a' })
  );
  console.log(`[index] Worker logs → ${LOGS_DIR}/worker-N.log`);

  await Promise.all(
    workerPages.map((p, i) =>
      workerStorage.run({ workerId: i + 1, stream: workerStreams[i] }, () => runWorker(p, i + 1))
    )
  );

  workerStreams.forEach((s) => s.end());

  // ---------------------------------------------------------------------------
  // Teardown
  // ---------------------------------------------------------------------------

  await browser.close();

  const done   = [...progressMap.values()].filter((r) => r.status === 'done').length;
  const errors = [...progressMap.values()].filter((r) => r.status === 'error').length;

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

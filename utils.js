'use strict';

const fs = require('fs');
const path = require('path');
const { DELAYS, ERROR_LOG, USER_AGENT } = require('./config');

// ---------------------------------------------------------------------------
// Custom errors
// ---------------------------------------------------------------------------

class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotFoundError';
  }
}

class SessionExpiredError extends Error {
  constructor(message = 'Session expired') {
    super(message);
    this.name = 'SessionExpiredError';
  }
}

// ---------------------------------------------------------------------------
// Delays
// ---------------------------------------------------------------------------

function randomDelay(min, max) {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Filename / path helpers
// ---------------------------------------------------------------------------

function sanitizeFilename(name) {
  return String(name)
    .replace(/[\\/:*?"<>|&]/g, '')   // chars illegal on Windows NTFS
    .replace(/\s+/g, '_')             // spaces to underscores
    .replace(/_{2,}/g, '_')           // collapse multiple underscores
    .replace(/^_+|_+$/g, '')          // trim leading/trailing underscores
    .substring(0, 180);               // max 180 chars — safe on all platforms
}

function getClientDir(downloadDir, client) {
  const folderName = sanitizeFilename(`${client.name}_${client.uid}`);
  return path.join(downloadDir, folderName);
}

// Extracts the original filename from a Content-Disposition header or URL.
function filenameFromResponse(url, contentDisposition) {
  if (contentDisposition) {
    // RFC 5987 encoded: filename*=UTF-8''foo%20bar.pdf
    const rfc5987 = contentDisposition.match(/filename\*\s*=\s*([^;]+)/i);
    if (rfc5987) {
      const [, encoded] = rfc5987[1].trim().split("''");
      if (encoded) {
        try { return decodeURIComponent(encoded).trim(); } catch (_) {}
      }
    }
    // Plain filename=
    const plain = contentDisposition.match(/filename\s*=\s*"?([^";\n\r]+)"?/i);
    if (plain) return plain[1].trim();
  }

  // Fall back to the last path segment of the URL.
  try {
    const u = new URL(url);
    const segments = u.pathname.split('/').filter(Boolean);
    const last = segments[segments.length - 1];
    if (last) return decodeURIComponent(last);
  } catch (_) {}

  return 'download';
}

// ---------------------------------------------------------------------------
// Safe file write — exits immediately on ENOSPC (disk full).
// ---------------------------------------------------------------------------

function safeWriteFile(filepath, data) {
  try {
    fs.mkdirSync(path.dirname(filepath), { recursive: true });
    fs.writeFileSync(filepath, data);
  } catch (err) {
    if (err.code === 'ENOSPC') {
      console.error('\nFATAL: Disk full. Exiting to prevent file corruption.');
      process.exit(1);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Retry wrapper
// ---------------------------------------------------------------------------

// fn receives the zero-based attempt index.
// NotFoundError and SessionExpiredError are never retried — callers handle those.
async function withRetry(fn, maxRetries = 3) {
  let lastError;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (err instanceof NotFoundError || err instanceof SessionExpiredError) {
        throw err;
      }
      lastError = err;
      if (attempt < maxRetries - 1) {
        const range = attempt === 0 ? DELAYS.RETRY_FIRST : DELAYS.RETRY_SECOND;
        await randomDelay(range.MIN, range.MAX);
      }
    }
  }
  throw lastError;
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function logError(message, error, context = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    message,
    error: error?.message || String(error),
    stack: error?.stack,
    ...context,
  };
  const line = JSON.stringify(entry) + '\n';
  try { fs.appendFileSync(ERROR_LOG, line); } catch (_) {}
  console.error(`[ERROR] ${message}:`, error?.message || error);
}

// ---------------------------------------------------------------------------
// Authenticated file download via Node 22 built-in fetch
// ---------------------------------------------------------------------------

async function downloadFile(url, cookieHeader, destPath) {
  const response = await fetch(url, {
    headers: {
      Cookie: cookieHeader,
      'User-Agent': USER_AGENT,
      Accept: '*/*',
    },
    redirect: 'follow',
  });

  if (response.status === 404) {
    throw new NotFoundError(`404 for ${url}`);
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} downloading ${url}`);
  }

  const contentDisposition = response.headers.get('content-disposition');
  const filename = sanitizeFilename(filenameFromResponse(url, contentDisposition));
  const filepath = path.join(destPath, filename);

  const buffer = Buffer.from(await response.arrayBuffer());
  safeWriteFile(filepath, buffer);

  return filename;
}

// Build a Cookie header string from an array of puppeteer cookie objects.
function cookieHeader(cookies) {
  return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}

module.exports = {
  NotFoundError,
  SessionExpiredError,
  randomDelay,
  sanitizeFilename,
  getClientDir,
  filenameFromResponse,
  safeWriteFile,
  withRetry,
  logError,
  downloadFile,
  cookieHeader,
};

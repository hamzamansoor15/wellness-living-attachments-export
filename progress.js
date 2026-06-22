'use strict';

const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { stringify } = require('csv-stringify/sync');
const { safeWriteFile } = require('./utils');

const HEADERS = [
  'uid',
  'name',
  'status',
  'attachments_found',
  'attachments_downloaded',
  'forms_found',
  'forms_downloaded',
  'error',
  'timestamp',
];

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

// Returns a Map<string uid, rowObject> built from progress.csv.
// Returns an empty Map if the file does not exist or is empty.
function loadProgress(filepath) {
  const map = new Map();
  if (!fs.existsSync(filepath)) return map;

  let content;
  try {
    content = fs.readFileSync(filepath, 'utf8').trim();
  } catch (err) {
    console.warn(`[progress] Could not read ${filepath}: ${err.message}`);
    return map;
  }

  if (!content) return map;

  let records;
  try {
    records = parse(content, { columns: true, skip_empty_lines: true, relax_quotes: true });
  } catch (err) {
    console.warn(`[progress] Could not parse ${filepath}: ${err.message} — starting fresh.`);
    return map;
  }

  for (const row of records) {
    const uid = String(row.uid || '').trim();
    if (uid) map.set(uid, normalizeRow(row));
  }

  return map;
}

// ---------------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------------

// Writes the full progress map to disk as CSV (overwrites the file).
function saveProgress(filepath, progressMap) {
  const rows = [HEADERS.join(',')];

  for (const row of progressMap.values()) {
    const ordered = HEADERS.map((h) => {
      const val = String(row[h] ?? '');
      // Quote fields that might contain commas or quotes.
      return val.includes(',') || val.includes('"') || val.includes('\n')
        ? `"${val.replace(/"/g, '""')}"`
        : val;
    });
    rows.push(ordered.join(','));
  }

  safeWriteFile(filepath, rows.join('\n') + '\n');
}

// ---------------------------------------------------------------------------
// Row factory
// ---------------------------------------------------------------------------

function makeRow(uid, name, data = {}) {
  return normalizeRow({
    uid: String(uid),
    name: String(name),
    status:                   data.status                   ?? 'error',
    attachments_found:        data.attachments_found        ?? 0,
    attachments_downloaded:   data.attachments_downloaded   ?? 0,
    forms_found:              data.forms_found              ?? 0,
    forms_downloaded:         data.forms_downloaded         ?? 0,
    error:                    data.error                    ?? '',
    timestamp:                data.timestamp                ?? new Date().toISOString(),
  });
}

function normalizeRow(row) {
  return {
    uid:                     String(row.uid                     ?? ''),
    name:                    String(row.name                    ?? ''),
    status:                  String(row.status                  ?? 'error'),
    attachments_found:       Number(row.attachments_found       ?? 0),
    attachments_downloaded:  Number(row.attachments_downloaded  ?? 0),
    forms_found:             Number(row.forms_found             ?? 0),
    forms_downloaded:        Number(row.forms_downloaded        ?? 0),
    error:                   String(row.error                   ?? ''),
    timestamp:               String(row.timestamp               ?? ''),
  };
}

module.exports = { loadProgress, saveProgress, makeRow };

# WellnessLiving → Jane App Migration Automation
## Product Requirements Document

**Version:** 1.0  
**Date:** June 2026  
**Status:** Ready for Development

---

## 1. Overview

### 1.1 Purpose

This document defines the requirements for an automated Node.js script that downloads client attachments and completed form responses from WellnessLiving, organized per client in a folder structure compatible with Jane App's bulk import format.

### 1.2 Background

A clinic group operating across 5 locations is migrating from WellnessLiving to Jane App. The migration involves ~1,700 clients with an estimated 27,880 total documents. WellnessLiving does not provide a bulk export for client attachments or forms via API. All data must be retrieved through browser automation against the authenticated web application.

### 1.3 Scope

This script covers two data types:

- **Attachments** — files stored under a client's profile at Documents → Attachments
- **Forms** — completed form responses stored under a client's profile at Documents → Forms

It does not cover appointments, billing, SOAP notes, or any other WellnessLiving data.

---

## 2. Technical Stack

| Component | Package | Version |
|-----------|---------|---------|
| Runtime | Node.js | 22+ |
| Browser automation | puppeteer | latest |
| Bot detection bypass | puppeteer-extra + puppeteer-extra-plugin-stealth | latest |
| CSV input parsing | csv-parse | latest |
| CSV output writing | csv-stringify | latest |
| File system | fs, path | built-in |
| Environment variables | dotenv | latest |

---

## 3. Project Structure

```
wl-migration/
├── index.js              # Entry point and main orchestrator loop
├── auth.js               # Login, session management, cookie persistence
├── attachments.js        # Attachment page navigation and file download
├── forms.js              # Forms API fetch and PDF export logic
├── progress.js           # Progress tracking, CSV logging, resume logic
├── config.js             # Constants: URLs, k_business, paths, delays
├── stealth.js            # Browser launch config and anti-detection setup
├── utils.js              # Filename sanitization, path helpers, retry logic
├── .env                  # Credentials (never committed to git)
├── .env.example          # Template for credentials
├── .gitignore            # Excludes .env, downloads/, progress.csv
├── clients.csv           # Input: uid, name columns
├── progress.csv          # Auto-generated: tracks per-client completion state
├── error.log             # Auto-generated: detailed error log
└── downloads/            # Output root directory
    └── {ClientName}_{uid}/
        ├── attachments/
        └── forms/
```

---

## 4. Input Format

### 4.1 clients.csv

```csv
uid,name
14861978,Rachelle Dziurzynski
12345678,Bailey Thiessen
```

- `uid` — WellnessLiving client user ID
- `name` — Full client name (used for folder naming)
- No header variations accepted — must be exactly `uid,name`

---

## 5. Output Format

### 5.1 Folder structure

```
downloads/
  Rachelle_Dziurzynski_14861978/
    attachments/
      personal_data_policy.pdf
      neuromodulator_consent_form_2024-12-08.pdf
    forms/
      REPEAT_Neuromodulator_Dermal_Filler_926193.pdf
      REPEAT_Neuromodulator_treatment_1101295.pdf
```

### 5.2 Filename rules

- Spaces replaced with underscores
- Special characters stripped: `\ / : * ? " < > | &`
- Max filename length: 180 characters (Windows NTFS safe)
- Forms named as: `{formTitle}_{k_quiz_response}.pdf`
- Attachments use original filename from the download URL

### 5.3 progress.csv

Auto-generated after each client is processed:

```csv
uid,name,status,attachments_found,attachments_downloaded,forms_found,forms_downloaded,error,timestamp
14861978,Rachelle Dziurzynski,done,48,48,4,4,,2026-06-22T10:30:00Z
12345678,Bailey Thiessen,done,38,38,0,0,,2026-06-22T10:31:15Z
99999999,Some Client,error,0,0,0,0,Navigation timeout,2026-06-22T10:32:00Z
```

Status values: `done`, `error`, `skipped`

---

## 6. Functional Requirements

### 6.1 Authentication

- Script prompts for WellnessLiving email and password at runtime via terminal input
- Credentials are never hardcoded or written to disk
- After successful login, session cookies are saved to `session.json` in memory and reused for all subsequent requests
- If a request returns a 401 or redirects to the login page mid-run, the script re-authenticates automatically and retries the current client

### 6.2 Attachments Download

**URL pattern:**
```
https://www.wellnessliving.com/Wl/Profile/Attach/AttachList.html?k_business=643838&uid={uid}
```

**Process:**
1. Navigate directly to the attachment list URL for the client
2. Wait for the table to load (`css-wl-first-table-list`)
3. Extract all `<a href>` elements containing `drive-download` in the href
4. For each download link:
   - Use authenticated `fetch` with session cookies to download the file binary
   - Save to `downloads/{ClientName}_{uid}/attachments/`
5. If zero attachments found, log `attachments_found: 0` and continue to forms

### 6.3 Forms Download

**API endpoint:**
```
GET https://www.wellnessliving.com/rs/report-render.html
```

**Parameters:**
```
a-ajax=1
i_container=0
sid_report=profile-form-response
uid_customer={uid}
k_business=643838
dt_start=2024-01-01
dt_end=2031-12-31
i_page=1
s_sort=+text_create,-text_status,-text_complete
```

**Process:**
1. Make authenticated GET request to report-render with client's `uid_customer`
2. Parse JSON response — extract all rows from the table
3. Filter to only rows where `k_quiz_response != "none"` (completed forms only)
4. For each completed form, trigger individual PDF export using `k_quiz_response` ID
5. Save each as `{formTitle}_{k_quiz_response}.pdf` in `downloads/{ClientName}_{uid}/forms/`
6. If zero completed forms found, log `forms_found: 0` and continue

**Note on incomplete forms:** Forms where `id_status = 3` and `k_quiz_response = "none"` are not exported — there is no response data to download. These are logged in `progress.csv` under `forms_found` vs `forms_downloaded` so the discrepancy is visible.

### 6.4 Resume Support

- On startup, script reads `progress.csv` if it exists
- Any client with status `done` is skipped entirely
- Any client with status `error` is retried
- Allows safe interruption and restart at any point without re-downloading completed clients

---

## 7. Anti-Detection & Rate Limiting Strategy

This is critical. WellnessLiving's platform will flag and block automated sessions if requests are made too fast or if the browser fingerprint looks non-human. The following strategy must be implemented in full.

### 7.1 Browser Fingerprint Hardening

**Use `puppeteer-extra-plugin-stealth`** — this patches the following detection vectors automatically:

- `navigator.webdriver` flag (the most common bot detection check)
- Chrome headless detection via `window.chrome`
- Plugin and MIME type spoofing
- `permissions.query` override
- `navigator.languages` and `navigator.platform` normalization

**Additional manual patches in `stealth.js`:**

```js
// Set a real user agent — never use the default headless one
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

// Set realistic viewport
await page.setViewport({ width: 1366, height: 768 });

// Set Accept-Language header
await page.setExtraHTTPHeaders({
  'Accept-Language': 'en-US,en;q=0.9',
});

// Disable automation-specific features
args: [
  '--disable-blink-features=AutomationControlled',
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-accelerated-2d-canvas',
  '--disable-gpu',
]
```

### 7.2 Request Delay Strategy

Delays are randomized within a range to mimic human browsing patterns. No two requests are spaced equally.

| Action | Delay Range | Reason |
|--------|-------------|--------|
| Between clients | 3,000 – 6,000 ms | Primary rate limit buffer |
| Between file downloads within a client | 800 – 1,800 ms | Simulate manual clicking |
| After login | 2,000 – 3,000 ms | Wait for session to settle |
| After navigation | 1,000 – 2,500 ms | Page render buffer |
| After failed request (first retry) | 8,000 – 12,000 ms | Backoff |
| After failed request (second retry) | 20,000 – 30,000 ms | Extended backoff |

All delays use a `randomDelay(min, max)` utility:
```js
const randomDelay = (min, max) => 
  new Promise(r => setTimeout(r, Math.floor(Math.random() * (max - min + 1)) + min));
```

### 7.3 Retry Logic

Every network operation wraps in a retry handler:

- **Max retries:** 3 per operation
- **Retry on:** navigation timeout, network error, 5xx response, session expiry
- **Do not retry on:** 404 (file genuinely missing — log and skip)
- After 3 failures on a single client, mark as `error` in progress.csv and move to next client — never block the entire run on one client

### 7.4 Session Management

- Login is performed once at the start
- Session cookies are held in memory and injected into every request
- Every 200 clients, the script checks session validity by making a lightweight authenticated request — re-authenticates silently if expired
- Browser is never fully closed between clients — same browser instance runs the entire job to maintain session continuity

### 7.5 Concurrency

- **Single-threaded only** — one client processed at a time, no parallelism
- Running multiple instances simultaneously against the same account risks an IP ban
- If faster processing is needed in future, it should be done by splitting `clients.csv` into batches and running on separate machines with separate accounts

### 7.6 Additional Precautions

- Run during off-peak hours (overnight) to reduce server load detection
- Do not run from a cloud server IP (AWS/GCP/Azure IPs are commonly flagged) — run from a local machine or residential IP only
- If the script is interrupted mid-session, wait at least 5 minutes before restarting to avoid rapid re-authentication flags

---

## 8. Error Handling

| Scenario | Behaviour |
|----------|-----------|
| Client has 0 attachments | Log `attachments_found: 0`, continue to forms |
| Client has 0 completed forms | Log `forms_found: 0`, continue to next client |
| File download returns 404 | Log filename as missing, skip, continue |
| Navigation timeout | Retry up to 3 times with backoff, then mark client as `error` |
| Session expired mid-run | Re-authenticate silently, retry current operation |
| Login fails at startup | Exit with clear error message — do not proceed |
| Disk full | Exit immediately with error — do not corrupt partial files |
| Malformed client row in CSV | Skip row, log warning, continue |

---

## 9. Configuration

All configurable values live in `config.js`:

```js
module.exports = {
  K_BUSINESS: '643838',
  BASE_URL: 'https://www.wellnessliving.com',
  ATTACHMENTS_PATH: '/Wl/Profile/Attach/AttachList.html',
  FORMS_REPORT_PATH: '/rs/report-render.html',
  FORMS_DATE_START: '2024-01-01',
  FORMS_DATE_END: '2031-12-31',
  DOWNLOAD_DIR: './downloads',
  CLIENTS_CSV: './clients.csv',
  PROGRESS_CSV: './progress.csv',
  ERROR_LOG: './error.log',
  SESSION_REFRESH_INTERVAL: 200, // clients between session checks
  DELAYS: {
    BETWEEN_CLIENTS: { MIN: 3000, MAX: 6000 },
    BETWEEN_DOWNLOADS: { MIN: 800, MAX: 1800 },
    AFTER_LOGIN: { MIN: 2000, MAX: 3000 },
    AFTER_NAVIGATION: { MIN: 1000, MAX: 2500 },
    RETRY_FIRST: { MIN: 8000, MAX: 12000 },
    RETRY_SECOND: { MIN: 20000, MAX: 30000 },
  }
};
```

---

## 10. Running the Script

### 10.1 Setup

```bash
# Install dependencies
npm install

# Copy env template
cp .env.example .env

# Add your clients list
# clients.csv must have uid,name columns
```

### 10.2 Run

```bash
node index.js
```

Script will prompt:
```
WellnessLiving email: _
WellnessLiving password: _
```

Credentials are not echoed or stored.

### 10.3 Resume after interruption

```bash
# Just run again — progress.csv is read automatically
node index.js
```

Clients already marked `done` are skipped.

### 10.4 Retry only failed clients

```bash
node index.js --retry-errors
```

Only processes clients with status `error` in progress.csv.

---

## 11. Cross-Platform Compatibility

The script is written to run on Linux, macOS, and Windows without code changes:

- All file paths use `path.join()` — never hardcoded `/` or `\` separators
- Filenames are sanitized to remove characters illegal on Windows NTFS
- Puppeteer downloads its own Chromium — no system Chrome dependency
- No OS-specific shell commands used anywhere

---

## 12. Out of Scope

The following are explicitly not handled by this script:

- SOAP notes
- Contracts
- Billing or financial records
- Appointment history
- Uploading files to Jane App (this script handles export only)
- Deduplication of files (e.g. repeated imports in WellnessLiving)

---

## 13. Acceptance Criteria

- [ ] Script runs end-to-end on a test batch of 10 clients without error
- [ ] All completed form PDFs are downloaded and named correctly
- [ ] All attachments are downloaded with original filenames preserved
- [ ] progress.csv accurately reflects the state after each client
- [ ] Resuming from an interrupted run skips already-completed clients
- [ ] No client credentials are written to disk at any point
- [ ] Script completes 1,700 clients in a single overnight run without IP ban or session expiry
- [ ] Output folder structure is compatible with Jane App bulk import requirements

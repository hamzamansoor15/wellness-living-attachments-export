# WellnessLiving Attachments Export

Puppeteer-based CLI tool that bulk-downloads client attachments and completed form responses from WellnessLiving. WellnessLiving has no native bulk export for these data types, so the tool drives a real browser session to navigate each client's profile and download files.

## Source layout

| File | Role |
|---|---|
| `index.js` | Entry point — worker queue, re-auth mutex, serialized CSV writes |
| `src/config.js` | All configuration constants and env vars |
| `src/auth.js` | WL login, session health check, re-authentication |
| `src/attachments.js` | Navigates client attachment page, downloads files |
| `src/forms.js` | Navigates forms report, exports form PDFs and CSVs |
| `src/stealth.js` | Puppeteer browser launch with anti-detection settings |
| `src/utils.js` | Random delays, filename sanitization, retry logic, error helpers |
| `src/progress.js` | Reads/writes `progress.csv` for resumable runs |

## How to run

```bash
cp .env.example .env          # set K_BUSINESS in .env
cp clients-sample.csv clients.csv  # populate with real uid,name rows
npm install
npm start                     # prompts for WL email + password at runtime
npm run retry                 # re-process only clients with error status
```

## Key patterns

- **Worker queue**: `queue.shift()` in `index.js` is safe without locks because Node.js is single-threaded — concurrent async workers can't dequeue the same client simultaneously.
- **Re-auth mutex**: `reAuthPromise` in `index.js` ensures only one worker runs re-authentication at a time; others await the same promise.
- **Serialized CSV writes**: `saveLock = saveLock.then(...)` chains saves sequentially so concurrent workers never interleave writes to `progress.csv`.

## What not to break

- **Resume logic** (`src/progress.js`): clients with `status=done` must be skipped on re-run.
- **Session expiry** (`SessionExpiredError`): thrown in `src/attachments.js` and `src/forms.js`, caught in `index.js` to trigger re-auth and re-queue the client.
- **`--retry-errors` flag**: only processes clients with `status=error` in `progress.csv`.

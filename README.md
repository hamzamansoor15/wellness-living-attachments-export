# WellnessLiving Attachments Export

![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen) ![License](https://img.shields.io/badge/license-MIT-blue)

Bulk-export client attachments and completed form responses from WellnessLiving via browser automation.

WellnessLiving does not provide a way to bulk-download client attachments or completed form responses. This tool drives a real browser session with Puppeteer to navigate each client's profile and download everything, organized per client into a folder structure ready for import into other systems.

---

## What gets downloaded

- **Attachments** — files stored under a client's profile at Documents → Attachments
- **Forms** — completed form responses exported as PDF and CSV

---

## Prerequisites

- [Node.js](https://nodejs.org/) 22 or higher
- A WellnessLiving staff account with access to client profiles
- ~300 MB of disk space for Chromium, which Puppeteer downloads automatically on `npm install`

---

## Setup

**Step 1 — Clone the repository**
```bash
git clone https://github.com/hamzamansoor15/wellness-living-attachments-export.git
cd wellness-living-attachments-export
```

**Step 2 — Install dependencies**
```bash
npm install
```

**Step 3 — Configure your environment**
```bash
cp .env.example .env
```
Open `.env` and set `K_BUSINESS` to your WellnessLiving business ID. You can find it in the URL bar on any WellnessLiving page when logged in — look for `k_business=XXXXX`.

**Step 4 — Prepare your client list**
```bash
cp clients-sample.csv clients.csv
```
Edit `clients.csv` and add one row per client:
```csv
uid,name
123456789,Jane Doe
987654321,John Smith
```
Client UIDs appear in the URL when you open a client profile in WellnessLiving (`?uid=XXXXX`).

**Step 5 — Run**
```bash
npm start
```
You will be prompted for your WellnessLiving email and password. Credentials are entered at runtime and never written to disk.

---

## Output

Downloaded files are organized under `./downloads/` (configurable via `DOWNLOAD_DIR`):

```
downloads/
  Jane_Doe_123456789/
    attachments/
      Intake_Form.pdf
      photo.jpg
    forms/
      MEDICAL_HEALTH_QUESTIONNAIRE_2023-04-01_98765.pdf
      MEDICAL_HEALTH_QUESTIONNAIRE_2023-04-01_98765.csv
```

---

## Resuming interrupted runs

Progress is tracked in `progress.csv`. If the script stops for any reason, re-run `npm start` — clients already marked `done` are skipped automatically.

## Retrying failed clients

```bash
npm run retry
```

Only processes clients with `error` status in `progress.csv`.

---

## Configuration

All options are set in your `.env` file (copy from `.env.example`):

| Variable | Default | Description |
|---|---|---|
| `K_BUSINESS` | **required** | Your WellnessLiving business ID |
| `WORKER_COUNT` | `3` | Number of parallel browser tabs. Higher is faster but may trigger rate limits — start at 2–3. |
| `DOWNLOAD_DIR` | `./downloads` | Output directory for downloaded files |
| `HEADLESS` | `true` | Set to `false` to watch the browser (useful for debugging) |

---

## Troubleshooting

**Login fails or the browser gets stuck**
Run with `HEADLESS=false` to watch the browser and see what's happening:
```bash
HEADLESS=false npm start
```

**Rate limits or bot detection**
Lower the parallelism:
```bash
WORKER_COUNT=1 npm start
```

**Detailed logs**
- Per-worker logs: `logs/worker-1.log`, `logs/worker-2.log`, …
- Error summary: `error.log`

---

---

## Data & privacy

Downloaded files are stored **locally only** and are never uploaded anywhere. It is your responsibility to handle them according to applicable privacy laws and your organization's data policies.

- Never commit `clients.csv`, `progress.csv`, or the `downloads/` folder to version control. All three are excluded by `.gitignore`.
- Your WellnessLiving credentials are entered at runtime and are never written to disk.
- Use of this tool must comply with your WellnessLiving subscription terms and any applicable data protection regulations.

---

## Contributing

Pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for how to set up a local development environment and the contribution guidelines.

---

## License

[MIT](LICENSE)

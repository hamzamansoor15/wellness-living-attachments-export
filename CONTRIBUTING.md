# Contributing

Thank you for your interest in contributing! This is a small CLI tool and contributions are welcome — bug fixes, documentation improvements, and new features alike.

## Getting started

**1. Fork and clone**
```bash
git clone https://github.com/<your-username>/wellness-living-attachments-export.git
cd wellness-living-attachments-export
```

**2. Install dependencies**
```bash
npm install
```
This will also download a Chromium binary (~300 MB) via Puppeteer.

**3. Configure**
```bash
cp .env.example .env           # set K_BUSINESS in .env
cp clients-sample.csv clients.csv   # add your own test client UIDs
```

**4. Run**
```bash
npm start
```
You will be prompted for your WellnessLiving email and password at runtime.

## Project layout

| File | Role |
|---|---|
| `index.js` | Entry point — worker queue, re-auth mutex, serialized CSV writes |
| `src/config.js` | All configuration constants and env vars |
| `src/auth.js` | Login, session health check, re-authentication |
| `src/attachments.js` | Navigates client attachment page, downloads files |
| `src/forms.js` | Navigates forms report, exports PDFs and CSVs |
| `src/stealth.js` | Puppeteer browser launch with anti-detection settings |
| `src/utils.js` | Random delays, filename sanitization, retry logic, error helpers |
| `src/progress.js` | Reads/writes `progress.csv` for resumable runs |

## Coding conventions

- Match the style of the existing code: CommonJS (`require`/`module.exports`), async/await, no external type system.
- Keep modules focused. Each `src/` file has one clear job; don't add cross-cutting concerns to existing modules.
- Use `HEADLESS=false npm start` to watch the browser while debugging automation changes.
- Run `npm run lint` before opening a PR.

## Pull request checklist

- [ ] I tested the change against a real WellnessLiving session (or clearly marked it as untested).
- [ ] I have not committed `clients.csv`, `progress.csv`, `downloads/`, or `.env`.
- [ ] `npm run lint` passes.
- [ ] The PR description explains what changed and why.

## Reporting issues

Please use the GitHub issue templates. Include your Node.js version (`node -v`) and paste any relevant output from the `logs/` directory.

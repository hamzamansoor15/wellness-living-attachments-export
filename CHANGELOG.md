# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] — 2026-06-27

### Added
- Parallel worker queue to process multiple clients concurrently (configurable via `WORKER_COUNT`)
- Bulk download of client attachments stored under Documents → Attachments in WellnessLiving
- Bulk export of completed form responses as PDF and CSV
- Resumable runs via `progress.csv` — clients already marked `done` are skipped on re-run
- `--retry-errors` flag (`npm run retry`) to reprocess only clients that previously failed
- Re-authentication mutex so only one worker re-logs in when a session expires, while others wait and continue
- Serialized writes to `progress.csv` so concurrent workers never interleave CSV output
- Per-worker log files (`logs/worker-N.log`) and a consolidated `error.log`
- Puppeteer stealth mode to reduce bot-detection false positives
- All configuration via `.env` — no credentials or business IDs hardcoded in source
- Runtime credential prompting — email and password are never written to disk

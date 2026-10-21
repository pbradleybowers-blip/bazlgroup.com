# bazlgroup.com

Personal site of Brad Bowers, built on the Bowers design system. Static HTML, hosted on GitHub Pages.

## Interview practice (unlisted)

`practice/index.html` is a mock interview tool behind an access code. It is not linked from the site and asks search engines not to index it.
Its backend is a separate Cloudflare Worker, `worker/interview.js` (deployed as `bazl-interview`), so it never affects the site assistant (`worker/worker.js`, deployed as `bazl-ask`).

Worker secrets and settings:
- `ANTHROPIC_API_KEY`.
- `ACCESS_HASH`: Brad's own access code as a salted SHA-256 fingerprint (`sha256:<salt hex>:<hash hex>`). It signs in as person `brad`, the only admin.
- `ACCESS_CODES`: personal codes for everyone else, a JSON object of person id to fingerprint (or to `{"hash": ..., "name": ...}`). Make one with `node scripts/make-code.mjs tester4 "Display name"`. Never commit real codes or this value.
- `SESSIONS_PER_DAY` (optional, default 3): interviews each person can start per day. The count resets at midnight US Central time. Brad is exempt.
- KV binding `HISTORY` (namespace `bazl-interview-history`): stores only session summaries per person (date, role, company, level, panelist, mode, length, verdict, pattern) and usage counts. Never resumes, job descriptions or transcripts. Without it, history stays in the browser and there is no daily limit.
Tests:
- Worker: `node --test worker/interview.test.mjs worker/worker.test.mjs`.
- Page: `bash tests/browser/run.sh` runs the page in headless Chromium against the real Worker code with a fake model and in-memory KV (needs python playwright). It covers sign-in, the account bar, the daily limit, history, the admin table, the privacy panel, the browser-only fallback and failure paths.
- Live site, read-only, no model calls: `LIVE_CODE=<tester code> python3 tests/browser/live_check.py`.
To try the page locally against a local Worker: `practice/?api=http://localhost:8787`.

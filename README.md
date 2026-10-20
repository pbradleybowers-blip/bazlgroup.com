# bazlgroup.com

Personal site of Brad Bowers, built on the Bowers design system. Static HTML, hosted on GitHub Pages.

## Interview practice (unlisted)

`practice/index.html` is a mock interview tool behind an access code. It is not linked from the site and asks search engines not to index it.
Its backend is a separate Cloudflare Worker, `worker/interview.js` (deployed as `bazl-interview`), so it never affects the site assistant (`worker/worker.js`, deployed as `bazl-ask`).

Worker secrets: `ANTHROPIC_API_KEY` and `ACCESS_HASH` (a salted SHA-256 fingerprint of the access code, `sha256:<salt hex>:<hash hex>`).
Tests: `node --test worker/interview.test.mjs worker/worker.test.mjs`.
To try the page locally against a local Worker: `practice/?api=http://localhost:8787`.

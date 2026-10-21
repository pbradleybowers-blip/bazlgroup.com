# Read-only check of the live site and Worker. It makes no model calls and saves nothing.
# Usage: LIVE_CODE=<a tester code> python3 tests/browser/live_check.py
import os, sys
from playwright.sync_api import sync_playwright, expect
code = os.environ.get('LIVE_CODE')
if not code: sys.exit('Set LIVE_CODE to a tester code.')
fails, errors = [], []
def ok(n, c): print(('PASS ' if c else 'FAIL ') + n); c or fails.append(n)
with sync_playwright() as p:
    b = p.chromium.launch()
    for tz in ['America/Chicago', 'America/New_York']:
        page = b.new_context(viewport={'width': 1440, 'height': 780}, timezone_id=tz).new_page()
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.goto('https://bazlgroup.com/practice/?v=live' + str(os.getpid()))
        expect(page.locator('#v-gate')).to_be_visible()
        page.click('#v-gate .privacy-note [data-privacy]'); ok(tz + ': privacy panel opens', page.locator('#privacy').is_visible()); page.click('#privacy-close')
        page.fill('#code', code); page.click('#gate-form button[type=submit]')
        page.wait_for_selector('#v-setup [data-acct]:not([hidden])', timeout=15000)
        t = page.inner_text('#v-setup [data-acct]')
        print('   bar:', t.replace('\n', ' | '))
        ok(tz + ': bar shows who and the limit', 'Signed in as' in t and ('left today' in t or 'No interviews left' in t))
        ok(tz + ': local time shown only outside Central', ('your time' in t) == (tz != 'America/Chicago'))
        page.click('#v-setup [data-go="history"]'); page.wait_for_selector('#history table.hist, #history .empty', timeout=15000)
        ok(tz + ': history loads from the server', 'any device' in page.inner_text('#history'))
        page.click('#v-history .acct .signout'); ok(tz + ': sign out', page.locator('#v-gate').is_visible())
    b.close()
ok('no JavaScript errors', not errors)
sys.exit(1 if fails else 0)

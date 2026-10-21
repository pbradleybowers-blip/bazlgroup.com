# Browser tests for the interview practice page. Start with: bash tests/browser/run.sh
# Uses server.mjs (the real Worker with a fake model and in-memory KV) on 8787, the same without KV on 8788,
# and the repo served on 8080. Speech is stubbed out so answers are typed. Exits 1 on any failure.
import json, os, sys, tempfile, time, urllib.request
from playwright.sync_api import sync_playwright, expect

BASE = 'http://localhost:8080/practice/?api=http://localhost:%d'
SHOTS = os.path.join(tempfile.gettempdir(), 'practice-shots') + os.sep
os.makedirs(SHOTS, exist_ok=True)
STUB = """
Object.defineProperty(window, 'webkitSpeechRecognition', { value: undefined });
Object.defineProperty(window, 'SpeechRecognition', { value: undefined });
const fakeSynth = { speak(u) { setTimeout(() => u.onend && u.onend(), 5); }, cancel() {}, getVoices() { return []; }, onvoiceschanged: null };
Object.defineProperty(window, 'speechSynthesis', { value: fakeSynth });
window.SpeechSynthesisUtterance = function (t) { this.text = t; };
"""
JD = 'Own the product strategy for our marketplace and lead a team of PMs. ' * 6
RESUME = 'Pat Lee. Senior PM at Acme. Led checkout redesign, grew conversion. ' * 6
W, H = 1440, 780

results, page_errors = [], []
def ok(name, cond=True):
    results.append((name, bool(cond)))
    print(('PASS ' if cond else 'FAIL ') + name, flush=True)

def in_view(page, sel):
    box = page.locator(sel).first.bounding_box()
    return box is not None and box['y'] >= 0 and box['y'] + box['height'] <= H and box['x'] >= 0 and box['x'] + box['width'] <= W

def kv(port=8787):
    return dict(json.load(urllib.request.urlopen('http://localhost:%d/__kv' % port)))

def new_page(browser, port=8787, tz='America/Chicago'):
    ctx = browser.new_context(viewport={'width': W, 'height': H}, timezone_id=tz)
    ctx.add_init_script(STUB)
    page = ctx.new_page()
    page.on('pageerror', lambda e: page_errors.append(str(e)))
    page.goto(BASE % port)
    return page

def sign_in(page, code):
    page.fill('#code', code); page.click('#gate-form button[type=submit]')
    expect(page.locator('#v-setup')).to_be_visible()
    page.wait_for_selector('#v-setup [data-acct]:not([hidden])')

def bar(page, view='setup'):
    return page.inner_text(f'#v-{view} [data-acct]')

def fill_setup(page, mode='coach'):
    page.fill('#f-role', 'Director of Product')
    page.click('#levels .chip:has-text("Director")')
    if not page.locator('#f-jdtext').is_visible(): page.click('#jd-toggle')
    page.fill('#f-jdtext', JD)
    if not page.locator('#f-resumetext').is_visible(): page.click('#resume-toggle')
    page.fill('#f-resumetext', RESUME)
    page.click(f'#modes [data-mode="{mode}"]')

def answer(page, mode):
    page.wait_for_selector('#typebox:not([hidden])', timeout=10000)
    page.fill('#typed', 'i led the checkout redesign and we grew conversion')
    page.click('#send-typed')
    if mode == 'coach': page.wait_for_selector('#cb-next', timeout=10000)
    else: page.wait_for_selector('#typebox:not([hidden])', timeout=10000)

def end_interview(page):
    page.click('#end'); page.click('#end')
    page.wait_for_selector('#verdict-h', timeout=15000)

def session(page, mode='coach'):
    fill_setup(page, mode); page.click('#start')
    page.wait_for_selector('#v-ready:not([hidden])', timeout=15000)
    page.click('#join'); answer(page, mode); end_interview(page)

with sync_playwright() as p:
    b = p.chromium.launch()

    # ---------------- Access code screen and privacy panel ----------------
    page = new_page(b)
    expect(page.locator('#v-gate')).to_be_visible()
    ok('gate shows the privacy note', page.locator('#v-gate .privacy-note').is_visible())
    page.screenshot(path=SHOTS + '01-gate.png')
    opener = '#v-gate .privacy-note [data-privacy]'
    page.click(opener); expect(page.locator('#privacy')).to_be_visible()
    txt = page.inner_text('#privacy')
    ok('privacy close button on screen', in_view(page, '#privacy-close'))
    ok('privacy covers Claude, Google speech, deletion and counts', all(t in txt for t in ["Anthropic's Claude", 'Google', 'delete your history', 'counts stay']))
    ok('privacy links Anthropic policy pages', page.inner_html('#privacy').count('privacy.claude.com') == 2)
    page.keyboard.press('Escape'); expect(page.locator('#privacy')).to_be_hidden()
    page.click(opener); page.mouse.click(20, 20)  # the backdrop
    expect(page.locator('#privacy')).to_be_hidden()
    ok('privacy closes on backdrop click and returns focus', page.evaluate("document.activeElement && document.activeElement.hasAttribute('data-privacy')"))

    page.fill('#code', 'wrong-code-1'); page.click('#gate-form button[type=submit]')
    expect(page.locator('#code-err')).to_be_visible()
    ok('wrong code is refused', "didn't work" in page.inner_text('#code-err'))

    # ---------------- Tester: account bar, sessions, limit ----------------
    sign_in(page, 'maple-river-123')
    t = bar(page)
    ok('bar: signed in as tester1', page.inner_text('#v-setup [data-acct] .acct-who b') == 'tester1')
    ok('bar: 2 of 2 left', '2 of 2 interviews left today' in t)
    ok('bar: resets at midnight Central with countdown, no "your time" in Central', 'midnight Central time' in t and ', in ' in t and 'your time' not in t)
    ok('bar is at the top of the page', page.locator('#v-setup [data-acct]').bounding_box()['y'] < 120)
    ok('resume privacy note mentions Anthropic', 'Anthropic' in page.inner_text('#v-setup .privacy-note'))
    ok('Start button on screen', in_view(page, '#start'))
    page.screenshot(path=SHOTS + '02-setup.png')
    page.click('#v-setup footer [data-privacy]'); expect(page.locator('#privacy')).to_be_visible(); page.click('#privacy-close')

    fill_setup(page, 'coach'); page.click('#start')
    page.wait_for_selector('#v-ready:not([hidden])', timeout=15000)
    page.click('#join'); answer(page, 'coach')
    ok('coach buttons on screen', in_view(page, '#cb-next'))
    page.screenshot(path=SHOTS + '03-coach.png')
    end_interview(page)
    ok('debrief says the summary is saved under the code', 'saved under your access code' in page.inner_text('#debrief'))
    store = kv()
    ok('server has one summary for tester1', len(json.loads(store['h:tester1']['value'])) == 1)
    ok('summary holds no answer text or resume', 'checkout' not in store['h:tester1']['value'] and 'Acme' not in store['h:tester1']['value'])
    ok('browser keeps no copy when the server saved it', page.evaluate("localStorage.getItem('bi_sessions')") in (None, '[]'))

    # Practice again prepares a fresh brief, so it counts.
    page.click('#again')
    page.wait_for_selector('#v-ready:not([hidden])', timeout=15000)
    counts = [v['value'] for k, v in kv().items() if k.startswith('n:tester1:')]
    ok('practice again counted toward the limit', counts == ['2'])
    page.click('#join'); answer(page, 'coach')
    page.click('#end'); page.wait_for_timeout(400)
    ok('one click on End does not end a second interview', page.locator('#v-room').is_visible() and page.inner_text('#end') == 'Click again to end')
    page.click('#end'); page.wait_for_selector('#verdict-h', timeout=15000)
    ok('practice again is off when none are left', page.locator('#again').is_disabled() and 'No interviews left' in page.inner_text('#again'))

    page.click('#v-debrief [data-go="history"]'); page.wait_for_selector('table.hist tbody tr')
    ok('history lists 2 sessions from the server', page.locator('table.hist tbody tr').count() == 2)
    ok('history says it follows you', 'any device' in page.inner_text('#history'))
    ok('bar shown on History', page.locator('#v-history [data-acct]').is_visible())
    ok('no admin table for a tester', page.locator('#admin-table').count() == 0)

    page.click('#v-history [data-go="setup"]')
    ok('bar: none left', 'No interviews left today' in bar(page))
    ok('Start is off at the limit', page.locator('#start').is_disabled())
    ok('action bar says when more open up', "used today's 2" in page.inner_text('#start-help') and 'midnight Central' in page.inner_text('#start-help'))
    page.screenshot(path=SHOTS + '04-none-left.png')
    page.evaluate("document.getElementById('start').disabled = false")  # the server must still refuse
    fill_setup(page); page.click('#start')
    page.wait_for_selector('#setup-err-top:not([hidden])', timeout=10000)
    msg = page.inner_text('#setup-err-top')
    ok('server refuses a third interview, page explains: ' + msg, "used all 2 of today's practice interviews" in msg and 'midnight Central' in msg)

    page.click('#v-setup [data-go="history"]'); page.wait_for_selector('table.hist tbody tr')
    page.click('#h-delete'); page.click('#h-delete'); page.wait_for_selector('#history .empty')
    ok('delete my history removes it from the server', 'h:tester1' not in kv())

    page.click('#v-history .acct .signout'); expect(page.locator('#v-gate')).to_be_visible()
    ok('use a different code forgets the code', page.evaluate("JSON.parse(localStorage.getItem('bi_code'))") in (None, ''))

    # ---------------- Brad: no limit, admin table ----------------
    sign_in(page, 'brad-code-1')
    ok('Brad sees no daily limit', 'No daily limit for you' in bar(page) and not page.locator('#start').is_disabled())
    page.click('#v-setup [data-go="history"]'); page.wait_for_selector('#admin-table tbody tr')
    rows = page.inner_text('#admin-table')
    ok('admin: tester1 started 2, finished 2', any(l.startswith('tester1') and '\t2\t2\t' in l for l in rows.splitlines()))
    ok('admin: Sam not yet, no content shown', 'Sam' in rows and 'Not yet' in rows and 'Director of Product' not in rows)
    page.screenshot(path=SHOTS + '05-admin.png')
    page.reload(); expect(page.locator('#v-setup')).to_be_visible()
    page.wait_for_function("(document.querySelector('#v-setup [data-acct] .acct-who b')||{}).textContent === 'Brad'")
    ok('reload remembers the code and who it is', True)
    ok('setup fields reset on reload', page.input_value('#f-role') == '')

    # A code removed from ACCESS_CODES lands back on the access code screen.
    page.evaluate("localStorage.setItem('bi_code', JSON.stringify('revoked-code-1'))"); page.reload()
    expect(page.locator('#v-gate')).to_be_visible(timeout=5000)
    ok('a revoked code is sent back to the access code screen', True)
    page.context.close()

    # ---------------- No HISTORY binding: browser-only history ----------------
    p2 = new_page(b, port=8788, tz='UTC')
    sign_in(p2, 'maple-river-123')
    ok('no KV: no daily limit shown', 'left today' not in bar(p2))
    session(p2, 'realistic')
    ok('no KV: debrief says browser only', 'saved in this browser only' in p2.inner_text('#debrief'))
    ok('no KV: summary stored in the browser', len(json.loads(p2.evaluate("localStorage.getItem('bi_sessions')"))) == 1)
    p2.click('#v-debrief [data-go="history"]'); p2.wait_for_selector('table.hist tbody tr')
    ok('no KV: history reads the browser', 'in this browser' in p2.inner_text('#history'))
    p2.click('#h-delete'); p2.click('#h-delete'); p2.wait_for_selector('#history .empty')
    ok('no KV: delete clears the browser', p2.evaluate("localStorage.getItem('bi_sessions')") is None)
    p2.evaluate("localStorage.setItem('bi_sessions', JSON.stringify([{id:1,at:'2026-09-01T10:00:00Z',role:'PM',verdict:'No'}]))")
    p2.click('#v-history footer .signout'); expect(p2.locator('#v-gate')).to_be_visible()
    ok('use a different code also clears browser-only history', p2.evaluate("localStorage.getItem('bi_sessions')") is None)
    p2.context.close()

    # ---------------- Outside Central; moving old sessions; failure paths ----------------
    p3 = new_page(b, tz='UTC')
    p3.evaluate("""localStorage.setItem('bi_code', JSON.stringify('cobalt-stone-456')); localStorage.setItem('bi_sessions', JSON.stringify([{id:5,at:'2026-09-01T10:00:00Z',role:'PM',company:'Old Co',level:'Senior PM',persona:'Tom Weller',mode:'coach',elapsed:600,verdict:'No',pattern:'Rambles'}]))""")
    p3.reload(); p3.wait_for_selector('#v-setup [data-acct]:not([hidden])')
    t3 = bar(p3)
    ok('outside Central the bar adds your local reset time', 'your time' in t3 and 'Sam' in t3)
    p3.click('#v-setup [data-go="history"]'); p3.wait_for_selector('#h-move')
    p3.click('#h-move'); p3.wait_for_selector('table.hist tbody tr')
    ok('older browser-only sessions move to the server', 'h:tester2' in kv() and p3.locator('#h-move').count() == 0)

    # The model call fails with an unknown error, then the save fails: the page explains, keeps working, and falls back.
    p3.route('**/turn', lambda r: r.fulfill(status=500, content_type='application/json', body='{"error":"weird"}', headers={'Access-Control-Allow-Origin': 'http://localhost:8080'}))
    p3.route('**/history/save', lambda r: r.fulfill(status=500, content_type='application/json', body='{"error":"upstream_error","detail":"kv down"}', headers={'Access-Control-Allow-Origin': 'http://localhost:8080'}))
    p3.click('#v-history [data-go="setup"]')
    fill_setup(p3, 'realistic'); p3.click('#start')
    p3.wait_for_selector('#v-ready:not([hidden])', timeout=15000); p3.click('#join')
    p3.wait_for_selector('#typebox:not([hidden])'); p3.fill('#typed', 'my answer'); p3.click('#send-typed')
    p3.wait_for_selector('#toast:not([hidden])', timeout=10000)
    ok('unknown error shows a message with details: ' + p3.inner_text('#toast-text'), 'Details: weird' in p3.inner_text('#toast-text'))
    end_interview(p3)
    ok('failed save falls back to this browser', 'saved in this browser only' in p3.inner_text('#debrief') and len(json.loads(p3.evaluate("localStorage.getItem('bi_sessions')"))) == 1)
    p3.route('**/history/delete', lambda r: r.fulfill(status=500, content_type='application/json', body='{"error":"upstream_error"}', headers={'Access-Control-Allow-Origin': 'http://localhost:8080'}))
    p3.click('#v-debrief [data-go="history"]'); p3.wait_for_selector('#h-delete')
    p3.click('#h-delete'); p3.click('#h-delete'); p3.wait_for_function("document.getElementById('h-del-msg').textContent.length > 0")
    ok('failed delete says so and the button works again', not p3.locator('#h-delete').is_disabled() and 'h:tester2' in kv())
    p3.context.close()

    # ---------------- After midnight, the page asks for a fresh count at most once a minute ----------------
    p4 = new_page(b)
    hits = {'n': 0}
    def fake_unlock(route):
        hits['n'] += 1
        h = {'Access-Control-Allow-Origin': 'http://localhost:8080'}
        if hits['n'] == 1:
            route.fulfill(status=200, content_type='application/json', headers=h, body=json.dumps({'ok': True, 'id': 'tester1', 'name': 'tester1', 'admin': False, 'serverHistory': True, 'perDay': 2, 'usedToday': 2, 'resetAt': '2020-01-01T00:00:00Z'}))
        else:
            route.fulfill(status=429, content_type='application/json', headers=h, body='{"error":"rate_limited"}')
    p4.route('**/unlock', fake_unlock)
    p4.evaluate("localStorage.setItem('bi_code', JSON.stringify('maple-river-123'))"); p4.reload()
    p4.wait_for_selector('#v-setup [data-acct]:not([hidden])')
    for _ in range(8): p4.click('#v-setup [data-go="setup"]'); p4.wait_for_timeout(250)
    ok(f'reset refresh is throttled ({hits["n"]} unlock calls in 2 seconds)', hits['n'] <= 2)
    p4.context.close()

    b.close()

ok('no JavaScript errors on any page', not page_errors)
if page_errors: print('page errors:', page_errors)
fails = [n for n, c in results if not c]
print(f'\n{len(results) - len(fails)} of {len(results)} passed' + (': FAILED ' + '; '.join(fails) if fails else ''))
sys.exit(1 if fails else 0)

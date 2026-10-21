// Tests for bazl-interview. Run: node --test worker/
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import worker, { extractJobText, _internals } from './interview.js';
import { createHash } from 'node:crypto';

const TEST_CODE = 'test-code-456';
const TEST_SALT = 'ffeeddccbbaa99887766554433221100';
const TEST_HASH = 'sha256:' + TEST_SALT + ':' + createHash('sha256').update(Buffer.concat([Buffer.from(TEST_SALT, 'hex'), Buffer.from(TEST_CODE)])).digest('hex');
const ENV = { ANTHROPIC_API_KEY: 'test-key-not-real', ACCESS_HASH: TEST_HASH, RETRY_BASEBACKOFFMS: '1', RETRY_MAXBACKOFFMS: '50', RETRY_CALLTIMEOUTMS: '200' };

const SETUP = { role: 'Director, R&D Digital Transformation', level: 'Director', company: 'Kraft Heinz', industry: 'CPG', panelist: 'hiring_manager', mode: 'coach' };
const JD = 'Own the R&D digital transformation agenda. '.repeat(20);
const RESUME = 'Brad Bowers. Sr. Director, Global Digital Product Management, Pampered Chef. '.repeat(10);
const BRIEF = {
  panelist_title: 'VP, R&D Transformation', candidate_first_name: 'Brad', candidate_summary: 'Digital product leader.',
  jd_summary: 'Digital R&D leader.', focus_areas: ['Motivation and fit', 'Transformation track record'], gaps: ['No food science background'],
  resume_hooks: [{ hook: 'Pampered Chef platform', why: 'adoption' }], question_plan: [{ topic: 'Opening', question: 'Why this role?', probe: 'Why now?' }]
};

const toolReply = (name, input, status = 200) => () => new Response(JSON.stringify({
  content: [{ type: 'tool_use', id: 't1', name, input }], stop_reason: 'tool_use'
}), { status, headers: { 'Content-Type': 'application/json' } });
const errReply = (status, text = '{"type":"error"}', h = {}) => () => new Response(text, { status, headers: h });

let plan, calls, pages, logs, ip = 0;
beforeEach(() => {
  plan = []; calls = []; pages = {}; logs = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (!u.startsWith('https://api.anthropic.com')) {
      if (pages[u]) return new Response(pages[u], { status: 200, headers: { 'Content-Type': 'text/html' } });
      return new Response('nope', { status: 404 });
    }
    calls.push(JSON.parse(init.body));
    const step = plan.shift();
    if (!step) throw new Error('unexpected extra API call');
    return step(init);
  };
  console.log = (...a) => logs.push(a.join(' '));
});

async function post(path, body, { code = TEST_CODE, origin = 'https://bazlgroup.com', env = ENV } = {}) {
  const h = { Origin: origin, 'Content-Type': 'application/json', 'CF-Connecting-IP': '10.1.0.' + (++ip) };
  if (code !== null) h['X-Access-Code'] = code;
  const res = await worker.fetch(new Request('https://bazl-interview.example' + path, { method: 'POST', headers: h, body: JSON.stringify(body) }), env);
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json, res };
}

test('unlock accepts the right code and rejects others', async () => {
  assert.equal((await post('/unlock', {})).status, 200);
  assert.equal((await post('/unlock', {}, { code: 'wrong' })).status, 401);
  assert.equal((await post('/unlock', {}, { code: null })).status, 401);
});

test('stays locked when ACCESS_HASH is missing', async () => {
  const r = await post('/turn', {}, { env: { ANTHROPIC_API_KEY: 'k' } });
  assert.equal(r.status, 401);
});

test('refuses other origins', async () => {
  const r = await post('/unlock', {}, { origin: 'https://evil.example' });
  assert.equal(r.status, 403);
});

test('dev origin is allowed only when configured', async () => {
  assert.equal((await post('/unlock', {}, { origin: 'http://localhost:8080' })).status, 403);
  assert.equal((await post('/unlock', {}, { origin: 'http://localhost:8080', env: { ...ENV, DEV_ORIGIN: 'http://localhost:8080' } })).status, 200);
});

test('prepare with pasted text returns a brief and an opening, forcing the brief tool', async () => {
  plan.push(toolReply('interview_brief', { ...BRIEF, opening: 'Hi Brad, thanks for making the time.' }));
  const r = await post('/prepare', { setup: SETUP, jdText: JD, resume: { text: RESUME } });
  assert.equal(r.status, 200);
  assert.equal(r.json.opening, 'Hi Brad, thanks for making the time.');
  assert.deepEqual(r.json.brief.gaps, ['No food science background']);
  assert.equal(calls[0].tool_choice.type, 'auto');
  assert.equal(calls[0].tools[0].name, 'interview_brief');
  assert.match(calls[0].system, /calling the interview_brief tool/);
  assert.equal(calls[0].model, 'claude-sonnet-5-5');
  assert.match(calls[0].messages[0].content.at(-1).text, /JOB DESCRIPTION/);
});

test('prepare sends a PDF resume as a document block', async () => {
  plan.push(toolReply('interview_brief', { ...BRIEF, opening: 'Hello.' }));
  const pdf = Buffer.from('%PDF-1.4 fake').toString('base64');
  const r = await post('/prepare', { setup: SETUP, jdText: JD, resume: { pdfBase64: pdf } });
  assert.equal(r.status, 200);
  const doc = calls[0].messages[0].content[0];
  assert.equal(doc.type, 'document');
  assert.equal(doc.source.media_type, 'application/pdf');
});

test('prepare reads a job link through structured job data', async () => {
  pages['https://jobs.example.com/123'] = `<html><head><title>Job</title><script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', title: 'Director, R&D', hiringOrganization: { name: 'Acme' }, description: '<p>' + JD + '</p>' })}</script></head><body>Apply</body></html>`;
  plan.push(toolReply('interview_brief', { ...BRIEF, opening: 'Hello.' }));
  const r = await post('/prepare', { setup: SETUP, jdUrl: 'jobs.example.com/123', resume: { text: RESUME } });
  assert.equal(r.status, 200);
  assert.match(calls[0].messages[0].content.at(-1).text, /Director, R&D\nAcme\nOwn the R&D/);
});

test('prepare explains an unreadable job link instead of calling the API', async () => {
  const r = await post('/prepare', { setup: SETUP, jdUrl: 'https://jobs.example.com/missing', resume: { text: RESUME } });
  assert.equal(r.status, 422);
  assert.equal(r.json.error, 'link_unreadable');
  assert.equal(calls.length, 0);
});

test('prepare requires role, level, a job and a resume', async () => {
  assert.equal((await post('/prepare', { setup: { role: 'PM' }, jdText: JD, resume: { text: RESUME } })).json.error, 'missing_setup');
  assert.equal((await post('/prepare', { setup: SETUP, jdText: 'short', resume: { text: RESUME } })).json.error, 'missing_job');
  assert.equal((await post('/prepare', { setup: SETUP, jdText: JD, resume: {} })).json.error, 'missing_resume');
});

test('turn returns what the interviewer says and caches the persona prompt', async () => {
  plan.push(toolReply('interviewer_turn', { say: 'Tell me more about the adoption numbers.', move: 'probe', topic: 'Transformation', done: false }));
  const r = await post('/turn', {
    setup: SETUP, brief: BRIEF, event: 'answer', elapsedSec: 612,
    history: [{ who: 'interviewer', text: 'Tell me about a transformation.' }, { who: 'candidate', text: 'we moved consultants off facebook' }]
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.say, 'Tell me more about the adoption numbers.');
  assert.equal(r.json.done, false);
  assert.equal(calls[0].system[0].cache_control.type, 'ephemeral');
  assert.match(calls[0].system[0].text, /Elena Marsh/);
  assert.match(calls[0].messages[0].content, /Elapsed: 10:12 of 30:00/);
  assert.match(calls[0].messages[0].content, /CANDIDATE: we moved consultants off facebook/);
});

test('a wrap event always ends the interview', async () => {
  plan.push(toolReply('interviewer_turn', { say: 'Thanks so much, Brad.', move: 'close', topic: 'Close', done: false }));
  const r = await post('/turn', { setup: SETUP, brief: BRIEF, event: 'wrap', elapsedSec: 1790, history: [] });
  assert.equal(r.json.done, true);
});

test('a raised-hand question is labeled for the interviewer', async () => {
  plan.push(toolReply('interviewer_turn', { say: 'Good question.', move: 'answer_candidate', topic: 'Team', done: false }));
  await post('/turn', { setup: SETUP, brief: BRIEF, event: 'hand', elapsedSec: 400, history: [{ who: 'candidate', kind: 'question', text: 'how big is the team' }] });
  assert.match(calls[0].messages[0].content, /CANDIDATE \(asking you a question\): how big is the team/);
  assert.match(calls[0].messages[0].content, /raised their hand/);
});

test('coach returns cleaned text and feedback for an answer', async () => {
  plan.push(toolReply('coach_feedback', {
    cleaned: 'We moved consultants off Facebook.', signal: 'Neutral', landed: 'A concrete situation.', fix: 'No number.',
    try_this: 'Lead with adoption.', level_check: '', question_rating: 'n/a', sharper: '', read_so_far: 'Maybe'
  }));
  const r = await post('/coach', { setup: SETUP, brief: BRIEF, kind: 'answer', prompt: 'Tell me about a transformation.', raw: 'we moved consultants off facebook', history: [] });
  assert.equal(r.status, 200);
  assert.equal(r.json.cleaned, 'We moved consultants off Facebook.');
  assert.equal(r.json.signal, 'Neutral');
  assert.equal(r.json.tryThis, 'Lead with adoption.');
  assert.equal(r.json.readSoFar, 'Maybe');
  assert.match(calls[0].system, /Never penalize transcription errors/);
});

test('coach judges a candidate question', async () => {
  plan.push(toolReply('coach_feedback', {
    cleaned: 'What does success look like?', signal: 'Neutral', landed: 'Outcome focused.', fix: 'Add a constraint.',
    try_this: '', level_check: '', question_rating: 'Strong', sharper: 'And where has adoption stalled?', read_so_far: 'Yes'
  }));
  const r = await post('/coach', { setup: SETUP, brief: BRIEF, kind: 'question', raw: 'what does success look like', history: [] });
  assert.equal(r.json.kind, 'question');
  assert.equal(r.json.questionRating, 'Strong');
  assert.match(calls[0].messages[0].content, /The candidate asked the interviewer this question/);
});

test('debrief needs at least one answer, then returns the verdict', async () => {
  assert.equal((await post('/debrief', { setup: SETUP, brief: BRIEF, history: [{ who: 'interviewer', text: 'Hi' }] })).json.error, 'no_answers');
  plan.push(toolReply('interview_debrief', {
    verdict: 'Maybe', rationale: 'Real experience, but never said why this role.', signals: [{ area: 'Motivation and fit', status: 'Missing' }],
    strongest: ['A concrete before and after.'], concerns: ['No numbers.'], practice: [{ title: 'Answer why this role first', detail: 'In the first 30 seconds.' }],
    per_answer: [{ signal: 'Weakened', note: 'Skipped the question.' }], pattern: 'No numbers in any answer.'
  }));
  const r = await post('/debrief', { setup: SETUP, brief: BRIEF, elapsedSec: 900, history: [{ who: 'interviewer', text: 'Why this role?' }, { who: 'candidate', text: 'transformation' }] });
  assert.equal(r.status, 200);
  assert.equal(r.json.verdict, 'Maybe');
  assert.equal(r.json.practice[0].title, 'Answer why this role first');
  assert.equal(r.json.perAnswer[0].signal, 'Weakened');
});

test('retries an overloaded model, then falls back to the next model', async () => {
  plan.push(errReply(529), errReply(529));
  plan.push(toolReply('interviewer_turn', { say: 'Okay.', move: 'question', topic: 'x', done: false }));
  const r = await post('/turn', { setup: SETUP, brief: BRIEF, event: 'next', elapsedSec: 100, history: [] });
  assert.equal(r.status, 200);
  assert.deepEqual(calls.map(c => c.model), ['claude-sonnet-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']);
});

test('a reply without the tool counts as a failure and retries', async () => {
  plan.push(() => new Response(JSON.stringify({ content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn' }), { status: 200 }));
  plan.push(toolReply('interviewer_turn', { say: 'Okay.', move: 'question', topic: 'x', done: false }));
  const r = await post('/turn', { setup: SETUP, brief: BRIEF, event: 'next', elapsedSec: 100, history: [] });
  assert.equal(r.status, 200);
  assert.equal(calls.length, 2);
});

test('the spend limit stops calls with a clear error', async () => {
  plan.push(errReply(400, '{"error":{"message":"You have reached your specified API usage limits."}}'));
  const r = await post('/turn', { setup: SETUP, brief: BRIEF, event: 'next', elapsedSec: 100, history: [] });
  assert.equal(r.status, 503);
  assert.equal(r.json.error, 'spend_limit');
  assert.equal(calls.length, 1);
});

test('a non-retryable error fails fast', async () => {
  plan.push(errReply(401));
  const r = await post('/turn', { setup: SETUP, brief: BRIEF, event: 'next', elapsedSec: 100, history: [] });
  assert.equal(r.status, 502);
  assert.equal(calls.length, 1);
});

test('oversized bodies are refused before any API call', async () => {
  const r = await post('/prepare', { setup: SETUP, jdText: JD, resume: { pdfBase64: 'A'.repeat(8_100_000) } });
  assert.equal(r.status, 413);
  assert.equal(calls.length, 0);
});

test('unknown routes and bad JSON are rejected', async () => {
  assert.equal((await post('/nope', {})).status, 404);
  const res = await worker.fetch(new Request('https://x/turn', { method: 'POST', headers: { Origin: 'https://bazlgroup.com', 'X-Access-Code': TEST_CODE, 'CF-Connecting-IP': '10.9.9.9' }, body: '{bad' }), ENV);
  assert.equal(res.status, 400);
});

test('job text extraction reads a meta description posting', () => {
  const html = `<html><head><title>Kraft Heinz Careers</title><meta name="description" content="Own the R&amp;D digital transformation agenda. ${'Translate ambition into a roadmap. '.repeat(10)}"></head><body><div id="app"></div></body></html>`;
  const text = extractJobText(html);
  assert.match(text, /Own the R&D digital transformation agenda/);
});

test('job links to local or numeric hosts are refused', () => {
  assert.equal(_internals.safeUrl('http://localhost/x'), null);
  assert.equal(_internals.safeUrl('http://169.254.169.254/latest'), null);
  assert.equal(_internals.safeUrl('ftp://example.com/x'), null);
  assert.ok(_internals.safeUrl('jobs.kraftheinz.com/careers?pid=1'));
});

test('logs never contain prompts, answers or keys', async () => {
  plan.push(errReply(529), errReply(529), errReply(529), errReply(529));
  await post('/turn', { setup: SETUP, brief: BRIEF, event: 'answer', elapsedSec: 100, history: [{ who: 'candidate', text: 'my secret answer text' }] });
  const all = logs.join('\n');
  assert.doesNotMatch(all, /secret answer|test-key-not-real|Elena/);
});

test('the interviewer prompt carries the brief and the rules that matter', () => {
  const p = _internals.interviewerSystem(SETUP, BRIEF);
  assert.match(p, /Never give feedback, scores, hints or coaching/);
  assert.match(p, /No food science background/);
  assert.match(p, /Core questions run until about 24 minutes/);
  assert.match(p, /Pampered Chef platform/);
});

test('an API error comes back with its reason, so failures can be diagnosed', async () => {
  plan.push(errReply(400, '{"type":"error","error":{"type":"invalid_request_error","message":"model: not found"}}'));
  const r = await post('/turn', { setup: SETUP, brief: BRIEF, event: 'next', elapsedSec: 100, history: [] });
  assert.equal(r.status, 502);
  assert.match(r.json.detail, /http_400: invalid_request_error model: not found/);
});

test('timeouts are reported as such', async () => {
  plan.push(() => new Promise(() => {}), () => new Promise(() => {}), () => new Promise(() => {}), () => new Promise(() => {}));
  const r = await post('/turn', { setup: SETUP, brief: BRIEF, event: 'next', elapsedSec: 100, history: [] });
  assert.equal(r.json.error, 'upstream_error');
  assert.match(r.json.detail, /timeout/);
});

test('JSON written as text instead of a tool call is still accepted', async () => {
  plan.push(() => new Response(JSON.stringify({ content: [{ type: 'text', text: 'Here: {"say":"Okay, next one.","move":"question","topic":"x","done":false}' }], stop_reason: 'end_turn' }), { status: 200 }));
  const r = await post('/turn', { setup: SETUP, brief: BRIEF, event: 'next', elapsedSec: 100, history: [] });
  assert.equal(r.status, 200);
  assert.equal(r.json.say, 'Okay, next one.');
});

// ---------------------------------------------------------------------------
// Personal codes, server history, daily limit, admin view

const fingerprint = (code, salt) => 'sha256:' + salt + ':' + createHash('sha256').update(Buffer.concat([Buffer.from(salt, 'hex'), Buffer.from(code)])).digest('hex');
const T1 = 'maple-river-123', T2 = 'cobalt-stone-456';
const ACCESS_CODES = JSON.stringify({
  tester1: fingerprint(T1, '00112233445566778899aabbccddeeff'),
  tester2: { hash: fingerprint(T2, '0f1e2d3c4b5a69788796a5b4c3d2e1f0'), name: 'Sam' },
  brad: fingerprint('sneaky', '00112233445566778899aabbccddeeff') // ignored: "brad" is ACCESS_HASH only
});

// A Map-backed stand-in for a Cloudflare KV namespace.
function mockKV() {
  const m = new Map();
  return {
    m,
    async get(k, type) { const e = m.get(k); if (!e) return null; return type === 'json' ? JSON.parse(e.value) : e.value; },
    async getWithMetadata(k) { const e = m.get(k); return e ? { value: e.value, metadata: e.metadata ?? null } : { value: null, metadata: null }; },
    async put(k, value, opts = {}) { m.set(k, { value: String(value), metadata: opts.metadata, ttl: opts.expirationTtl }); },
    async delete(k) { m.delete(k); },
    async list({ prefix = '' } = {}) { return { keys: [...m.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name, metadata: m.get(name).metadata })), list_complete: true }; }
  };
}
const kvEnv = (extra = {}) => ({ ...ENV, ACCESS_CODES, HISTORY: mockKV(), ...extra });
const SUMMARY = { id: 1761000000000, at: '2026-10-20T15:00:00.000Z', role: 'Director of Product', company: 'Acme', level: 'Director', persona: 'Elena Marsh', personaType: 'Hiring manager', mode: 'coach', elapsed: 1500, verdict: 'Yes', pattern: 'Lead with numbers.' };

test('unlock says who a code belongs to; ACCESS_HASH is Brad and the only admin', async () => {
  const env = kvEnv();
  const brad = await post('/unlock', {}, { env });
  assert.deepEqual([brad.json.id, brad.json.admin, brad.json.serverHistory], ['brad', true, true]);
  const t1 = await post('/unlock', {}, { env, code: T1 });
  assert.deepEqual([t1.json.id, t1.json.name, t1.json.admin, t1.json.perDay, t1.json.usedToday], ['tester1', 'tester1', false, 3, 0]);
  const t2 = await post('/unlock', {}, { env, code: T2 });
  assert.deepEqual([t2.json.id, t2.json.name], ['tester2', 'Sam']);
  assert.equal((await post('/unlock', {}, { env, code: 'sneaky' })).status, 401);
  assert.equal((await post('/unlock', {}, { env, code: 'maple-river-124' })).status, 401);
});

test('personal codes work without ACCESS_HASH, and a broken ACCESS_CODES only locks testers out', async () => {
  assert.equal((await post('/unlock', {}, { env: { ACCESS_CODES }, code: T1 })).json.id, 'tester1');
  assert.equal((await post('/unlock', {}, { env: { ...ENV, ACCESS_CODES: '{not json' }, code: T1 })).status, 401);
  assert.equal((await post('/unlock', {}, { env: { ...ENV, ACCESS_CODES: '{not json' } })).status, 200);
});

test('history routes explain when no HISTORY namespace is bound', async () => {
  const r = await post('/history/list', {}, { env: { ...ENV, ACCESS_CODES }, code: T1 });
  assert.equal(r.status, 501);
  assert.equal(r.json.error, 'no_server_history');
  assert.equal((await post('/unlock', {}, { env: { ...ENV, ACCESS_CODES }, code: T1 })).json.serverHistory, false);
});

test('history save, list and delete are per person, and keep only summary fields', async () => {
  const env = kvEnv();
  const saved = await post('/history/save', { summary: { ...SUMMARY, transcript: 'secret words', resume: 'my resume', jdText: 'the job' } }, { env, code: T1 });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.sessions.length, 1);
  const stored = env.HISTORY.m.get('h:tester1').value;
  assert.doesNotMatch(stored, /secret words|my resume|the job/);
  assert.deepEqual(Object.keys(JSON.parse(stored)[0]).sort(), ['at', 'company', 'elapsed', 'id', 'level', 'mode', 'pattern', 'persona', 'personaType', 'role', 'verdict']);
  // Saving the same session twice does not duplicate it.
  await post('/history/save', { summary: SUMMARY }, { env, code: T1 });
  const mine = await post('/history/list', {}, { env, code: T1 });
  assert.equal(mine.json.sessions.length, 1);
  assert.equal(mine.json.sessions[0].verdict, 'Yes');
  // Another person sees nothing of it.
  assert.deepEqual((await post('/history/list', {}, { env, code: T2 })).json.sessions, []);
  assert.equal((await post('/history/delete', {}, { env, code: T1 })).status, 200);
  assert.deepEqual((await post('/history/list', {}, { env, code: T1 })).json.sessions, []);
});

test('history save takes a batch moved from the browser, newest first, and rejects junk', async () => {
  const env = kvEnv();
  const older = { ...SUMMARY, id: 1, at: '2026-09-01T10:00:00.000Z', verdict: 'No' };
  const r = await post('/history/save', { sessions: [older, SUMMARY, { role: 'x' }] }, { env, code: T1 });
  assert.deepEqual(r.json.sessions.map(s => s.verdict), ['Yes', 'No']);
  assert.equal((await post('/history/save', { summary: { role: 'PM', verdict: 'Great' } }, { env, code: T1 })).status, 400);
  assert.equal((await post('/history/list', {}, { env, code: 'wrong' })).status, 401);
});

test('history routes do not need the Anthropic key', async () => {
  const env = kvEnv({ ANTHROPIC_API_KEY: '' });
  assert.equal((await post('/history/list', {}, { env, code: T1 })).status, 200);
  assert.equal((await post('/turn', { setup: SETUP, brief: BRIEF }, { env, code: T1 })).status, 503);
});

test('each person can start SESSIONS_PER_DAY interviews a day; Brad is exempt', async () => {
  const env = kvEnv({ SESSIONS_PER_DAY: '2' });
  const go = code => post('/prepare', { setup: SETUP, jdText: JD, resume: { text: RESUME } }, { env, code });
  for (let i = 0; i < 2; i++) { plan.push(toolReply('interview_brief', { ...BRIEF, opening: 'Hi.' })); assert.equal((await go(T1)).status, 200); }
  const blocked = await go(T1);
  assert.equal(blocked.status, 429);
  assert.equal(blocked.json.error, 'daily_limit');
  assert.equal(blocked.json.limit, 2);
  assert.ok(Date.parse(blocked.json.resetAt) > Date.now());
  assert.equal(calls.length, 2, 'the blocked call never reaches the API');
  plan.push(toolReply('interview_brief', { ...BRIEF, opening: 'Hi.' }));
  assert.equal((await go(T2)).status, 200, 'other people have their own count');
  for (let i = 0; i < 3; i++) { plan.push(toolReply('interview_brief', { ...BRIEF, opening: 'Hi.' })); assert.equal((await go(TEST_CODE)).status, 200); }
  assert.equal((await post('/unlock', {}, { env, code: T1 })).json.usedToday, 2);
});

test('a failed prepare does not use up a session', async () => {
  const env = kvEnv({ SESSIONS_PER_DAY: '1' });
  plan.push(errReply(401));
  assert.equal((await post('/prepare', { setup: SETUP, jdText: JD, resume: { text: RESUME } }, { env, code: T1 })).status, 502);
  plan.push(toolReply('interview_brief', { ...BRIEF, opening: 'Hi.' }));
  assert.equal((await post('/prepare', { setup: SETUP, jdText: JD, resume: { text: RESUME } }, { env, code: T1 })).status, 200);
});

test('the daily limit defaults to 3 and is skipped without HISTORY', async () => {
  const env = kvEnv();
  for (let i = 0; i < 3; i++) { plan.push(toolReply('interview_brief', { ...BRIEF, opening: 'Hi.' })); await post('/prepare', { setup: SETUP, jdText: JD, resume: { text: RESUME } }, { env, code: T1 }); }
  assert.equal((await post('/prepare', { setup: SETUP, jdText: JD, resume: { text: RESUME } }, { env, code: T1 })).json.error, 'daily_limit');
  const noKv = { ...ENV, ACCESS_CODES };
  for (let i = 0; i < 4; i++) { plan.push(toolReply('interview_brief', { ...BRIEF, opening: 'Hi.' })); assert.equal((await post('/prepare', { setup: SETUP, jdText: JD, resume: { text: RESUME } }, { env: noKv, code: T1 })).status, 200); }
});

test('admin usage is Brad only and shows counts, never content', async () => {
  const env = kvEnv();
  plan.push(toolReply('interview_brief', { ...BRIEF, opening: 'Hi.' }));
  await post('/prepare', { setup: SETUP, jdText: JD, resume: { text: RESUME } }, { env, code: T1 });
  await post('/history/save', { summary: SUMMARY }, { env, code: T1 });
  assert.equal((await post('/admin/usage', {}, { env, code: T1 })).status, 403);
  const r = await post('/admin/usage', {}, { env });
  assert.equal(r.status, 200);
  const t1 = r.json.people.find(p => p.id === 'tester1');
  assert.deepEqual([t1.started, t1.finished, t1.last], [1, 1, _internals.centralDay()]);
  const t2 = r.json.people.find(p => p.id === 'tester2');
  assert.deepEqual([t2.name, t2.started, t2.last], ['Sam', 0, '']);
  assert.ok(r.json.people.find(p => p.id === 'brad'));
  assert.doesNotMatch(JSON.stringify(r.json), /Director of Product|Lead with numbers|Acme/);
});

test('deleting history keeps the usage counts but removes every summary', async () => {
  const env = kvEnv();
  await post('/history/save', { summary: SUMMARY }, { env, code: T1 });
  await post('/history/delete', {}, { env, code: T1 });
  assert.equal(env.HISTORY.m.has('h:tester1'), false);
  assert.equal((await post('/admin/usage', {}, { env })).json.people.find(p => p.id === 'tester1').finished, 1);
});

test('the day and the reset follow US Central time, including daylight saving changes', () => {
  const { centralDay, nextCentralMidnight } = _internals;
  assert.equal(centralDay(new Date('2026-10-22T03:00:00Z')), '2026-10-21'); // 10 PM CDT
  assert.equal(centralDay(new Date('2026-10-22T05:30:00Z')), '2026-10-22'); // 12:30 AM CDT
  assert.equal(nextCentralMidnight(new Date('2026-10-21T15:00:00Z')), '2026-10-22T05:00:00.000Z'); // CDT
  assert.equal(nextCentralMidnight(new Date('2026-12-10T20:00:00Z')), '2026-12-11T06:00:00.000Z'); // CST
  assert.equal(nextCentralMidnight(new Date('2026-10-31T20:00:00Z')), '2026-11-01T05:00:00.000Z'); // before fall back
  assert.equal(nextCentralMidnight(new Date('2026-11-01T12:00:00Z')), '2026-11-02T06:00:00.000Z'); // fall-back day, 25 hours
  assert.equal(nextCentralMidnight(new Date('2026-03-07T20:00:00Z')), '2026-03-08T06:00:00.000Z'); // before spring forward
  assert.equal(nextCentralMidnight(new Date('2026-03-08T12:00:00Z')), '2026-03-09T05:00:00.000Z'); // spring-forward day, 23 hours
  assert.equal(nextCentralMidnight(new Date('2026-10-22T04:59:59Z')), '2026-10-22T05:00:00.000Z'); // one second before
});

test('unlock tells the page when the daily count resets', async () => {
  const r = await post('/unlock', {}, { env: kvEnv(), code: T1 });
  const at = Date.parse(r.json.resetAt);
  assert.ok(at > Date.now() && at <= Date.now() + 25 * 3600000);
  assert.equal(_internals.centralDay(new Date(at - 1000)), _internals.centralDay());
});

// ---------------------------------------------------------------------------
// Coverage added after review: limit edge cases, history limits, failures, the code generator

const PREP = { setup: SETUP, jdText: JD, resume: { text: RESUME } };

test('a second prepare while the first is still waiting on the model is held to the limit', async () => {
  const env = kvEnv({ SESSIONS_PER_DAY: '1' });
  let finish;
  plan.push(() => new Promise(r => { finish = () => r(toolReply('interview_brief', { ...BRIEF, opening: 'Hi.' })()); }));
  const first = post('/prepare', PREP, { env, code: T1 });
  await new Promise(r => setTimeout(r, 20)); // first one is now waiting on the model
  const second = await post('/prepare', PREP, { env, code: T1 });
  assert.equal(second.status, 429);
  assert.equal(second.json.error, 'daily_limit');
  finish();
  assert.equal((await first).status, 200);
  assert.equal(calls.length, 1);
});

test('a prepare that fails before the model (bad job link, missing resume) gives its slot back', async () => {
  const env = kvEnv({ SESSIONS_PER_DAY: '1' });
  assert.equal((await post('/prepare', { setup: SETUP, jdUrl: 'https://jobs.example.com/missing', resume: { text: RESUME } }, { env, code: T1 })).json.error, 'link_unreadable');
  assert.equal((await post('/prepare', { setup: SETUP, jdText: JD, resume: {} }, { env, code: T1 })).json.error, 'missing_resume');
  assert.equal((await post('/unlock', {}, { env, code: T1 })).json.usedToday, 0);
  plan.push(toolReply('interview_brief', { ...BRIEF, opening: 'Hi.' }));
  assert.equal((await post('/prepare', PREP, { env, code: T1 })).status, 200);
});

test('at the limit, a job link is never fetched', async () => {
  const env = kvEnv({ SESSIONS_PER_DAY: '1' });
  plan.push(toolReply('interview_brief', { ...BRIEF, opening: 'Hi.' }));
  await post('/prepare', PREP, { env, code: T1 });
  let fetched = false;
  pages['https://jobs.example.com/watch'] = 'x'; const orig = globalThis.fetch;
  globalThis.fetch = async (u, i) => { if (String(u).includes('jobs.example.com/watch')) fetched = true; return orig(u, i); };
  const r = await post('/prepare', { setup: SETUP, jdUrl: 'https://jobs.example.com/watch', resume: { text: RESUME } }, { env, code: T1 });
  assert.equal(r.json.error, 'daily_limit');
  assert.equal(fetched, false);
});

test('the day counter expires on its own after two days', async () => {
  const env = kvEnv();
  plan.push(toolReply('interview_brief', { ...BRIEF, opening: 'Hi.' }));
  await post('/prepare', PREP, { env, code: T1 });
  const e = env.HISTORY.m.get(`n:tester1:${_internals.centralDay()}`);
  assert.equal(e.value, '1');
  assert.equal(e.ttl, 172800);
});

test('if KV fails, interviews still go ahead (the limit fails open) and nothing crashes', async () => {
  const env = kvEnv();
  env.HISTORY.get = async () => { throw new Error('kv down'); };
  env.HISTORY.getWithMetadata = async () => { throw new Error('kv down'); };
  plan.push(toolReply('interview_brief', { ...BRIEF, opening: 'Hi.' }));
  assert.equal((await post('/prepare', PREP, { env, code: T1 })).status, 200);
  const env2 = kvEnv();
  env2.HISTORY.put = async () => { throw new Error('kv down'); };
  plan.push(toolReply('interview_brief', { ...BRIEF, opening: 'Hi.' }));
  assert.equal((await post('/prepare', PREP, { env: env2, code: T1 })).status, 200);
});

test('Brad gets no daily limit fields; testers do', async () => {
  const env = kvEnv();
  const b = (await post('/unlock', {}, { env })).json;
  assert.equal(b.perDay, undefined); assert.equal(b.usedToday, undefined); assert.equal(b.resetAt, undefined);
  assert.equal(typeof (await post('/unlock', {}, { env, code: T1 })).json.resetAt, 'string');
});

test('history keeps the newest 100 sessions and takes at most 50 per batch', async () => {
  const env = kvEnv();
  const mk = i => ({ ...SUMMARY, id: 1000 + i, at: new Date(Date.UTC(2026, 0, 1) + i * 60000).toISOString() });
  const r1 = await post('/history/save', { sessions: Array.from({ length: 60 }, (_, i) => mk(i)) }, { env, code: T1 });
  assert.equal(r1.json.sessions.length, 50);
  await post('/history/save', { sessions: Array.from({ length: 50 }, (_, i) => mk(60 + i)) }, { env, code: T1 });
  await post('/history/save', { sessions: Array.from({ length: 20 }, (_, i) => mk(110 + i)) }, { env, code: T1 });
  const all = (await post('/history/list', {}, { env, code: T1 })).json.sessions;
  assert.equal(all.length, 100);
  assert.equal(all[0].id, 1129);
  assert.ok(all.every((s, i) => i === 0 || all[i - 1].at >= s.at), 'newest first');
});

test('summaries without a usable id get unique ids, and duplicates in one batch count once', async () => {
  const { cleanSummary } = _internals;
  const a = cleanSummary({ ...SUMMARY, id: null }), b = cleanSummary({ ...SUMMARY, id: '' }), c = cleanSummary({ ...SUMMARY, id: -5 });
  assert.ok(a.id > 0 && b.id > 0 && c.id > 0);
  assert.equal(new Set([a.id, b.id, c.id]).size, 3);
  const env = kvEnv();
  const r = await post('/history/save', { sessions: [SUMMARY, { ...SUMMARY }, { ...SUMMARY, id: null }, { ...SUMMARY, id: null }] }, { env, code: T1 });
  assert.equal(r.json.sessions.length, 3);
  assert.equal((await post('/admin/usage', {}, { env })).json.people.find(p => p.id === 'tester1').finished, 3);
});

test('history routes refuse bodies over 200 KB before reading them', async () => {
  const r = await post('/history/save', { summary: SUMMARY, pad: 'x'.repeat(300_000) }, { env: kvEnv(), code: T1 });
  assert.equal(r.status, 413);
});

test('admin usage needs HISTORY, and flags people whose code was removed', async () => {
  assert.equal((await post('/admin/usage', {}, { env: { ...ENV, ACCESS_CODES } })).status, 501);
  const env = kvEnv();
  await env.HISTORY.put('u:gone', '', { metadata: { started: 4, finished: 2, last: '2026-09-01' } });
  const gone = (await post('/admin/usage', {}, { env })).json.people.find(p => p.id === 'gone');
  assert.deepEqual([gone.active, gone.started, gone.name], [false, 4, 'gone']);
});

test('ACCESS_CODES cannot add another "brad" in any case, or ids with odd characters', async () => {
  const codes = JSON.stringify({ Brad: fingerprint('x-y-1', 'aa'.repeat(16)), BRAD: fingerprint('x-y-2', 'aa'.repeat(16)), 'a b': fingerprint('x-y-3', 'aa'.repeat(16)) });
  for (const c of ['x-y-1', 'x-y-2', 'x-y-3']) assert.equal(await _internals.whoIs(c, { ACCESS_CODES: codes }), null);
});

test('make-code.mjs prints a code whose fingerprint unlocks, and refuses bad ids', async () => {
  const { execFileSync } = await import('node:child_process');
  const script = new URL('../scripts/make-code.mjs', import.meta.url).pathname;
  const out = execFileSync(process.execPath, [script, 'tester9', 'Jo Smith'], { encoding: 'utf8' });
  const code = out.match(/Code:\s+(\S+)/)[1];
  assert.match(code, /^[a-z]+-[a-z]+-\d{3}$/);
  const entry = JSON.parse('{' + out.match(/^\s+("tester9": .*)$/m)[1] + '}');
  assert.deepEqual(await _internals.whoIs(code, { ACCESS_CODES: JSON.stringify(entry) }), { id: 'tester9', name: 'Jo Smith', admin: false });
  const two = new Set(Array.from({ length: 3 }, () => execFileSync(process.execPath, [script, 'x'], { encoding: 'utf8' }).match(/Code:\s+(\S+)/)[1]));
  assert.equal(two.size, 3, 'codes are random');
  for (const bad of ['brad', 'Brad', 'has space', '']) {
    assert.throws(() => execFileSync(process.execPath, [script, bad], { stdio: 'pipe' }));
  }
});

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

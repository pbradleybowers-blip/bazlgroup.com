// Tests for bazl-ask's retry, timeout and fallback behavior. Run: node --test worker/
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from './worker.js';

const KEY = 'test-key-not-real';
const ENV = {
  ANTHROPIC_API_KEY: KEY,
  RETRY_BASEBACKOFFMS: '1', RETRY_MAXBACKOFFMS: '50',
  RETRY_CONNECTTIMEOUTMS: '60', RETRY_FIRSTTOKENTIMEOUTMS: '60', RETRY_IDLETIMEOUTMS: '60'
};

const enc = new TextEncoder();
const streamOf = (chunks, { hangAfter = false } = {}) => new ReadableStream({
  async start(c) {
    for (const ch of chunks) c.enqueue(enc.encode(ch));
    if (!hangAfter) c.close();
  }
});
const sseText = t => `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } })}\n\n`;
const sseError = type => `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type } })}\n\n`;

const B = {
  ok: (...words) => () => new Response(streamOf(words.map(sseText)), { status: 200 }),
  status: (s, h = {}) => () => new Response(JSON.stringify({ type: 'error' }), { status: s, headers: h }),
  hang: () => (init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))),
  streamErrorFirst: () => () => new Response(streamOf([sseError('overloaded_error')]), { status: 200 }),
  silent: () => () => new Response(streamOf([': ping\n\n'], { hangAfter: true }), { status: 200 }),
  partialThenError: () => () => new Response(streamOf([sseText('Brad led '), sseError('overloaded_error')]), { status: 200 })
};

let plan, calls, logs, ipCounter = 0;
beforeEach(() => {
  plan = []; calls = []; logs = [];
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).endsWith('knowledge.md')) return new Response('Brad is a product leader.');
    calls.push(JSON.parse(init.body).model);
    const step = plan.shift();
    if (!step) throw new Error('unexpected extra API call');
    return step(init);
  };
  console.log = (...a) => logs.push(a.join(' '));
});

async function ask() {
  const req = new Request('https://bazl-ask.example/', {
    method: 'POST',
    headers: { Origin: 'https://bazlgroup.com', 'Content-Type': 'application/json', 'CF-Connecting-IP': '10.0.0.' + (++ipCounter) },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'Has Brad led global teams?' }] })
  });
  const res = await worker.fetch(req, ENV);
  return { status: res.status, text: await res.text() };
}

const HAIKU = 'claude-haiku-5-5', SONNET = 'claude-sonnet-5-5';

test('answers on the first try with Haiku', async () => {
  plan = [B.ok('Yes, ', 'he did.')];
  const r = await ask();
  assert.equal(r.status, 200);
  assert.equal(r.text, 'Yes, he did.');
  assert.deepEqual(calls, [HAIKU]);
});

test('retries Haiku once after a 529 overload', async () => {
  plan = [B.status(529), B.ok('Yes.')];
  const r = await ask();
  assert.equal(r.text, 'Yes.');
  assert.deepEqual(calls, [HAIKU, HAIKU]);
});

test('falls back to Sonnet after Haiku is rate limited twice', async () => {
  plan = [B.status(429), B.status(429), B.ok('From Sonnet.')];
  const r = await ask();
  assert.equal(r.status, 200);
  assert.equal(r.text, 'From Sonnet.');
  assert.deepEqual(calls, [HAIKU, HAIKU, SONNET]);
  assert.ok(logs.some(l => l.includes('"fallback"') && l.includes(HAIKU)));
});

test('skips straight to Sonnet when retry-after is too long to wait', async () => {
  plan = [B.status(429, { 'retry-after': '30' }), B.ok('Quick answer.')];
  const r = await ask();
  assert.equal(r.text, 'Quick answer.');
  assert.deepEqual(calls, [HAIKU, SONNET]);
});

test('honors a short retry-after before retrying', async () => {
  plan = [B.status(503, { 'retry-after': '0' }), B.ok('Ok.')];
  const r = await ask();
  assert.equal(r.text, 'Ok.');
  assert.deepEqual(calls, [HAIKU, HAIKU]);
});

test('does not retry a 400 bad request', async () => {
  plan = [B.status(400)];
  const r = await ask();
  assert.equal(r.status, 502);
  assert.deepEqual(calls, [HAIKU]);
});

test('does not retry a 401 bad key', async () => {
  plan = [B.status(401)];
  const r = await ask();
  assert.equal(r.status, 502);
  assert.deepEqual(calls, [HAIKU]);
});

test('retries after a connect timeout', async () => {
  plan = [B.hang(), B.ok('After timeout.')];
  const r = await ask();
  assert.equal(r.text, 'After timeout.');
  assert.deepEqual(calls, [HAIKU, HAIKU]);
});

test('retries when the stream errors before any words', async () => {
  plan = [B.streamErrorFirst(), B.ok('Recovered.')];
  const r = await ask();
  assert.equal(r.text, 'Recovered.');
  assert.deepEqual(calls, [HAIKU, HAIKU]);
});

test('retries when no words arrive in time', async () => {
  plan = [B.silent(), B.ok('Second try.')];
  const r = await ask();
  assert.equal(r.text, 'Second try.');
  assert.deepEqual(calls, [HAIKU, HAIKU]);
});

test('does not fall back once words have been sent', async () => {
  plan = [B.partialThenError()];
  const r = await ask();
  assert.equal(r.status, 200);
  assert.equal(r.text, 'Brad led ');
  assert.deepEqual(calls, [HAIKU]);
});

test('stops after both models fail: two tries each, then a clean error', async () => {
  plan = [B.status(503), B.status(500), B.status(502), B.status(504)];
  const r = await ask();
  assert.equal(r.status, 502);
  assert.deepEqual(JSON.parse(r.text), { error: 'upstream_error' });
  assert.deepEqual(calls, [HAIKU, HAIKU, SONNET, SONNET]);
});

test('reports rate_limited when every model is rate limited', async () => {
  plan = [B.status(429), B.status(429), B.status(429), B.status(429)];
  const r = await ask();
  assert.equal(r.status, 429);
  assert.deepEqual(JSON.parse(r.text), { error: 'rate_limited' });
});

test('never logs the API key or the visitor question', async () => {
  plan = [B.status(429), B.status(429), B.ok('Fine.')];
  await ask();
  const all = logs.join('\n');
  assert.ok(!all.includes(KEY));
  assert.ok(!all.includes('global teams'));
});

const spendLimit = () => () => new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'You have reached your specified API usage limits. You will regain access on 2026-11-01.' } }), { status: 400 });

test('spend limit: visitors get the resting message, no retry, no fallback', async () => {
  plan = [spendLimit()];
  const r = await ask();
  assert.equal(r.status, 503);
  assert.deepEqual(JSON.parse(r.text), { error: 'unavailable' });
  assert.deepEqual(calls, [HAIKU]);
  assert.ok(logs.some(l => l.includes('spend_limit_reached')));
});

test('health check reports the spend limit', async () => {
  plan = [spendLimit()];
  const res = await worker.fetch(new Request('https://bazl-ask.example/health'), ENV);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.ok, false);
  assert.equal(body.reason, 'spend_limit');
  assert.ok(body.lastSpendLimitAt);
});

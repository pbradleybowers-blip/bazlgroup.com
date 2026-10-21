// Local stand-in for the bazl-interview Worker, used by run.py: runs the real worker/interview.js
// with a fake Anthropic API and an in-memory KV. Test codes only: brad-code-1 (Brad), maple-river-123, cobalt-stone-456.
// PORT sets the port; NOKV=1 runs it without the HISTORY binding.
import http from 'node:http';
import { createHash } from 'node:crypto';
import worker from '../../worker/interview.js';
const fp = (code, salt) => 'sha256:' + salt + ':' + createHash('sha256').update(Buffer.concat([Buffer.from(salt, 'hex'), Buffer.from(code)])).digest('hex');
const m = new Map();
const HISTORY = {
  async get(k, t) { const e = m.get(k); if (!e) return null; return t === 'json' ? JSON.parse(e.value) : e.value; },
  async getWithMetadata(k) { const e = m.get(k); return e ? { value: e.value, metadata: e.metadata ?? null } : { value: null, metadata: null }; },
  async put(k, v, o = {}) { m.set(k, { value: String(v), metadata: o.metadata }); },
  async delete(k) { m.delete(k); },
  async list({ prefix = '' } = {}) { return { keys: [...m.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name, metadata: m.get(name).metadata })), list_complete: true }; }
};
const env = {
  ANTHROPIC_API_KEY: 'fake', DEV_ORIGIN: 'http://localhost:8080', HISTORY: process.env.NOKV ? undefined : HISTORY, SESSIONS_PER_DAY: '2',
  ACCESS_HASH: fp('brad-code-1', 'aa'.repeat(16)),
  ACCESS_CODES: JSON.stringify({ tester1: fp('maple-river-123', 'bb'.repeat(16)), tester2: { hash: fp('cobalt-stone-456', 'cc'.repeat(16)), name: 'Sam' } })
};
const realFetch = globalThis.fetch;
const canned = {
  interview_brief: { panelist_title: 'VP Product', candidate_first_name: 'Pat', candidate_summary: 'PM', jd_summary: 'Director', focus_areas: ['Fit', 'Execution'], gaps: ['No marketplace experience', 'Limited people leadership'], resume_hooks: [{ hook: 'Acme', why: 'scale' }], question_plan: [{ topic: 'Open', question: 'Why?', probe: 'Why now?' }], opening: 'Hi Pat, thanks for joining. Why this role?' },
  interviewer_turn: { say: 'Thanks. Tell me about a launch that missed.', move: 'question', topic: 'Execution', done: false },
  coach_feedback: { cleaned: 'I led the checkout redesign.', signal: 'Neutral', landed: 'Clear ownership.', fix: 'No number.', try_this: 'Lead with the result.', level_check: '', question_rating: 'n/a', sharper: '', read_so_far: 'Maybe' },
  interview_debrief: { verdict: 'Maybe', rationale: 'Solid, but thin on numbers.', signals: [{ area: 'Fit', status: 'Partial' }], strongest: ['Ownership'], concerns: ['No metrics'], practice: [{ title: 'Lead with numbers', detail: 'Open every answer with the result.' }], per_answer: [{ signal: 'Neutral', note: 'Fine.' }], pattern: 'Answers lack numbers.' }
};
globalThis.fetch = async (url, init) => {
  if (String(url).startsWith('https://api.anthropic.com')) {
    const body = JSON.parse(init.body); const name = body.tools[0].name;
    await new Promise(r => setTimeout(r, 150));
    return new Response(JSON.stringify({ content: [{ type: 'tool_use', id: 'x', name, input: canned[name] }], stop_reason: 'tool_use' }), { status: 200 });
  }
  return realFetch(url, init);
};
console.log = () => {};
http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  if (req.url === '/__kv') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify([...m.entries()])); return; }
  const r = await worker.fetch(new Request('http://localhost:8787' + req.url, { method: req.method, headers: { ...req.headers, 'cf-connecting-ip': '10.0.0.' + Math.floor(Math.random() * 250) }, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) }), env);
  res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
}).listen(process.env.PORT || 8787);

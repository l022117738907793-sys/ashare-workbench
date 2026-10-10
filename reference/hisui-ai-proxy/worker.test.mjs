import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest, reserveDaily } from './worker.mjs';

const ORIGIN = 'https://l022117738907793-sys.github.io';
const request = (input = { question: '挂单为什么没有马上成交？' }, extra = {}) => new Request('https://demo.workers.dev/ask', {
  method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(input),
});
const environment = () => ({ DEEPSEEK_API_KEY: 'mock-key-only', HISUI_RATE_LIMITER: { limit: async () => ({ success: true }) }, DAILY_BUDGET: { getByName: () => ({ reserve: async () => true }) } });
const answer = { mood: 'explain', answer: '历史推演的委托会在下一交易日开盘尝试撮合。' };
const mockAnswer = async () => ({ status: 200, body: answer });

test('allows exact configured Origin and serves bodyless CORS preflight without quota or paid request', async () => {
  const req = new Request('https://demo.workers.dev/ask', { method: 'OPTIONS', headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST' } });
  const res = await handleRequest(req, {}, { answerImpl: () => { throw new Error('must not call'); } });
  assert.equal(res.status, 204);
  assert.equal(await res.text(), '');
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.equal(res.headers.get('Access-Control-Allow-Headers'), 'Content-Type');
});
test('rejects Origin paths, foreign sites and absent Origin before quota and paid request', async () => {
  for (const origin of [`${ORIGIN}/ashare-workbench/`, 'https://other.example', '']) {
    const res = await handleRequest(request(undefined, { Origin: origin }), environment(), { answerImpl: () => { throw new Error('must not call'); } });
    assert.equal(res.status, 403);
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), null);
  }
});
test('health and unconfigured or paused routes never reveal secrets or ask upstream', async () => {
  const env = environment();
  const health = await handleRequest(new Request('https://demo.workers.dev/health'), env);
  assert.equal(health.status, 200);
  assert.ok(!(await health.text()).includes('mock-key-only'));
  assert.equal((await handleRequest(request(), {})).status, 503);
  assert.equal((await handleRequest(request(), { ...env, ENABLED: 'false' })).status, 503);
});
test('rejects malformed and oversized input before reserving daily allowance', async () => {
  const env = environment();
  env.DAILY_BUDGET.getByName = () => { throw new Error('must not reserve'); };
  assert.equal((await handleRequest(request({ question: 'a'.repeat(201) }), env)).status, 400);
  assert.equal((await handleRequest(request({ question: '什么是挂单？', context: 'a'.repeat(17000) }), env)).status, 413);
  const req = new Request('https://demo.workers.dev/ask', { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: '{' });
  assert.equal((await handleRequest(req, env)).status, 400);
});
test('rate and persistent daily limits stop upstream; missing protection fails closed', async () => {
  const env = environment();
  const forbid = { answerImpl: () => { throw new Error('must not ask'); } };
  env.HISUI_RATE_LIMITER.limit = async () => ({ success: false });
  assert.equal((await handleRequest(request(), env, forbid)).status, 429);
  env.HISUI_RATE_LIMITER.limit = async () => ({ success: true });
  env.DAILY_BUDGET.getByName = () => ({ reserve: async () => false });
  assert.equal((await handleRequest(request(), env, forbid)).status, 429);
  assert.equal((await handleRequest(request(), { DEEPSEEK_API_KEY: 'mock-key-only' }, forbid)).status, 503);
});
test('returns existing frontend protocol and reserves once before mock upstream', async () => {
  const env = environment();
  const order = [];
  env.HISUI_RATE_LIMITER.limit = async ({ key }) => { order.push(key); return { success: true }; };
  env.DAILY_BUDGET.getByName = name => ({ reserve: async () => { order.push(name); return true; } });
  const res = await handleRequest(request(undefined, { 'CF-Connecting-IP': '192.0.2.1' }), env, { answerImpl: async (input, options) => { order.push('upstream'); assert.equal(options.apiKey, 'mock-key-only'); return mockAnswer(); } });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), answer);
  assert.deepEqual(order, ['ask:192.0.2.1', 'hisui-global-v1', 'upstream']);
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
});
test('persistent daily allowance survives object reconstruction and resets on UTC day', async () => {
  const values = new Map();
  const storage = { get: async key => values.get(key), put: async (key, value) => values.set(key, value), transaction: async fn => fn(storage) };
  assert.equal(await reserveDaily(storage, '2', '2026-10-10'), true);
  assert.equal(await reserveDaily({ ...storage }, '2', '2026-10-10'), true);
  assert.equal(await reserveDaily(storage, '2', '2026-10-10'), false);
  assert.equal(await reserveDaily(storage, '2', '2026-10-11'), true);
  assert.deepEqual(values.get('budget'), { day: '2026-10-11', used: 1 });
});

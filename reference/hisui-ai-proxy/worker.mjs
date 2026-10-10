import { answerQuestion, isValidQuestion } from './proxy.mjs';

const MAX_BODY_BYTES = 16384;
async function readInput(request) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error('json');
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) { await reader.cancel(); throw new Error('size'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes));
}

/** Fetch adapter; test seams never appear in public requests or configuration. */
export async function handleRequest(request, env, { answerImpl = answerQuestion } = {}) {
  const url = new URL(request.url);
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', Vary: 'Origin' };
  const send = (status, body) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers });
  if (url.pathname === '/health' && request.method === 'GET') {
    return send(200, { service: 'hisui-teaching-proxy', configured: !!env.DEEPSEEK_API_KEY, enabled: env.ENABLED !== 'false', model: env.HISUI_MODEL || 'deepseek-flash' });
  }
  const origin = request.headers.get('Origin');
  const origins = new Set((env.ALLOWED_ORIGINS || 'https://l022117738907793-sys.github.io').split(',').map(s => s.trim()).filter(Boolean));
  if (!origin || !origins.has(origin)) return send(403, { error: '来源不允许' });
  headers['Access-Control-Allow-Origin'] = origin;
  headers['Access-Control-Allow-Methods'] = 'POST, OPTIONS';
  headers['Access-Control-Allow-Headers'] = 'Content-Type';
  headers['Access-Control-Max-Age'] = '600';
  if (url.pathname !== '/ask') return send(404, { error: '接口不存在' });
  if (request.method === 'OPTIONS') return send(204, null);
  if (request.method !== 'POST') return send(405, { error: '只支持POST' });
  if (!(request.headers.get('Content-Type') || '').startsWith('application/json')) return send(415, { error: '需要JSON' });
  if (env.ENABLED === 'false') return send(503, { error: '问答服务已暂停，离线解释仍可使用' });
  if (!env.DEEPSEEK_API_KEY) return send(503, { error: '问答服务尚未配置' });
  let input;
  try { input = await readInput(request); } catch (error) { return send(error.message === 'size' ? 413 : 400, { error: '问题格式不正确或过长' }); }
  if (!isValidQuestion(input)) return send(400, { error: '问题格式不正确（最多200字）' });
  // The edge supplies this header in production. Shared mobile IPs share this small-demo allowance.
  const key = request.headers.get('CF-Connecting-IP') || 'local-development';
  try {
    if (!env.HISUI_RATE_LIMITER || !env.DAILY_BUDGET) return send(503, { error: '问答保护尚未配置' });
    const rate = await env.HISUI_RATE_LIMITER.limit({ key: `ask:${key}` });
    if (!rate.success) return send(429, { error: '提问太快，请过一分钟再试' });
    const reserved = await env.DAILY_BUDGET.getByName('hisui-global-v1').reserve();
    if (!reserved) return send(429, { error: '今日问答额度已用完，离线解释仍可使用' });
  } catch { return send(503, { error: '问答保护暂时不可用，请稍后重试' }); }
  const result = await answerImpl(input, { apiKey: env.DEEPSEEK_API_KEY, model: env.HISUI_MODEL || 'deepseek-flash' });
  return send(result.status, result.body);
}

/** Persistent reservation: consumed before contacting DeepSeek, including failed attempts. */
export async function reserveDaily(storage, configuredLimit, today = new Date().toISOString().slice(0, 10)) {
  const parsed = Number(configuredLimit);
  const limit = Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, 100000) : 300;
  return storage.transaction(async txn => {
    const saved = await txn.get('budget');
    const used = saved?.day === today ? saved.used : 0;
    if (used >= limit) return false;
    await txn.put('budget', { day: today, used: used + 1 });
    return true;
  });
}

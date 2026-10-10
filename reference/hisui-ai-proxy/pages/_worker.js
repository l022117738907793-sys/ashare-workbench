/**
 * Cloudflare Pages 版入口（Functions advanced mode，`_worker.js`）。
 *
 * 为什么要有这一层：本题的问答服务本体是 `../worker-entry.mjs` 部署成的 Cloudflare Worker。
 * 但 **`*.workers.dev` 在中国大陆被屏蔽**——DNS 被污染，把域名强行解析到真实 IP 之后
 * TLS 握手也会立刻被重置，大陆网络下这个地址永远打不开。`*.pages.dev` 不受影响，
 * 所以这里放一个大陆能打开的入口，把 `/ask` 与 `/health` 原样转发给 Worker。
 *
 * **规则、限流、每日额度、密钥全部留在 Worker 上**，这里不碰、也拿不到密钥；
 * 换机器、换域名时只要改下面这一行 `UPSTREAM`。
 *
 * 注意：Cloudflare 的 Worker 之间互相 fetch 走的是边缘内网，不经过大陆的国际出口，
 * 所以「大陆用户 → pages.dev → Worker → DeepSeek → 原路返回」这条链是通的。
 */

/** Worker 的地址。`npx wrangler deploy` 的输出就是它。 */
const UPSTREAM = 'https://ashare-hisui-teacher.ashare-workbench.workers.dev';

/** 只有这两个路径转发，其余交给同目录的静态文件（见 pages/build.mjs 生成的 index.html）。 */
const RELAY_PATHS = new Set(['/ask', '/health']);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!RELAY_PATHS.has(url.pathname)) return env.ASSETS.fetch(request);
    try {
      const headers = new Headers(request.headers);
      // 转发时把真实来访 IP 显式带上，Worker 的每分钟限流就是按它分桶的。
      const ip = request.headers.get('CF-Connecting-IP');
      if (ip) headers.set('CF-Connecting-IP', ip);
      const upstream = await fetch(new URL(url.pathname, UPSTREAM), {
        method: request.method,
        headers,
        body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
      });
      // 状态码与响应头（含 Worker 写好的 CORS 头）一律照搬，不对内容做任何加工。
      return new Response(upstream.body, { status: upstream.status, headers: upstream.headers });
    } catch {
      return new Response(JSON.stringify({ error: '问答服务暂时不可用，请稍后重试' }), {
        status: 502,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }
  },
};

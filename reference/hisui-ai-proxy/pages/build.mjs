/**
 * 拼出 Pages 的部署目录 `.pages-build/`。
 *
 * `_worker.js` 由 Pages 自己用 esbuild 打包，它 import 的 `worker.mjs` / `proxy.mjs` /
 * `knowledge.json` 必须和它同目录，所以这里做一次拷贝 —— 规则与提示词只有一份源文件，
 * 改完 `proxy.mjs` 重新 `npm run pages:deploy` 就同步过去了，不需要手工维护副本。
 */
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';

const here = new URL('./', import.meta.url);
const out = new URL('.pages-build/', here);
const shared = ['worker.mjs', 'proxy.mjs', 'knowledge.json'];

const LANDING = `<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>翡翠问答代理</title>
<body style="font-family:system-ui,-apple-system,'PingFang SC',sans-serif;max-width:36rem;margin:4rem auto;padding:0 1.25rem;line-height:1.7;color:#1b1f22">
<h1 style="font-size:1.25rem">翡翠问答代理</h1>
<p>这是 A 股模拟投资工作台「翡翠教学助手」的服务端代理。它只接受来自本工作台网页的提问，
把问题交给上游模型，再把回答发回网页。密钥存在服务端，网页上拿不到。</p>
<p><a href="/health">/health</a> 可以看服务是否已配置好。</p>
</body>
</html>
`;

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await cp(new URL('_worker.js', here), new URL('_worker.js', out));
for (const name of shared) await cp(new URL(`../${name}`, here), new URL(name, out));
await writeFile(new URL('index.html', out), LANDING);
console.log(`pages 构建完成：${out.pathname}`);

import { createServer } from 'node:http';
import { answerQuestion } from './proxy.mjs';
const origins = new Set((process.env.ALLOWED_ORIGINS ?? 'https://l022117738907793-sys.github.io').split(',').map(s=>s.trim()).filter(Boolean));
const buckets = new Map();
let day = '', spent = 0, active = 0;
const limit = Math.max(1, Number(process.env.DAILY_REQUEST_LIMIT) || 300);
const server = createServer(async (req, res) => {
  const origin = req.headers.origin;
  const headers = {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Vary':'Origin'};
  const send = (code,body) => {res.writeHead(code,headers); res.end(JSON.stringify(body));};
  if (!origin || !origins.has(origin)) return send(403,{error:'来源不允许'});
  headers['Access-Control-Allow-Origin'] = origin;
  headers['Access-Control-Allow-Methods'] = 'POST, OPTIONS';
  headers['Access-Control-Allow-Headers'] = 'Content-Type';
  if (req.url !== '/ask') return send(404,{error:'接口不存在'});
  if (req.method === 'OPTIONS') return send(204,null);
  if (req.method !== 'POST') return send(405,{error:'只支持POST'});
  if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return send(415,{error:'需要JSON'});
  const today = new Date().toISOString().slice(0,10);
  if (day !== today) {day=today;spent=0;}
  const now=Date.now(), key=req.socket.remoteAddress ?? 'unknown';
  for (const [address,bucket] of buckets) if (now-bucket.start>60000) buckets.delete(address);
  const bucket=buckets.get(key) ?? {start:now,count:0};
  buckets.set(key,bucket);
  if (bucket.count>=6 || spent>=limit || active>=4) return send(429,{error:'问答稍忙，请稍后再问'});
  bucket.count++;
  let size=0, chunks=[];
  try {
    for await (const chunk of req) {size+=chunk.length;if(size>16384){send(413,{error:'问题过长'});req.destroy();return;}chunks.push(chunk);}
    const input=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    spent++;active++;
    try {const result=await answerQuestion(input,{apiKey:process.env.DEEPSEEK_API_KEY,model:process.env.HISUI_MODEL || 'deepseek-flash'});send(result.status,result.body);} finally {active--;}
  } catch {if(!res.headersSent) send(400,{error:'问题格式不正确'});}
});
server.requestTimeout=25000;
server.headersTimeout=10000;
server.listen(Number(process.env.PORT)||8787,'127.0.0.1',()=>console.log('教学问答代理已启动；公网接入请配置HTTPS反向代理'));

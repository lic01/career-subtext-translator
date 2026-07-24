// 职场潜台词翻译器 — Coze 代理 + 静态托管（Node，零依赖）
// 运行：COZE_PAT=xxx node server.js   （COZE_BOT_ID 已内置默认值，如需覆盖可设环境变量）
// 本地访问：http://localhost:3000
// Vercel：把 module.exports 当作 (req, res) handler；不需改 vercel.json。

const http = require('http');
const fs = require('fs');
const path = require('path');

// Bot ID 已内置（用户提供的真实 ID）；PAT 是密钥，必须走环境变量，绝不写死在前端/代码里
const BOT_ID = process.env.COZE_BOT_ID || '7665697678680047642';
const PAT = process.env.COZE_PAT || '';
const PORT = process.env.PORT || 3000;
const DIR = __dirname;

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.json': 'application/json; charset=utf-8' };

function serveStatic(req, res) {
  let p = req.url.split('?')[0];
  if (p === '/' || p === '') p = '/index.html';
  const fp = path.join(DIR, path.normalize(p));
  if (!fp.startsWith(DIR)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
    res.end(data);
  });
}

// 把 Coze 的 v4.1 文本输出解析为结构化 JSON
function parseCoze(text) {
  const out = { decoded: '', index: 0, layers: [], replies: [], stage: '', sceneRead: '', analysis: '', cta: '', quote: '' };
  const clean = (s) => (s || '').replace(/^[\s:：#*\-–—]+/, '').replace(/\s+$/, '').trim();
  const until = (str, stops) => {
    for (const s of stops) {
      const i = str.indexOf(s);
      if (i >= 0) return str.slice(0, i);
    }
    return str;
  };

  // 一句话解码 + 人性洞察指数（两段独立解析，避免 decM 边界切到 index 行）
  const decM = text.match(/【一句话解码】[^\n]*\n?([\s\S]*?)(?=【三层翻译】|【这样接话】|【高发阶段|【场景异读】|【拆解】|【CTA)/);
  if (decM) {
    let block = decM[1];
    out.decoded = clean(until(block, ['人性洞察指数'])).replace(/\s*[+|＋]\s*$/, '');
  }
  // index 独立从全文抓，不受 decM 边界影响
  const idxM = text.match(/人性洞察指数[^\n]*?(\d+(?:\.\d+)?)\s*\/\s*10/);
  if (idxM) out.index = parseFloat(idxM[1]);

  // 三层翻译 A/B/C 面（兼容 Coze 输出的 "1. A面（...）" 编号格式）
  const layerBlock = text.match(/【三层翻译】[\s\S]*?([\s\S]*?)(?=【这样接话】|【高发阶段|【场景异读】|【拆解】|【CTA|$)/);
  if (layerBlock) {
    const lb = layerBlock[1];
    const re = /(?:\d+[\.、]\s*)?([ABC]\s*面[（(][^)）]+[)）])/g;
    let mm; const cuts = [];
    while ((mm = re.exec(lb)) !== null) cuts.push({ at: mm.index, tag: mm[1] });
    for (let k = 0; k < cuts.length; k++) {
      const seg = lb.slice(cuts[k].at, k + 1 < cuts.length ? cuts[k + 1].at : lb.length);
      let content = seg.replace(cuts[k].tag, '')
                        .replace(/^\s*\d+[\.、]\s*/, '')
                        .replace(/\s*\d+[\.、]?\s*$/, '');
      content = clean(content);
      if (content) out.layers.push({ t: cuts[k].tag, c: content });
    }
  }

  // 这样接话（三版话术）——按"XX版"或数字编号切分
  const repBlock = text.match(/【这样接话】[\s\S]*?([\s\S]*?)(?=【高发阶段|【场景异读】|【拆解】|【CTA|$)/);
  if (repBlock) {
    const rb = repBlock[1];
    const reTag = /(^|\n)\s*(?:\d+[\.\、]\s*)?([^：:\n]{1,14}?版)\s*[：:]?\s*/g;
    let mm; const cuts = [];
    while ((mm = reTag.exec(rb)) !== null) {
      const tagStart = mm.index + mm[0].indexOf(mm[2]);
      cuts.push({ start: tagStart, end: tagStart + mm[2].length, tag: mm[2] });
    }
    for (let k = 0; k < cuts.length; k++) {
      const seg = rb.slice(cuts[k].end, k + 1 < cuts.length ? cuts[k + 1].start : rb.length);
      const c = clean(seg).replace(/^[\s\-–—•·*]+/, '').replace(/\s*\d+[\.、]?\s*$/, '');
      if (c) out.replies.push({ tag: cuts[k].tag.replace(/^[\s\-–—•·*]+/, ''), c });
    }
    if (!out.replies.length) {
      const c = clean(rb);
      if (c) out.replies.push({ tag: '', c });
    }
  }

  // 高发阶段·同句异读
  const stM = text.match(/【高发阶段[^\n]*】[^\n]*\n?([\s\S]*?)(?=【场景异读】|【拆解】|【CTA|$)/);
  if (stM) out.stage = clean(stM[1]);

  // 场景异读（仅用户未给场景时出现）
  const scM = text.match(/【场景异读】[^\n]*\n?([\s\S]*?)(?=【拆解】|【CTA|$)/);
  if (scM) out.sceneRead = clean(scM[1]);

  // 拆解
  const anM = text.match(/【拆解】[^\n]*\n?([\s\S]*?)(?=【CTA|$)/);
  if (anM) out.analysis = clean(anM[1]);

  // CTA + 金句（金句取「金句：」后整行，兼容句内含引号；CTA 取去除金句行后的剩余）
  // 注意：Coze 偶发把完整答案整段重复推送，【CTA + 金句】之后可能还跟着第二份内容的【一句话解码】标记，
  // 这里用 lookahead 限定 CTA 块到第一个【标记前，避免翻倍内容渗入 CTA 框。
  const ctM = text.match(/【CTA\s*\+\s*金句】[^\n]*\n?([\s\S]*?)(?=\n【一句话解码】|\n【三层翻译】|\n【这样接话】|\n【高发阶段|\n【场景异读】|\n【拆解】|\n【CTA|$)/);
  if (ctM) {
    let block = ctM[1];
    const qM = block.match(/金句[：: ]*(.+?)\s*$/m);
    if (qM) {
      out.quote = qM[1].trim().replace(/^["「『]/, '').replace(/["」』]$/, '');
    }
    out.cta = clean(block.replace(/金句[：: ].*$/m, '')).replace(/五阶五阶/g, '五阶').trim();
  }

  // 兜底：完全没解析出任何结构化内容，则整段存入 decoded
  if (!out.decoded && !out.layers.length && !out.replies.length && !out.cta) {
    out.decoded = text.replace(/\n{2,}/g, '\n').slice(0, 400).trim();
  }
  return out;
}

async function callCoze(text) {
  if (!PAT) throw new Error('missing PAT');
  const resp = await fetch('https://api.coze.cn/v3/chat', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${PAT}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      bot_id: BOT_ID,
      user_id: 'h5_' + Date.now(),
      stream: true,
      auto_save_history: false,
      additional_messages: [{ role: 'user', content: text, content_type: 'text' }]
    })
  });
  if (!resp.ok) {
    let msg = 'coze http ' + resp.status;
    try { const t = await resp.text(); if (t) msg += ' ' + t.slice(0, 200); } catch (e) {}
    throw new Error(msg);
  }
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = '', full = '', fullReason = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const evs = buf.split('\n\n'); buf = evs.pop();
    for (const ev of evs) {
      const dl = ev.split('\n').find(l => l.startsWith('data:'));
      if (!dl) continue;
      try {
        const j = JSON.parse(dl.slice(5).trim());
        // 兼容两种 SSE 格式：标准包裹 {event,data} 或 api.coze.cn 的扁平对象
        const m = (j && j.data) ? j.data : j;
        if (m && m.role === 'assistant' && m.type === 'answer') {
          // 最终答案（干净、结构化）。Coze 偶发把完整答案整段重复推送两次，
          // 这里做去重：子串跳过、超集替换、非尾随才追加，避免内容翻倍。
          const c = m.content || '';
          if (c) {
            if (full.length === 0) full = c;
            else if (full.includes(c)) { /* 新内容是已有子串，跳过 */ }
            else if (c.includes(full)) full = c;          // 新内容已含全部已有，以新内容为准
            else if (!full.endsWith(c)) full += c;       // 增量分片，正常追加
          }
          if (m.reasoning_content) fullReason += m.reasoning_content; // 深度思考思维链（仅兜底用）
        }
      } catch (e) {}
    }
  }
  // 优先用最终答案；仅当 content 全程为空（极少数非深度思考异常）才退回思维链
  const finalText = full.trim() ? full : fullReason;
  return parseCoze(finalText);
}

// Vercel / 本地 双模式入口：导出 HTTP handler（(req, res) => void）
// Vercel 的 @vercel/node 会把 module.exports 当作请求处理器来调用
// 本地直接 `node server.js` 时，require.main === module，再走 http.createServer 监听端口
function handler(req, res) {
  if (req.method === 'POST' && req.url.split('?')[0] === '/api/translate') {
    const chunks = [];
    req.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))));
    req.on('end', async () => {
      const body = Buffer.concat(chunks).toString('utf-8');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      try {
        const { text } = JSON.parse(body || '{}');
        if (!text || !text.trim()) { res.writeHead(400); return res.end(JSON.stringify({ error: 'empty text' })); }
        const data = await callCoze(text.trim());
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, data }));
      } catch (e) {
        res.writeHead(502);
        res.end(JSON.stringify({ ok: false, error: e.message, hint: '请确认：1) COZE_PAT 环境变量已设置；2) 智能体已发布为 API 服务；3) 已关联知识库 zcdjzsk1~5' }));
      }
    });
    return;
  }
  if (req.method === 'OPTIONS') { res.setHeader('Access-Control-Allow-Origin', '*'); res.writeHead(204); return res.end(); }
  serveStatic(req, res);
}

// Vercel handler export（Vercel 期望 module.exports 是函数；附加属性 Vercel 不会当作入口）
module.exports = handler;
// 单测暴露（不影响 Vercel：函数上的属性 Vercel 不会用来当 handler）
module.exports.parseCoze = parseCoze;
module.exports.callCoze = callCoze;

if (require.main === module) {
  const server = http.createServer(handler);
  server.listen(PORT, () => {
    console.log(`潜台词翻译器运行中：http://localhost:${PORT}`);
    console.log(`Bot ID：${BOT_ID}`);
    if (!PAT) console.log('⚠️  未设置 COZE_PAT，前端将使用演示模式（不连真 Coze）。运行：COZE_PAT=你的令牌 node server.js');
  });
}

// 职场潜台词翻译器 — Coze 代理 + 静态托管（Node，零依赖）
// 运行：COZE_PAT=xxx node server.js   （COZE_BOT_ID 已内置默认值，如需覆盖可设环境变量）
// 本地访问：http://localhost:3000

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

  // 一句话解码 + 人性洞察指数
  const decM = text.match(/【一句话解码】[^\n]*\n?([\s\S]*?)(?=【三层翻译】|【这样接话】|【高发阶段|【场景异读】|【拆解】|【CTA)/);
  if (decM) {
    let block = decM[1];
    const idxM = block.match(/人性洞察指数[^\n]*?(\d+(?:\.\d+)?)\s*\/\s*10/);
    if (idxM) out.index = parseFloat(idxM[1]);
    out.decoded = clean(until(block, ['人性洞察指数'])).replace(/\s*[+＋]\s*$/, '');
  }

  // 三层翻译 A/B/C 面
  const layerBlock = text.match(/【三层翻译】[\s\S]*?([\s\S]*?)(?=【这样接话】|【高发阶段|【场景异读】|【拆解】|【CTA|$)/);
  if (layerBlock) {
    const lb = layerBlock[1];
    const re = /([ABC]\s*面[（(][^)）]+[)）])/g;
    let mm; const cuts = [];
    while ((mm = re.exec(lb)) !== null) cuts.push({ at: mm.index, tag: mm[0] });
    for (let k = 0; k < cuts.length; k++) {
      const seg = lb.slice(cuts[k].at, k + 1 < cuts.length ? cuts[k + 1].at : lb.length);
      const content = clean(seg.replace(cuts[k].tag, ''));
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
      const c = clean(seg);
      if (c) out.replies.push({ tag: cuts[k].tag, c });
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

  // CTA + 金句（优先匹配「」包裹的金句，避免误抓 CTA 里的"五阶"关键词）
  const ctM = text.match(/【CTA\s*\+\s*金句】[^\n]*\n?([\s\S]*?)$/);
  if (ctM) {
    const block = ctM[1];
    // 金句必须紧跟「金句」标记提取，避免误抓 CTA 行里回复关键词的引号（如 回复"五阶"）
    const qM = block.match(/金句[：: ]*[「『"]([^」』"]+)[」』"]/);
    if (qM) {
      out.quote = qM[1].trim();
      // 整行删除金句，避免残留在 CTA 中
      out.cta = clean(block.replace(/💡?\s*金句[：: ]*[「『"][^」』"]*[」』"]/, '')).trim();
    } else {
      out.cta = clean(block);
    }
    // 模型偶发把"五阶"重复为"五阶五阶"，归一化（仅此处出现，安全）
    out.cta = out.cta.replace(/五阶五阶/g, '五阶');
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
          if (m.content) full += m.content;            // 最终答案（干净、结构化）
          if (m.reasoning_content) fullReason += m.reasoning_content; // 深度思考思维链（仅兜底用）
        }
      } catch (e) {}
    }
  }
  // 优先用最终答案；仅当 content 全程为空（极少数非深度思考异常）才退回思维链
  const finalText = full.trim() ? full : fullReason;
  return parseCoze(finalText);
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url.split('?')[0] === '/api/translate') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
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
});

server.listen(PORT, () => {
  console.log(`潜台词翻译器运行中：http://localhost:${PORT}`);
  console.log(`Bot ID：${BOT_ID}`);
  if (!PAT) console.log('⚠️  未设置 COZE_PAT，前端将使用演示模式（不连真 Coze）。运行：COZE_PAT=你的令牌 node server.js');
});

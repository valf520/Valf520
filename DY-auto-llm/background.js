/* background service worker
 *
 * 三件事：
 *   1) 长记忆：IndexedDB 存全部对话（不进页面源，页面脚本读不到）
 *   2) 大模型：唯一调用出口，Key 只活在这里
 *   3) 图片识别（可选）：VLM 把图片转成一句描述，喂给主模型
 *
 * 为什么用 IndexedDB 而不是 SQLite：
 *   扩展里没有原生 SQLite。WASM 版（sql.js / wa-sqlite）要 1.5MB 体积，而且 OPFS 同步句柄
 *   在 MV3 service worker 里拿不到；真要 SQL 就得跑本地 sidecar（Node/Python 监听 127.0.0.1）。
 *   IndexedDB 是浏览器内置的嵌入式库，MV3 SW 里原生可用、事务原子、容量按配额给到几百 MB，
 *   这个量级（一个账号几万条消息）完全够。想要 SQL 的话用 DY_DB_EXPORT 导出 JSON 再灌进 SQLite。
 */

/* kb/retrieve.js 是普通脚本，直接 importScripts 挂到 worker 全局 */
let KB_OK = false;
try {
  importScripts('kb/retrieve.js');
  KB_OK = typeof DYKB !== 'undefined';
} catch (e) {
  console.warn('[DY-AI] kb/retrieve.js 未加载：', e && e.message);
}

const DEFAULTS = {
  API_KEY: '',
  API_BASE: 'https://api.deepseek.com',
  MODEL: 'deepseek-chat',
  TEMPERATURE: 0.3,
  MAX_TOKENS: 200,
  VISION_ON: false,
  VISION_BASE: '',
  VISION_MODEL: '',
  VISION_KEY: '',
  ASR_ON: false,
  ASR_BASE: '',
  ASR_MODEL: '',
  ASR_KEY: '',
  KB_RETRIEVE: true,
};

const LLM_TIMEOUT = 30000;
const VISION_TIMEOUT = 20000;
const SUMMARY_TRIGGER = 40;   // 未归档消息超过这个数就压缩一次
const SUMMARY_KEEP = 20;      // 保留最近 N 条原文不压缩

/* ============================================================
 * 一、IndexedDB
 * ============================================================ */

const DB_NAME = 'dy_ai';
const DB_VER = 1;
let _db = null;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('chats')) {
        db.createObjectStore('chats', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('msgs')) {
        const s = db.createObjectStore('msgs', { keyPath: 'id', autoIncrement: true });
        s.createIndex('byChat', ['chatId', 'ts'], { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function db() {
  if (!_db) _db = await openDB();
  return _db;
}

/** 在一个事务里跑 fn(store, t)。fn 必须同步发起所有请求，结果靠 request.onsuccess 收集。 */
async function run(names, mode, fn) {
  const d = await db();
  const t = d.transaction(names, mode);
  const stores = Array.isArray(names) ? names.map((n) => t.objectStore(n)) : t.objectStore(names);
  const box = fn(stores, t);
  await new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('tx aborted'));
  });
  return box;
}

async function getChat(id) {
  const box = await run('chats', 'readonly', (s) => {
    const b = { v: null };
    const r = s.get(String(id));
    r.onsuccess = () => { b.v = r.result || null; };
    return b;
  });
  return box.v;
}

async function putChat(obj) {
  await run('chats', 'readwrite', (s) => { s.put(obj); });
}

/** 追加消息，返回实际写入条数 */
async function appendMsgs(chatId, list) {
  if (!list || !list.length) return 0;
  const now = Date.now();
  const box = await run('msgs', 'readwrite', (s) => {
    const b = { n: 0 };
    list.forEach((m, i) => {
      s.add({
        chatId: String(chatId),
        role: m.role === 'me' ? 'me' : 'them',
        kind: m.kind || 'text',
        text: String(m.text || '').slice(0, 500),
        ts: now + i,
        archived: 0,
      });
      b.n++;
    });
    return b;
  });
  const chat = (await getChat(chatId)) || { id: String(chatId), firstSeen: now, summary: '', facts: [] };
  chat.lastSeen = now;
  chat.count = (chat.count || 0) + box.n;
  await putChat(chat);
  return box.n;
}

/**
 * 带去重的追加：页面每次进来都会重读同一段 DOM，直接 append 会把历史刷成 N 份。
 * 做法：在「新列表」里找「已存尾部」最后一次出现的位置，它后面才是真正的新消息。
 */
async function appendMsgsDedup(chatId, list) {
  const clean = (list || []).filter((m) => m && String(m.text || '').trim());
  if (!clean.length) return 0;

  const tail = await recentMsgs(chatId, 80);
  const key = (m) => (m.role === 'me' ? 'me' : 'them') + '|' + String(m.text || '').trim();

  let end = 0;   // 已存在部分的结束位置
  const maxK = Math.min(clean.length, tail.length);
  outer:
  for (let k = maxK; k >= 1; k--) {
    for (let i = clean.length - k; i >= 0; i--) {
      let ok = true;
      for (let j = 0; j < k; j++) {
        if (key(clean[i + j]) !== key(tail[tail.length - k + j])) { ok = false; break; }
      }
      if (ok) { end = i + k; break outer; }
    }
  }

  const fresh = clean.slice(end);
  if (!fresh.length) return 0;
  return appendMsgs(chatId, fresh);
}

/** 最近 N 条（升序返回） */
async function recentMsgs(chatId, limit) {
  const box = await run('msgs', 'readonly', (s) => {
    const b = { v: [] };
    const idx = s.index('byChat');
    const range = IDBKeyRange.bound([String(chatId), 0], [String(chatId), Number.MAX_SAFE_INTEGER]);
    const req = idx.openCursor(range, 'prev');
    req.onsuccess = () => {
      const c = req.result;
      if (!c || b.v.length >= limit) return;
      b.v.push(c.value);
      c.continue();
    };
    return b;
  });
  return box.v.reverse();
}

async function liveMsgs(chatId) {
  const box = await run('msgs', 'readonly', (s) => {
    const b = { v: [] };
    const idx = s.index('byChat');
    const range = IDBKeyRange.bound([String(chatId), 0], [String(chatId), Number.MAX_SAFE_INTEGER]);
    const req = idx.openCursor(range);
    req.onsuccess = () => {
      const c = req.result;
      if (!c) return;
      if (!c.value.archived) b.v.push(c.value);
      c.continue();
    };
    return b;
  });
  return box.v;
}

async function markArchived(ids) {
  if (!ids.length) return;
  const set = new Set(ids);
  await run('msgs', 'readwrite', (s) => {
    const req = s.openCursor();
    req.onsuccess = () => {
      const c = req.result;
      if (!c) return;
      if (set.has(c.value.id)) {
        const v = c.value;
        v.archived = 1;
        c.update(v);
      }
      c.continue();
    };
  });
}

async function clearChat(chatId) {
  await run(['msgs', 'chats'], 'readwrite', ([ms, cs]) => {
    const idx = ms.index('byChat');
    const range = IDBKeyRange.bound([String(chatId), 0], [String(chatId), Number.MAX_SAFE_INTEGER]);
    const req = idx.openCursor(range);
    req.onsuccess = () => {
      const c = req.result;
      if (!c) return;
      c.delete();
      c.continue();
    };
    cs.delete(String(chatId));
  });
}

async function clearAll() {
  await run(['msgs', 'chats'], 'readwrite', ([ms, cs]) => { ms.clear(); cs.clear(); });
}

async function stats() {
  const box = await run(['msgs', 'chats'], 'readonly', ([ms, cs]) => {
    const b = { msgs: 0, chats: 0 };
    const r1 = ms.count();
    const r2 = cs.count();
    r1.onsuccess = () => { b.msgs = r1.result; };
    r2.onsuccess = () => { b.chats = r2.result; };
    return b;
  });
  return box;
}

async function exportAll() {
  const box = await run(['msgs', 'chats'], 'readonly', ([ms, cs]) => {
    const b = { msgs: [], chats: [] };
    const r1 = ms.getAll();
    const r2 = cs.getAll();
    r1.onsuccess = () => { b.msgs = r1.result || []; };
    r2.onsuccess = () => { b.chats = r2.result || []; };
    return b;
  });
  return box;
}

/* ============================================================
 * 二、记忆压缩
 * ============================================================ */

function summaryPrompt(oldText, prevSummary) {
  return [
    '你在压缩一段抖音客服对话，产出的内容会作为后续回复的长期记忆。',
    '只记录事实，不要客套话，不要推测。',
    '输出严格 JSON，不要代码块，不要多余文字：',
    '{"summary":"200 字以内的对话摘要","facts":["客户的关键信息，最多 5 条"]}',
    '',
    '【已有摘要】',
    prevSummary || '（无）',
    '',
    '【需要合并进来的对话】',
    oldText.slice(0, 6000),
  ].join('\n');
}

async function maybeSummarize(chatId) {
  const chat = (await getChat(chatId)) || {};
  const live = await liveMsgs(chatId);
  if (live.length <= SUMMARY_TRIGGER) return { summarized: false, live: live.length };

  const old = live.slice(0, live.length - SUMMARY_KEEP);
  const text = old.map((m) => (m.role === 'me' ? '我: ' : '客户: ') + m.text).join('\n');

  const res = await callLLM({
    messages: [{ role: 'user', content: summaryPrompt(text, chat.summary) }],
    temperature: 0.2,
    maxTokens: 400,
  });

  let summary = chat.summary || '';
  let facts = chat.facts || [];
  if (res.ok) {
    const m = String(res.text).match(/\{[\s\S]*\}/);
    if (m) {
      try {
        const j = JSON.parse(m[0]);
        if (j.summary) summary = String(j.summary).slice(0, 400);
        if (Array.isArray(j.facts)) facts = j.facts.slice(0, 5).map((x) => String(x).slice(0, 120));
      } catch (e) { summary = String(res.text).slice(0, 400); }
    } else {
      summary = String(res.text).slice(0, 400);
    }
  } else {
    /* 模型挂了也要能压缩：退化成截断式摘要，别让记忆无限膨胀 */
    summary = (summary + ' / ' + text).slice(-600);
  }

  await putChat({ ...chat, id: String(chatId), summary, facts, summarizedAt: Date.now(), summarizedUpTo: old[old.length - 1].id });
  await markArchived(old.map((m) => m.id));
  console.log('[DY-AI] 记忆压缩：归档', old.length, '条 ->', summary.slice(0, 60));
  return { summarized: true, archived: old.length, summary, facts };
}

/* ============================================================
 * 三、模型调用
 * ============================================================ */

async function callLLM(payload, opts = {}) {
  const cfg = await chrome.storage.local.get(DEFAULTS);
  if (!cfg.API_KEY) return { ok: false, error: 'NO_KEY' };

  const base = String(cfg.API_BASE || DEFAULTS.API_BASE).replace(/\/+$/, '');
  const body = {
    model: cfg.MODEL || DEFAULTS.MODEL,
    messages: payload.messages || [],
    temperature: payload.temperature != null ? payload.temperature : (Number(cfg.TEMPERATURE) || 0.3),
    max_tokens: payload.maxTokens || Number(cfg.MAX_TOKENS) || 200,
    stream: false,
  };

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeout || LLM_TIMEOUT);
  try {
    const res = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.API_KEY },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      const hint =
        res.status === 401 ? 'INVALID_KEY' :
        res.status === 402 ? 'NO_BALANCE' :
        res.status === 429 ? 'RATE_LIMIT' :
        res.status >= 500 ? 'UPSTREAM_DOWN' : 'HTTP_' + res.status;
      return { ok: false, error: hint + ' | ' + text.slice(0, 180) };
    }
    let json;
    try { json = JSON.parse(text); } catch (e) { return { ok: false, error: 'BAD_JSON' }; }
    const out = json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
    if (!out) return { ok: false, error: 'EMPTY_CHOICE' };
    const u = json.usage || {};
    return {
      ok: true,
      text: String(out).trim(),
      usage: u.total_tokens ? ('tokens ' + u.prompt_tokens + '+' + u.completion_tokens + '=' + u.total_tokens) : '',
      model: json.model || body.model,
    };
  } catch (e) {
    if (e && e.name === 'AbortError') return { ok: false, error: 'TIMEOUT' };
    return { ok: false, error: 'NETWORK: ' + ((e && e.message) || e) };
  } finally {
    clearTimeout(timer);
  }
}

/* ============================================================
 * 四、图片识别（可选，OpenAI 兼容的 vision 接口）
 * ============================================================ */

async function describeImage(url) {
  const cfg = await chrome.storage.local.get(DEFAULTS);
  if (!cfg.VISION_ON) return { ok: false, error: 'VISION_OFF' };
  const key = cfg.VISION_KEY || cfg.API_KEY;
  const base = String(cfg.VISION_BASE || cfg.API_BASE || '').replace(/\/+$/, '');
  const model = cfg.VISION_MODEL || '';
  if (!base || !model || !key) return { ok: false, error: 'VISION_NOT_CONFIGURED' };

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), VISION_TIMEOUT);
  try {
    const res = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({
        model,
        max_tokens: 80,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: '用一句中文描述这张图里最主要的东西（20 字内），只输出描述本身。如果看不清就说"看不清"。' },
            { type: 'image_url', image_url: { url } },
          ],
        }],
      }),
      signal: ac.signal,
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, error: 'VISION_HTTP_' + res.status + ' | ' + text.slice(0, 120) };
    const json = JSON.parse(text);
    const out = json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
    return out ? { ok: true, text: String(out).trim().slice(0, 60) } : { ok: false, error: 'EMPTY' };
  } catch (e) {
    return { ok: false, error: 'VISION_NET: ' + ((e && e.message) || e) };
  } finally {
    clearTimeout(timer);
  }
}

/* ============================================================
 * 五、语音转写（ASR，OpenAI 兼容的 /audio/transcriptions）
 * ============================================================ */

const MIME_EXT = {
  'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/m4a': 'm4a',
  'audio/aac': 'aac', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3',
  'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/wav': 'wav',
  'audio/x-wav': 'wav', 'audio/wave': 'wav', 'application/octet-stream': 'm4a',
};

async function transcribe(payload) {
  const cfg = await chrome.storage.local.get(DEFAULTS);
  if (!cfg.ASR_ON) return { ok: false, error: 'ASR_OFF' };
  const key = cfg.ASR_KEY || cfg.API_KEY;
  const base = String(cfg.ASR_BASE || cfg.API_BASE || '').replace(/\/+$/, '');
  const model = cfg.ASR_MODEL || '';
  if (!base || !model || !key) return { ok: false, error: 'ASR_NOT_CONFIGURED' };

  let blob = null;
  if (payload && payload.b64) {
    try {
      const bin = atob(payload.b64);
      const buf = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
      blob = new Blob([buf], { type: payload.mime || 'audio/mp4' });
    } catch (e) {
      return { ok: false, error: 'BAD_B64' };
    }
  } else if (payload && payload.url) {
    try {
      const r = await fetch(payload.url, { credentials: 'include' });   // 抖音 CDN 要 Cookie
      if (!r.ok) return { ok: false, error: 'AUDIO_HTTP_' + r.status };
      blob = await r.blob();
    } catch (e) {
      return { ok: false, error: 'AUDIO_FETCH: ' + ((e && e.message) || e) };
    }
  } else {
    return { ok: false, error: 'NO_AUDIO' };
  }

  if (!blob.size) return { ok: false, error: 'EMPTY_AUDIO' };
  if (blob.size > 20 * 1024 * 1024) return { ok: false, error: 'TOO_LARGE' };

  const ext = MIME_EXT[blob.type] || 'm4a';
  const fd = new FormData();
  fd.append('file', blob, 'voice.' + ext);
  fd.append('model', model);
  try { fd.append('language', 'zh'); } catch (e) {}

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 60000);
  try {
    const res = await fetch(base + '/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key },
      body: fd,
      signal: ac.signal,
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, error: 'ASR_HTTP_' + res.status + ' | ' + text.slice(0, 160) };
    let json = null;
    try { json = JSON.parse(text); } catch (e) {}
    const out = (json && (json.text || (json.data && json.data.text))) || (json ? '' : text);
    const t = String(out || '').trim();
    return t ? { ok: true, text: t.slice(0, 300) } : { ok: false, error: 'ASR_EMPTY' };
  } catch (e) {
    if (e && e.name === 'AbortError') return { ok: false, error: 'ASR_TIMEOUT' };
    return { ok: false, error: 'ASR_NET: ' + ((e && e.message) || e) };
  } finally {
    clearTimeout(timer);
  }
}

/* ============================================================
 * 六、本地资料库检索（狗头军师 corpus）
 * ============================================================ */

let kbMeta = null;

async function ensureKB() {
  if (!KB_OK) return false;
  if (kbMeta) return true;
  try {
    const res = await fetch(chrome.runtime.getURL('kb/kb.json'));
    const json = await res.json();
    let routes = [];
    try {
      const r2 = await fetch(chrome.runtime.getURL('kb/routes.json'));
      routes = await r2.json();
    } catch (e) {
      console.warn('[DY-AI] routes.json 没读到（可选）：', e && e.message);
    }
    const n = DYKB.load(json.chunks || [], routes);
    kbMeta = { n, builtAt: json.builtAt, source: json.source, routes: routes.length };
    console.log('[DY-AI] 资料库已载入：', n, '块 /', routes.length, '条路由');
    return true;
  } catch (e) {
    console.warn('[DY-AI] 资料库载入失败：', e && e.message);
    return false;
  }
}

async function kbSearch(query, limit) {
  const cfg = await chrome.storage.local.get(DEFAULTS);
  if (!cfg.KB_RETRIEVE) return { ok: true, gated: true, reason: 'DISABLED', chunks: [] };
  if (!(await ensureKB())) return { ok: false, error: 'KB_NOT_LOADED', chunks: [] };
  if (!DYKB.shouldRetrieve(query)) return { ok: true, gated: true, chunks: [] };
  const chunks = DYKB.search(query, { limit: limit || 2, budget: 1800, sectionCap: 1200 });
  return { ok: true, gated: false, chunks, meta: kbMeta };
}

/* ============================================================
 * 七、路由
 * ============================================================ */

chrome.runtime.onInstalled.addListener(() => console.log('[DY-AI] background ready'));

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (!msg || !msg.type) return false;

  const safe = (p) => p.then(reply).catch((e) => reply({ ok: false, error: 'EXCEPTION: ' + ((e && e.message) || e) }));

  switch (msg.type) {
    case 'DY_LLM':
      safe(callLLM(msg.payload || {}));
      return true;

    case 'DY_TEST_LLM': {
      const t = msg.payload || {};
      const sys = [
        '你是「' + (t.persona || '本店客服') + '」的在线客服。',
        '本店的具体信息（价格/库存/发货/政策）只能来自知识库；通用常识和闲聊可以正常回答。',
        (t.maxChars || 40) + ' 字以内，口语，不要 markdown。',
        '',
        '【知识库】',
        (t.kb || '（空）').slice(0, 1500),
      ].join('\n');
      safe(callLLM({
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: t.message || '在吗？这个多少钱' },
        ],
      }));
      return true;
    }

    case 'DY_DESCRIBE_IMAGE':
      safe(describeImage(msg.url));
      return true;

    case 'DY_ASR':
      safe(transcribe(msg.payload || {}));
      return true;

    case 'DY_KB':
      safe(kbSearch(msg.query || '', msg.limit));
      return true;

    case 'DY_KB_STATS':
      safe((async () => {
        const ok = await ensureKB();
        return { ok, ...(kbMeta || {}), enabled: (await chrome.storage.local.get({ KB_RETRIEVE: true })).KB_RETRIEVE };
      })());
      return true;

    case 'DY_MEMORY_GET':
      safe((async () => {
        const chat = (await getChat(msg.chatId)) || {};
        const recent = await recentMsgs(msg.chatId, msg.limit || 24);
        const s = await stats();
        return {
          ok: true,
          summary: chat.summary || '',
          facts: chat.facts || [],
          recent: recent.map((m) => ({ role: m.role, text: m.text, kind: m.kind })),
          count: chat.count || 0,
          stats: s,
        };
      })());
      return true;

    case 'DY_DB_APPEND':
      safe((async () => {
        const n = await appendMsgsDedup(msg.chatId, msg.msgs || []);
        /* 压缩放后台跑，不阻塞回复 */
        maybeSummarize(msg.chatId).catch((e) => console.log('[DY-AI] summarize fail', e && e.message));
        return { ok: true, appended: n };
      })());
      return true;

    case 'DY_MEMORY_SUMMARIZE':
      safe(maybeSummarize(msg.chatId).then((r) => ({ ok: true, ...r })));
      return true;

    case 'DY_DB_STATS':
      safe(stats().then((s) => ({ ok: true, ...s })));
      return true;

    case 'DY_DB_CLEAR':
      safe((async () => {
        if (msg.chatId) await clearChat(msg.chatId); else await clearAll();
        return { ok: true, ...(await stats()) };
      })());
      return true;

    case 'DY_DB_EXPORT':
      safe(exportAll().then((d) => ({ ok: true, ...d })));
      return true;

    default:
      return false;
  }
});
